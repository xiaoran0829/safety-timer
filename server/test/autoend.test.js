import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../db.js';
import { startSession, pauseSession, getSessionRow, forceStopSession } from '../services/timer.js';
import { sweepTimeoutSessions, resolveShiftEnd, startAutoEndSweeper, resolveAutoEndMode } from '../services/autoEnd.js';

let db;
let opA;
let v1;
let shiftDan, shiftYe;

const D = (h, mi = 0, s = 0) => new Date(Date.UTC(2026, 9, 5, h, mi, s)); // 2026-10-05 墙上时间
const D6 = (h, mi = 0, s = 0) => new Date(Date.UTC(2026, 9, 6, h, mi, s));

function seed() {
  opA = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('张伟','安全员A',10)").run().lastInsertRowid);
  v1 = Number(db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES('LSVAB1234K5678901','工位A',1)").run().lastInsertRowid);
  shiftDan = db.prepare("SELECT id FROM shift WHERE name='白班'").get().id;
  shiftYe = db.prepare("SELECT id FROM shift WHERE name='夜班'").get().id;
}

function mkSession(status, startAt) {
  const sid = db
    .prepare(
      `INSERT INTO timer_session(work_order_no,operator_id,vehicle_id,operator_name,vin,status,start_at)
       VALUES(?,?,?,?,?,?,?)`
    )
    .run(`WO-20991005-${String(Math.floor(Math.random() * 900) + 100)}`, opA, v1, '张伟', 'LSVAB1234K5678901', status, startAt)
    .lastInsertRowid;
  return Number(sid);
}
function openSeg(sid, kind, startedAt, endedAt = null, seconds = 0) {
  db.prepare('INSERT INTO timer_segment(session_id,kind,started_at,ended_at,seconds) VALUES(?,?,?,?,?)').run(
    sid,
    kind,
    startedAt,
    endedAt,
    seconds
  );
}
function mkSchedule(workDate, shiftId) {
  db.prepare(
    "INSERT INTO schedule(work_date,shift_id,operator_id,vehicle_id,status) VALUES(?,?,?,?,'planned')"
  ).run(workDate, shiftId, opA, v1);
}

beforeEach(() => {
  db = openDb(':memory:');
  seed();
});

describe('CR-13 自动结束（班次结束时间口径）', () => {
  it('running：过班次结束（白班20:00）→ end=20:00:00', () => {
    const sid = mkSession('running', '2026-10-05 08:36:27');
    openSeg(sid, 'work', '2026-10-05 08:36:27');
    mkSchedule('2026-10-05', shiftDan);
    expect(resolveShiftEnd(db, getSessionRow(db, sid))).toBe('2026-10-05 20:00:00');

    const r = sweepTimeoutSessions(db, { bufferMin: 0, at: D(20, 1) });
    expect(r.ended).toHaveLength(1);
    const row = getSessionRow(db, sid);
    expect(row.status).toBe('stopped');
    expect(row.end_at).toBe('2026-10-05 20:00:00');
    // 08:36:27 → 20:00:00 = 41013s
    expect(row.net_seconds).toBe(41013);
  });

  it('paused：过班次结束 → end=最后一次暂停时间（19:32:30）', () => {
    const sid = mkSession('paused', '2026-10-05 08:36:27');
    openSeg(sid, 'work', '2026-10-05 08:36:27', '2026-10-05 19:32:30', '39363');
    openSeg(sid, 'pause', '2026-10-05 19:32:30');
    mkSchedule('2026-10-05', shiftDan);

    const r = sweepTimeoutSessions(db, { bufferMin: 0, at: D(20, 1) });
    expect(r.ended).toHaveLength(1);
    const row = getSessionRow(db, sid);
    expect(row.status).toBe('stopped');
    expect(row.end_at).toBe('2026-10-05 19:32:30');
    expect(row.net_seconds).toBe(39363);
    expect(row.pause_seconds).toBe(0);
  });

  it('未过班次结束 → 不结束；缓冲生效', () => {
    const sid = mkSession('running', '2026-10-05 08:36:27');
    openSeg(sid, 'work', '2026-10-05 08:36:27');
    mkSchedule('2026-10-05', shiftDan);
    expect(sweepTimeoutSessions(db, { bufferMin: 0, at: D(19, 59) }).ended).toHaveLength(0);
    expect(sweepTimeoutSessions(db, { bufferMin: 30, at: D(20, 29) }).ended).toHaveLength(0); // 20:29 < 20:30
    expect(sweepTimeoutSessions(db, { bufferMin: 30, at: D(20, 31) }).ended).toHaveLength(1); // > 20:30
    expect(getSessionRow(db, sid).status).toBe('stopped');
  });

  it('夜班 20:00–08:00（跨零点）→ 归属次日 08:00:00', () => {
    const sid = mkSession('running', '2026-10-05 20:00:02');
    openSeg(sid, 'work', '2026-10-05 20:00:02');
    mkSchedule('2026-10-05', shiftYe);
    expect(resolveShiftEnd(db, getSessionRow(db, sid))).toBe('2026-10-06 08:00:00');
    const r = sweepTimeoutSessions(db, { bufferMin: 0, at: D6(8, 1) });
    expect(r.ended).toHaveLength(1);
    expect(getSessionRow(db, sid).end_at).toBe('2026-10-06 08:00:00');
  });

  it('无 planned 排班 → 不结束，计入 unresolved', () => {
    const sid = mkSession('running', '2026-10-05 08:36:27');
    openSeg(sid, 'work', '2026-10-05 08:36:27');
    const r = sweepTimeoutSessions(db, { bufferMin: 0, at: D(23, 59) });
    expect(r.ended).toHaveLength(0);
    expect(r.unresolved.map((x) => x.id)).toEqual([sid]);
    expect(getSessionRow(db, sid).status).toBe('running');
  });

  it('硬顶（maxHours）仅对不可解析单兜底', () => {
    const sid = mkSession('running', '2026-10-04 08:00:00');
    openSeg(sid, 'work', '2026-10-04 08:00:00');
    expect(sweepTimeoutSessions(db, { bufferMin: 0, maxHours: 0, at: D(20, 1) }).ended).toHaveLength(0);
    const r = sweepTimeoutSessions(db, { bufferMin: 0, maxHours: 24, at: D(20, 1) });
    expect(r.ended).toHaveLength(1);
    expect(getSessionRow(db, sid).status).toBe('stopped');
  });

  it('幂等：两次清扫，第二次不再命中', () => {
    const sid = mkSession('running', '2026-10-05 08:36:27');
    openSeg(sid, 'work', '2026-10-05 08:36:27');
    mkSchedule('2026-10-05', shiftDan);
    expect(sweepTimeoutSessions(db, { bufferMin: 0, at: D(20, 1) }).ended).toHaveLength(1);
    expect(sweepTimeoutSessions(db, { bufferMin: 0, at: D(20, 1) }).ended).toHaveLength(0);
    const rm = db.prepare("SELECT COUNT(*) c FROM remark WHERE session_id=? AND author='系统'").get(sid).c;
    expect(rm).toBe(1);
  });

  it('dryRun 只判定不落库', () => {
    const sid = mkSession('running', '2026-10-05 08:36:27');
    openSeg(sid, 'work', '2026-10-05 08:36:27');
    mkSchedule('2026-10-05', shiftDan);
    const r = sweepTimeoutSessions(db, { bufferMin: 0, at: D(20, 1), dryRun: true });
    expect(r.candidates).toHaveLength(1);
    expect(r.ended).toHaveLength(0);
    expect(getSessionRow(db, sid).status).toBe('running');
  });
});

describe('CR-13 观察/写入 模式（AUTO_END_MODE）', () => {
  const cap = () => {
    const lines = [];
    return { lines, log: (m) => lines.push('LOG ' + m), warn: (m) => lines.push('WARN ' + m), error: (m) => lines.push('ERR ' + m) };
  };

  it('observe：只日志「将结束」（含 id / old→new / 原因），零写入', () => {
    const sid = mkSession('running', '2026-10-05 08:36:27');
    openSeg(sid, 'work', '2026-10-05 08:36:27');
    mkSchedule('2026-10-05', shiftDan);
    const L = cap();
    const stop = startAutoEndSweeper(db, { bufferMin: 0, mode: 'observe', intervalMs: 999999, logger: L, at: D(20, 1) });
    stop();
    expect(getSessionRow(db, sid).status).toBe('running'); // 零写入
    expect(db.prepare('SELECT COUNT(*) c FROM remark').get().c).toBe(0);
    const out = L.lines.join('\n');
    expect(out).toMatch(/dryrun\] 将结束 1 单/);
    expect(out).toMatch(new RegExp(`#${sid} WO-\\d+-\\d+ running old=-→new=2026-10-05 20:00:00 原因=班次结束`));
  });

  it('observe：暂停单原因=末次暂停', () => {
    const sid = mkSession('paused', '2026-10-05 08:36:27');
    openSeg(sid, 'work', '2026-10-05 08:36:27', '2026-10-05 19:32:30', '39363');
    openSeg(sid, 'pause', '2026-10-05 19:32:30');
    mkSchedule('2026-10-05', shiftDan);
    const L = cap();
    const stop = startAutoEndSweeper(db, { bufferMin: 0, mode: 'observe', intervalMs: 999999, logger: L, at: D(20, 1) });
    stop();
    const out = L.lines.join('\n');
    expect(out).toMatch(/paused old=-→new=2026-10-05 19:32:30 原因=末次暂停/);
    expect(getSessionRow(db, sid).status).toBe('paused');
  });

  it('live：写入结束', () => {
    const sid = mkSession('running', '2026-10-05 08:36:27');
    openSeg(sid, 'work', '2026-10-05 08:36:27');
    mkSchedule('2026-10-05', shiftDan);
    const L = cap();
    const stop = startAutoEndSweeper(db, { bufferMin: 0, mode: 'live', intervalMs: 999999, logger: L, at: D(20, 1) });
    stop();
    expect(getSessionRow(db, sid).status).toBe('stopped');
    expect(L.lines.join('\n')).toMatch(/自动结束 1 单/);
  });

  it('resolveAutoEndMode：优先级 MODE > DRYRUN > 默认 observe', () => {
    expect(resolveAutoEndMode({})).toEqual({ mode: 'observe', source: 'default' });
    expect(resolveAutoEndMode({ AUTO_END_DRYRUN: '1' })).toEqual({ mode: 'observe', source: 'AUTO_END_DRYRUN' });
    expect(resolveAutoEndMode({ AUTO_END_DRYRUN: '0' })).toEqual({ mode: 'live', source: 'AUTO_END_DRYRUN' });
    expect(resolveAutoEndMode({ AUTO_END_MODE: 'live', AUTO_END_DRYRUN: '1' })).toEqual({ mode: 'live', source: 'AUTO_END_MODE' });
    expect(resolveAutoEndMode({ AUTO_END_MODE: 'observe', AUTO_END_DRYRUN: '0' })).toEqual({ mode: 'observe', source: 'AUTO_END_MODE' });
  });
});

describe('CR-13 管理员强制结束', () => {
  it('running → stopped，写入管理员备注', () => {
    const { session } = startSession(db, { operatorId: opA, vehicleId: v1 });
    const out = forceStopSession(db, session.id, { remark: '现场异常，管理员纠偏', author: '管理员甲' });
    expect(out.session.status).toBe('stopped');
    expect(out.remark.content).toBe('现场异常，管理员纠偏');
  });

  it('已结束单再强制 → 报错，不重复写备注', () => {
    const { session } = startSession(db, { operatorId: opA, vehicleId: v1 });
    forceStopSession(db, session.id, {});
    expect(() => forceStopSession(db, session.id, {})).toThrow();
    expect(db.prepare('SELECT * FROM remark WHERE session_id=?').all(session.id)).toHaveLength(1);
  });
});
