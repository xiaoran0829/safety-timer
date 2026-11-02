// CR-06 后端验收：H5 安全员登录 + 后台「强制改密」机制 + 改密后旧 token 立即失效。
// 明文口令仅测试夹具；断言库内绝不明文。固定 AUTH_SECRET 由 vitest.config 注入（不碰 ~/.safety-timer）。
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';

const ROOT_PASS = 'cr06-root-pass'; // env ADMIN_PASSWORD 单口令兜底通道夹具（isRoot）
const ROOT_USER = '管理员';

let db;
let app;
let opId; // 安全员（有账号）
let op2Id; // 安全员（无账号）
let vId;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: ROOT_PASS, adminUser: ROOT_USER });
  opId = Number(
    db.prepare("INSERT INTO operator(name,label,group_name,sort) VALUES('张伟','安全员A','一组',10)").run().lastInsertRowid
  );
  op2Id = Number(
    db.prepare("INSERT INTO operator(name,label,group_name,sort) VALUES('李强','安全员B','二组',20)").run().lastInsertRowid
  );
  vId = Number(db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES('LSVAB1234K5678901','工位A',1)").run().lastInsertRowid);
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const adminLogin = (username, password) => request(app).post('/api/admin/login').send({ username, password });
const h5Login = (username, password) => request(app).post('/api/h5/login').send({ username, password });

async function rootLogin() {
  const r = await request(app).post('/api/admin/login').send({ password: ROOT_PASS });
  expect(r.status).toBe(200);
  return r.body.data.token;
}
const createAdmin = (root, body) => request(app).post('/api/admin/users').set(bearer(root)).send(body);
const setOpAccount = (root, id, body) => request(app).post(`/api/admin/operators/${id}/account`).set(bearer(root)).send(body);

describe('CR-06 §1 后台强制改密闸门', () => {
  it('建号默认 mustChangePwd=true；未改密访问业务接口 → 403 MUST_CHANGE_PASSWORD，白名单可访问', async () => {
    const root = await rootLogin();
    const c = await createAdmin(root, { username: 'newbie', password: 'abc123' });
    expect(c.status).toBe(201);

    const l = await adminLogin('newbie', 'abc123');
    expect(l.status).toBe(200);
    expect(l.body.data.mustChangePwd).toBe(true);
    const token = l.body.data.token;

    const blocked = await request(app).get('/api/admin/operators').set(bearer(token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('MUST_CHANGE_PASSWORD');
    expect(blocked.body.message).toBe('请先修改密码');

    // 白名单：/me 放行
    const me = await request(app).get('/api/admin/me').set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ username: 'newbie', mustChangePwd: true, active: 1 });
  });

  it('建号 mustChange:false 显式关闭 → 无强制改密，可直接访问业务接口', async () => {
    const root = await rootLogin();
    await createAdmin(root, { username: 'direct', password: 'abc123', mustChange: false });
    const l = await adminLogin('direct', 'abc123');
    expect(l.body.data.mustChangePwd).toBe(false);
    const ok = await request(app).get('/api/admin/operators').set(bearer(l.body.data.token));
    expect(ok.status).toBe(200);
  });

  it('本人改密成功 → 下发新 token；旧 token 立即 401 TOKEN_STALE', async () => {
    const root = await rootLogin();
    await createAdmin(root, { username: 'self', password: 'abc123' });
    const oldToken = (await adminLogin('self', 'abc123')).body.data.token;

    const r = await request(app)
      .post('/api/admin/me/password')
      .set(bearer(oldToken))
      .send({ oldPassword: 'abc123', newPassword: 'newpass1' });
    expect(r.status).toBe(200);
    const newToken = r.body.data.token;
    expect(newToken).toBeTruthy();

    // 新 token：强制改密已解除 → 可访问业务接口
    expect((await request(app).get('/api/admin/operators').set(bearer(newToken))).status).toBe(200);
    // 旧 token：pv 过期 → 401 TOKEN_STALE
    const stale = await request(app).get('/api/admin/operators').set(bearer(oldToken));
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('TOKEN_STALE');

    // 新口令可登录；旧口令不可
    expect((await adminLogin('self', 'abc123')).status).toBe(401);
    expect((await adminLogin('self', 'newpass1')).status).toBe(200);
  });

  it('本人改密：旧密不符 → 400 INVALID_OLD_PASSWORD', async () => {
    const root = await rootLogin();
    await createAdmin(root, { username: 'o4', password: 'abc123' });
    const token = (await adminLogin('o4', 'abc123')).body.data.token;
    const r = await request(app)
      .post('/api/admin/me/password')
      .set(bearer(token))
      .send({ oldPassword: 'nope', newPassword: 'newpass1' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_OLD_PASSWORD');
  });

  it('本人改密：新密 <6 位 → 400 VALIDATION', async () => {
    const root = await rootLogin();
    await createAdmin(root, { username: 'o5', password: 'abc123' });
    const token = (await adminLogin('o5', 'abc123')).body.data.token;
    const r = await request(app)
      .post('/api/admin/me/password')
      .set(bearer(token))
      .send({ oldPassword: 'abc123', newPassword: '123' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION');
  });

  it('管理员重置口令 → 目标旧 token 失效且 mustChangePwd=1', async () => {
    const root = await rootLogin();
    const c = await createAdmin(root, { username: 'target', password: 'abc123', mustChange: false });
    const l = await adminLogin('target', 'abc123');
    expect(l.body.data.mustChangePwd).toBe(false);
    const oldToken = l.body.data.token;
    expect((await request(app).get('/api/admin/operators').set(bearer(oldToken))).status).toBe(200);

    const rp = await request(app)
      .post(`/api/admin/users/${c.body.data.id}/password`)
      .set(bearer(root))
      .send({ password: 'reset123' });
    expect(rp.status).toBe(200);
    expect(rp.body.data).toMatchObject({ ok: true, mustChangePwd: true });

    // 旧 token 立即失效
    const stale = await request(app).get('/api/admin/operators').set(bearer(oldToken));
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('TOKEN_STALE');

    // 新口令登录 → mustChangePwd=1 → 业务接口被闸门拦
    const l2 = await adminLogin('target', 'reset123');
    expect(l2.body.data.mustChangePwd).toBe(true);
    expect((await request(app).get('/api/admin/operators').set(bearer(l2.body.data.token))).status).toBe(403);
  });

  it('管理员重置「自己」口令 → 同走重置逻辑（旧 token 失效 + mustChangePwd=1，不得绕过）', async () => {
    const root = await rootLogin();
    const c = await createAdmin(root, { username: 'self2', password: 'abc123', mustChange: false });
    const token = (await adminLogin('self2', 'abc123')).body.data.token;

    const rp = await request(app)
      .post(`/api/admin/users/${c.body.data.id}/password`)
      .set(bearer(token))
      .send({ password: 'reset456' });
    expect(rp.status).toBe(200);
    expect(rp.body.data.mustChangePwd).toBe(true);

    expect((await request(app).get('/api/admin/operators').set(bearer(token))).status).toBe(401);
    const l2 = await adminLogin('self2', 'reset456');
    expect(l2.body.data.mustChangePwd).toBe(true);
  });

  it('管理员账号被（硬）删除后，其旧 token 访问接口 → 401 TOKEN_STALE', async () => {
    const root = await rootLogin();
    await createAdmin(root, { username: 'keeper', password: 'abc123', mustChange: false }); // 保证非最后管理员
    const c = await createAdmin(root, { username: 'todelete', password: 'abc123', mustChange: false });
    const token = (await adminLogin('todelete', 'abc123')).body.data.token;
    // 删除前可用
    expect((await request(app).get('/api/admin/operators').set(bearer(token))).status).toBe(200);

    const del = await request(app).delete(`/api/admin/users/${c.body.data.id}`).set(bearer(root));
    expect(del.status).toBe(200);

    // 删除后：查无 admin_user 行 → 旧 token 立即失效
    const stale = await request(app).get('/api/admin/operators').set(bearer(token));
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('TOKEN_STALE');
  });
});

describe('CR-06 §2 H5 安全员登录 / 改密', () => {
  it('H5 登录成功 → token + operator 摘要 + mustChangePwd（设号后强制改密）', async () => {
    const root = await rootLogin();
    const acc = await setOpAccount(root, opId, { username: 'safety1', password: 'op12345' });
    expect(acc.status).toBe(200);
    expect(acc.body.data).toMatchObject({ hasAccount: true, username: 'safety1' });

    const l = await h5Login('safety1', 'op12345');
    expect(l.status).toBe(200);
    expect(l.body.data.token).toBeTruthy();
    expect(l.body.data.operator).toMatchObject({ id: opId, name: '张伟', label: '安全员A', groupName: '一组' });
    expect(l.body.data.mustChangePwd).toBe(true);

    // 白名单 /me 可访问
    const me = await request(app).get('/api/h5/me').set(bearer(l.body.data.token));
    expect(me.status).toBe(200);
    expect(me.body.data.operator.id).toBe(opId);
    expect(me.body.data.mustChangePwd).toBe(true);
  });

  it('H5 登录：错口令 401 / 未开通（无账号）401（统一文案，不泄露）', async () => {
    const root = await rootLogin();
    await setOpAccount(root, opId, { username: 'safety1', password: 'op12345' });

    const wrong = await h5Login('safety1', 'wrong-pass');
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.body.message).toBe('用户名或密码错误');

    // op2 未开通账号 → 用其姓名当 username 亦 401
    const none = await h5Login('李强', 'whatever');
    expect(none.status).toBe(401);
    expect(none.body.code).toBe('INVALID_CREDENTIALS');

    // 缺参 → 400 VALIDATION
    expect((await request(app).post('/api/h5/login').send({ username: 'safety1' })).status).toBe(400);
  });

  it('H5 登录：停用 / 离职 → 403 ACCOUNT_INACTIVE', async () => {
    const root = await rootLogin();
    await setOpAccount(root, opId, { username: 'safety1', password: 'op12345' });
    await request(app).put(`/api/admin/operators/${opId}`).set(bearer(root)).send({ active: 0 });
    const l = await h5Login('safety1', 'op12345');
    expect(l.status).toBe(403);
    expect(l.body.code).toBe('ACCOUNT_INACTIVE');
  });

  it('H5 本人改密成功 → 旧 token 立即 401 TOKEN_STALE；新口令可登录', async () => {
    const root = await rootLogin();
    await setOpAccount(root, opId, { username: 'safety1', password: 'op12345' });
    const oldToken = (await h5Login('safety1', 'op12345')).body.data.token;

    const r = await request(app)
      .post('/api/h5/password')
      .set(bearer(oldToken))
      .send({ oldPassword: 'op12345', newPassword: 'op67890' });
    expect(r.status).toBe(200);
    const newToken = r.body.data.token;
    expect(newToken).toBeTruthy();

    expect((await request(app).get('/api/h5/me').set(bearer(newToken))).status).toBe(200);
    const stale = await request(app).get('/api/h5/me').set(bearer(oldToken));
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('TOKEN_STALE');
    expect((await h5Login('safety1', 'op67890')).status).toBe(200);
    expect((await h5Login('safety1', 'op12345')).status).toBe(401);
  });

  it('H5 旧密错误 → 400 INVALID_OLD_PASSWORD；未登录 → 401', async () => {
    const root = await rootLogin();
    await setOpAccount(root, opId, { username: 'safety1', password: 'op12345' });
    const token = (await h5Login('safety1', 'op12345')).body.data.token;
    const r = await request(app)
      .post('/api/h5/password')
      .set(bearer(token))
      .send({ oldPassword: 'bad-old', newPassword: 'op67890' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_OLD_PASSWORD');

    expect((await request(app).get('/api/h5/me')).status).toBe(401);
  });
});

describe('CR-06 §3 会话 ownerId 以 token 为准（不回归）', () => {
  it('operator 登录态 POST /api/sessions/start 传他人 operatorId → 仍以 token 为准', async () => {
    const root = await rootLogin();
    await setOpAccount(root, opId, { username: 'safety1', password: 'op12345' });
    const t0 = (await h5Login('safety1', 'op12345')).body.data.token;
    // 先改密解锁（未改密时公开路由已被闸门拦，见 §5）
    const token = (await request(app).post('/api/h5/password').set(bearer(t0)).send({ oldPassword: 'op12345', newPassword: 'op67890' })).body.data.token;

    const r = await request(app)
      .post('/api/sessions/start')
      .set(bearer(token))
      .send({ operatorId: op2Id, vehicleId: vId, odometerOut: 1000 });
    expect(r.status).toBe(201);
    expect(r.body.data.session.operatorId).toBe(opId); // 忽略 body 传入的他人 id
    expect(r.body.data.session.operatorName).toBe('张伟');
  });

  it('operator 登录态可查 /active（无 operatorId 参数 → 用 token）', async () => {
    const root = await rootLogin();
    await setOpAccount(root, opId, { username: 'safety1', password: 'op12345' });
    const t0 = (await h5Login('safety1', 'op12345')).body.data.token;
    const token = (await request(app).post('/api/h5/password').set(bearer(t0)).send({ oldPassword: 'op12345', newPassword: 'op67890' })).body.data.token;
    await request(app).post('/api/sessions/start').set(bearer(token)).send({ vehicleId: vId, odometerOut: 1000 });

    const a = await request(app).get('/api/sessions/active').set(bearer(token));
    expect(a.status).toBe(200);
    expect(a.body.data.session.operatorId).toBe(opId);
  });

  it('无 token POST /api/sessions/start 行为不变（回归）', async () => {
    const r = await request(app).post('/api/sessions/start').send({ operatorId: opId, vehicleId: vId });
    expect(r.status).toBe(201);
    expect(r.body.data.session.operatorId).toBe(opId);
    expect(r.body.data.session.operatorName).toBe('张伟');
    expect(r.body.data.session.initiatorName).toBeNull();
  });
});

describe('CR-06 §5 公开路由的强制改密闸门（补丁 #2）', () => {
  async function opWithAccount(mustChange = true) {
    const root = await rootLogin();
    await setOpAccount(root, opId, { username: 'safety1', password: 'op12345' });
    const t0 = (await h5Login('safety1', 'op12345')).body.data.token; // mustChangePwd=1
    if (!mustChange) {
      const nt = (await request(app).post('/api/h5/password').set(bearer(t0)).send({ oldPassword: 'op12345', newPassword: 'op67890' })).body.data.token;
      return { root, token: nt };
    }
    return { root, token: t0 };
  }

  it('未改密 operator token 打公开 /api/sessions/active 与 /start → 403 MUST_CHANGE_PASSWORD', async () => {
    const { token } = await opWithAccount(true);
    const a = await request(app).get(`/api/sessions/active?operatorId=${opId}`).set(bearer(token));
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('MUST_CHANGE_PASSWORD');
    const s = await request(app).post('/api/sessions/start').set(bearer(token)).send({ vehicleId: vId, odometerOut: 1000 });
    expect(s.status).toBe(403);
    expect(s.body.code).toBe('MUST_CHANGE_PASSWORD');
  });

  it('改密后（新 token）同接口放行：/active 200、/start 201', async () => {
    const { token } = await opWithAccount(false);
    const a = await request(app).get('/api/sessions/active').set(bearer(token));
    expect(a.status).toBe(200);
    const s = await request(app).post('/api/sessions/start').set(bearer(token)).send({ vehicleId: vId, odometerOut: 1000 });
    expect(s.status).toBe(201);
    expect(s.body.data.session.operatorId).toBe(opId);
  });

  it('无 token 公开访问 /api/sessions/active 与 /start 行为完全不变（回归）', async () => {
    expect((await request(app).get(`/api/sessions/active?operatorId=${opId}`)).status).toBe(200);
    expect((await request(app).get('/api/sessions/active')).status).toBe(400); // 缺 operatorId 原有校验
    expect((await request(app).post('/api/sessions/start').send({ operatorId: opId, vehicleId: vId })).status).toBe(201);
  });

  it('非法/陈旧 token 打公开路由 → 不拦截（与原公开行为一致）', async () => {
    expect((await request(app).get(`/api/sessions/active?operatorId=${opId}`).set(bearer('bogus.token.x'))).status).toBe(200);
  });
});

describe('CR-06 §4 安全员账号管理（DTO / 设置 / 清空）', () => {
  it('/api/admin/operators DTO 含 hasAccount/username，且绝无 hash/salt', async () => {
    const root = await rootLogin();
    await setOpAccount(root, opId, { username: 'safety1', password: 'op12345' });
    const r = await request(app).get('/api/admin/operators').set(bearer(root));
    expect(r.status).toBe(200);
    const a = r.body.data.find((o) => o.id === opId);
    const b = r.body.data.find((o) => o.id === op2Id);
    expect(a).toMatchObject({ hasAccount: true, username: 'safety1' });
    expect(b).toMatchObject({ hasAccount: false, username: null });
    expect(JSON.stringify(r.body.data)).not.toMatch(/pwd_hash|pwd_salt/);
  });

  it('operator 账号清空 → username/hash/salt 置 NULL，H5 登录失败', async () => {
    const root = await rootLogin();
    await setOpAccount(root, opId, { username: 'safety1', password: 'op12345' });
    expect((await h5Login('safety1', 'op12345')).status).toBe(200);

    const del = await request(app).delete(`/api/admin/operators/${opId}/account`).set(bearer(root));
    expect(del.status).toBe(200);
    expect(del.body.data).toMatchObject({ hasAccount: false, username: null });

    expect((await h5Login('safety1', 'op12345')).status).toBe(401);
    const row = db.prepare('SELECT username,pwd_hash,pwd_salt FROM operator WHERE id=?').get(opId);
    expect(row.username).toBeNull();
    expect(row.pwd_hash).toBeNull();
    expect(row.pwd_salt).toBeNull();
  });

  it('operator 账号 username 冲突 → 409 CONFLICT；口令 <6 → 400 VALIDATION', async () => {
    const root = await rootLogin();
    await setOpAccount(root, opId, { username: 'dup', password: 'op12345' });
    const clash = await setOpAccount(root, op2Id, { username: 'dup', password: 'op12345' });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('CONFLICT');

    const weak = await setOpAccount(root, op2Id, { username: 'okname', password: '123' });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('VALIDATION');
  });
});
