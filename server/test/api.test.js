import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';

let db;
let app;
let opId;
let vId;

const PAX = 'test-pass';

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: PAX });
  opId = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('张伟','安全员A',10)").run().lastInsertRowid);
  vId = Number(db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES('LSVAB1234K5678901','工位A',1)").run().lastInsertRowid);
});

describe('API 契约（冻结规格 §5）', () => {
  it('GET /api/operators 成功包装 {ok:true,data}', async () => {
    const res = await request(app).get('/api/operators?active=1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data[0]).toMatchObject({ name: '张伟', label: '安全员A' });
  });

  it('start 201 → 重复 start 409 OPERATOR_BUSY + activeSession', async () => {
    const r1 = await request(app).post('/api/sessions/start').send({ operatorId: opId, vehicleId: vId });
    expect(r1.status).toBe(201);
    expect(r1.body.data.session.workOrderNo).toMatch(/^WO-\d{8}-001$/);
    const r2 = await request(app).post('/api/sessions/start').send({ operatorId: opId, vehicleId: vId });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('OPERATOR_BUSY');
    expect(r2.body.data.activeSession.id).toBe(r1.body.data.session.id);
  });

  it('C6 幂等：带相同 Idempotency-Key 重放不重复建', async () => {
    const key = 'idem-abc';
    const r1 = await request(app).post('/api/sessions/start').set('Idempotency-Key', key).send({ operatorId: opId, vehicleId: vId });
    const r2 = await request(app).post('/api/sessions/start').set('Idempotency-Key', key).send({ operatorId: opId, vehicleId: vId });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.body.data.session.id).toBe(r1.body.data.session.id);
    expect(db.prepare('SELECT COUNT(*) n FROM timer_session').get().n).toBe(1);
  });

  it('pause/resume/stop + active 查询', async () => {
    const st = await request(app).post('/api/sessions/start').send({ operatorId: opId, vehicleId: vId });
    const sid = st.body.data.session.id;

    let a = await request(app).get(`/api/sessions/active?operatorId=${opId}`);
    expect(a.body.data.session.status).toBe('running');

    const pa = await request(app).post(`/api/sessions/${sid}/pause`).send({ operatorId: opId, remark: 'API 流程-暂停备注' });
    expect(pa.body.data.session.status).toBe('paused');
    const re = await request(app).post(`/api/sessions/${sid}/resume`).send({ operatorId: opId });
    expect(re.body.data.session.status).toBe('running');
    const sp = await request(app).post(`/api/sessions/${sid}/stop`).send({ operatorId: opId });
    expect(sp.body.data.session.status).toBe('stopped');

    a = await request(app).get(`/api/sessions/active?operatorId=${opId}`);
    expect(a.body.data).toBeNull();
  });

  it('非法状态转移 → 409 INVALID_STATE', async () => {
    const st = await request(app).post('/api/sessions/start').send({ operatorId: opId, vehicleId: vId });
    const sid = st.body.data.session.id;
    const r = await request(app).post(`/api/sessions/${sid}/resume`).send({ operatorId: opId });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('INVALID_STATE');
  });

  it('越权操作 → 403 FORBIDDEN', async () => {
    const other = Number(db.prepare("INSERT INTO operator(name) VALUES('李强')").run().lastInsertRowid);
    const st = await request(app).post('/api/sessions/start').send({ operatorId: opId, vehicleId: vId });
    const r = await request(app).post(`/api/sessions/${st.body.data.session.id}/pause`).send({ operatorId: other, remark: '越权测试' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
  });

  it('备注 201 + 带时间戳', async () => {
    const st = await request(app).post('/api/sessions/start').send({ operatorId: opId, vehicleId: vId });
    const sid = st.body.data.session.id;
    const r = await request(app).post(`/api/sessions/${sid}/remarks`).send({ operatorId: opId, content: '配合吊装作业，暂停计时' });
    expect(r.status).toBe(201);
    expect(r.body.data.remark.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(r.body.data.remark.content).toBe('配合吊装作业，暂停计时');
  });

  it('vehicles 含 occupied 占用态', async () => {
    await request(app).post('/api/sessions/start').send({ operatorId: opId, vehicleId: vId });
    const r = await request(app).get('/api/vehicles?active=1');
    expect(r.body.data[0].occupied).toMatchObject({ operatorName: '张伟' });
    expect(typeof r.body.data[0].occupied.sessionId).toBe('number');
  });

  it('GET /api/sessions 列表分页', async () => {
    const st = await request(app).post('/api/sessions/start').send({ operatorId: opId, vehicleId: vId });
    await request(app).post(`/api/sessions/${st.body.data.session.id}/stop`).send({ operatorId: opId });
    const r = await request(app).get('/api/sessions?page=1&pageSize=50');
    expect(r.body.data.total).toBe(1);
    expect(r.body.data.list[0].status).toBe('stopped');
  });

  it('GET /api/sessions/:id 详情（session+segments+remarks）', async () => {
    const st = await request(app).post('/api/sessions/start').send({ operatorId: opId, vehicleId: vId });
    const sid = st.body.data.session.id;
    const r = await request(app).get(`/api/sessions/${sid}`);
    expect(r.body.data.session.id).toBe(sid);
    expect(Array.isArray(r.body.data.segments)).toBe(true);
    expect(Array.isArray(r.body.data.remarks)).toBe(true);
  });

  it('参数非法 → 400 VALIDATION', async () => {
    const r = await request(app).post('/api/sessions/start').send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION');
  });
});

describe('导出 API（§5.4 / §6）', () => {
  async function stopOne() {
    const st = await request(app).post('/api/sessions/start').send({ operatorId: opId, vehicleId: vId });
    await request(app).post(`/api/sessions/${st.body.data.session.id}/stop`).send({ operatorId: opId });
  }

  it('csv：Content-Disposition + BOM + 定序表头', async () => {
    await stopOne();
    const res = await request(app).get('/api/export?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text).toContain('组织,供应商,车架号,工单号,试验开始时间,发起人,安全员,实验总里程,试验实际时长,有效计费时长（h）,总计费时长,不计费时长');
  });

  it('xlsx：返回二进制 + 文件名安全员计时_*.xlsx', async () => {
    await stopOne();
    const res = await request(app).get('/api/export?format=xlsx').buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('attachment');
    // 文件名含中文 → 以 RFC5987 编码下发
    const cd = res.headers['content-disposition'];
    expect(cd).toContain("filename*=UTF-8''");
    const encoded = /filename\*=UTF-8''([^;]+)/.exec(cd)[1];
    expect(decodeURIComponent(encoded)).toMatch(/^安全员计时_\d{8}\.xlsx$/);
    expect(res.body.length).toBeGreaterThan(1000);
  });
});

describe('后台（§5.5）：鉴权 + CRUD + 软删 + CSV 导入', () => {
  it('未登录访问后台 → 401 UNAUTHORIZED', async () => {
    const r = await request(app).get('/api/admin/operators');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('UNAUTHORIZED');
  });

  it('错口令 → 401；对口令 → 下发 token', async () => {
    const bad = await request(app).post('/api/admin/login').send({ password: 'nope' });
    expect(bad.status).toBe(401);
    const ok = await request(app).post('/api/admin/login').send({ password: PAX });
    expect(ok.status).toBe(200);
    expect(ok.body.data.token).toBeTruthy();
  });

  async function login() {
    const r = await request(app).post('/api/admin/login').send({ password: PAX });
    return r.body.data.token;
  }

  it('安全员 CRUD + 软删', async () => {
    const token = await login();
    const auth = { Authorization: `Bearer ${token}` };
    const created = await request(app).post('/api/admin/operators').set(auth).send({ name: '王五', label: '安全员C', employeeNo: 'E0005', sort: 5 });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const dup = await request(app).post('/api/admin/operators').set(auth).send({ name: '王五', employeeNo: 'E0005' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CONFLICT');

    const upd = await request(app).put(`/api/admin/operators/${id}`).set(auth).send({ label: '安全员D' });
    expect(upd.body.data.label).toBe('安全员D');

    const del = await request(app).delete(`/api/admin/operators/${id}`).set(auth);
    expect(del.body.data.active).toBe(0); // 软删
    // 软删后不出现在 active 列表
    const list = await request(app).get('/api/operators?active=1');
    expect(list.body.data.find((o) => o.id === id)).toBeUndefined();
  });

  it('车架号 CRUD + 软删 + 唯一约束', async () => {
    const token = await login();
    const auth = { Authorization: `Bearer ${token}` };
    const created = await request(app).post('/api/admin/vehicles').set(auth).send({ vin: 'NEWVIN0001', station: '工位Z' });
    expect(created.status).toBe(201);
    const dup = await request(app).post('/api/admin/vehicles').set(auth).send({ vin: 'NEWVIN0001' });
    expect(dup.status).toBe(409);
    const del = await request(app).delete(`/api/admin/vehicles/${created.body.data.id}`).set(auth);
    expect(del.body.data.active).toBe(0);
  });

  it('CSV 导入安全员（含表头 + 重复跳过）', async () => {
    const token = await login();
    const auth = { Authorization: `Bearer ${token}` };
    const csv = 'name,label,phone,sort\n赵六,安全员E,13800000000,3\n张伟,安全员A,,10\n钱七,安全员F,,4\n';
    const r = await request(app)
      .post('/api/admin/operators/import')
      .set(auth)
      .attach('file', Buffer.from(csv, 'utf8'), 'ops.csv');
    expect(r.status).toBe(201);
    expect(r.body.data.inserted).toBe(2); // 赵六、钱七
    expect(r.body.data.skipped).toBe(1); // 张伟已存在
  });

  it('CSV 导入车架号', async () => {
    const token = await login();
    const auth = { Authorization: `Bearer ${token}` };
    const csv = 'vin,station,org,supplier,sort\nLSVAB1234K5678910,工位A,,,1\nLSVAB1234K5678911,工位B,,,2\n';
    const r = await request(app)
      .post('/api/admin/vehicles/import')
      .set(auth)
      .attach('file', Buffer.from(csv, 'utf8'), 'veh.csv');
    expect(r.status).toBe(201);
    expect(r.body.data.inserted).toBe(2);
  });

  it('logout 后 token 失效', async () => {
    const token = await login();
    await request(app).post('/api/admin/logout').set('Authorization', `Bearer ${token}`);
    const r = await request(app).get('/api/admin/operators').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(401);
  });
});
