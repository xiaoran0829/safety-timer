// CR-08 批2（老板 7 条需求 · 批2）验收：② 班次时间窗 / ④ 发起人=排班下发人 /
// ⑤ 只看本人排班车（后端硬拦）/ ⑦ 当天结束锁定（同人同车同天）。
// 红线：不碰现网；本用例仅内存库。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { startSession, stopSession } from '../services/timer.js';
import { hashPassword } from '../middleware/auth.js';
import { fmtDay } from '../lib/time.js';
import { isScheduled, findSchedule } from '../services/schedule.js';

const PAX = 'cr08b-pass';
const D = fmtDay();
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let db;
let app;
let token;
let opId;
let op2;
let vId;
let v2;

function addShift(name, start, end) {
  return Number(
    db
      .prepare('INSERT INTO shift(name,start_time,end_time,sort,active) VALUES(?,?,?,?,1)')
      .run(name, start, end, 99).lastInsertRowid
  );
}
function schedule(operatorId, vehicleId, shiftId, createdBy = '排班员') {
  return Number(
    db
      .prepare(
        "INSERT INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,note,created_by) VALUES(?,?,?,?,'planned',NULL,?)"
      )
      .run(D, shiftId, operatorId, vehicleId, createdBy).lastInsertRowid
  );
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: PAX });
  opId = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('张伟','安全员A',10)").run().lastInsertRowid);
  op2 = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('李强','安全员B',20)").run().lastInsertRowid);
  vId = Number(db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES('LSVAB1234K5678901','工位A',1)").run().lastInsertRowid);
  v2 = Number(db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES('LSVAB1234K5678902','工位B',2)").run().lastInsertRowid);
  const l = await request(app).post('/api/admin/login').send({ password: PAX });
  token = l.body.data.token;
});

afterEach(() => {
  delete process.env.SCHEDULE_ENFORCE;
});

describe('② 班次时间窗（仅拦「早于班次开始」；迟到/早退放行、按实际计时）', () => {
  it('开始早于班次开始时间 → BEFORE_SHIFT_START（403）', () => {
    const sh = addShift('晚班', '23:59', '23:58'); // 班次「今天 23:59」开始，此刻必早于它
    schedule(opId, vId, sh);
    try {
      startSession(db, { operatorId: opId, vehicleId: vId });
      throw new Error('should not reach');
    } catch (e) {
      expect(e.code).toBe('BEFORE_SHIFT_START');
      expect(e.http).toBe(403);
    }
  });

  it('已到/晚于班次开始（迟到）→ 放行', () => {
    const sh = addShift('早班', '00:00', '23:59'); // 00:00 起，此刻必已开始
    schedule(opId, vId, sh);
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    expect(session.status).toBe('running');
  });

  it('无排班 / 班次为空 → 时间窗豁免', () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId }); // 无排班
    expect(session.status).toBe('running');
    // 有排班但 shift_id 为空 → 不校验时间窗
    db.prepare(
      "INSERT INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,created_by) VALUES(?,NULL,?,?,'planned','x')"
    ).run(D, op2, v2);
    const r2 = startSession(db, { operatorId: op2, vehicleId: v2 });
    expect(r2.session.status).toBe('running');
  });

  it('早退（结束早于班次结束）→ 放行，工时按实际（不额外扣减）', () => {
    const sh = addShift('早班', '00:00', '23:59');
    schedule(opId, vId, sh);
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    const stopped = stopSession(db, session.id, opId).session; // 立即停 → 远早于 23:59
    expect(stopped.status).toBe('stopped');
    expect(stopped.netSeconds).toBeGreaterThanOrEqual(0);
    expect(stopped.endAt).toBeTruthy();
  });
});

describe('④ 发起人 = 排班下发人（schedule.created_by）', () => {
  it('有排班 → initiator_name=created_by 且 id=null', () => {
    const sh = addShift('早班', '00:00', '23:59');
    schedule(opId, vId, sh, '王调度');
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    expect(session.initiatorName).toBe('王调度');
    expect(session.initiatorId).toBeNull();
    const row = db.prepare('SELECT initiator_id,initiator_name FROM timer_session WHERE id=?').get(session.id);
    expect(row.initiator_name).toBe('王调度');
    expect(row.initiator_id).toBeNull();
  });

  it('无排班 → 发起人留空（不回落本人）', () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    expect(session.initiatorName).toBeNull();
    expect(session.initiatorId).toBeNull();
  });

  it('显式 initiatorId 仍可覆盖（后台/脚本直调兼容）', () => {
    const iniId = Number(db.prepare("INSERT INTO initiator(name) VALUES('手选发起')").run().lastInsertRowid);
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId, initiatorId: iniId });
    expect(session.initiatorId).toBe(iniId);
    expect(session.initiatorName).toBe('手选发起');
  });
});

describe('⑦ 当天结束锁定（同人+同车+同日）', () => {
  it('stop 后再次 start 同车同日 → DAY_CLOSED（409）', () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    stopSession(db, session.id, opId);
    try {
      startSession(db, { operatorId: opId, vehicleId: vId });
      throw new Error('should not reach');
    } catch (e) {
      expect(e.code).toBe('DAY_CLOSED');
      expect(e.http).toBe(409);
    }
  });

  it('同人换车 → 仍可开始（锁定仅同车）', () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    stopSession(db, session.id, opId);
    const { session: s2 } = startSession(db, { operatorId: opId, vehicleId: v2 });
    expect(s2.status).toBe('running');
  });

  it('他人同车当天 → 不受影响', () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    stopSession(db, session.id, opId);
    const { session: s2 } = startSession(db, { operatorId: op2, vehicleId: vId });
    expect(s2.status).toBe('running');
  });

  it('未结束（进行中）不受「当天锁定」影响', () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    expect(session.status).toBe('running');
    // 进行中再次 start → OPERATOR_BUSY（C1），非 DAY_CLOSED
    try {
      startSession(db, { operatorId: opId, vehicleId: v2 });
      throw new Error('should not reach');
    } catch (e) {
      expect(e.code).toBe('OPERATOR_BUSY');
    }
  });
});

describe('⑤ H5 只看本人排班车（后端硬拦）', () => {
  async function opLogin(username, password) {
    return (await request(app).post('/api/h5/login').send({ username, password })).body.data.token;
  }

  it('/api/h5/my-vehicles 仅返回本人当日排班车', async () => {
    const sh = addShift('早班', '00:00', '23:59');
    schedule(opId, vId, sh);
    schedule(opId, v2, sh); // 本人两车
    const { hash, salt } = hashPassword('op1234');
    db.prepare(
      'UPDATE operator SET username=?,pwd_hash=?,pwd_salt=?,pwd_ver=0,must_change_pwd=0,employed=1 WHERE id=?'
    ).run('zhangwei', hash, salt, opId);
    const t = await opLogin('zhangwei', 'op1234');
    const r = await request(app).get(`/api/h5/my-vehicles?date=${D}`).set({ Authorization: `Bearer ${t}` });
    expect(r.status).toBe(200);
    expect(r.body.data.map((x) => x.vehicleId).sort()).toEqual([vId, v2].sort());
  });

  it('enforcement 开启：非排班车 start 硬拦（allowUnscheduled 已无效）', () => {
    process.env.SCHEDULE_ENFORCE = '1';
    expect(() => startSession(db, { operatorId: opId, vehicleId: vId })).toThrow(/未排给您/);
    expect(() => startSession(db, { operatorId: opId, vehicleId: vId, allowUnscheduled: true })).toThrow(/未排给您/);
  });
});

// 收口A：跨零点夜班——本期明确「仅支持同天班次」。
// 依据：生产 shift 表 3 个班次（白班 06:00–15:00 / 夜班 15:00–24:00 / 单班 08:30–20:30）
// 均 start_time ≤ end_time，`SELECT COUNT(*) WHERE start_time>end_time` = 0，无跨零点班次。
// 排班/命中一律按 work_date 精确同天匹配；跨零点凌晨会落在次日 → 未排班 → enforce=1 下硬拦。
describe('② 时间窗·同天口径（跨零点不在本期范围，收口A）', () => {
  it('排班按 work_date 精确同天匹配；跨日不命中', () => {
    const sh = addShift('夜班X', '15:00', '24:00'); // 现网夜班口径，同天（end=24:00）
    schedule(opId, vId, sh); // work_date = D
    expect(isScheduled(db, { operatorId: opId, vehicleId: vId, date: D })).toBe(true);
    expect(findSchedule(db, { operatorId: opId, vehicleId: vId, date: D })).toBeTruthy();
    // 次日（跨零点后的凌晨落在此）不命中 → enforce=1 下会被 NOT_SCHEDULED 硬拦
    expect(isScheduled(db, { operatorId: opId, vehicleId: vId, date: '2099-01-01' })).toBe(false);
    expect(findSchedule(db, { operatorId: opId, vehicleId: vId, date: '2099-01-01' })).toBeNull();
  });
});
