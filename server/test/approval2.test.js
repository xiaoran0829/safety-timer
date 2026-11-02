// 2026-10-08 老板补充：换组织/供应商审批「主要涉及车架号」+ 流程配置仅管理员
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';

const ROOT_PASS = 'appr2-root-pass';
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let db, app, orgA, orgB, sup1, root, engTok, aTok, aId, vA, vB;

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: ROOT_PASS, adminUser: '管理员' });
  orgA = Number(db.prepare("INSERT INTO organization(name) VALUES('组织A')").run().lastInsertRowid);
  orgB = Number(db.prepare("INSERT INTO organization(name) VALUES('组织B')").run().lastInsertRowid);
  sup1 = Number(db.prepare("INSERT INTO supplier(name) VALUES('供应商1')").run().lastInsertRowid);
  vA = 'LVIN0000000000001';
  vB = 'LVIN0000000000002';
  db.prepare("INSERT INTO vehicle(vin,station,org_id,supplier_id,active,sort) VALUES(?,?,?,?,1,0)").run(vA, '站A', orgA, sup1);
  db.prepare("INSERT INTO vehicle(vin,station,org_id,supplier_id,active,sort) VALUES(?,?,?,?,1,0)").run(vB, '站B', orgB, sup1);
  root = (await request(app).post('/api/admin/login').send({ password: ROOT_PASS })).body.data.token;
  await request(app).post('/api/admin/users').set(bearer(root)).send({ username: 'eng1', password: 'abc123', role: 'engineer', orgId: orgA, mustChange: false });
  engTok = (await request(app).post('/api/admin/login').send({ username: 'eng1', password: 'abc123' })).body.data.token;
  const A = await request(app).post('/api/admin/users').set(bearer(root)).send({ username: 'auditA', password: 'abc123', role: 'engineer', mustChange: false });
  aId = A.body.data.id;
  aTok = (await request(app).post('/api/admin/login').send({ username: 'auditA', password: 'abc123' })).body.data.token;
  const flows = await request(app).get('/api/admin/approvals/flows').set(bearer(root));
  const flow = flows.body.data.find((f) => f.code === 'org_change');
  await request(app).put(`/api/admin/approvals/flows/${flow.id}/nodes`).set(bearer(root)).send({ nodes: [{ approverId: aId }] });
});

describe('需求② 车架号换组织/供应商', () => {
  it('车架号申请通过后改绑组织，并同步文本字段', async () => {
    const s = await request(app)
      .post('/api/admin/approvals/requests')
      .set(bearer(engTok))
      .send({ kind: 'org_change', targetType: 'vehicle', vin: vA, orgId: orgB, reason: '车辆调拨' });
    expect(s.status).toBe(201);
    expect(s.body.data.payload.vin).toBe(vA);
    const rid = s.body.data.id;
    const ok = await request(app).post(`/api/admin/approvals/requests/${rid}/approve`).set(bearer(aTok)).send({ comment: '同意' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('approved');
    const v = db.prepare('SELECT org_id, org FROM vehicle WHERE vin=?').get(vA);
    expect(v.org_id).toBe(orgB);
    expect(v.org).toBe('组织B');
  });

  it('只能对本单位车辆提交（越权 403）', async () => {
    const r = await request(app)
      .post('/api/admin/approvals/requests')
      .set(bearer(engTok))
      .send({ kind: 'org_change', targetType: 'vehicle', vin: vB, orgId: orgA });
    expect(r.status).toBe(403);
  });

  it('车架号不存在 / 未指定目标 → 400', async () => {
    const r1 = await request(app)
      .post('/api/admin/approvals/requests')
      .set(bearer(engTok))
      .send({ kind: 'org_change', targetType: 'vehicle', vin: 'NOPE', orgId: orgB });
    expect(r1.status).toBe(404);
    const r2 = await request(app)
      .post('/api/admin/approvals/requests')
      .set(bearer(engTok))
      .send({ kind: 'org_change', targetType: 'vehicle', vin: vA });
    expect(r2.status).toBe(400);
  });

  it('流程配置仅管理员可见/可改（非管理员 403）', async () => {
    expect((await request(app).get('/api/admin/approvals/flows').set(bearer(aTok))).status).toBe(403);
    expect((await request(app).post('/api/admin/approvals/flows').set(bearer(aTok)).send({ code: 'x', name: 'x' })).status).toBe(403);
    expect((await request(app).get('/api/admin/approvals/flows').set(bearer(root))).status).toBe(200);
  });
});
