// CR-11 后端验收：登录日志（login_log）——写入（成功/失败，后台 + 安全员 H5）+ 查询（admin 独占 + 筛选/分页）。
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb, migrate } from '../db.js';
import { createApp } from '../app.js';
import { hashPassword } from '../middleware/auth.js';

const ROOT_PASS = 'root-pass-123';
const ROOT_USER = '管理员';
const PWD = 'pwd123456';

let db;
let app;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: ROOT_PASS, adminUser: ROOT_USER });
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const rootLogin = async () => {
  const r = await request(app).post('/api/admin/login').send({ password: ROOT_PASS });
  expect(r.status).toBe(200);
  return r.body.data.token;
};

/** 建一个后台账号（root 操作） */
async function makeAdmin(username, role) {
  const root = await rootLogin();
  const c = await request(app)
    .post('/api/admin/users')
    .set(bearer(root))
    .send({ username, password: PWD, role, mustChange: false });
  expect(c.status).toBe(201);
  return c.body.data;
}

/** 建一个已开号的安全员（H5） */
function makeOperator({ username = 'E10001', password = PWD, name = '张三' } = {}) {
  const info = db
    .prepare('INSERT INTO operator(name,employee_no,employed,active,sort) VALUES(?,?,1,1,0)')
    .run(name, username);
  const id = Number(info.lastInsertRowid);
  const { hash, salt } = hashPassword(password);
  db.prepare('UPDATE operator SET username=?,pwd_hash=?,pwd_salt=?,pwd_ver=0,must_change_pwd=0 WHERE id=?').run(
    username,
    hash,
    salt,
    id
  );
  return id;
}

const logsOf = (source) => db.prepare('SELECT * FROM login_log WHERE source=? ORDER BY id ASC').all(source);
const logsFor = (account) => db.prepare('SELECT * FROM login_log WHERE account=? ORDER BY id ASC').all(account);

describe('CR-11 登录日志', () => {
  it('后台登录成功 → 记 1 条 ok（账号/角色/IP/UA）', async () => {
    await makeAdmin('eng', 'engineer');
    const r = await request(app)
      .post('/api/admin/login')
      .set('User-Agent', 'vitest-ua/1.0')
      .send({ username: 'eng', password: PWD });
    expect(r.status).toBe(200);
    const rows = logsFor('eng');
    expect(rows.length).toBe(1);
    expect(rows[0].result).toBe('ok');
    expect(rows[0].account).toBe('eng');
    expect(rows[0].role).toBe('engineer');
    expect(rows[0].ua).toBe('vitest-ua/1.0');
    expect(rows[0].ip).toBeTruthy();
    expect(rows[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it('后台登录失败（口令错）→ 记 1 条 fail（原样 401，不泄露账号存在）', async () => {
    await makeAdmin('eng2', 'engineer');
    const r = await request(app).post('/api/admin/login').send({ username: 'eng2', password: 'wrong-password' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('UNAUTHORIZED');
    const rows = logsFor('eng2');
    expect(rows.length).toBe(1);
    expect(rows[0].result).toBe('fail');
    expect(rows[0].account).toBe('eng2');
    expect(rows[0].reason).toBe('UNAUTHORIZED');
  });

  it('单口令兜底登录成功 → 记 1 条 ok（account=NULL，role=admin）', async () => {
    const r = await request(app).post('/api/admin/login').send({ password: ROOT_PASS });
    expect(r.status).toBe(200);
    const rows = logsOf('admin');
    expect(rows.length).toBe(1);
    expect(rows[0].result).toBe('ok');
    expect(rows[0].account).toBeNull();
    expect(rows[0].role).toBe('admin');
  });

  it('安全员 H5 登录成功/失败均记（source=h5，role=operator）', async () => {
    makeOperator({ username: 'E10001' });
    const ok = await request(app).post('/api/h5/login').send({ username: 'E10001', password: PWD });
    expect(ok.status).toBe(200);
    const bad = await request(app).post('/api/h5/login').send({ username: 'E10001', password: 'nope' });
    expect(bad.status).toBe(401);
    const rows = logsOf('h5');
    expect(rows.length).toBe(2);
    expect(rows[0].result).toBe('ok');
    expect(rows[0].role).toBe('operator');
    expect(rows[0].name).toBe('张三');
    expect(rows[1].result).toBe('fail');
    expect(rows[1].reason).toBe('INVALID_CREDENTIALS');
  });

  it('绝不记录口令/派生值/盐（表内不出现敏感串）', async () => {
    await makeAdmin('eng3', 'engineer');
    await request(app).post('/api/admin/login').send({ username: 'eng3', password: PWD });
    const dump = JSON.stringify(db.prepare('SELECT * FROM login_log').all());
    expect(dump).not.toContain(PWD);
    expect(dump).not.toContain('pwd_hash');
    const cols = db.prepare('PRAGMA table_info(login_log)').all().map((c) => c.name);
    expect(cols).not.toContain('pwd_hash');
    expect(cols).not.toContain('password');
  });

  it('查询：admin 可读（200）；engineer / fleet_admin → 403 NO_PERMISSION', async () => {
    await makeAdmin('eng4', 'engineer');
    await makeAdmin('flt4', 'fleet_admin');
    const root = await rootLogin();
    const l1 = await request(app).post('/api/admin/login').send({ username: 'eng4', password: PWD });
    const l2 = await request(app).post('/api/admin/login').send({ username: 'flt4', password: PWD });

    const rAdmin = await request(app).get('/api/admin/logs').set(bearer(root));
    expect(rAdmin.status).toBe(200);
    expect(Array.isArray(rAdmin.body.data.items)).toBe(true);
    expect(typeof rAdmin.body.data.total).toBe('number');

    const rEng = await request(app).get('/api/admin/logs').set(bearer(l1.body.data.token));
    expect(rEng.status).toBe(403);
    expect(rEng.body.code).toBe('NO_PERMISSION');

    const rFlt = await request(app).get('/api/admin/logs').set(bearer(l2.body.data.token));
    expect(rFlt.status).toBe(403);
    expect(rFlt.body.code).toBe('NO_PERMISSION');
  });

  it('未登录 → 401', async () => {
    const r = await request(app).get('/api/admin/logs');
    expect(r.status).toBe(401);
  });

  it('筛选（账号/类型/结果/时间范围）+ 分页 正确', async () => {
    makeOperator({ username: 'E20001' });
    makeOperator({ username: 'E20002', name: '李四' });
    // 1 成功 + 2 失败（h5）；1 成功（admin）
    await request(app).post('/api/h5/login').send({ username: 'E20001', password: PWD });
    await request(app).post('/api/h5/login').send({ username: 'E20002', password: 'x' });
    await request(app).post('/api/h5/login').send({ username: 'E20001', password: 'x' });
    const root = await rootLogin();

    const all = await request(app).get('/api/admin/logs').set(bearer(root));
    expect(all.body.data.total).toBe(4);

    const onlyFail = await request(app).get('/api/admin/logs?result=fail').set(bearer(root));
    expect(onlyFail.body.data.total).toBe(2);
    expect(onlyFail.body.data.items.every((x) => x.result === 'fail')).toBe(true);

    const onlyH5ok = await request(app).get('/api/admin/logs?source=h5&result=ok').set(bearer(root));
    expect(onlyH5ok.body.data.total).toBe(1);

    const byAcct = await request(app).get('/api/admin/logs?account=E20002').set(bearer(root));
    expect(byAcct.body.data.total).toBe(1);

    const p1 = await request(app).get('/api/admin/logs?page=1&pageSize=3').set(bearer(root));
    expect(p1.body.data.items.length).toBe(3);
    const p2 = await request(app).get('/api/admin/logs?page=2&pageSize=3').set(bearer(root));
    expect(p2.body.data.items.length).toBe(1);

    // 时间范围（今天 → 命中；未来 → 空）
    const today = new Date().toISOString().slice(0, 10);
    const inRange = await request(app).get(`/api/admin/logs?from=${today}&to=${today}`).set(bearer(root));
    expect(inRange.body.data.total).toBe(4);
    const future = await request(app).get('/api/admin/logs?from=2999-01-01&to=2999-12-31').set(bearer(root));
    expect(future.body.data.total).toBe(0);
  });

  it('老库幂等：重复 migrate 不炸、不丢已有日志', async () => {
    await request(app).post('/api/admin/login').send({ password: ROOT_PASS });
    const n1 = db.prepare('SELECT COUNT(*) AS n FROM login_log').get().n;
    expect(n1).toBe(1);
    migrate(db);
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM login_log').get().n).toBe(1);
    expect(db.prepare('PRAGMA table_info(login_log)').all().length).toBeGreaterThan(5);
  });
});
