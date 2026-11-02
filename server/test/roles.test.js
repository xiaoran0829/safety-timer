// CR-10 后端验收：后台角色（admin|engineer|fleet_admin）+ 模块级权限（前端藏菜单不算权限，后端必须 403）。
// 覆盖：越权拒绝（负向） + 授权放行（正向） + 读写分离 + 存量库幂等补列默认 admin + 改角色即时生效 + 防锁死。
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { openDb, migrate } from '../db.js';
import { createApp } from '../app.js';
import { hashPassword } from '../middleware/auth.js';

const ROOT_PASS = 'root-pass-123';
const ROOT_USER = '管理员';
const PWD = 'pwd123456';

let db;
let app;
let shiftId;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: ROOT_PASS, adminUser: ROOT_USER });
  shiftId = db.prepare('SELECT id FROM shift ORDER BY id ASC LIMIT 1').get().id;
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const rootLogin = async () => {
  const r = await request(app).post('/api/admin/login').send({ password: ROOT_PASS });
  expect(r.status).toBe(200);
  return r.body.data.token;
};

/** 建号（root）并登录，返回 token */
async function newAccount(username, role) {
  const root = await rootLogin();
  const c = await request(app).post('/api/admin/users').set(bearer(root)).send({ username, password: PWD, role, mustChange: false });
  expect(c.status).toBe(201);
  const l = await request(app).post('/api/admin/login').send({ username, password: PWD });
  expect(l.status).toBe(200);
  return { token: l.body.data.token, id: c.body.data.id, data: l.body.data };
}

/** 通用模块探测：返回各模块状态码（读/写） */
async function probe(token) {
  const g = (url) => request(app).get(url).set(bearer(token));
  const p = (url, body) => request(app).post(url).set(bearer(token)).send(body);
  return {
    usersRead: (await g('/api/admin/users')).status,
    usersWrite: (await p('/api/admin/users', { username: 'zzz' + Math.random(), password: PWD })).status,
    operatorsRead: (await g('/api/admin/operators')).status,
    operatorsWrite: (await p('/api/admin/operators', { name: '权限测试安全员' + Math.random(), employeeNo: 'E' + String(Math.random()).slice(2, 10) })).status,
    vehiclesRead: (await g('/api/admin/vehicles')).status,
    vehiclesWrite: (await p('/api/admin/vehicles', { vin: 'LSVAB1234K5678901' })).status,
    dictsRead: (await g('/api/admin/organizations')).status,
    dictsWrite: (await p('/api/admin/organizations', { name: '权限测试组织' + Math.random() })).status,
    schedulesRead: (await g('/api/admin/schedules')).status,
    sessionsRead: (await g('/api/admin/sessions')).status,
    detailRead: (await g('/api/admin/sessions/detail')).status,
    meRead: (await g('/api/admin/me')).status,
  };
}

describe('CR-10 后台角色 × 模块权限', () => {
  it('admin：全模块读写全通', async () => {
    const { token } = await newAccount('管理员A', 'admin');
    const s = await probe(token);
    expect(s).toMatchObject({
      usersRead: 200,
      operatorsRead: 200,
      vehiclesRead: 200,
      dictsRead: 200,
      schedulesRead: 200,
      sessionsRead: 200,
      detailRead: 200,
      meRead: 200,
    });
    // 写：users/operators/vehicles/dicts 均应成功（201）
    expect(s.usersWrite).toBe(201);
    expect(s.operatorsWrite).toBe(201);
    expect(s.vehiclesWrite).toBe(201);
    expect(s.dictsWrite).toBe(201);
  });

  it('engineer：账号管理 403（读+写）、改安全员 403；车架号/组织/排班等放行', async () => {
    const { token } = await newAccount('工程师A', 'engineer');
    const s = await probe(token);
    // 负向（硬指标）
    expect(s.usersRead).toBe(403);
    expect(s.usersWrite).toBe(403);
    expect(s.operatorsWrite).toBe(403); // 工程师不可改安全员
    // 正向
    expect(s.operatorsRead).toBe(200); // 读写分离：筛选用
    expect(s.vehiclesRead).toBe(200);
    expect(s.vehiclesWrite).toBe(201); // 工程师可改车架号
    expect(s.dictsWrite).toBe(201);
    expect(s.schedulesRead).toBe(200);
    expect(s.sessionsRead).toBe(200);
    expect(s.detailRead).toBe(200);
    // 排班：engineer 全放行（主人 15:49 口径）
    const sc = await request(app)
      .post('/api/admin/schedules')
      .set(bearer(token))
      .send({ workDate: '2026-10-01', shiftId, operatorId: 1, vehicleId: 1 });
    expect(sc.status).not.toBe(403);
  });

  it('fleet_admin：车架号写 403；安全员写放行；排班/计时/详细工时放行', async () => {
    const { token } = await newAccount('车队管理员A', 'fleet_admin');
    const s = await probe(token);
    // 负向（硬指标）
    expect(s.vehiclesWrite).toBe(403); // 车队管理员不可改车架号
    expect(s.usersRead).toBe(403); // 账号管理 admin 独占
    expect(s.usersWrite).toBe(403);
    // 正向
    expect(s.operatorsWrite).toBe(201); // 可改安全员
    expect(s.vehiclesRead).toBe(200);
    expect(s.dictsWrite).toBe(201);
    expect(s.schedulesRead).toBe(200);
    expect(s.sessionsRead).toBe(200);
    expect(s.detailRead).toBe(200);
    const sc = await request(app)
      .post('/api/admin/schedules')
      .set(bearer(token))
      .send({ workDate: '2026-10-02', shiftId, operatorId: 1, vehicleId: 1 });
    expect(sc.status).not.toBe(403);
  });

  it('越权响应码 = NO_PERMISSION / 403（不是 401，不得伪装未登录）', async () => {
    const { token } = await newAccount('工程师B', 'engineer');
    const r = await request(app).get('/api/admin/users').set(bearer(token));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('NO_PERMISSION');
  });

  it('未登录仍 401（权限闸门不改变原鉴权语义）', async () => {
    const r = await request(app).get('/api/admin/users');
    expect(r.status).toBe(401);
  });

  it('存量老库：幂等补列 role，默认 admin，登录不受影响；重复 migrate 不报错', async () => {
    const raw = new Database(':memory:');
    // 模拟 CR-03 时期的老库（无 role / 无 must_change_pwd / 无 pwd_ver）
    raw.exec(`
      CREATE TABLE admin_user (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        name TEXT NOT NULL,
        pwd_hash TEXT NOT NULL,
        pwd_salt TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
        updated_at TEXT
      );
    `);
    const { hash, salt } = hashPassword('old-pass-123');
    raw.prepare('INSERT INTO admin_user(username,name,pwd_hash,pwd_salt,active) VALUES(?,?,?,?,1)').run('老账号', '老王', hash, salt);

    migrate(raw);
    migrate(raw); // 幂等：再来一次不得抛
    const row = raw.prepare('SELECT role FROM admin_user WHERE username=?').get('老账号');
    expect(row.role).toBe('admin'); // 存量默认 admin

    const app2 = createApp({ db: raw, adminPassword: 'x', adminUser: 'x' });
    const l = await request(app2).post('/api/admin/login').send({ username: '老账号', password: 'old-pass-123' });
    expect(l.status).toBe(200); // 补列不破坏登录
    expect(l.body.data.user.role).toBe('admin');
    const t = l.body.data.token;
    expect((await request(app2).get('/api/admin/users').set(bearer(t))).status).toBe(200); // 老账号 → 全通
    const me = await request(app2).get('/api/admin/me').set(bearer(t));
    expect(me.body.data.role).toBe('admin');
  });

  it('改角色即时生效：engineer→admin 无需重登（同一 token）', async () => {
    const root = await rootLogin();
    await newAccount('守护管理员D', 'admin'); // 保证库内至少 2 个 admin，降级不被防锁死拦
    const { token, id } = await newAccount('工程师C', 'engineer');
    expect((await request(app).get('/api/admin/users').set(bearer(token))).status).toBe(403);

    const up = await request(app).put(`/api/admin/users/${id}`).set(bearer(root)).send({ role: 'admin' });
    expect(up.status).toBe(200);
    expect(up.body.data.role).toBe('admin');

    // 同一 token（未重登）→ 立即放行
    expect((await request(app).get('/api/admin/users').set(bearer(token))).status).toBe(200);
    const me = await request(app).get('/api/admin/me').set(bearer(token));
    expect(me.body.data.role).toBe('admin');

    // 反向：降级为 fleet_admin → 同一 token 立即被拒
    await request(app).put(`/api/admin/users/${id}`).set(bearer(root)).send({ role: 'fleet_admin' });
    expect((await request(app).get('/api/admin/users').set(bearer(token))).status).toBe(403);
  });

  it('防锁死：不能降级自己；不能降级/禁用/删除最后一个管理员', async () => {
    const a = await newAccount('管理员B', 'admin');
    // 唯一管理员：降级自己 → 409
    const self = await request(app).put(`/api/admin/users/${a.id}`).set(bearer(a.token)).send({ role: 'engineer' });
    expect(self.status).toBe(409);
    expect(self.body.code).toBe('INVALID_STATE');
    // 唯一管理员：禁用自己 → 409（沿用 CR-03 守卫）
    expect((await request(app).put(`/api/admin/users/${a.id}`).set(bearer(a.token)).send({ active: 0 })).status).toBe(409);
    // 唯一管理员：删除自己 → 409
    expect((await request(app).delete(`/api/admin/users/${a.id}`).set(bearer(a.token))).status).toBe(409);

    // 再来一个管理员 B：A 可被 B 降级；B 不能降级自己（最后一个 admin）
    const b = await newAccount('管理员C', 'admin');
    const demoteA = await request(app).put(`/api/admin/users/${a.id}`).set(bearer(b.token)).send({ role: 'engineer' });
    expect(demoteA.status).toBe(200);
    const demoteB = await request(app).put(`/api/admin/users/${b.id}`).set(bearer(b.token)).send({ role: 'engineer' });
    expect(demoteB.status).toBe(409); // 只剩 B 一个 admin
  });

  it('建号 role 缺省 = admin；非法 role → 400 VALIDATION', async () => {
    const root = await rootLogin();
    const d = await request(app).post('/api/admin/users').set(bearer(root)).send({ username: '缺省角色', password: PWD });
    expect(d.status).toBe(201);
    expect(d.body.data.role).toBe('admin');
    const bad = await request(app).post('/api/admin/users').set(bearer(root)).send({ username: '非法角色', password: PWD, role: 'root' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION');
  });

  it('isRoot 兜底通道（env 单口令，无 DB 行）视同 admin', async () => {
    const t = await rootLogin();
    const me = await request(app).get('/api/admin/me').set(bearer(t));
    expect(me.body.data.role).toBe('admin');
    expect((await request(app).get('/api/admin/users').set(bearer(t))).status).toBe(200);
  });
});
