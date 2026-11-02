// CR-03 后端验收：账号体系（用户名+密码）/ 用户 CRUD + 防锁死 / 发起人=登录用户姓名。
// 口令来源仅测试夹具；断言库内绝不明文。
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb, ensureInitialAdmin } from '../db.js';
import { createApp } from '../app.js';
import { startSession } from '../services/timer.js';
import { fmtDay } from '../lib/time.js';

const ROOT_PASS = 'root-pass-123'; // env ADMIN_PASSWORD 兜底通道夹具
const ROOT_USER = '管理员';

let db;
let app;
let opId;
let op2;
let vId;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: ROOT_PASS, adminUser: ROOT_USER });
  opId = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('张伟','安全员A',10)").run().lastInsertRowid);
  op2 = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('李强','安全员B',20)").run().lastInsertRowid);
  vId = Number(db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES('LSVAB1234K5678901','工位A',1)").run().lastInsertRowid);
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function rootLogin() {
  const r = await request(app).post('/api/admin/login').send({ password: ROOT_PASS });
  expect(r.status).toBe(200);
  return r.body.data.token;
}
async function createUser(token, body) {
  return request(app).post('/api/admin/users').set(bearer(token)).send(body);
}
async function accountLogin(username, password) {
  return request(app).post('/api/admin/login').send({ username, password });
}

describe('CR-03 §1 登录：账号 + 兜底口令', () => {
  it('账号登录成功 → token + user{id,username,name}', async () => {
    const rootToken = await rootLogin();
    const c = await createUser(rootToken, { username: '张三', password: 'abc123', name: '张大三' });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ username: '张三', name: '张大三', active: 1 });
    expect(c.body.data.pwd_hash).toBeUndefined();
    expect(c.body.data.pwd_salt).toBeUndefined();

    const l = await accountLogin('张三', 'abc123');
    expect(l.status).toBe(200);
    expect(l.body.data.token).toBeTruthy();
    expect(l.body.data.user).toMatchObject({ id: c.body.data.id, username: '张三', name: '张大三' });
  });

  it('账号登录失败统一 401 且文案一致（防枚举）', async () => {
    const rootToken = await rootLogin();
    await createUser(rootToken, { username: '张三', password: 'abc123' });

    const wrongPwd = await accountLogin('张三', 'wrong-pass');
    const noUser = await accountLogin('查无此人', 'whatever');
    for (const r of [wrongPwd, noUser]) {
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('UNAUTHORIZED');
      expect(r.body.message).toBe('用户名或密码错误');
    }
  });

  it('缺参 → 400 VALIDATION（无 password）', async () => {
    const r = await request(app).post('/api/admin/login').send({ username: '张三' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION');
  });

  it('兜底口令仍可用（仅 password，isRoot）', async () => {
    const ok = await request(app).post('/api/admin/login').send({ password: ROOT_PASS });
    expect(ok.status).toBe(200);
    expect(ok.body.data.token).toBeTruthy();
    expect(ok.body.data.user.id).toBeNull();
    expect(ok.body.data.user.name).toBe(ROOT_USER);

    const bad = await request(app).post('/api/admin/login').send({ password: 'nope' });
    expect(bad.status).toBe(401);
    expect(bad.body.message).toBe('用户名或密码错误');
  });

  it('停用账号不可登录 → 403 ACCOUNT_INACTIVE（错口令仍 401 防枚举）', async () => {
    const rootToken = await rootLogin();
    const a = await createUser(rootToken, { username: 'userA', password: 'abc123' });
    await createUser(rootToken, { username: 'userB', password: 'abc123' }); // 保证非最后管理员
    const dis = await request(app).put(`/api/admin/users/${a.body.data.id}`).set(bearer(rootToken)).send({ active: 0 });
    expect(dis.status).toBe(200);
    // CR-06：口令正确 + 已停用 → 403 ACCOUNT_INACTIVE
    const l = await accountLogin('userA', 'abc123');
    expect(l.status).toBe(403);
    expect(l.body.code).toBe('ACCOUNT_INACTIVE');
    // 错口令 → 仍统一 401（防用户名枚举）
    const bad = await accountLogin('userA', 'wrong-pass');
    expect(bad.status).toBe(401);
    expect(bad.body.message).toBe('用户名或密码错误');
  });
});

describe('CR-03 §2 账号 CRUD + 防锁死', () => {
  it('建号：中文用户名可用；name 缺省=username；唯一冲突 409', async () => {
    const token = await rootLogin();
    const c = await createUser(token, { username: '李四', password: 'abc123' });
    expect(c.status).toBe(201);
    expect(c.body.data.name).toBe('李四');

    const dup = await createUser(token, { username: '李四', password: 'abc123' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CONFLICT');
  });

  it('口令长度 < 6 → 400 VALIDATION（建号与改密同口径）', async () => {
    const token = await rootLogin();
    const c = await createUser(token, { username: '短口令', password: '12345' });
    expect(c.status).toBe(400);
    expect(c.body.code).toBe('VALIDATION');
    const ok = await createUser(token, { username: '短口令', password: '123456' });
    expect(ok.status).toBe(201);
    const rp = await request(app).post(`/api/admin/users/${ok.body.data.id}/password`).set(bearer(token)).send({ password: '1' });
    expect(rp.status).toBe(400);
    expect(rp.body.code).toBe('VALIDATION');
  });

  it('列表 DTO 仅白名单字段，绝不返回 hash/salt；支持 ?active&q', async () => {
    const token = await rootLogin();
    await createUser(token, { username: '王五', password: 'abc123', name: '王一' });
    const r = await request(app).get('/api/admin/users').set(bearer(token));
    expect(r.status).toBe(200);
    const item = r.body.data.find((u) => u.username === '王五');
    expect(Object.keys(item).sort()).toEqual(['active', 'createdAt', 'id', 'name', 'orgId', 'orgName', 'role', 'supplierId', 'supplierName', 'updatedAt', 'username']);
    expect(JSON.stringify(r.body.data)).not.toMatch(/pwd_hash|pwd_salt/);

    const q = await request(app).get('/api/admin/users?q=王一').set(bearer(token));
    expect(q.body.data.length).toBe(1);
    expect(q.body.data[0].username).toBe('王五');
  });

  it('改密后旧口令失效、新口令可登录', async () => {
    const token = await rootLogin();
    const c = await createUser(token, { username: '王五', password: 'oldpass1' });
    const rp = await request(app).post(`/api/admin/users/${c.body.data.id}/password`).set(bearer(token)).send({ password: 'newpass1' });
    expect(rp.status).toBe(200);
    expect((await accountLogin('王五', 'oldpass1')).status).toBe(401);
    expect((await accountLogin('王五', 'newpass1')).status).toBe(200);
  });

  it('防锁死①：不能删除/禁用「自己」→ 409 INVALID_STATE', async () => {
    const rootToken = await rootLogin();
    // CR-06：建号默认 must_change_pwd=1，会先被强制改密闸门 403；本用例专注防锁死守卫 → 显式关闭
    const c = await createUser(rootToken, { username: '赵六', password: 'zhaoliu1', mustChange: false });
    const l = await accountLogin('赵六', 'zhaoliu1');
    const auth = bearer(l.body.data.token);

    const del = await request(app).delete(`/api/admin/users/${c.body.data.id}`).set(auth);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('INVALID_STATE');

    const dis = await request(app).put(`/api/admin/users/${c.body.data.id}`).set(auth).send({ active: 0 });
    expect(dis.status).toBe(409);
    expect(dis.body.code).toBe('INVALID_STATE');
  });

  it('防锁死②：不能删除/禁用最后一个 active 管理员 → 409 INVALID_STATE', async () => {
    const rootToken = await rootLogin(); // isRoot，userId=null → 自身守卫不适用
    const c = await createUser(rootToken, { username: '钱七', password: 'qianqi11' });
    const auth = bearer(rootToken);

    const dis = await request(app).put(`/api/admin/users/${c.body.data.id}`).set(auth).send({ active: 0 });
    expect(dis.status).toBe(409);
    expect(dis.body.code).toBe('INVALID_STATE');

    const del = await request(app).delete(`/api/admin/users/${c.body.data.id}`).set(auth);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('INVALID_STATE');

    // 再加一个 active 管理员后，可禁用第一个
    await createUser(rootToken, { username: '孙八', password: 'sunba11' });
    const dis2 = await request(app).put(`/api/admin/users/${c.body.data.id}`).set(auth).send({ active: 0 });
    expect(dis2.status).toBe(200);
    expect(dis2.body.data.active).toBe(0);
  });

  it('删除（硬删）后列表不再出现；DELETE 不存在 → 404', async () => {
    const token = await rootLogin();
    const c = await createUser(token, { username: '周九', password: 'zhoujiu1' });
    await createUser(token, { username: '吴十', password: 'wushi111' }); // 保证非最后管理员
    const del = await request(app).delete(`/api/admin/users/${c.body.data.id}`).set(bearer(token));
    expect(del.status).toBe(200);
    const list = await request(app).get('/api/admin/users').set(bearer(token));
    expect(list.body.data.find((u) => u.username === '周九')).toBeUndefined();
    const miss = await request(app).delete(`/api/admin/users/${c.body.data.id}`).set(bearer(token));
    expect(miss.status).toBe(404);
    expect(miss.body.code).toBe('NOT_FOUND');
  });

  it('未登录访问 /users → 401', async () => {
    const r = await request(app).get('/api/admin/users');
    expect(r.status).toBe(401);
  });
});

describe('CR-03 §3 口令哈希：明文永不入库', () => {
  it('库内 pwd_hash 为 scrypt 派生值（≠明文），带随机盐', async () => {
    const token = await rootLogin();
    const plain = 'Secret#123';
    await createUser(token, { username: '吴九', password: plain });
    const row = db.prepare('SELECT * FROM admin_user WHERE username=?').get('吴九');
    expect(row.pwd_hash).toBeTruthy();
    expect(row.pwd_hash).not.toBe(plain);
    expect(row.pwd_hash).toMatch(/^[0-9a-f]{64}$/); // 32B hex
    expect(row.pwd_salt).toMatch(/^[0-9a-f]{32}$/); // 16B hex
    expect(JSON.stringify(row)).not.toContain(plain);
  });

  it('启动引导 ensureInitialAdmin：无口令跳过；有口令建号且幂等、不覆盖', () => {
    const d = openDb(':memory:');
    expect(ensureInitialAdmin(d, { username: 'admin', password: undefined })).toBe(false);
    expect(d.prepare('SELECT COUNT(*) n FROM admin_user').get().n).toBe(0);
    expect(ensureInitialAdmin(d, { username: 'admin', password: 'Init#12345' })).toBe(true);
    const row = d.prepare('SELECT * FROM admin_user WHERE username=?').get('admin');
    expect(row.name).toBe('admin');
    expect(row.pwd_hash).not.toBe('Init#12345');
    // 幂等：已有账号不覆盖
    expect(ensureInitialAdmin(d, { username: 'admin', password: 'Other#12345' })).toBe(false);
    expect(d.prepare('SELECT * FROM admin_user WHERE username=?').get('admin').pwd_hash).toBe(row.pwd_hash);
    d.close();
  });
});

describe('CR-03 §7 发起人取值', () => {
  it('service：传 initiatorName → initiator_id=null, initiator_name=该值', () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId, initiatorName: '张三' });
    const row = db.prepare('SELECT * FROM timer_session WHERE id=?').get(session.id);
    expect(row.initiator_name).toBe('张三');
    expect(row.initiator_id).toBeNull();
    expect(session.initiatorName).toBe('张三');
    expect(session.initiatorId).toBeNull();
  });

  it('service：无排班 → 发起人留空（CR-08 批2 #4：不回落默认发起人）', () => {
    const iniId = Number(db.prepare("INSERT INTO initiator(name,department) VALUES('老发起','技术部')").run().lastInsertRowid);
    db.prepare('UPDATE vehicle SET default_initiator_id=? WHERE id=?').run(iniId, vId);
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    const row = db.prepare('SELECT * FROM timer_session WHERE id=?').get(session.id);
    expect(row.initiator_id).toBeNull();
    expect(row.initiator_name).toBeNull();
  });

  it('service：显式 initiatorId 仍生效（未传 initiatorName 时）', () => {
    const iniId = Number(db.prepare("INSERT INTO initiator(name,department) VALUES('显式发起','技术部')").run().lastInsertRowid);
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId, initiatorId: iniId });
    expect(session.initiatorId).toBe(iniId);
    expect(session.initiatorName).toBe('显式发起');
  });

  it('路由：CR-08 批2 #4 → 发起人=排班下发人(created_by)；无排班 → 留空（不再取登录用户姓名）', async () => {
    const rootToken = await rootLogin();
    await createUser(rootToken, { username: 'zhaoliu', name: '李经理', password: 'abc123', mustChange: false });
    const l = await accountLogin('zhaoliu', 'abc123');
    const token = l.body.data.token;

    // 登录态但无排班 → 发起人留空（旧行为曾=登录用户姓名「李经理」）
    const r = await request(app).post('/api/sessions/start').set(bearer(token)).send({ operatorId: op2, vehicleId: vId });
    expect(r.status).toBe(201);
    expect(r.body.data.session.initiatorName).toBeNull();

    // 建今日排班（下发人=排班管理员）→ 发起人=下发人
    const shiftId = Number(
      db.prepare("INSERT INTO shift(name,start_time,end_time,sort,active) VALUES('全天','00:00','23:59',90,1)").run()
        .lastInsertRowid
    );
    db.prepare(
      "INSERT INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,created_by) VALUES(?,?,?,?, 'planned', '排班管理员')"
    ).run(fmtDay(), shiftId, opId, vId);
    const r2 = await request(app).post('/api/sessions/start').send({ operatorId: opId, vehicleId: vId });
    expect(r2.status).toBe(201);
    expect(r2.body.data.session.initiatorName).toBe('排班管理员');
    expect(r2.body.data.session.initiatorId).toBeNull();
  });

  it('历史 timer_session 原值不被覆盖', async () => {
    const info = db
      .prepare(
        `INSERT INTO timer_session
           (work_order_no,operator_id,vehicle_id,operator_name,vin,status,start_at,end_at,net_seconds,pause_seconds,initiator_id,initiator_name)
         VALUES('WO-20200101-001',?,?,'张伟','VIN-HIST','stopped','2020-01-01 08:00:00','2020-01-01 09:00:00',3600,0,NULL,'老王')`
      )
      .run(opId, vId);
    startSession(db, { operatorId: opId, vehicleId: vId, initiatorName: '李经理' });
    const old = db.prepare('SELECT * FROM timer_session WHERE id=?').get(Number(info.lastInsertRowid));
    expect(old.initiator_name).toBe('老王');
    expect(old.initiator_id).toBeNull();
  });
});
