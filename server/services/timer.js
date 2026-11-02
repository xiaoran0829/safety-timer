// 计时核心：状态机 + 时长口径 + 互斥（冻结规格 §3 / §4）
// 权威源：时长、工单号、互斥判定一律后端裁决。
import { ApiError, ERR } from '../lib/errors.js';
import { nowDate, fmtDateTime, fmtDay, diffSeconds, parseTs } from '../lib/time.js';
import { nextWorkOrderNo } from './woSeq.js';
import { isScheduled, findSchedule, scheduleEnforceEnabled } from './schedule.js';

const ACTIVE = "status IN ('running','paused')";

// 2026-10-08 需求①：里程解析（required=true 时缺失即报错）
function parseOdometer(v, required) {
  if (v === undefined || v === null || v === '') {
    if (required) throw ERR.ODOMETER_REQUIRED();
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 3000000) {
    throw ERR.ODOMETER_INVALID('里程数需为 0 ~ 3000000 之间的数字');
  }
  return n;
}

/* ---------------- 视图/DTO ---------------- */

function liveDurations(db, row) {
  const segs = db
    .prepare('SELECT kind, started_at, ended_at, seconds FROM timer_segment WHERE session_id=? ORDER BY id')
    .all(row.id);
  let work = 0;
  let pause = 0;
  for (const s of segs) {
    if (s.ended_at) {
      if (s.kind === 'work') work += s.seconds;
      else pause += s.seconds;
    } else if (s.kind === 'work') {
      work += diffSeconds(s.started_at);
    } else {
      pause += diffSeconds(s.started_at);
    }
  }
  return { netSeconds: work, pauseSeconds: pause };
}

/** DB 行 → API 会话 DTO（字段与冻结规格 §5.3 对齐；进行中时长实时计算） */
export function toSessionDto(db, row) {
  if (!row) return null;
  const live = row.status === 'stopped'
    ? { netSeconds: row.net_seconds, pauseSeconds: row.pause_seconds }
    : liveDurations(db, row);
  return {
    id: row.id,
    workOrderNo: row.work_order_no,
    operatorId: row.operator_id,
    vehicleId: row.vehicle_id,
    operatorName: row.operator_name,
    vin: row.vin,
    status: row.status,
    startAt: row.start_at,
    endAt: row.end_at,
    netSeconds: live.netSeconds,
    pauseSeconds: live.pauseSeconds,
    orgName: row.org_name ?? null,
    supplierName: row.supplier_name ?? null,
    initiatorId: row.initiator_id ?? null,
    initiatorName: row.initiator_name ?? null,
    // CR-08（需求③）：排班备注快照（开始计时那一刻的排班备注）
    scheduleNote: row.schedule_note ?? null,
    // 2026-10-08 需求①：出车/收车里程
    odometerOut: row.odometer_out ?? null,
    odometerIn: row.odometer_in ?? null,
    // 2026-10-14 老板：任务延时 —— 计划结束时间（审批通过后写入；NULL=按班次结束时间推导）
    planEndAt: row.plan_end_at ?? null,
    createdAt: row.created_at,
  };
}

export function getSessionRow(db, id) {
  return db.prepare('SELECT * FROM timer_session WHERE id=?').get(Number(id));
}

export function findActiveByOperator(db, operatorId) {
  return db
    .prepare(`SELECT * FROM timer_session WHERE operator_id=? AND ${ACTIVE} ORDER BY id DESC LIMIT 1`)
    .get(Number(operatorId));
}

export function findActiveByVehicle(db, vehicleId) {
  return db
    .prepare(`SELECT * FROM timer_session WHERE vehicle_id=? AND ${ACTIVE} ORDER BY id DESC LIMIT 1`)
    .get(Number(vehicleId));
}

function activeSessionBrief(row) {
  return row ? { id: row.id, vin: row.vin, workOrderNo: row.work_order_no } : null;
}

/* ---------------- start ---------------- */

/**
 * 开始计时（C1/C1'/C2/C3/C3'）。
 * 车架号被占用（C2/Q5）仅信息，不硬拦。
 *
 * CR-08 批2 口径：
 *   ④ 发起人 = 「下发排班任务的人」（schedule.created_by 快照）；无排班 → 留空（**不**回落登录本人/车辆默认发起人）。
 *   ② 班次时间窗：开始任务早于班次开始时间 → 拦（BEFORE_SHIFT_START）；迟到/早退 → 放行，工时按实际计时。
 *   ⑦ 当天锁定：同人+同车+同日 已有 stopped 会话 → 不可再次开始（DAY_CLOSED）。
 *   ⑤ 非排班车 → 硬拦（enforcement 开启时，不再提供 allowUnscheduled 放行口）。
 *   显式 initiatorId / initiatorName（后台/脚本/测试直调）优先级最高，保留兼容。
 */
export function startSession(db, { operatorId, vehicleId, initiatorId, initiatorName, by, odometerOut } = {}) {
  const oid = Number(operatorId);
  const vid = Number(vehicleId);
  if (!Number.isInteger(oid) || !Number.isInteger(vid) || oid <= 0 || vid <= 0) {
    throw ERR.VALIDATION('operatorId / vehicleId 必填且为整数');
  }
  const forcedInitiatorName = typeof initiatorName === 'string' ? initiatorName.trim() : '';

  const run = db.transaction(() => {
    const op = db.prepare('SELECT * FROM operator WHERE id=?').get(oid);
    if (!op) throw ERR.NOT_FOUND('安全员不存在');
    if (op.active !== 1) throw ERR.OPERATOR_INACTIVE();

    const veh = db.prepare('SELECT * FROM vehicle WHERE id=?').get(vid);
    if (!veh) throw ERR.NOT_FOUND('车架号不存在');
    if (veh.active !== 1) throw ERR.VEHICLE_INACTIVE();

    // 2026-10-08 需求①：出车里程（可选入参，H5 安全员由路由层强制必填）+ 与上次收车里程核对（偏差 >10km 拦）
    const odoOut = parseOdometer(odometerOut, false);
    if (odoOut != null) {
      const prev = db
        .prepare('SELECT odometer_in FROM timer_session WHERE vehicle_id=? AND odometer_in IS NOT NULL ORDER BY id DESC LIMIT 1')
        .get(vid);
      if (prev && prev.odometer_in != null) {
        const d = Math.abs(odoOut - Number(prev.odometer_in));
        if (d > 10) {
          throw ERR.ODOMETER_MISMATCH(
            `出车里程与上次收车里程不符（本次 ${odoOut} km，上次收车 ${Number(prev.odometer_in)} km，相差 ${d} km > 10km），请核对后重填`,
            { odometerOut: odoOut, lastOdometerIn: Number(prev.odometer_in), diff: d }
          );
        }
      }
    }

    const workDay = fmtDay();

    // C1 一人一车（事务内预检）
    const active = findActiveByOperator(db, oid);
    if (active) throw ERR.OPERATOR_BUSY('您已有进行中的计时', { activeSession: activeSessionBrief(active) });

    // CR-08 批2（需求⑦）：同人+同车+当天 已结束（stopped）→ 当天不可再次开始
    const stoppedToday = db
      .prepare(
        "SELECT 1 FROM timer_session WHERE operator_id=? AND vehicle_id=? AND status='stopped' AND substr(start_at,1,10)=? LIMIT 1"
      )
      .get(oid, vid, workDay);
    if (stoppedToday) throw ERR.DAY_CLOSED('该车今日任务已结束，不可再次开始', { workDate: workDay, vin: veh.vin });

    // CR-07 起点校验（需 SCHEDULE_ENFORCE=1 才生效，避免与 CR-06 撞车）。
    // CR-08 批2（需求⑤）：非排班车 → 硬拦（取消 allowUnscheduled 放行口/二次确认留痕）。
    const enforce = scheduleEnforceEnabled();
    const scheduled = !enforce || isScheduled(db, { operatorId: oid, vehicleId: vid, date: workDay });
    if (enforce && !scheduled) {
      throw ERR.NOT_SCHEDULED('该车未排给您', { workDate: workDay, vin: veh.vin });
    }

    // CR-01（§11.2）：快照 组织/供应商/发起人 当时值，保证导出/历史稳定
    // CR-08（需求③）：匹配排班并快照其备注（schedule_note），供导出第12列使用（与 enforcement 开关无关）
    // CR-08 批2（需求④）：匹配排班并快照「下发人」（created_by）作为发起人
    const sched = findSchedule(db, { operatorId: oid, vehicleId: vid, date: workDay });
    const scheduleNote = sched && typeof sched.note === 'string' && sched.note.trim() ? sched.note.trim() : null;

    // CR-08 批2（需求②）：班次时间窗——仅拦「早于班次开始」；迟到/早退放行，工时按实际计时。
    // 无排班 / 无班次 / 班次无开始时间 → 豁免。跨零点夜班：窗口起点 = 排班日 + 班次开始时间。
    if (sched && sched.shift_start) {
      const startMs = parseTs(`${workDay} ${String(sched.shift_start).slice(0, 5)}:00`);
      if (!Number.isNaN(startMs) && nowDate().getTime() < startMs) {
        throw ERR.BEFORE_SHIFT_START(`未到班次开始时间（${String(sched.shift_start).slice(0, 5)}），请稍后再开始`, {
          workDate: workDay,
          vin: veh.vin,
          shiftStart: sched.shift_start,
        });
      }
    }

    const org = veh.org_id ? db.prepare('SELECT name FROM organization WHERE id=?').get(veh.org_id) : null;
    const sup = veh.supplier_id ? db.prepare('SELECT name FROM supplier WHERE id=?').get(veh.supplier_id) : null;
    let iid = null;
    let snapshotInitiatorName = null;
    if (initiatorId !== undefined && initiatorId !== null && initiatorId !== '') {
      const n = Number(initiatorId);
      if (!Number.isInteger(n) || n <= 0) throw ERR.VALIDATION('initiatorId 非法');
      const init = db.prepare('SELECT * FROM initiator WHERE id=?').get(n);
      if (!init) throw ERR.VALIDATION('发起人不存在');
      iid = n;
      snapshotInitiatorName = init.name;
    } else if (forcedInitiatorName) {
      iid = null;
      snapshotInitiatorName = forcedInitiatorName;
    } else if (sched && typeof sched.created_by === 'string' && sched.created_by.trim()) {
      // 需求④：发起人 = 下发排班任务的人（排班 created_by）；无排班 → 留空（不回落本人）
      iid = null;
      snapshotInitiatorName = sched.created_by.trim();
    }
    const orgName = org ? org.name : null;
    const supplierName = sup ? sup.name : null;

    const now = fmtDateTime();
    const wono = nextWorkOrderNo(db);
    const info = db
      .prepare(
        `INSERT INTO timer_session
           (work_order_no,operator_id,vehicle_id,operator_name,vin,status,start_at,net_seconds,pause_seconds,created_at,
            org_name,supplier_name,initiator_id,initiator_name,schedule_note,odometer_out)
         VALUES(?,?,?,?,?, 'running', ?, 0, 0, ?, ?,?,?,?,?,?)`
      )
      .run(wono, oid, vid, op.name, veh.vin, now, now, orgName, supplierName, iid, snapshotInitiatorName, scheduleNote, odoOut);
    const sid = Number(info.lastInsertRowid);
    db.prepare(`INSERT INTO timer_segment(session_id,kind,started_at,ended_at,seconds) VALUES(?, 'work', ?, NULL, 0)`).run(sid, now);
    return sid;
  });

  try {
    const sid = run.immediate();
    return { session: toSessionDto(db, getSessionRow(db, sid)) };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (isActiveOperatorConflict(e)) {
      // C1' 并发兜底：唯一索引冲突 → 回滚 → 同 C1
      const active = findActiveByOperator(db, oid);
      throw ERR.OPERATOR_BUSY('您已有进行中的计时', { activeSession: activeSessionBrief(active) });
    }
    throw e;
  }
}

function isActiveOperatorConflict(e) {
  return (
    e &&
    typeof e.message === 'string' &&
    /ux_active_operator|UNIQUE constraint failed: timer_session\.operator_id/i.test(e.message)
  );
}

/* ---------------- pause / resume / stop ---------------- */

function loadOwned(db, id, operatorId, { admin = false } = {}) {
  const s = getSessionRow(db, id);
  if (!s) throw ERR.NOT_FOUND('会话不存在');
  if (!admin && Number(s.operator_id) !== Number(operatorId)) throw ERR.FORBIDDEN();
  return s;
}

// CR-09（需求⑫）：暂停以「点击时刻」为准。
// 前端点按瞬间取 at 随请求上报；接受条件：at ≥ 当前开段 started_at 且 ≤ 服务器 now；
// 缺失/非法/越界（未来或早于开段）→ 回退服务器 now。
function resolvePauseAt(db, sid, atRaw, nowStr) {
  const at = typeof atRaw === 'string' ? atRaw.trim() : '';
  if (!at) return nowStr;
  const atMs = parseTs(at);
  if (atMs === null || Number.isNaN(atMs)) return nowStr;
  const open = db
    .prepare('SELECT started_at FROM timer_segment WHERE session_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(sid);
  const lo = parseTs(open && open.started_at);
  const hi = parseTs(nowStr);
  if (lo === null || Number.isNaN(lo) || hi === null || Number.isNaN(hi)) return nowStr;
  if (atMs < lo || atMs > hi) return nowStr;
  return fmtDateTime(new Date(atMs));
}

function closeOpenSegment(db, sid, now) {  const open = db
    .prepare('SELECT * FROM timer_segment WHERE session_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(sid);
  if (open) {
    // 需求⑫：end 时刻可为「点击时刻 at」；seconds 须按该时刻算（非服务器实时 now）
    const endMs = parseTs(now);
    const secs =
      endMs === null || Number.isNaN(endMs)
        ? diffSeconds(open.started_at)
        : diffSeconds(open.started_at, new Date(endMs));
    db.prepare('UPDATE timer_segment SET ended_at=?, seconds=? WHERE id=?').run(now, secs, open.id);
  }
  return open;
}

export function pauseSession(db, id, operatorId, opts = {}) {
  // CR-09（需求⑩）：暂停必须带备注；空/缺 → REMARK_REQUIRED（400）
  const remark = typeof opts.remark === 'string' ? opts.remark.trim() : '';
  if (!remark) throw ERR.REMARK_REQUIRED();
  const run = db.transaction(() => {
    const s = loadOwned(db, id, operatorId, opts);
    if (s.status !== 'running') throw ERR.INVALID_STATE();
    const nowStr = fmtDateTime();
    const now = resolvePauseAt(db, s.id, opts.at, nowStr);
    closeOpenSegment(db, s.id, now);
    // 备注与暂停同事务写入；该备注即本次暂停段的备注（⑧时间轴归位）
    db.prepare('INSERT INTO remark(session_id,ts,content,author) VALUES(?,?,?,?)').run(
      s.id,
      now,
      remark,
      s.operator_name
    );
    db.prepare(`INSERT INTO timer_segment(session_id,kind,started_at,ended_at,seconds) VALUES(?, 'pause', ?, NULL, 0)`).run(s.id, now);
    db.prepare(`UPDATE timer_session SET status='paused' WHERE id=?`).run(s.id);
    return s.id;
  });
  const sid = run.immediate();
  return { session: toSessionDto(db, getSessionRow(db, sid)) };
}

export function resumeSession(db, id, operatorId, opts = {}) {
  const run = db.transaction(() => {
    const s = loadOwned(db, id, operatorId, opts);
    if (s.status !== 'paused') throw ERR.INVALID_STATE();
    const now = fmtDateTime();
    closeOpenSegment(db, s.id, now);
    db.prepare(`INSERT INTO timer_segment(session_id,kind,started_at,ended_at,seconds) VALUES(?, 'work', ?, NULL, 0)`).run(s.id, now);
    db.prepare(`UPDATE timer_session SET status='running' WHERE id=?`).run(s.id);
    return s.id;
  });
  const sid = run.immediate();
  return { session: toSessionDto(db, getSessionRow(db, sid)) };
}

export function stopSession(db, id, operatorId, opts = {}) {
  const run = db.transaction(() => {
    const s = loadOwned(db, id, operatorId, opts);
    if (s.status !== 'running' && s.status !== 'paused') throw ERR.INVALID_STATE();
    // 2026-10-08 需求①：收车里程（可选入参）+ 与出车里程核对（必需 ≥ 出车；0 或 >1000km 视为离谱）
    const odoIn = parseOdometer(opts.odometerIn, false);
    if (odoIn != null) {
      const odoOut = s.odometer_out == null ? null : Number(s.odometer_out);
      if (odoOut != null) {
        const delta = odoIn - odoOut;
        if (delta < 0) throw ERR.ODOMETER_INVALID(`收车里程（${odoIn} km）不能小于出车里程（${odoOut} km）`, { odometerIn: odoIn, odometerOut: odoOut });
        if (delta === 0) throw ERR.ODOMETER_INVALID('收车里程与出车里程相同（本次行驶 0 km），请核对后重填', { odometerIn: odoIn, odometerOut: odoOut });
        if (delta > 1000) throw ERR.ODOMETER_INVALID(`本次行驶里程 ${delta} km 超出合理范围（>1000km），请核对后重填`, { odometerIn: odoIn, odometerOut: odoOut });
      }
    }
    const now = fmtDateTime();
    closeOpenSegment(db, s.id, now);
    const agg = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN kind='work'  THEN seconds ELSE 0 END),0) AS net,
           COALESCE(SUM(CASE WHEN kind='pause' THEN seconds ELSE 0 END),0) AS pause
         FROM timer_segment WHERE session_id=?`
      )
      .get(s.id);
    db.prepare(`UPDATE timer_session SET status='stopped', end_at=?, net_seconds=?, pause_seconds=?, odometer_in=? WHERE id=?`).run(
      now,
      agg.net,
      agg.pause,
      odoIn,
      s.id
    );
    return s.id;
  });
  const sid = run.immediate();
  return { session: toSessionDto(db, getSessionRow(db, sid)) };
}

/**
 * 管理员强制结束（纠偏）：同一事务内闭合开放段 + 结算 + 置 stopped + 写备注。
 * 用于后台纠偏，替代直改库（CR-13）。
 */
export function forceStopSession(db, id, { remark = '', author = '管理员' } = {}) {
  const run = db.transaction(() => {
    const s = getSessionRow(db, id);
    if (!s) throw ERR.NOT_FOUND('会话不存在');
    if (s.status !== 'running' && s.status !== 'paused') throw ERR.INVALID_STATE('会话已结束，无需强制结束');
    const now = fmtDateTime();
    closeOpenSegment(db, s.id, now);
    const agg = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN kind='work'  THEN seconds ELSE 0 END),0) AS net,
           COALESCE(SUM(CASE WHEN kind='pause' THEN seconds ELSE 0 END),0) AS pause
         FROM timer_segment WHERE session_id=?`
      )
      .get(s.id);
    db.prepare(`UPDATE timer_session SET status='stopped', end_at=?, net_seconds=?, pause_seconds=? WHERE id=?`).run(
      now,
      agg.net,
      agg.pause,
      s.id
    );
    const text = (remark && String(remark).trim()) || `管理员强制结束（${author}）`;
    const info = db.prepare('INSERT INTO remark(session_id,ts,content,author) VALUES(?,?,?,?)').run(s.id, now, text, author);
    const row = db.prepare('SELECT * FROM remark WHERE id=?').get(Number(info.lastInsertRowid));
    return { sid: s.id, remark: toRemarkDto(row) };
  });
  const out = run.immediate();
  return { session: toSessionDto(db, getSessionRow(db, out.sid)), remark: out.remark };
}

/* ---------------- remark ---------------- */

export function addRemark(db, id, operatorId, content, { admin = false } = {}) {
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) throw ERR.VALIDATION('备注内容不能为空');
  const s = loadOwned(db, id, operatorId, { admin });
  if (s.status === 'stopped') throw ERR.INVALID_STATE('会话已结束，不能再加备注');
  const now = fmtDateTime();
  const info = db
    .prepare('INSERT INTO remark(session_id,ts,content,author) VALUES(?,?,?,?)')
    .run(s.id, now, text, s.operator_name);
  const row = db.prepare('SELECT * FROM remark WHERE id=?').get(Number(info.lastInsertRowid));
  return { remark: toRemarkDto(row) };
}

export function toRemarkDto(row) {
  if (!row) return null;
  return { id: row.id, sessionId: row.session_id, ts: row.ts, content: row.content, author: row.author };
}

/* ---------------- 查询 ---------------- */

export function getSessionDetail(db, id) {
  const s = getSessionRow(db, id);
  if (!s) throw ERR.NOT_FOUND('会话不存在');
  return {
    session: toSessionDto(db, s),
    segments: db.prepare('SELECT * FROM timer_segment WHERE session_id=? ORDER BY id').all(s.id).map(toSegmentDto),
    remarks: db.prepare('SELECT * FROM remark WHERE session_id=? ORDER BY id').all(s.id).map(toRemarkDto),
  };
}

export function toSegmentDto(row) {
  return { id: row.id, sessionId: row.session_id, kind: row.kind, startedAt: row.started_at, endedAt: row.ended_at, seconds: row.seconds };
}

export function getActiveDetail(db, operatorId) {
  const s = findActiveByOperator(db, operatorId);
  if (!s) return null;
  return getSessionDetail(db, s.id);
}

/** 记录查询（按试验开始时间归当日） */
export function listSessions(db, { date, from, to, operatorId, vin, scope, page = 1, pageSize = 50 } = {}) {
  const where = [];
  const args = [];
  if (date) {
    where.push("start_at >= ? AND start_at < ?");
    args.push(`${date} 00:00:00`, `${date} 23:59:59`);
  }
  if (from) {
    where.push('start_at >= ?');
    args.push(`${from} 00:00:00`);
  }
  if (to) {
    where.push('start_at <= ?');
    args.push(`${to} 23:59:59`);
  }
  if (operatorId) {
    where.push('operator_id = ?');
    args.push(Number(operatorId));
  }
  if (vin) {
    where.push('vin LIKE ?');
    args.push(`%${vin}%`);
  }
  // 2026-10-08 需求：按组织/供应商过滤工单（see_all 组织 → scope=all 不过滤）
  if (scope && scope.type !== 'all') {
    if (scope.id == null) {
      where.push('1=0');
    } else {
      const col = scope.type === 'org' ? 'org_id' : 'supplier_id';
      where.push(`EXISTS (SELECT 1 FROM vehicle v WHERE v.vin = timer_session.vin AND v.${col} = ?)`);
      args.push(Number(scope.id));
    }
  }
  const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(500, Math.max(1, Number(pageSize) || 50));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM timer_session ${wsql}`).get(...args).n;
  const rows = db
    .prepare(`SELECT * FROM timer_session ${wsql} ORDER BY start_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, ps, (p - 1) * ps);
  return { list: rows.map((r) => toSessionDto(db, r)), page: p, pageSize: ps, total };
}

/**
 * CR-08（需求⑥）：详细工时（含备注）列表——在 listSessions 之上合并
 * 「排班备注（快照）」与「计时备注（remark 表，多条拼接）」，供后台「详细工时」页/导出。
 */
export function listSessionDetails(db, filters = {}) {
  const page = listSessions(db, filters);
  const remStmt = db.prepare('SELECT ts, content, author FROM remark WHERE session_id=? ORDER BY id');
  const segStmt = db.prepare(
    'SELECT kind, started_at, ended_at, seconds FROM timer_segment WHERE session_id=? ORDER BY id'
  );
  const list = page.list.map((s) => {
    const remarks = remStmt.all(s.id);
    return {
      ...s,
      scheduleNote: s.scheduleNote ?? null,
      remarks,
      remarkText: remarks.map((r) => r.content).join(' / '),
      // CR-09（需求⑧）：时间轴——按段（work/pause）归位
      segments: segStmt.all(s.id).map((g) => ({
        kind: g.kind,
        startedAt: g.started_at,
        endedAt: g.ended_at,
        seconds: g.seconds,
      })),
    };
  });
  return { ...page, list };
}
