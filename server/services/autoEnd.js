// CR-13：工单自动结束（幂等清扫）—— 依「班次结束时间」口径（主人令 2026-10-06 15:52）
// 规则：过班次结束时间仍未点结束 → 自动结束。
//   · running → 结束时间 = 班次结束时间
//   · paused  → 结束时间 = 最后一次暂停时间（开放暂停段的起点）
// 班次归属：按 (operator_id, vehicle_id, substr(start_at,1,10)) 命中的 planned 排班取其 shift 的 end_time。
//   · 跨零点：shift.end_time='24:00' 视为「work_date 次日 00:00:00」（夜班归属开始日）。
//   · 无排班/班次不可解析 → 默认跳过（不误结束）；可选硬顶 AUTO_END_MAX_HOURS>0 时按总时长兜底。
import { nowDate, fmtDateTime, parseTs, diffSeconds } from '../lib/time.js';

const ACTIVE = "status IN ('running','paused')";

/** 取会话当前开放段（ended_at IS NULL，取最新一条） */
export function findOpenSegment(db, sid) {
  return db
    .prepare('SELECT * FROM timer_segment WHERE session_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(sid);
}

/** 'HH:MM'(start) + 'HH:MM'(end) + 归属日 → 绝对时间戳字符串。
 *  · end='24:00' → 次日 00:00:00；
 *  · end ≤ start（如夜班 20:00–08:00）→ 次日 end；
 *  · 其余 → 当日 end。非法返回 null。 */
function composeShiftEnd(workDate, startTime, endTime) {
  const em = /^(\d{2}):(\d{2})$/.exec(String(endTime || '').trim());
  if (!em || !workDate) return null;
  const H = Number(em[1]);
  const Mi = Number(em[2]);
  const sm = /^(\d{2}):(\d{2})$/.exec(String(startTime || '').trim());
  const startHM = sm ? Number(sm[1]) * 60 + Number(sm[2]) : null;
  const endHM = H * 60 + Mi;
  const base = parseTs(`${workDate} 00:00:00`);
  if (base === null || Number.isNaN(base)) return null;
  if (endHM === 24 * 60) return fmtDateTime(new Date(base + 24 * 3600 * 1000));
  if (H > 23 || Mi > 59 || endHM < 0) return null;
  const crossDay = startHM !== null && endHM <= startHM;
  const ms = base + (crossDay ? 24 : 0) * 3600 * 1000 + endHM * 60 * 1000;
  return fmtDateTime(new Date(ms));
}

/**
 * 解析会话所属班次的结束时间（绝对 'YYYY-MM-DD HH:mm:ss'）；不可解析 → null。
 * 依据该（人,车,归当日）的 planned 排班（shift_id 非空）取 shift.end_time；多条取 id 最小。
 */
export function resolveShiftEnd(db, s) {
  const day = String(s.start_at || '').slice(0, 10);
  if (!day) return null;
  const row = db
    .prepare(
      `SELECT sh.start_time AS start_time, sh.end_time AS end_time
         FROM schedule sc JOIN shift sh ON sh.id = sc.shift_id
        WHERE sc.status='planned' AND sc.work_date=? AND sc.operator_id=? AND sc.vehicle_id=?
          AND sc.shift_id IS NOT NULL
        ORDER BY sc.id ASC LIMIT 1`
    )
    .get(day, Number(s.operator_id), Number(s.vehicle_id));
  if (!row || !row.end_time) return null;
  return composeShiftEnd(day, row.start_time, row.end_time);
}

/**
 * 清扫超时会话（幂等：已结束的不再命中）。
 * @param {object} db
 * @param {object} opts
 * @param {number} opts.bufferMin 班次结束后的缓冲（分钟；默认 30）
 * @param {number} opts.maxHours  总时长硬顶（小时；<=0 关闭；仅对「班次不可解析」的单兜底）
 * @param {Date}   opts.at        判定基准（默认 nowDate()）
 * @param {boolean} opts.dryRun   只判定不落库
 */
export function sweepTimeoutSessions(db, { bufferMin = 30, maxHours = 0, at = nowDate(), dryRun = false } = {}) {
  const nowMs = at.getTime();
  const rows = db.prepare(`SELECT * FROM timer_session WHERE ${ACTIVE}`).all();
  const candidates = [];
  const unresolved = [];

  for (const s of rows) {
    const shiftEnd = resolveShiftEnd(db, s);
    // 2026-10-14 老板：任务延时 —— 计划结束时间优先于班次结束时间
    const deadline = s.plan_end_at || shiftEnd;
    const isPlanEnd = !!s.plan_end_at;
    const label = isPlanEnd ? '任务结束' : '班次结束';
    let endStr = null;
    let reason = null;
    let hit = null;

    if (deadline) {
      const deadlineMs = parseTs(deadline);
      if (deadlineMs !== null && !Number.isNaN(deadlineMs) && nowMs > deadlineMs + bufferMin * 60 * 1000) {
        if (s.status === 'paused') {
          const openPause = findOpenSegment(db, s.id);
          endStr = openPause && openPause.kind === 'pause' ? openPause.started_at : deadline;
          hit = '末次暂停';
          reason = `${hit}（开放暂停段起点）于${label}(${deadline})后仍未结束`;
        } else {
          endStr = deadline;
          hit = label;
          reason = `${hit}（${deadline}）后仍未结束`;
        }
      }
    } else if (maxHours > 0) {
      const startMs = parseTs(s.start_at);
      if (startMs !== null && !Number.isNaN(startMs) && nowMs - startMs > maxHours * 3600 * 1000) {
        endStr = fmtDateTime(at);
        hit = '硬顶';
        reason = `班次不可解析，按总时长>${maxHours}h 兜底`;
      }
    }

    if (endStr) {
      candidates.push({
        id: s.id,
        workOrderNo: s.work_order_no,
        operatorName: s.operator_name,
        status: s.status,
        oldEndAt: s.end_at || null,
        shiftEnd: deadline || null,
        endAt: endStr,
        hit,
        reason,
      });
    } else if (!shiftEnd) {
      unresolved.push({ id: s.id, workOrderNo: s.work_order_no, reason: '班次不可解析（无 planned 排班/无班次）' });
    }
  }

  if (dryRun || candidates.length === 0) {
    return { bufferMin, maxHours, scanned: rows.length, ended: [], candidates, unresolved };
  }

  const apply = db.transaction((list) => {
    const out = [];
    for (const c of list) {
      const seg = findOpenSegment(db, c.id);
      if (!seg) continue; // 幂等
      const endMs = parseTs(c.endAt);
      const secs = Math.max(0, Math.floor((endMs - parseTs(seg.started_at)) / 1000));
      db.prepare('UPDATE timer_segment SET ended_at=?, seconds=? WHERE id=?').run(c.endAt, secs, seg.id);
      const agg = db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN kind='work'  THEN seconds ELSE 0 END),0) AS net,
             COALESCE(SUM(CASE WHEN kind='pause' THEN seconds ELSE 0 END),0) AS pause
           FROM timer_segment WHERE session_id=?`
        )
        .get(c.id);
      db.prepare("UPDATE timer_session SET status='stopped', end_at=?, net_seconds=?, pause_seconds=? WHERE id=?").run(
        c.endAt,
        agg.net,
        agg.pause,
        c.id
      );
      db.prepare('INSERT INTO remark(session_id,ts,content,author) VALUES(?,?,?,?)').run(
        c.id,
        c.endAt,
        `系统自动结束（${c.reason}）`,
        '系统'
      );
      out.push({ ...c, net: agg.net, pause: agg.pause });
    }
    return out;
  });

  const ended = apply.immediate(candidates);
  return { bufferMin, maxHours, scanned: rows.length, ended, candidates, unresolved };
}

/**
 * 解析自动结束模式（CEO/main 双口径兼容）。优先级：
 *  1) AUTO_END_MODE=live|observe（显式最高）
 *  2) AUTO_END_DRYRUN：1→observe（只记日志不写库）、0→live（真写）
 *  3) 均未设 → observe（安全默认，CEO 裁定）
 * @returns {{mode:'live'|'observe', source:string}}
 */
export function resolveAutoEndMode(env = process.env) {
  const mode = String(env.AUTO_END_MODE ?? '').toLowerCase();
  if (mode === 'live' || mode === 'observe') return { mode, source: 'AUTO_END_MODE' };
  const dr = env.AUTO_END_DRYRUN;
  if (dr !== undefined && dr !== null && String(dr) !== '') {
    return { mode: Number(dr) === 0 ? 'live' : 'observe', source: 'AUTO_END_DRYRUN' };
  }
  return { mode: 'observe', source: 'default' };
}

/**
 * 启动周期清扫（默认每 2min）。启动即先跑一次。返回 stop()。
 * @param {'live'|'observe'} opts.mode live=写库；observe=只扫描+打「将结束」日志，**零写入**（首日安全默认）。
 */
export function startAutoEndSweeper(db, { bufferMin = 30, maxHours = 0, intervalMs = 120000, mode = 'observe', at = undefined, logger = console } = {}) {
  const live = mode === 'live';
  const run = () => {
    try {
      const r = sweepTimeoutSessions(db, { bufferMin, maxHours, dryRun: !live, at: at || nowDate() });
      if (!live) {
        if (r.candidates.length) {
          logger.warn(
            `[auto-end][dryrun] 将结束 ${r.candidates.length} 单（未写库）：` +
              r.candidates
                .map((x) => `#${x.id} ${x.workOrderNo} ${x.status} old=${x.oldEndAt || '-'}→new=${x.endAt} 原因=${x.hit}`)
                .join('；')
          );
        } else {
          logger.log('[auto-end][dryrun] 本轮无将结束单（未写库）');
        }
      } else if (r.ended.length) {
        logger.log(
          `[auto-end] 自动结束 ${r.ended.length} 单：${r.ended
            .map((x) => `#${x.id} ${x.workOrderNo} old=${x.oldEndAt || '-'}→new=${x.endAt} 原因=${x.hit}`)
            .join('；')}`
        );
      }
      if (r.unresolved.length) {
        logger.warn(
          `[auto-end] ${r.unresolved.length} 单班次不可解析（已跳过）：${r.unresolved.map((x) => x.workOrderNo).join(',')}`
        );
      }
    } catch (e) {
      logger.error(`[auto-end] 清扫失败：${e && e.message ? e.message : e}`);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}
