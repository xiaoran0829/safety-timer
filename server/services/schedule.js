// CR-07 排班域：排班 DTO / 列表 / 建派 / 批量 / 复制 / 导入 / 看板 / 越权留痕。
// 权威源：排班落库、冲突判定、done 推导一律后端裁决。
// 口径：允许多车（一人同日可多班/多车）；唯一约束=「同日期同班次一车一派」（DB 兜底，见 migrations/schedule.js）。
import { ERR } from '../lib/errors.js';
import { fmtDay } from '../lib/time.js';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 起点校验（口径 B）开关：默认关，避免与 CR-06 撞车；主人/tech 打开后生效。 */
export function scheduleEnforceEnabled() {
  return process.env.SCHEDULE_ENFORCE === '1';
}

const toInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const normDate = (v) => (DATE_RE.test(String(v || '').trim()) ? String(v).trim() : null);

function requireDate(v, field = 'workDate') {
  const d = normDate(v);
  if (!d) throw ERR.VALIDATION(`${field} 必填且格式 YYYY-MM-DD`);
  return d;
}

const SCHEDULE_SELECT = `
  SELECT s.*,
         o.name AS operator_name,
         v.vin  AS vin,
         sh.name AS shift_name, sh.start_time AS shift_start, sh.end_time AS shift_end
  FROM schedule s
  LEFT JOIN operator o ON o.id = s.operator_id
  LEFT JOIN vehicle v  ON v.id = s.vehicle_id
  LEFT JOIN shift sh   ON sh.id = s.shift_id
`;

/** 该排班是否已有对应计时记录（done 由 timer_session 推导，不落库） */
function sessionStats(db, operatorId, vehicleId, workDate) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(status IN ('running','paused')),0) AS active_n,
              COALESCE(SUM(status='stopped'),0)             AS stopped_n
       FROM timer_session
       WHERE operator_id=? AND vehicle_id=? AND substr(start_at,1,10)=?`
    )
    .get(Number(operatorId), Number(vehicleId), workDate);
}

export function scheduleDto(db, row) {
  if (!row) return null;
  const st = sessionStats(db, row.operator_id, row.vehicle_id, row.work_date);
  return {
    id: row.id,
    workDate: row.work_date,
    shiftId: row.shift_id ?? null,
    shiftName: row.shift_name ?? null,
    shiftStart: row.shift_start ?? null,
    shiftEnd: row.shift_end ?? null,
    operatorId: row.operator_id,
    operatorName: row.operator_name ?? null,
    vehicleId: row.vehicle_id,
    vin: row.vin ?? null,
    status: row.status,
    note: row.note ?? null,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
    done: (st.n || 0) > 0, // 当日该人+车是否存在计时记录
    sessionCount: st.n || 0,
    activeSessions: st.active_n || 0,
    stoppedSessions: st.stopped_n || 0,
  };
}

/** 列表（admin）：date / from-to / operatorId / vehicleId / shiftId / status */
export function listSchedules(db, { date, from, to, operatorId, vehicleId, shiftId, status } = {}) {
  const where = [];
  const args = [];
  if (date) {
    where.push('s.work_date = ?');
    args.push(String(date).trim());
  }
  if (from) {
    where.push('s.work_date >= ?');
    args.push(String(from).trim());
  }
  if (to) {
    where.push('s.work_date <= ?');
    args.push(String(to).trim());
  }
  if (operatorId) {
    where.push('s.operator_id = ?');
    args.push(Number(operatorId));
  }
  if (vehicleId) {
    where.push('s.vehicle_id = ?');
    args.push(Number(vehicleId));
  }
  if (shiftId !== undefined && shiftId !== null && shiftId !== '') {
    where.push('s.shift_id = ?');
    args.push(Number(shiftId));
  }
  if (status) {
    where.push('s.status = ?');
    args.push(String(status).trim());
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`${SCHEDULE_SELECT} ${w} ORDER BY s.work_date DESC, s.shift_id ASC, s.vehicle_id ASC, s.id ASC`)
    .all(...args);
  return rows.map((r) => scheduleDto(db, r));
}

function assertRefs(db, operatorId, vehicleId, shiftId) {
  const op = db.prepare('SELECT id,name,active FROM operator WHERE id=?').get(operatorId);
  if (!op) throw ERR.VALIDATION('operatorId 引用的安全员不存在');
  const veh = db.prepare('SELECT id,vin,active FROM vehicle WHERE id=?').get(vehicleId);
  if (!veh) throw ERR.VALIDATION('vehicleId 引用的车架号不存在');
  if (shiftId) {
    const sh = db.prepare('SELECT id FROM shift WHERE id=?').get(shiftId);
    if (!sh) throw ERR.VALIDATION('shiftId 引用的班次不存在');
  }
  return { op, veh };
}

/** 单条指派。冲突（同日期同班次一车两派）→ 409 CONFLICT。返回 DTO。 */
export function createSchedule(db, body = {}, by = null) {
  const workDate = requireDate(body.workDate, 'workDate');
  const operatorId = toInt(body.operatorId);
  const vehicleId = toInt(body.vehicleId);
  if (!operatorId) throw ERR.VALIDATION('operatorId 必填且为整数');
  if (!vehicleId) throw ERR.VALIDATION('vehicleId 必填且为整数');
  const shiftId = toInt(body.shiftId); // 可空
  const note = body.note === undefined || body.note === null ? null : String(body.note).trim() || null;
  assertRefs(db, operatorId, vehicleId, shiftId);

  try {
    const info = db
      .prepare(
        `INSERT INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,note,created_by)
         VALUES(?,?,?,?,'planned',?,?)`
      )
      .run(workDate, shiftId, operatorId, vehicleId, note, by);
    const row = db.prepare(`${SCHEDULE_SELECT} WHERE s.id=?`).get(Number(info.lastInsertRowid));
    return scheduleDto(db, row);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(e.message)) {
      throw ERR.CONFLICT('该车在当日该班次已排班（一人可多车，但同日期同班次内一车只能派一人）');
    }
    throw e;
  }
}

/** 批量指派：mode='cross'（笛卡尔积）| 'pair'（一一配对，按索引 zip）。逐行容错，返回明细。 */
export function batchAssign(db, body = {}, by = null) {
  const workDate = requireDate(body.workDate, 'workDate');
  const shiftId = toInt(body.shiftId);
  const mode = body.mode === 'pair' ? 'pair' : 'cross';
  const operatorIds = Array.isArray(body.operatorIds) ? body.operatorIds.map(toInt).filter(Boolean) : [];
  const vehicleIds = Array.isArray(body.vehicleIds) ? body.vehicleIds.map(toInt).filter(Boolean) : [];
  if (!operatorIds.length || !vehicleIds.length) throw ERR.VALIDATION('operatorIds / vehicleIds 均不能为空');

  const pairs = [];
  if (mode === 'pair') {
    const n = Math.min(operatorIds.length, vehicleIds.length);
    for (let i = 0; i < n; i++) pairs.push([operatorIds[i], vehicleIds[i]]);
  } else {
    for (const o of operatorIds) for (const v of vehicleIds) pairs.push([o, v]);
  }

  const ins = db.prepare(
    `INSERT OR IGNORE INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,note,created_by)
     VALUES(?,?,?,?,'planned',NULL,?)`
  );
  const result = { workDate, shiftId, mode, inserted: 0, skipped: 0, conflicts: [] };
  const tx = db.transaction(() => {
    for (const [o, v] of pairs) {
      try {
        assertRefs(db, o, v, shiftId);
        const info = ins.run(workDate, shiftId, o, v, by);
        if (info.changes) result.inserted++;
        else {
          result.skipped++;
          result.conflicts.push({ operatorId: o, vehicleId: v, reason: '该车在当日该班次已排班' });
        }
      } catch (e) {
        result.skipped++;
        result.conflicts.push({ operatorId: o, vehicleId: v, reason: e.message });
      }
    }
  });
  tx();
  return result;
}

/** 复制：把 fromDate 的 planned 排班复制到 toDate（可选仅某班次）；重复跳过（幂等）。 */
export function copySchedules(db, body = {}, by = null) {
  const fromDate = requireDate(body.fromDate, 'fromDate');
  const toDate = requireDate(body.toDate, 'toDate');
  const shiftId = toInt(body.shiftId);
  if (fromDate === toDate) throw ERR.VALIDATION('fromDate 与 toDate 不能相同');

  const where = ["status='planned'", 'work_date=?'];
  const args = [fromDate];
  if (shiftId) {
    where.push('shift_id=?');
    args.push(shiftId);
  }
  const src = db.prepare(`SELECT * FROM schedule WHERE ${where.join(' AND ')}`).all(...args);
  const ins = db.prepare(
    `INSERT OR IGNORE INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,note,created_by)
     VALUES(?,?,?,?,'planned',?,?)`
  );
  const result = { fromDate, toDate, shiftId, sourceCount: src.length, inserted: 0, skipped: 0, conflicts: [] };
  const tx = db.transaction(() => {
    for (const r of src) {
      const info = ins.run(toDate, r.shift_id, r.operator_id, r.vehicle_id, r.note, by);
      if (info.changes) result.inserted++;
      else {
        result.skipped++;
        result.conflicts.push({ operatorId: r.operator_id, vehicleId: r.vehicle_id, reason: '目标日该班次已排班' });
      }
    }
  });
  tx();
  return result;
}

/** 改派：换人 / 换车 / 换班次 / 备注（仅 planned）。冲突 → 409。 */
export function updateSchedule(db, id, body = {}, by = null) {
  const cur = db.prepare('SELECT * FROM schedule WHERE id=?').get(Number(id));
  if (!cur) throw ERR.NOT_FOUND('排班不存在');
  if (cur.status !== 'planned') throw ERR.INVALID_STATE('已取消的排班不可改派');

  const workDate = body.workDate !== undefined ? requireDate(body.workDate, 'workDate') : cur.work_date;
  const operatorId = body.operatorId !== undefined ? toInt(body.operatorId) : cur.operator_id;
  const vehicleId = body.vehicleId !== undefined ? toInt(body.vehicleId) : cur.vehicle_id;
  const shiftId = body.shiftId !== undefined ? toInt(body.shiftId) : cur.shift_id;
  if (!operatorId) throw ERR.VALIDATION('operatorId 非法');
  if (!vehicleId) throw ERR.VALIDATION('vehicleId 非法');
  const note = body.note !== undefined ? (body.note === null ? null : String(body.note).trim() || null) : cur.note;
  assertRefs(db, operatorId, vehicleId, shiftId);

  try {
    db.prepare(
      `UPDATE schedule SET work_date=?, shift_id=?, operator_id=?, vehicle_id=?, note=?, updated_at=datetime('now','+8 hours'), updated_by=?
       WHERE id=?`
    ).run(workDate, shiftId, operatorId, vehicleId, note, by, Number(id));
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(e.message)) {
      throw ERR.CONFLICT('该车在当日该班次已排班');
    }
    throw e;
  }
  return scheduleDto(db, db.prepare(`${SCHEDULE_SELECT} WHERE s.id=?`).get(Number(id)));
}

/** 取消（软删）：status='cancelled'。 */
export function cancelSchedule(db, id, by = null) {
  const cur = db.prepare('SELECT * FROM schedule WHERE id=?').get(Number(id));
  if (!cur) throw ERR.NOT_FOUND('排班不存在');
  if (cur.status === 'cancelled') return scheduleDto(db, db.prepare(`${SCHEDULE_SELECT} WHERE s.id=?`).get(Number(id)));
  // 注：改派/取消**不再写 created_by** —— 它是「发起人」（CR-08 批2 #4：安全员界面 initiator_name 同源快照），
  // 必须保持为首位下发人；旧写法 created_by=COALESCE(?,created_by) 在 by 非空时等于**覆盖**，会把发起人污染成最后操作人。
  db.prepare(`UPDATE schedule SET status='cancelled', updated_at=datetime('now','+8 hours'), updated_by=? WHERE id=?`).run(by, Number(id));
  return scheduleDto(db, db.prepare(`${SCHEDULE_SELECT} WHERE s.id=?`).get(Number(id)));
}

const isHeaderRow = (row) =>
  ['日期', 'date', 'work_date', 'workdate'].includes(String((row || [])[0] || '').trim().toLowerCase());

/**
 * CSV 导入：列 = 日期,班次,安全员,车架号（0..3，支持表头）。
 * 幂等：重复行跳过（INSERT OR IGNORE）；无法解析的行计入 errors。
 * @param {string[][]} rows parseCsv 结果
 */
export function importSchedules(db, rows, by = null) {
  const result = { inserted: 0, skipped: 0, errors: [] };
  const ins = db.prepare(
    `INSERT OR IGNORE INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,note,created_by)
     VALUES(?,?,?,?,'planned',NULL,?)`
  );
  const findOp = db.prepare('SELECT id FROM operator WHERE name=? ORDER BY active DESC, id ASC LIMIT 1');
  const findVeh = db.prepare('SELECT id FROM vehicle WHERE vin=? LIMIT 1');
  const findShift = db.prepare('SELECT id FROM shift WHERE name=? LIMIT 1');

  const tx = db.transaction(() => {
    rows.forEach((row, i) => {
      if (i === 0 && isHeaderRow(row)) return;
      const workDate = normDate(row[0]);
      const shiftName = String(row[1] || '').trim();
      const opName = String(row[2] || '').trim();
      const vin = String(row[3] || '').trim();
      if (!workDate || !opName || !vin) {
        result.skipped++;
        result.errors.push({ line: i + 1, reason: '日期/安全员/车架号 不能为空' });
        return;
      }
      const op = findOp.get(opName);
      if (!op) {
        result.skipped++;
        result.errors.push({ line: i + 1, reason: `安全员不存在：${opName}` });
        return;
      }
      const veh = findVeh.get(vin);
      if (!veh) {
        result.skipped++;
        result.errors.push({ line: i + 1, reason: `车架号不存在：${vin}` });
        return;
      }
      let shiftId = null;
      if (shiftName) {
        const sh = findShift.get(shiftName);
        if (!sh) {
          result.skipped++;
          result.errors.push({ line: i + 1, reason: `班次不存在：${shiftName}` });
          return;
        }
        shiftId = sh.id;
      }
      const info = ins.run(workDate, shiftId, op.id, veh.id, by);
      if (info.changes) result.inserted++;
      else {
        result.skipped++;
        result.errors.push({ line: i + 1, reason: '重复（当日该班次已排此车）' });
      }
    });
  });
  tx();
  return result;
}

/** 当日看板：已排 / 已开始 / 已完成 / 未完成（done 由计时记录推导） + 未排班车列表。 */
export function scheduleBoard(db, date) {
  const day = normDate(date) || fmtDay();
  const rows = db.prepare(`${SCHEDULE_SELECT} WHERE s.work_date=? AND s.status='planned'`).all(day);
  let planned = 0;
  let started = 0;
  let done = 0;
  let unfinished = 0;
  for (const r of rows) {
    planned++;
    const st = sessionStats(db, r.operator_id, r.vehicle_id, day);
    if ((st.n || 0) > 0) started++;
    if ((st.stopped_n || 0) > 0) done++;
    if ((st.n || 0) === 0) unfinished++;
  }
  const unscheduled = db
    .prepare(
      `SELECT v.id, v.vin, v.station FROM vehicle v
       WHERE v.active=1
         AND NOT EXISTS (SELECT 1 FROM schedule s WHERE s.vehicle_id=v.id AND s.work_date=? AND s.status='planned')
       ORDER BY v.sort ASC, v.id ASC`
    )
    .all(day)
    .map((v) => ({ id: v.id, vin: v.vin, station: v.station ?? null }));
  return { date: day, planned, started, done, unfinished, unscheduledVehicles: unscheduled };
}

/* ---------------- 起点校验（口径 B）/ 越权留痕 ---------------- */

/** 该（人,车,日）是否已有 planned 排班 */
export function isScheduled(db, { operatorId, vehicleId, date }) {
  const day = normDate(date);
  if (!day) return false;
  return !!db
    .prepare("SELECT 1 FROM schedule WHERE status='planned' AND work_date=? AND operator_id=? AND vehicle_id=?")
    .get(day, Number(operatorId), Number(vehicleId));
}

/**
 * CR-08（需求③/④）：取该（人,车,日）的首条 planned 排班（含 note / created_by / 班次），供计时快照。无则 null。
 * 口径：一人同日可有多个班次/多车；此处取 id 最小的一条作为快照源（唯一约束已保证同班次内一车一派）。
 */
export function findSchedule(db, { operatorId, vehicleId, date }) {
  const day = normDate(date);
  if (!day) return null;
  return (
    db
      .prepare(
        `${SCHEDULE_SELECT}
         WHERE s.status='planned' AND s.work_date=? AND s.operator_id=? AND s.vehicle_id=?
         ORDER BY s.id ASC LIMIT 1`
      )
      .get(day, Number(operatorId), Number(vehicleId)) || null
  );
}

/** 非排班车经确认放行后留痕（审计） */
export function recordUnscheduledOverride(db, { operatorId, vehicleId, date, sessionId, vin, by }) {
  const day = normDate(date) || fmtDay();
  db.prepare(
    `INSERT INTO schedule_override(work_date,operator_id,vehicle_id,session_id,vin,by_who)
     VALUES(?,?,?,?,?,?)`
  ).run(day, Number(operatorId), Number(vehicleId), sessionId ?? null, vin ?? null, by ?? null);
}

/** H5 口径 B：某人某日的排班车辆（含班次时间窗 + 占用态） */
export function myScheduledVehicles(db, { operatorId, date }) {
  const day = normDate(date) || fmtDay();
  const rows = db
    .prepare(
      `${SCHEDULE_SELECT}
       WHERE s.status='planned' AND s.work_date=? AND s.operator_id=?
       ORDER BY s.shift_id ASC, s.id ASC`
    )
    .all(day, Number(operatorId));
  const occ = db.prepare(
    "SELECT id, operator_name FROM timer_session WHERE vehicle_id=? AND status IN ('running','paused') ORDER BY id DESC LIMIT 1"
  );
  return rows.map((r) => {
    const o = occ.get(r.vehicle_id);
    const st = sessionStats(db, r.operator_id, r.vehicle_id, day);
    return {
      scheduleId: r.id,
      vehicleId: r.vehicle_id,
      vin: r.vin,
      shiftId: r.shift_id ?? null,
      shiftName: r.shift_name ?? null,
      shiftStart: r.shift_start ?? null,
      shiftEnd: r.shift_end ?? null,
      occupied: o ? { sessionId: o.id, operatorName: o.operator_name } : null,
      done: (st.stopped_n || 0) > 0,
      started: (st.n || 0) > 0,
    };
  });
}

/** H5：某人某区间排班日历 */
export function mySchedule(db, { operatorId, from, to }) {
  const where = ["s.status='planned'", 's.operator_id=?'];
  const args = [Number(operatorId)];
  if (from) {
    where.push('s.work_date >= ?');
    args.push(String(from).trim());
  }
  if (to) {
    where.push('s.work_date <= ?');
    args.push(String(to).trim());
  }
  return db
    .prepare(`${SCHEDULE_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.work_date ASC, s.shift_id ASC`)
    .all(...args)
    .map((r) => scheduleDto(db, r));
}
