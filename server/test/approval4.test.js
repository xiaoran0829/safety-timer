// 2026-10-08 老板第二批需求：SP 单号 / 可见范围下拉 / 未完结工单禁调配 / 自定义申请字段 / 强制结束走审批
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let db, app, root, orgA, orgB, supA, engId, engTok, flowId, runSid;

const mkUser = async (username, role, orgId) => {
  const r = await request(app).post('/api/admin/users').set(bearer(root)).send({ username, password: 'abc123', role, orgId, mustChange: false });
  const t = (await request(app).post('/api/admin/login').send({ username, password: 'abc123' })).body.data.token;
  return { id: r.body.data.id, token: t };
};
const submit = (b, tok = engTok) => request(app).post('/api/admin/approvals/requests').set(bearer(tok)).send(b);

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: 'p-appr4', adminUser: '管理员' });
  orgA = Number(db.prepare("INSERT INTO organization(name,code,active,sort,see_all) VALUES('组织A','A',1,1,0)").run().lastInsertRowid);
  orgB = Number(db.prepare("INSERT INTO organization(name,code,active,sort,see_all) VALUES('组织B','B',1,2,0)").run().lastInsertRowid);
  supA = Number(db.prepare("INSERT INTO supplier(name,code,active,sort) VALUES('供应商A','SA',1,1)").run().lastInsertRowid);
  for (const [vin, org] of [['VIN-A', orgA], ['VIN-B', orgA], ['VIN-C', orgB]]) {
    db.prepare('INSERT INTO vehicle(vin,station,org_id,supplier_id,active,sort) VALUES(?,?,?,?,1,0)').run(vin, '站', org, supA);
  }
  const opId = Number(db.prepare("INSERT INTO operator(name) VALUES('张三')").run().lastInsertRowid);
  const vB = db.prepare('SELECT id FROM vehicle WHERE vin=?').get('VIN-B').id;
  runSid = Number(
    db
      .prepare("INSERT INTO timer_session(work_order_no,operator_id,vehicle_id,operator_name,vin,status,start_at,net_seconds) VALUES('WO-RUN',?,?,'张三','VIN-B','running','2026-10-08 06:00:00',600)")
      .run(opId, vB).lastInsertRowid
  );
  root = (await request(app).post('/api/admin/login').send({ password: 'p-appr4' })).body.data.token;
  const eng = await mkUser('eng1', 'engineer', orgA);
  engId = eng.id;
  engTok = eng.token;
  flowId = (await request(app).get('/api/admin/approvals/flows').set(bearer(root))).body.data.find((f) => f.code === 'org_change').id;
});

describe('审批中心 · 第二批', () => {
  it('审批单号 = SP-YYYYMMDD001 且逐号递增', async () => {
    const r1 = await submit({ kind: 'org_change', targetUserId: engId, orgId: orgB });
    expect(r1.status).toBe(201);
    expect(r1.body.data.no).toMatch(/^SP-\d{8}\d{3}$/);
    const r2 = await submit({ kind: 'org_change', targetUserId: engId, orgId: orgB });
    const n1 = Number(r1.body.data.no.slice(-3));
    expect(Number(r2.body.data.no.slice(-3))).toBe(n1 + 1);
  });

  it('/options 只返回申请人可见车辆，并标记未完结工单', async () => {
    const o = await request(app).get('/api/admin/approvals/options').set(bearer(engTok));
    expect(o.body.data.vehicles.map((v) => v.vin)).toEqual(['VIN-A', 'VIN-B']); // 不含 orgB 的 VIN-C
    expect(o.body.data.vehicles.find((v) => v.vin === 'VIN-B').busy).toBe(true);
    expect(o.body.data.vehicles.find((v) => v.vin === 'VIN-A').busy).toBe(false);
    const all = await request(app).get('/api/admin/approvals/options').set(bearer(root));
    expect(all.body.data.vehicles.length).toBe(3);
  });

  it('车辆有未完结工单 → 不允许调配（409）', async () => {
    const r = await submit({ kind: 'org_change', vin: 'VIN-B', orgId: orgB });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('INVALID_STATE');
  });

  it('无未完结工单的车辆可正常提交（201）', async () => {
    const r = await submit({ kind: 'org_change', vin: 'VIN-A', orgId: orgB });
    expect(r.status).toBe(201);
    expect(r.body.data.payload.vin).toBe('VIN-A');
  });

  it('流程可自定义申请字段（生效 + 必填校验）', async () => {
    const put = await request(app)
      .put(`/api/admin/approvals/flows/${flowId}`)
      .set(bearer(root))
      .send({
        fields: [
          { key: 'vin', label: '车架号', type: 'select', source: 'vehicles', required: true },
          { key: 'orgId', label: '目标组织', type: 'select', source: 'organizations', required: true },
        ],
      });
    expect(put.status).toBe(200);
    expect(put.body.data.fields.map((f) => f.key)).toEqual(['vin', 'orgId']);

    const bad = await submit({ kind: 'org_change', orgId: orgB });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION');

    const ok = await submit({ kind: 'org_change', vin: 'VIN-A', orgId: orgB });
    expect(ok.status).toBe(201);
    expect(Object.keys(ok.body.data.payload).sort()).toEqual(['orgId', 'supplierId', 'vin']);
  });

  it('非法字段定义 → 400', async () => {
    const bad = await request(app).put(`/api/admin/approvals/flows/${flowId}`).set(bearer(root)).send({ fields: [{ key: '1bad', label: 'x' }] });
    expect(bad.status).toBe(400);
  });

  it('强制结束进行中工单 → 先落审批（SP 单号），通过后才真的结束', async () => {
    const r = await request(app).post(`/api/admin/sessions/${runSid}/force-stop`).set(bearer(root)).send({ remark: '车辆异常' });
    expect(r.status).toBe(200);
    expect(r.body.data.pending).toBe(true);
    expect(r.body.data.request.no).toMatch(/^SP-/);
    // 尚未生效
    expect(db.prepare('SELECT status FROM timer_session WHERE id=?').get(runSid).status).toBe('running');
    // 审批通过
    const ap = await request(app).post(`/api/admin/approvals/requests/${r.body.data.request.id}/approve`).set(bearer(root)).send({ comment: 'ok' });
    expect(ap.body.data.status).toBe('approved');
    expect(db.prepare('SELECT status FROM timer_session WHERE id=?').get(runSid).status).toBe('stopped');
  });

  it('flow-options 列出可用流程（含 org_change / force_stop）', async () => {
    const r = await request(app).get('/api/admin/approvals/flow-options').set(bearer(engTok));
    const codes = r.body.data.map((f) => f.code);
    expect(codes).toContain('org_change');
    expect(codes).toContain('force_stop');
  });

  it('申请字段名支持中文，且能自动对上车架号/目标组织', async () => {
    const put = await request(app)
      .put(`/api/admin/approvals/flows/${flowId}`)
      .set(bearer(root))
      .send({
        fields: [
          { key: '车架号', label: '车架号', type: 'select', source: 'vehicles', required: true },
          { key: '目标组织', label: '目标组织', type: 'select', source: 'organizations', required: true },
          { key: '申请说明', label: '申请说明', type: 'textarea' },
        ],
      });
    expect(put.status).toBe(200);
    expect(put.body.data.fields.map((f) => f.key)).toEqual(['车架号', '目标组织', '申请说明']);

    const ok = await submit({ kind: 'org_change', 车架号: 'VIN-A', 目标组织: orgB, 申请说明: '  转组织  ' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.payload['车架号']).toBe('VIN-A');
    expect(ok.body.data.payload['申请说明']).toBe('转组织');
    // 语义别名：中文名也能正常改绑
    expect(ok.body.data.payload.vin).toBe('VIN-A');
    expect(ok.body.data.payload.orgId).toBe(orgB);

    const bad = await request(app).put(`/api/admin/approvals/flows/${flowId}`).set(bearer(root)).send({ fields: [{ key: 'a b', label: 'x' }] });
    expect(bad.status).toBe(400);
  });
});
