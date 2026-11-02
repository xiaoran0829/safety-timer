// 2026-10-08 老板需求③④：账号按所属组织/供应商隔离 + 角色映射（工程师↔组织，车队↔供应商）。
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';

const ROOT_PASS = 'scope-root-pass';
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let db, app, orgA, orgB, sup1, sup2, vA, vB, vS1, vS2;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: ROOT_PASS, adminUser: '管理员' });
  orgA = Number(db.prepare("INSERT INTO organization(name) VALUES('组织A')").run().lastInsertRowid);
  orgB = Number(db.prepare("INSERT INTO organization(name) VALUES('组织B')").run().lastInsertRowid);
  sup1 = Number(db.prepare("INSERT INTO supplier(name) VALUES('供应商1')").run().lastInsertRowid);
  sup2 = Number(db.prepare("INSERT INTO supplier(name) VALUES('供应商2')").run().lastInsertRowid);
  const mv = (vin, org, sup) =>
    Number(db.prepare('INSERT INTO vehicle(vin,org_id,supplier_id) VALUES(?,?,?)').run(vin, org, sup).lastInsertRowid);
  vA = mv('VINORGAAA0000001', orgA, null);
  vB = mv('VINORGBBB0000002', orgB, null);
  vS1 = mv('VINSUP1110000003', null, sup1);
  vS2 = mv('VINSUP2220000004', null, sup2);
});

const rootLogin = async () => (await request(app).post('/api/admin/login').send({ password: ROOT_PASS })).body.data.token;
async function mkUser(root, body) {
  return request(app).post('/api/admin/users').set(bearer(root)).send(body);
}
const userLogin = (u, p) => request(app).post('/api/admin/login').send({ username: u, password: p });
const listVeh = (t) => request(app).get('/api/admin/vehicles').set(bearer(t));

describe('需求④ 角色↔单位映射校验', () => {
  it('未绑定单位的工程师/车队：建号成功但看不到任何车辆（默认拒绝）', async () => {
    const root = await rootLogin();
    const e = await mkUser(root, { username: 'eng0', password: 'abc123', role: 'engineer', mustChange: false });
    expect(e.status).toBe(201);
    expect(e.body.data).toMatchObject({ role: 'engineer', orgId: null });
    const tok = (await userLogin('eng0', 'abc123')).body.data.token;
    expect((await listVeh(tok)).body.data).toEqual([]);
  });
  it('工程师绑组织、车队绑供应商 → DTO 回带单位', async () => {
    const root = await rootLogin();
    const e = await mkUser(root, { username: 'eng1', password: 'abc123', role: 'engineer', orgId: orgA, mustChange: false });
    expect(e.status).toBe(201);
    expect(e.body.data).toMatchObject({ role: 'engineer', orgId: orgA, orgName: '组织A', supplierId: null });
    const f = await mkUser(root, { username: 'flt1', password: 'abc123', role: 'fleet_admin', supplierId: sup1, mustChange: false });
    expect(f.status).toBe(201);
    expect(f.body.data).toMatchObject({ role: 'fleet_admin', supplierId: sup1, supplierName: '供应商1', orgId: null });
  });
});

describe('需求③ 车辆可见性按单位隔离', () => {
  it('工程师只见本组织车辆；车队只见本供应商车辆；管理员全见', async () => {
    const root = await rootLogin();
    await mkUser(root, { username: 'eng1', password: 'abc123', role: 'engineer', orgId: orgA, mustChange: false });
    await mkUser(root, { username: 'flt1', password: 'abc123', role: 'fleet_admin', supplierId: sup1, mustChange: false });

    const engTok = (await userLogin('eng1', 'abc123')).body.data.token;
    const fltTok = (await userLogin('flt1', 'abc123')).body.data.token;

    const eng = await listVeh(engTok);
    expect(eng.status).toBe(200);
    expect(eng.body.data.map((v) => v.id)).toEqual([vA]);

    const flt = await listVeh(fltTok);
    expect(flt.body.data.map((v) => v.id)).toEqual([vS1]);

    const all = await listVeh(root);
    expect(all.body.data.map((v) => v.id).sort()).toEqual([vA, vB, vS1, vS2].sort());
  });

  it('工程师改/删其他单位车辆 → 403 NO_PERMISSION', async () => {
    const root = await rootLogin();
    await mkUser(root, { username: 'eng1', password: 'abc123', role: 'engineer', orgId: orgA, mustChange: false });
    const engTok = (await userLogin('eng1', 'abc123')).body.data.token;

    const put = await request(app).put(`/api/admin/vehicles/${vB}`).set(bearer(engTok)).send({ station: 'X' });
    expect(put.status).toBe(403);
    expect(put.body.code).toBe('NO_PERMISSION');

    const del = await request(app).delete(`/api/admin/vehicles/${vB}`).set(bearer(engTok));
    expect(del.status).toBe(403);
  });

  it('工程师新建车辆 → 强制归入本组织（忽略传入的别家组织）', async () => {
    const root = await rootLogin();
    await mkUser(root, { username: 'eng1', password: 'abc123', role: 'engineer', orgId: orgA, mustChange: false });
    const engTok = (await userLogin('eng1', 'abc123')).body.data.token;

    const r = await request(app).post('/api/admin/vehicles').set(bearer(engTok)).send({ vin: 'VINNEW0000000009', orgId: orgB });
    expect(r.status).toBe(201);
    expect(r.body.data.orgId).toBe(orgA);
  });
});
