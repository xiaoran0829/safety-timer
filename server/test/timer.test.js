import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../db.js';
import {
  startSession,
  pauseSession,
  resumeSession,
  stopSession,
  addRemark,
  getSessionDetail,
  getActiveDetail,
  toSessionDto,
  getSessionRow,
} from '../services/timer.js';
import { nowDate, fmtDateTime, fmtDuration } from '../lib/time.js';

let db;
let opA;
let opB;
let v1;
let v2;

function seed() {
  opA = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('张伟','安全员A',10)").run().lastInsertRowid);
  opB = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('李强','安全员B',20)").run().lastInsertRowid);
  v1 = Number(db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES('LSVAB1234K5678901','工位A',1)").run().lastInsertRowid);
  v2 = Number(db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES('LSVAB1234K5678903','工位C',2)").run().lastInsertRowid);
}

beforeEach(() => {
  db = openDb(':memory:');
  seed();
});

describe('状态机（冻结规格 §4）', () => {
  it('start 建会话：状态 running、工单号、开 work 段', () => {
    const { session } = startSession(db, { operatorId: opA, vehicleId: v1 });
    expect(session.status).toBe('running');
    expect(session.workOrderNo).toMatch(/^WO-\d{8}-001$/);
    expect(session.operatorName).toBe('张伟');
    expect(session.vin).toBe('LSVAB1234K5678901');
    const segs = db.prepare('SELECT * FROM timer_segment WHERE session_id=?').all(session.id);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('work');
    expect(segs[0].ended_at).toBeNull();
  });

  it('running → pause → resume → stop 全流程', () => {
    const { session } = startSession(db, { operatorId: opA, vehicleId: v1 });
    expect(session.status).toBe('running');

    const p = pauseSession(db, session.id, opA, { remark: '流程测试-暂停' }).session;
    expect(p.status).toBe('paused');
    const kinds1 = db.prepare('SELECT kind FROM timer_segment WHERE session_id=? ORDER BY id').all(session.id).map((r) => r.kind);
    expect(kinds1).toEqual(['work', 'pause']);

    const r = resumeSession(db, session.id, opA).session;
    expect(r.status).toBe('running');
    const kinds2 = db.prepare('SELECT kind FROM timer_segment WHERE session_id=? ORDER BY id').all(session.id).map((r) => r.kind);
    expect(kinds2).toEqual(['work', 'pause', 'work']);

    const s = stopSession(db, session.id, opA).session;
    expect(s.status).toBe('stopped');
    expect(s.endAt).not.toBeNull();
  });

  it('非法转移：paused 不能 pause / resume 等', () => {
    const { session } = startSession(db, { operatorId: opA, vehicleId: v1 });
    expect(() => resumeSession(db, session.id, opA)).toThrowError(/状态/); // running 不能 resume
    pauseSession(db, session.id, opA, { remark: '非法转移-暂停' });
    expect(() => pauseSession(db, session.id, opA, { remark: 'x' })).toThrowError(/状态/); // paused 不能 pause
    stopSession(db, session.id, opA);
    expect(() => pauseSession(db, session.id, opA, { remark: 'x' })).toThrowError(/状态/);
    expect(() => stopSession(db, session.id, opA)).toThrowError(/状态/);
    expect(() => resumeSession(db, session.id, opA)).toThrowError(/状态/);
    expect(() => addRemark(db, session.id, opA, 'x')).toThrowError(/结束/); // stopped 不能备注
  });

  it('INVALID_STATE 错误码与 HTTP 409', () => {
    const { session } = startSession(db, { operatorId: opA, vehicleId: v1 });
    try {
      resumeSession(db, session.id, opA);
    } catch (e) {
      expect(e.code).toBe('INVALID_STATE');
      expect(e.http).toBe(409);
    }
  });
});

describe('互斥 C1 / C3 / C3′ / C5', () => {
  it('C1 一人一车：同一安全员再来一次 → OPERATOR_BUSY + activeSession', () => {
    startSession(db, { operatorId: opA, vehicleId: v1 });
    try {
      startSession(db, { operatorId: opA, vehicleId: v2 });
      throw new Error('should not reach');
    } catch (e) {
      expect(e.code).toBe('OPERATOR_BUSY');
      expect(e.http).toBe(409);
      expect(e.data.activeSession.vin).toBe('LSVAB1234K5678901');
    }
  });

  it('C2/Q5 一车一人：不同人可对同车计时（软提示，不硬拦）', () => {
    const a = startSession(db, { operatorId: opA, vehicleId: v1 }).session;
    const b = startSession(db, { operatorId: opB, vehicleId: v1 }).session;
    expect(a.id).not.toBe(b.id);
    expect(db.prepare("SELECT COUNT(*) n FROM timer_session WHERE vehicle_id=? AND status='running'").get(v1).n).toBe(2);
  });

  it('C3/C3′ 停用的安全员/车架号', () => {
    db.prepare('UPDATE operator SET active=0 WHERE id=?').run(opB);
    expect(() => startSession(db, { operatorId: opB, vehicleId: v1 })).toThrowError(/停用/);
    db.prepare('UPDATE vehicle SET active=0 WHERE id=?').run(v2);
    expect(() => startSession(db, { operatorId: opA, vehicleId: v2 })).toThrowError(/停用/);
  });

  it('C5 越权：非归属 operator 不能操作会话', () => {
    const { session } = startSession(db, { operatorId: opA, vehicleId: v1 });
    try {
      pauseSession(db, session.id, opB, { remark: '越权测试' });
    } catch (e) {
      expect(e.code).toBe('FORBIDDEN');
      expect(e.http).toBe(403);
    }
    // admin 例外可通过
    expect(pauseSession(db, session.id, opB, { admin: true, remark: 'admin 代为暂停' }).session.status).toBe('paused');
  });

  it('停止后放行：再开始新会话', () => {
    const { session } = startSession(db, { operatorId: opA, vehicleId: v1 });
    stopSession(db, session.id, opA);
    const { session: s2 } = startSession(db, { operatorId: opA, vehicleId: v2 });
    expect(s2.status).toBe('running');
    expect(getActiveDetail(db, opA).session.id).toBe(s2.id);
  });
});

describe('时长口径（冻结规格 §3）', () => {
  it('净时长 = Σwork 段；暂停不计入', () => {
    const { session } = startSession(db, { operatorId: opA, vehicleId: v1 });
    // 手工构造：work 120s + pause 30s + work 60s
    const nowStr = fmtDateTime();
    db.prepare('DELETE FROM timer_segment WHERE session_id=?').run(session.id);
    const ins = db.prepare('INSERT INTO timer_segment(session_id,kind,started_at,ended_at,seconds) VALUES(?,?,?,?,?)');
    ins.run(session.id, 'work', '2026-09-29 09:00:00', '2026-09-29 09:02:00', 120);
    ins.run(session.id, 'pause', '2026-09-29 09:02:00', '2026-09-29 09:02:30', 30);
    ins.run(session.id, 'work', '2026-09-29 09:02:30', '2026-09-29 09:03:30', 60);
    const s = stopSession(db, session.id, opA).session;
    expect(s.netSeconds).toBe(180);
    expect(s.pauseSeconds).toBe(30);
    expect(fmtDuration(s.netSeconds)).toBe('00:03:00');
  });

  it('进行中净时长 = 已结束 work + 当前 work 段（服务器时间推算）', () => {
    const { session } = startSession(db, { operatorId: opA, vehicleId: v1 });
    // 把当前 work 段 started_at 挪到 90 秒前
    const started = fmtDateTime(new Date(nowDate().getTime() - 90 * 1000));
    db.prepare('UPDATE timer_segment SET started_at=? WHERE session_id=? AND ended_at IS NULL').run(started, session.id);
    const dto = toSessionDto(db, getSessionRow(db, session.id));
    expect(dto.netSeconds).toBeGreaterThanOrEqual(89);
    expect(dto.netSeconds).toBeLessThanOrEqual(92);
    expect(dto.pauseSeconds).toBe(0);
  });

  it('备注带时间戳并入会话详情，不改状态', () => {
    const { session } = startSession(db, { operatorId: opA, vehicleId: v1 });
    const { remark } = addRemark(db, session.id, opA, '配合吊装作业，暂停计时');
    expect(remark.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(remark.author).toBe('张伟');
    const detail = getSessionDetail(db, session.id);
    expect(detail.remarks).toHaveLength(1);
    expect(detail.session.status).toBe('running');
  });

  it('备注内容为空 → VALIDATION', () => {
    const { session } = startSession(db, { operatorId: opA, vehicleId: v1 });
    try {
      addRemark(db, session.id, opA, '   ');
    } catch (e) {
      expect(e.code).toBe('VALIDATION');
    }
  });
});
