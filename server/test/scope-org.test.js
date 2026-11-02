// 2026-10-08 老板：长安科技项目（组织 see_all=1）可看全部组织工单；其他组织只看各自组织。
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let db, app, root, orgA, orgAll, sup1, opId, engA, engAll;

async function mkUser(username, role, orgId) {
  await request(app).post('/api/admin/users').set(bearer(root)).send({ username, password: 'abc123', role, orgId, mustChange: false });
  const t = (await request(app).post('/api/admin/login').send({ username, password: 'abc123' })).body.data.token;
  return { token: t };
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: 'p-seeall', adminUser: '管理员' });
  orgA = Number(db.prepare("INSERT INTO organization(name,code,active,sort,see_all) VALUES('组织A','A',1,1,0)").run().lastInsertRowid);
  orgAll = Number(db.prepare("INSERT INTO organization(name,code,active,sort,see_all) VALUES('长安科技项目','C',1,2,1)").run().lastInsertRowid);
  sup1 = Number(db.prepare("INSERT INTO supplier(name,code,active,sort) VALUES('供应商1','S1',1,1)").run().lastInsertRowid);
  db.prepare("INSERT INTO vehicle(vin,station,org_id,supplier_id,active,sort) VALUES('VIN-A','站',?,?,1,0)").run(orgA, sup1);
  db.prepare("INSERT INTO vehicle(vin,station,org_id,supplier_id,active,sort) VALUES('VIN-B','站',?,?,1,0)").run(orgAll, sup1);
  root = (await request(app).post('/api/admin/login').send({ password: 'p-seeall' })).body.data.token;
  opId = Number(db.prepare("INSERT INTO operator(name) VALUES('张三')").run().lastInsertRowid);
  const vA = db.prepare('SELECT id FROM vehicle WHERE vin=?').get('VIN-A').id;
  const vB = db.prepare('SELECT id FROM vehicle WHERE vin=?').get('VIN-B').id;
  db.prepare(
    "INSERT INTO timer_session(work_order_no,operator_id,vehicle_id,operator_name,vin,status,start_at,net_seconds) VALUES('WO-A',?,?,'张三','VIN-A','stopped','2026-10-08 06:00:00',3600)"
  ).run(opId, vA);
  db.prepare(
    "INSERT INTO timer_session(work_order_no,operator_id,vehicle_id,operator_name,vin,status,start_at,net_seconds) VALUES('WO-B',?,?,'张三','VIN-B','stopped','2026-10-08 07:00:00',3600)"
  ).run(opId, vB);
  engA = await mkUser('engA', 'engineer', orgA);
  engAll = await mkUser('engAll', 'engineer', orgAll);
});

const vins = (res) => res.body.data.map((r) => r.vin).sort();

describe('组织可见范围（see_all）', () => {
  it('普通组织工程师只看本单位车辆；see_all 组织看全部', async () => {
    const a = await request(app).get('/api/admin/vehicles?active=1').set(bearer(engA.token));
    expect(vins(a)).toEqual(['VIN-A']);
    const all = await request(app).get('/api/admin/vehicles?active=1').set(bearer(engAll.token));
    expect(vins(all)).toEqual(['VIN-A', 'VIN-B']);
  });

  it('工单（计时记录）按组织隔离；see_all 组织可见全部', async () => {
    const a = await request(app).get('/api/admin/sessions').set(bearer(engA.token));
    expect(a.body.data.list.map((r) => r.workOrderNo)).toEqual(['WO-A']);
    const all = await request(app).get('/api/admin/sessions').set(bearer(engAll.token));
    expect(all.body.data.list.map((r) => r.workOrderNo).sort()).toEqual(['WO-A', 'WO-B']);
  });

  it('详细工时同样按组织隔离', async () => {
    const a = await request(app).get('/api/admin/sessions/detail').set(bearer(engA.token));
    expect(a.body.data.list.map((r) => r.workOrderNo)).toEqual(['WO-A']);
    const all = await request(app).get('/api/admin/sessions/detail').set(bearer(engAll.token));
    expect(all.body.data.list.length).toBe(2);
  });

  it('组织字典返回 see_all 标记', async () => {
    const r = await request(app).get('/api/admin/organizations').set(bearer(root));
    const all = r.body.data.find((o) => o.name === '长安科技项目');
    expect(all.see_all).toBe(1);
    expect(r.body.data.find((o) => o.name === '组织A').see_all).toBe(0);
  });

  it('管理员不受限（全量）', async () => {
    const r = await request(app).get('/api/admin/sessions').set(bearer(root));
    expect(r.body.data.list.length).toBe(2);
  });
});
