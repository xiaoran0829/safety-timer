import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { startSession, stopSession } from '../services/timer.js';
import { buildMatrix } from '../services/export.js';
import { fmtDay } from '../lib/time.js';

const PAX = 'cr01-pass';

let db;
let app;
let auth;

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: PAX });
  const r = await request(app).post('/api/admin/login').send({ password: PAX });
  auth = { Authorization: `Bearer ${r.body.data.token}` };
});

const mk = (url, body) => request(app).post(url).set(auth).send(body);

describe('CR-01 字典 CRUD / 软删 / 导入', () => {
  it('组织：POST/PUT + 重名冲突 + 软删(active=0)', async () => {
    const c = await mk('/api/admin/organizations', { name: '某组织A', code: 'ORG-A', sort: 1 });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ name: '某组织A', code: 'ORG-A', active: 1 });
    const id = c.body.data.id;

    const dup = await mk('/api/admin/organizations', { name: '某组织A' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CONFLICT');

    const upd = await request(app).put(`/api/admin/organizations/${id}`).set(auth).send({ code: 'ORG-A2' });
    expect(upd.body.data.code).toBe('ORG-A2');

    const del = await request(app).delete(`/api/admin/organizations/${id}`).set(auth);
    expect(del.body.data.active).toBe(0);
    const list = await request(app).get('/api/admin/organizations?active=1').set(auth);
    expect(list.body.data.find((o) => o.id === id)).toBeUndefined();
  });

  it('供应商：CSV 导入（multipart，表头 + 重复跳过）', async () => {
    await mk('/api/admin/suppliers', { name: '某供应商A' });
    const csv = 'name,code,sort\n某供应商A,SUP-A,1\n某供应商B,SUP-B,2\n';
    const r = await request(app)
      .post('/api/admin/suppliers/import')
      .set(auth)
      .attach('file', Buffer.from(csv, 'utf8'), 'sup.csv');
    expect(r.status).toBe(201);
    expect(r.body.data.inserted).toBe(1);
    expect(r.body.data.skipped).toBe(1);
    const list = await request(app).get('/api/admin/suppliers?active=1').set(auth);
    expect(list.body.data.map((s) => s.name).sort()).toEqual(['某供应商A', '某供应商B']);
  });

  it('发起人：CRUD + 导入（department 字段）', async () => {
    const c = await mk('/api/admin/initiators', { name: '张三', department: '技术部' });
    expect(c.status).toBe(201);
    expect(c.body.data.department).toBe('技术部');
    const csv = 'name,department,sort\n李四,生产部,2\n王五,质量部,3\n';
    const r = await request(app)
      .post('/api/admin/initiators/import')
      .set(auth)
      .attach('file', Buffer.from(csv, 'utf8'), 'ini.csv');
    expect(r.body.data.inserted).toBe(2);
    // 未登录不可访问
    const anon = await request(app).get('/api/admin/initiators');
    expect(anon.status).toBe(401);
  });
});

describe('CR-01 安全员扩展（工号/分组/在职）', () => {
  it('后台 CRUD 支持 employeeNo/groupName/employed；选人页只列在职+启用', async () => {
    const a = await mk('/api/admin/operators', { name: '张伟', label: '安全员A', employeeNo: 'E001', groupName: '一组', sort: 10 });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ employeeNo: 'E001', groupName: '一组', employed: 1 });

    const b = await mk('/api/admin/operators', { name: '李强', employeeNo: 'E002', groupName: '二组', employed: 0 });
    expect(b.body.data.employed).toBe(0);

    // 公共选人接口：只返回 active=1 AND employed=1，含 employeeNo/groupName
    const pub = await request(app).get('/api/operators?active=1');
    expect(pub.body.data).toHaveLength(1);
    expect(pub.body.data[0]).toMatchObject({ name: '张伟', employeeNo: 'E001', groupName: '一组' });

    // 后台接口可见离职者
    const adm = await request(app).get('/api/admin/operators').set(auth);
    expect(adm.body.data.find((o) => o.name === '李强').employed).toBe(0);

    // PUT 切回在职
    const upd = await request(app).put(`/api/admin/operators/${b.body.data.id}`).set(auth).send({ employed: 1 });
    expect(upd.body.data.employed).toBe(1);
    const pub2 = await request(app).get('/api/operators?active=1');
    expect(pub2.body.data).toHaveLength(2);
  });

  it('CSV 导入支持工号/分组/在职列（含表头映射）', async () => {
    const csv = 'name,label,phone,employee_no,group_name,employed,sort\n赵六,安全员E,13800000000,E100,一组,1,3\n钱七,安全员F,,E101,二组,0,4\n';
    const r = await request(app)
      .post('/api/admin/operators/import')
      .set(auth)
      .attach('file', Buffer.from(csv, 'utf8'), 'ops.csv');
    expect(r.status).toBe(201);
    expect(r.body.data.inserted).toBe(2);
    const adm = await request(app).get('/api/admin/operators').set(auth);
    const zhao = adm.body.data.find((o) => o.name === '赵六');
    expect(zhao).toMatchObject({ employeeNo: 'E100', groupName: '一组', employed: 1 });
    // 离职者不在选人页
    const pub = await request(app).get('/api/operators?active=1');
    expect(pub.body.data.find((o) => o.name === '钱七')).toBeUndefined();
  });
});

describe('CR-01 车架号挂靠 + 快照 + 导出带出', () => {
  async function seedDictsAndVehicle() {
    const org = await mk('/api/admin/organizations', { name: '某组织A' });
    const sup = await mk('/api/admin/suppliers', { name: '某供应商A' });
    const init = await mk('/api/admin/initiators', { name: '张三' });
    const veh = await mk('/api/admin/vehicles', {
      vin: 'LSVAB1234K5678901',
      station: '工位A',
      org_id: org.body.data.id,
      supplier_id: sup.body.data.id,
      default_initiator_id: init.body.data.id,
    });
    return { org: org.body.data, sup: sup.body.data, init: init.body.data, veh: veh.body.data };
  }

  it('车架号 CRUD 挂靠：返回 orgName/supplierName/defaultInitiator*，引用非法 → 400', async () => {
    const { org, sup, init, veh } = await seedDictsAndVehicle();
    expect(veh).toMatchObject({
      orgId: org.id,
      supplierId: sup.id,
      defaultInitiatorId: init.id,
      orgName: '某组织A',
      supplierName: '某供应商A',
      defaultInitiatorName: '张三',
    });

    const list = await request(app).get('/api/vehicles?active=1');
    expect(list.body.data[0]).toMatchObject({
      orgName: '某组织A',
      supplierName: '某供应商A',
      defaultInitiatorId: init.id,
      defaultInitiatorName: '张三',
    });

    const bad = await mk('/api/admin/vehicles', { vin: 'XBAD', org_id: 99999 });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION');
  });

  it('start 快照：落 org/supplier 名称；发起人=排班下发人（CR-08 批2 #4）', async () => {
    const { org, sup, init, veh } = await seedDictsAndVehicle();
    const opId = Number(db.prepare("INSERT INTO operator(name,label) VALUES('张伟','安全员A')").run().lastInsertRowid);
    // 今日排班（下发人=张三）→ 发起人快照取 created_by（不再取车辆默认发起人）
    db.prepare(
      "INSERT INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,created_by) VALUES(?,NULL,?,?,'planned','张三')"
    ).run(fmtDay(), opId, veh.id);

    const { session } = startSession(db, { operatorId: opId, vehicleId: veh.id });
    expect(session).toMatchObject({
      orgName: '某组织A',
      supplierName: '某供应商A',
      initiatorId: null,
      initiatorName: '张三',
    });
    const row = db.prepare('SELECT org_name,supplier_name,initiator_id,initiator_name FROM timer_session WHERE id=?').get(session.id);
    expect(row).toEqual({ org_name: '某组织A', supplier_name: '某供应商A', initiator_id: null, initiator_name: '张三' });

    // 导出 3 列自动带出
    stopSession(db, session.id, opId);
    const m = buildMatrix(db, {});
    const r = m[1];
    expect(r[0]).toBe('某组织A'); // 组织（快照）
    expect(r[1]).toBe('某供应商A'); // 供应商（快照）
    expect(r[5]).toBe('张三'); // 发起人（快照）
    expect(r[7]).toBe(''); // 里程仍留空
    expect(r[9]).toMatch(/^\d+\.\d{2}$/); // 有效计费时长（h）
    expect(r[10]).toBe('');
    expect(r[11]).toBe('');

    // 快照稳定：档案改名/删除不影响历史导出
    db.prepare('UPDATE organization SET name=? WHERE id=?').run('改名后组织', org.id);
    const m2 = buildMatrix(db, {});
    expect(m2[1][0]).toBe('某组织A');
  });

  it('start 可选 initiatorId 覆盖默认发起人', async () => {
    const { veh, init } = await seedDictsAndVehicle();
    const other = await mk('/api/admin/initiators', { name: '李四' });
    const opId = Number(db.prepare("INSERT INTO operator(name,label) VALUES('李强','安全员B')").run().lastInsertRowid);

    const { session } = startSession(db, { operatorId: opId, vehicleId: veh.id, initiatorId: other.body.data.id });
    expect(session.initiatorId).toBe(other.body.data.id);
    expect(session.initiatorName).toBe('李四');
    expect(session.initiatorId).not.toBe(init.id);

    // 非法 initiatorId → VALIDATION（换一辆车：批2 #7 同人同车当天结束锁定，不能复用 veh.id）
    stopSession(db, session.id, opId);
    const veh2 = Number(db.prepare("INSERT INTO vehicle(vin,station) VALUES('LSVAB1234K5678902','工位B')").run().lastInsertRowid);
    expect(() => startSession(db, { operatorId: opId, vehicleId: veh2, initiatorId: 99999 })).toThrowError(/发起人不存在/);
  });

  it('HTTP start 透传 initiatorId（路由层）', async () => {
    const { veh } = await seedDictsAndVehicle();
    const other = await mk('/api/admin/initiators', { name: '李四' });
    const opId = Number(db.prepare("INSERT INTO operator(name,label) VALUES('王芳','安全员C')").run().lastInsertRowid);
    const r = await request(app).post('/api/sessions/start').send({ operatorId: opId, vehicleId: veh.id, initiatorId: other.body.data.id });
    expect(r.status).toBe(201);
    expect(r.body.data.session.initiatorName).toBe('李四');
  });
});
