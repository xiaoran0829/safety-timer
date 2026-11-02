import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { seed } from '../seed.js';
import { startSession, stopSession } from '../services/timer.js';
import { buildMatrix } from '../services/export.js';
import { fmtDay } from '../lib/time.js';

const PAX = 'cr01b-pass';

let db;
let app;
let auth;

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: PAX });
  const r = await request(app).post('/api/admin/login').send({ password: PAX });
  auth = { Authorization: `Bearer ${r.body.data.token}` };
});

const VIN1 = 'LSVAB1234K5678901';

describe('CR-01-BE2 seed 幂等回填', () => {
  it('已存在车架号（无挂靠）被按 VIN 回填 org/supplier/initiator', () => {
    // 模拟历史遗留：先建一台同 VIN 但无挂靠的车
    db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES(?,?,1)").run(VIN1, '旧工位');
    const before = db.prepare('SELECT org_id,supplier_id,default_initiator_id FROM vehicle WHERE vin=?').get(VIN1);
    expect(before).toEqual({ org_id: null, supplier_id: null, default_initiator_id: null });

    seed(db);

    const row = db
      .prepare(
        `SELECT v.org_id, v.supplier_id, v.default_initiator_id,
                o.name AS org_name, s.name AS sup_name, i.name AS init_name
           FROM vehicle v
           LEFT JOIN organization o ON o.id=v.org_id
           LEFT JOIN supplier s     ON s.id=v.supplier_id
           LEFT JOIN initiator i    ON i.id=v.default_initiator_id
          WHERE v.vin=?`
      )
      .get(VIN1);
    // 车1 → org1/sup1/init1
    expect(row).toMatchObject({
      org_name: '某组织A',
      sup_name: '某供应商A',
      init_name: '张三',
    });
    expect(row.org_id).toBeGreaterThan(0);
    expect(row.supplier_id).toBeGreaterThan(0);
    expect(row.default_initiator_id).toBeGreaterThan(0);
  });

  it('重复运行结果一致（幂等：计数不变、挂靠稳定）', () => {
    seed(db);
    const snap1 = {
      veh: db.prepare('SELECT COUNT(*) n FROM vehicle').get().n,
      orgs: db.prepare('SELECT COUNT(*) n FROM organization').get().n,
      sups: db.prepare('SELECT COUNT(*) n FROM supplier').get().n,
      inits: db.prepare('SELECT COUNT(*) n FROM initiator').get().n,
      ops: db.prepare('SELECT COUNT(*) n FROM operator').get().n,
      links: db.prepare('SELECT vin,org_id,supplier_id,default_initiator_id FROM vehicle ORDER BY vin').all(),
    };
    seed(db);
    seed(db);
    const snap2 = {
      veh: db.prepare('SELECT COUNT(*) n FROM vehicle').get().n,
      orgs: db.prepare('SELECT COUNT(*) n FROM organization').get().n,
      sups: db.prepare('SELECT COUNT(*) n FROM supplier').get().n,
      inits: db.prepare('SELECT COUNT(*) n FROM initiator').get().n,
      ops: db.prepare('SELECT COUNT(*) n FROM operator').get().n,
      links: db.prepare('SELECT vin,org_id,supplier_id,default_initiator_id FROM vehicle ORDER BY vin').all(),
    };
    expect(snap2).toEqual(snap1);
    // 4 台车全部挂靠齐全
    expect(snap1.links).toHaveLength(4);
    expect(snap1.links.every((v) => v.org_id && v.supplier_id && v.default_initiator_id)).toBe(true);
  });
});

describe('CR-01-BE2 公开 GET /api/initiators', () => {
  it('仅返回 active=1，按 sort 升序，字段 {id,name,department}', async () => {
    db.prepare("INSERT INTO initiator(name,department,active,sort) VALUES('张三','技术部',1,20)").run();
    db.prepare("INSERT INTO initiator(name,department,active,sort) VALUES('李四','生产部',1,10)").run();
    db.prepare("INSERT INTO initiator(name,department,active,sort) VALUES('停用者','已离职',0,5)").run();

    const r = await request(app).get('/api/initiators');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.map((i) => i.name)).toEqual(['李四', '张三']); // sort 10 < 20，停用者不出现
    expect(Object.keys(r.body.data[0]).sort()).toEqual(['department', 'id', 'name']);
    expect(r.body.data.find((i) => i.name === '停用者')).toBeUndefined();
  });

  it('公开可访问（无需登录），与后台接口语义区分', async () => {
    db.prepare("INSERT INTO initiator(name,department,active,sort) VALUES('张三','技术部',1,10)").run();
    db.prepare("INSERT INTO initiator(name,department,active,sort) VALUES('王五','质量部',0,20)").run();

    const pub = await request(app).get('/api/initiators'); // 无鉴权
    expect(pub.status).toBe(200);
    expect(pub.body.data).toHaveLength(1);

    const adm = await request(app).get('/api/admin/initiators').set(auth);
    expect(adm.status).toBe(200);
    expect(adm.body.data).toHaveLength(2); // 后台可见停用
    expect(adm.body.data[0]).toHaveProperty('active');
  });
});

describe('CR-01-BE2 后台别名 /api/admin/sessions 与 /api/admin/export', () => {
  async function stopOneWithLink() {
    const org = Number(db.prepare("INSERT INTO organization(name) VALUES('某组织A')").run().lastInsertRowid);
    const sup = Number(db.prepare("INSERT INTO supplier(name) VALUES('某供应商A')").run().lastInsertRowid);
    const init = Number(db.prepare("INSERT INTO initiator(name,department) VALUES('张三','技术部')").run().lastInsertRowid);
    const op = Number(db.prepare("INSERT INTO operator(name,label) VALUES('张伟','安全员A')").run().lastInsertRowid);
    const v = Number(
      db
        .prepare('INSERT INTO vehicle(vin,station,org_id,supplier_id,default_initiator_id) VALUES(?,?,?,?,?)')
        .run(VIN1, '工位A', org, sup, init).lastInsertRowid
    );
    // CR-08 批2 #4：发起人 = 排班下发人（created_by），不再取车辆默认发起人
    db.prepare(
      "INSERT INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,created_by) VALUES(?, NULL, ?, ?, 'planned', '张三')"
    ).run(fmtDay(), op, v);
    const { session } = startSession(db, { operatorId: op, vehicleId: v });
    stopSession(db, session.id, op);
    return { session, op, org, sup, init, v };
  }

  it('/api/admin/sessions 需登录且语义同公开（total/list）', async () => {
    await stopOneWithLink();

    const anon = await request(app).get('/api/admin/sessions');
    expect(anon.status).toBe(401);

    const adm = await request(app).get('/api/admin/sessions?page=1&pageSize=50').set(auth);
    const pub = await request(app).get('/api/sessions?page=1&pageSize=50');
    expect(adm.status).toBe(200);
    expect(adm.body.data.total).toBe(pub.body.data.total);
    expect(adm.body.data.list.map((s) => s.id)).toEqual(pub.body.data.list.map((s) => s.id));
  });

  it('/api/admin/export 需登录，13 列定序且组织/供应商/发起人 3 列带出', async () => {
    await stopOneWithLink();

    const anon = await request(app).get('/api/admin/export?format=csv');
    expect(anon.status).toBe(401);

    const adm = await request(app).get('/api/admin/export?format=csv').set(auth);
    expect(adm.status).toBe(200);
    expect(adm.headers['content-type']).toContain('text/csv');
    const csv = adm.text.replace(/^\ufeff/, '');
    expect(csv.split('\r\n')[0]).toContain(
      '组织,供应商,车架号,工单号,试验开始时间,发起人,安全员,实验总里程,试验实际时长,有效计费时长（h）,总计费时长,不计费时长'
    );
    const cols = csv.trim().split(/\r?\n/)[1].split(',');
    expect(cols[0]).toBe('某组织A');
    expect(cols[1]).toBe('某供应商A');
    expect(cols[5]).toBe('张三');
    expect(cols[7]).toBe('');
    expect(cols[9]).toMatch(/^\d+\.\d{2}$/); // 有效计费时长（h）
    expect(cols[10]).toBe('');
    expect(cols[11]).toBe('');

    // 与公开导出一致
    const pub = await request(app).get('/api/export?format=csv');
    expect(pub.text).toBe(adm.text);
    // 矩阵校验 3 列带出
    const m = buildMatrix(db, {});
    expect([m[1][0], m[1][1], m[1][5]]).toEqual(['某组织A', '某供应商A', '张三']);
  });
});
