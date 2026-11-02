// 2026-10-08 老板需求①：出车/收车里程必填 + 校验（含与上次收车里程核对 >10km）。
// 红线：仅内存库，不碰现网。
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { startSession, stopSession } from '../services/timer.js';

const ROOT_PASS = 'mileage-root-pass';
const ROOT_USER = '管理员';
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let db;
let app;
let opA;
let opB;
let opC;
let vId;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: ROOT_PASS, adminUser: ROOT_USER });
  opA = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('张伟','安全员A',10)").run().lastInsertRowid);
  opB = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('李强','安全员B',20)").run().lastInsertRowid);
  opC = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('王芳','安全员C',30)").run().lastInsertRowid);
  vId = Number(db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES('LSVAB1234K5678901','工位A',1)").run().lastInsertRowid);
});

describe('需求① A：出车里程与「上一次收车里程」核对（偏差 >10km 拦）', () => {
  it('偏差 ≤10km 放行；>10km → ODOMETER_MISMATCH', () => {
    const s1 = startSession(db, { operatorId: opA, vehicleId: vId, odometerOut: 1000 }).session;
    stopSession(db, s1.id, opA, { odometerIn: 1500 }); // 上次收车 = 1500

    // 偏差 5km → 放行
    const s2 = startSession(db, { operatorId: opB, vehicleId: vId, odometerOut: 1505 }).session;
    expect(s2.odometerOut).toBe(1505);

    // 偏差 20km → 拦
    expect(() => startSession(db, { operatorId: opC, vehicleId: vId, odometerOut: 1520 })).toThrow(/上次收车/);
    let code = null;
    try { startSession(db, { operatorId: opC, vehicleId: vId, odometerOut: 1520 }); } catch (e) { code = e.code; }
    expect(code).toBe('ODOMETER_MISMATCH');
  });

  it('无历史收车里程 → 不拦', () => {
    const s = startSession(db, { operatorId: opA, vehicleId: vId, odometerOut: 88888 }).session;
    expect(s.odometerOut).toBe(88888);
  });
});

describe('需求① B：收车里程校验（≥ 出车；0 或 >1000km 判离谱）', () => {
  it('收车 < 出车 → ODOMETER_INVALID', () => {
    const s = startSession(db, { operatorId: opA, vehicleId: vId, odometerOut: 2000 }).session;
    let code = null;
    try { stopSession(db, s.id, opA, { odometerIn: 1900 }); } catch (e) { code = e.code; }
    expect(code).toBe('ODOMETER_INVALID');
    expect(db.prepare('SELECT status FROM timer_session WHERE id=?').get(s.id).status).toBe('running');
  });

  it('收车 = 出车（0km）→ ODOMETER_INVALID', () => {
    const s = startSession(db, { operatorId: opA, vehicleId: vId, odometerOut: 2000 }).session;
    expect(() => stopSession(db, s.id, opA, { odometerIn: 2000 })).toThrow();
  });

  it('本次 >1000km → ODOMETER_INVALID', () => {
    const s = startSession(db, { operatorId: opA, vehicleId: vId, odometerOut: 2000 }).session;
    expect(() => stopSession(db, s.id, opA, { odometerIn: 3500 })).toThrow();
  });

  it('合法收车 → 落库并在 DTO 返回', () => {
    const s = startSession(db, { operatorId: opA, vehicleId: vId, odometerOut: 2000 }).session;
    const stopped = stopSession(db, s.id, opA, { odometerIn: 2500 }).session;
    expect(stopped.odometerOut).toBe(2000);
    expect(stopped.odometerIn).toBe(2500);
    expect(stopped.status).toBe('stopped');
  });
});

describe('需求① C：H5 安全员路由层强制必填（后台/脚本不强制）', () => {
  async function operatorToken() {
    const root = (await request(app).post('/api/admin/login').send({ password: ROOT_PASS })).body.data.token;
    await request(app).post(`/api/admin/operators/${opA}/account`).set(bearer(root)).send({ username: 'safety1', password: 'op12345' });
    const t0 = (await request(app).post('/api/h5/login').send({ username: 'safety1', password: 'op12345' })).body.data.token;
    return (await request(app).post('/api/h5/password').set(bearer(t0)).send({ oldPassword: 'op12345', newPassword: 'op67890' })).body.data.token;
  }

  it('operator 开始未填出车里程 → 400 ODOMETER_REQUIRED；填了 → 201', async () => {
    const token = await operatorToken();
    const noOdo = await request(app).post('/api/sessions/start').set(bearer(token)).send({ vehicleId: vId });
    expect(noOdo.status).toBe(400);
    expect(noOdo.body.code).toBe('ODOMETER_REQUIRED');
    const ok = await request(app).post('/api/sessions/start').set(bearer(token)).send({ vehicleId: vId, odometerOut: 1000 });
    expect(ok.status).toBe(201);
  });

  it('operator 停止未填收车里程 → 400 ODOMETER_REQUIRED；填了 → 200', async () => {
    const token = await operatorToken();
    const st = await request(app).post('/api/sessions/start').set(bearer(token)).send({ vehicleId: vId, odometerOut: 1000 });
    const sid = st.body.data.session.id;
    const noOdo = await request(app).post(`/api/sessions/${sid}/stop`).set(bearer(token)).send({});
    expect(noOdo.status).toBe(400);
    expect(noOdo.body.code).toBe('ODOMETER_REQUIRED');
    const ok = await request(app).post(`/api/sessions/${sid}/stop`).set(bearer(token)).send({ odometerIn: 1500 });
    expect(ok.status).toBe(200);
  });

  it('无 token（后台/脚本）开始/停止不受里程强制（回归）', async () => {
    const st = await request(app).post('/api/sessions/start').send({ operatorId: opA, vehicleId: vId });
    expect(st.status).toBe(201);
    const sid = st.body.data.session.id;
    const sp = await request(app).post(`/api/sessions/${sid}/stop`).send({ operatorId: opA });
    expect(sp.status).toBe(200);
  });
});
