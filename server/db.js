// 数据层：better-sqlite3 连接 + 建表/迁移
// DDL 冻结（见 docs/01-冻结规格-M0.md §1；CR-01 增量见 §11），禁止私改字段/索引。
import Database from 'better-sqlite3';
import { hashPassword } from './middleware/auth.js';
// CR-07：排班域（shift/schedule）幂等建表，独立迁移模块，避免与其它 CR 的 db.js 改动互相干扰。
import { ensureScheduleSchema } from './migrations/schedule.js';
// CR-11：登录日志域（login_log）幂等建表，独立迁移模块。
import { ensureLoginLogSchema } from './migrations/login_log.js';
// 2026-10-08 老板需求②：审批中心（approval_flow/node/request/log）。
import { ensureApprovalSchema } from './migrations/approval.js';

const DDL = `
CREATE TABLE IF NOT EXISTS operator (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  label      TEXT,
  phone      TEXT,
  active     INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_operator_name ON operator(name) WHERE active=1;

CREATE TABLE IF NOT EXISTS vehicle (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vin        TEXT    NOT NULL UNIQUE,
  station    TEXT,
  org        TEXT,
  supplier   TEXT,
  active     INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);

CREATE TABLE IF NOT EXISTS wo_sequence (
  day      TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS timer_session (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_no TEXT    NOT NULL UNIQUE,
  operator_id   INTEGER NOT NULL REFERENCES operator(id),
  vehicle_id    INTEGER NOT NULL REFERENCES vehicle(id),
  operator_name TEXT    NOT NULL,
  vin           TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'running'
                CHECK(status IN ('running','paused','stopped')),
  start_at      TEXT    NOT NULL,
  end_at        TEXT,
  net_seconds   INTEGER NOT NULL DEFAULT 0,
  pause_seconds INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
-- ★ 互斥：同一安全员至多 1 条进行中
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_operator ON timer_session(operator_id)
  WHERE status IN ('running','paused');
CREATE INDEX IF NOT EXISTS ix_session_start ON timer_session(start_at);
CREATE INDEX IF NOT EXISTS ix_session_operator ON timer_session(operator_id, start_at);

CREATE TABLE IF NOT EXISTS timer_segment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES timer_session(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL CHECK(kind IN ('work','pause')),
  started_at TEXT    NOT NULL,
  ended_at   TEXT,
  seconds    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_seg_session ON timer_segment(session_id);

CREATE TABLE IF NOT EXISTS remark (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES timer_session(id) ON DELETE CASCADE,
  ts         TEXT    NOT NULL DEFAULT (datetime('now','+8 hours')),
  content    TEXT    NOT NULL,
  author     TEXT
);
CREATE INDEX IF NOT EXISTS ix_remark_session ON remark(session_id);

-- CR-01（§11.2）：字典表（组织 / 供应商 / 发起人）
CREATE TABLE IF NOT EXISTS organization (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  code       TEXT,
  active     INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE IF NOT EXISTS supplier (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  code       TEXT,
  active     INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE IF NOT EXISTS initiator (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  department TEXT,
  active     INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);

-- 内部基础设施表（非冻结模型；承载 C6 幂等键）。可安全重建，不进导出/接口。
CREATE TABLE IF NOT EXISTS idempotency (
  key        TEXT PRIMARY KEY,
  response   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);

-- CR-03：后台账号（用户名 + 密码）。口令仅存 scrypt 派生值 + 随机盐（均 hex），明文永不落盘/入库/日志。
CREATE TABLE IF NOT EXISTS admin_user (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  pwd_hash   TEXT    NOT NULL,
  pwd_salt   TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  -- CR-10：后台角色（admin|engineer|fleet_admin）；存量账号默认 admin
  role       TEXT    NOT NULL DEFAULT 'admin',
  created_at TEXT    NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_admin_user_username ON admin_user(username);
`;

// CR-01（§11.2）：既有库的增量列（幂等迁移，ALTER 前先查 pragma table_info）
const ADD_COLUMNS = {
  operator: [
    ['employee_no', 'TEXT'],
    ['group_name', 'TEXT'],
    ['employed', 'INTEGER NOT NULL DEFAULT 1'],
    // CR-06：安全员 H5 登录账号（明文口令永不入库，仅存 scrypt 派生值 + 随机盐）
    ['username', 'TEXT'],
    ['pwd_hash', 'TEXT'],
    ['pwd_salt', 'TEXT'],
    ['must_change_pwd', 'INTEGER NOT NULL DEFAULT 0'],
    ['pwd_ver', 'INTEGER NOT NULL DEFAULT 0'],
  ],
  admin_user: [
    // CR-06：后台强制改密 + 口令版本（用于失效旧 token）
    ['must_change_pwd', 'INTEGER NOT NULL DEFAULT 0'],
    ['pwd_ver', 'INTEGER NOT NULL DEFAULT 0'],
    // CR-10：后台角色（幂等补列；DEFAULT 'admin' → 存量账号自动升级为管理员，不影响登录）
    ['role', "TEXT NOT NULL DEFAULT 'admin'"],
    // 2026-10-08 老板需求③④：账号所属组织/供应商（工程师↔组织，车队↔供应商；仅 admin 可改）
    ['org_id', 'INTEGER REFERENCES organization(id)'],
    ['supplier_id', 'INTEGER REFERENCES supplier(id)'],
  ],
  organization: [
    // 2026-10-08 老板：该组织可查看「全部组织」的工单/计时记录（如「长安科技项目」）
    ['see_all', 'INTEGER NOT NULL DEFAULT 0'],
  ],
  vehicle: [
    ['org_id', 'INTEGER REFERENCES organization(id)'],
    ['supplier_id', 'INTEGER REFERENCES supplier(id)'],
    ['default_initiator_id', 'INTEGER REFERENCES initiator(id)'],
  ],
  timer_session: [
    ['org_name', 'TEXT'],
    ['supplier_name', 'TEXT'],
    ['initiator_id', 'INTEGER REFERENCES initiator(id)'],
    ['initiator_name', 'TEXT'],
    // CR-08（老板需求③）：开始计时时快照「排班备注」，保证导出/历史稳定（不依赖 join 现状）
    ['schedule_note', 'TEXT'],
    // 2026-10-08 老板需求①：出车/收车里程（必填，H5 安全员流程）
    ['odometer_out', 'REAL'],
    ['odometer_in', 'REAL'],
    // 2026-10-14 老板：任务延时 —— 计划结束时间（审批通过后写入；NULL=按班次结束时间推导）
    ['plan_end_at', 'TEXT'],
  ],
};

function ensureColumns(db) {
  for (const [table, cols] of Object.entries(ADD_COLUMNS)) {
    const existing = new Set(db.pragma(`table_info(${table})`).map((c) => c.name));
    for (const [name, decl] of cols) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
    }
  }
}

export function migrate(db) {
  db.exec(DDL);
  ensureColumns(db);
  // CR-06：安全员账号名唯一（部分索引：仅非空 username 参与唯一性，可空允许多行）
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_operator_username ON operator(username) WHERE username IS NOT NULL AND username <> ''"
  );
  ensureScheduleSchema(db); // CR-07：shift/schedule + 默认白/夜班（幂等）
  ensureLoginLogSchema(db); // CR-11：login_log（幂等建表/索引）
  ensureApprovalSchema(db); // 2026-10-08 需求②：审批中心（幂等建表 + 默认流程）
}

/**
 * CR-03 启动引导（幂等）：仅当 admin_user 为空且提供了 password 时建初始管理员。
 * 口令只来自环境变量/调用方，**绝不打印、绝不落盘**。无 password 则跳过（保留 ADMIN_PASSWORD 兜底通道）。
 * @returns {boolean} 是否新建了初始管理员
 */
export function ensureInitialAdmin(db, { username = 'admin', password } = {}) {
  if (!password) return false;
  const n = db.prepare('SELECT COUNT(*) AS n FROM admin_user').get().n;
  if (n > 0) return false;
  const u = String(username || 'admin').trim() || 'admin';
  const { hash, salt } = hashPassword(String(password));
  db.prepare('INSERT INTO admin_user(username,name,pwd_hash,pwd_salt,active) VALUES(?,?,?,?,1)').run(u, u, hash, salt);
  return true;
}

/** 打开数据库（默认内存库，便于测试）。file 传路径则为文件库（WAL）。 */
export function openDb(file = ':memory:') {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
  } catch {
    /* :memory: 不支持 WAL，忽略 */
  }
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
