// CR-07 排班域：shift（班次字典） + schedule（排班明细） 幂等建表/建索引。
// ---------------------------------------------------------------------------
// 口径（主人拍板，锁定）：
//   ① H5 口径 = B（默认只列「今天排给我的车」；页脚「显示全部车辆」，选非排班车 → 二次确认 + 留痕）。
//   ② 启用班次字典（白/夜班），但**不强制**（schedule.shift_id 可空 = 不区分班次）。
//   ③ **允许多车**（一人同日可多班/多车）→ 唯一约束只保留「同日期同班次内一车一派」，
//      **去掉**「一人一派」约束。
// 表结构为**纯新增**，不改 timer_session 既有字段（schedule_id 快照本期不加）。
// 幂等：DDL 全 IF NOT EXISTS；默认班次 INSERT OR IGNORE（按 name 唯一）。
import { fmtDateTime } from '../lib/time.js';

export const SCHEDULE_DDL = `
CREATE TABLE IF NOT EXISTS shift (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,          -- 白班 / 夜班 / 中班
  start_time TEXT,                             -- '08:00'
  end_time   TEXT,                             -- '20:00'（跨零点夜班：归属开始日，见 docs/11 §7）
  sort       INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);

CREATE TABLE IF NOT EXISTS schedule (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date   TEXT    NOT NULL,                          -- '2026-09-30'
  shift_id    INTEGER REFERENCES shift(id),              -- 可空：不区分班次
  operator_id INTEGER NOT NULL REFERENCES operator(id),
  vehicle_id  INTEGER NOT NULL REFERENCES vehicle(id),
  status      TEXT    NOT NULL DEFAULT 'planned'
              CHECK(status IN ('planned','cancelled')),   -- done 由计时记录推导，不落库
  note        TEXT,
  created_by  TEXT,                                      -- 发起人：后台账号用户名/姓名（留痕，= 安全员界面「发起人」同源快照）
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at  TEXT,
  updated_by  TEXT                                       -- 最后修改人：改派/取消时的操作人（口径①：未改过 → NULL）
);

-- ★ 同日期 + 同班次内「一车一派」（shift_id 为空按 0 归一；仅约束 planned）
CREATE UNIQUE INDEX IF NOT EXISTS ux_sched_veh
  ON schedule(work_date, IFNULL(shift_id,0), vehicle_id) WHERE status='planned';
-- 查询索引（注意：**无**「一人一派」唯一索引 —— 主人口径允许一人多车/多班）
CREATE INDEX IF NOT EXISTS ix_sched_date    ON schedule(work_date);
CREATE INDEX IF NOT EXISTS ix_sched_opdate  ON schedule(work_date, operator_id);
CREATE INDEX IF NOT EXISTS ix_sched_vedate  ON schedule(work_date, vehicle_id);
CREATE INDEX IF NOT EXISTS ix_sched_shift   ON schedule(shift_id);

-- 越权留痕（口径 B：非排班车经 {allowUnscheduled:true} 放行时记录，供审计/统计）
CREATE TABLE IF NOT EXISTS schedule_override (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date   TEXT    NOT NULL,
  operator_id INTEGER NOT NULL REFERENCES operator(id),
  vehicle_id  INTEGER NOT NULL REFERENCES vehicle(id),
  session_id  INTEGER REFERENCES timer_session(id),
  vin         TEXT,
  by_who      TEXT,                                      -- 操作人（登录用户名/安全员名）
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS ix_override_date ON schedule_override(work_date);
`;

/** 默认班次（幂等按 name 插入；已存在不改动） */
const DEFAULT_SHIFTS = [
  ['白班', '08:00', '20:00', 10],
  ['夜班', '20:00', '08:00', 20],
];

/**
 * 幂等建表/建索引 + 默认班次播种。可重复调用。
 * @param {import('better-sqlite3').Database} db
 */
export function ensureScheduleSchema(db) {
  db.exec(SCHEDULE_DDL);
  // 幂等补列（老库）：schedule 表已存在时 CREATE TABLE IF NOT EXISTS 不会补新列，
  // 故对存量库显式检查并 ALTER 加列。口径①：updated_by 仅在改派/取消时写入，历史行留空。
  const cols = db.prepare('PRAGMA table_info(schedule)').all().map((c) => c.name);
  if (!cols.includes('updated_by')) {
    db.exec('ALTER TABLE schedule ADD COLUMN updated_by TEXT');
  }
  const ins = db.prepare(
    'INSERT OR IGNORE INTO shift(name,start_time,end_time,sort,active,created_at) VALUES(?,?,?,?,1,?)'
  );
  const now = fmtDateTime();
  for (const [name, start, end, sort] of DEFAULT_SHIFTS) ins.run(name, start, end, sort, now);
  return db;
}
