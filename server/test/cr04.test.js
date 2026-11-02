// CR-04 后端验收：token 改「无状态 HMAC 签名」→ 重启 / 多进程不再失效。
// 覆盖：①跨进程（新进程）签发仍可校验（模拟重启不失效）②篡改签名 401 ③exp 过期 401
//       ④cookie 通道可用 ⑤错误口令 401 ⑥ADMIN_PASSWORD 单口令兜底仍可用
//       ⑦密钥文件自动生成/权限/跨进程共享 ⑧密钥文件位于 server/ 之外（防 rsync --delete 误删）
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { signToken, verifyToken, defaultSecretFile, TOKEN_TTL_SECONDS } from '../lib/token.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
const TOKEN_MODULE_URL = pathToFileURL(path.join(SERVER_DIR, 'lib', 'token.js')).href;

const ROOT_PASS = 'cr04-root-pass';
const ROOT_USER = '管理员';

let db;
let app;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: ROOT_PASS, adminUser: ROOT_USER });
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

// 在「独立新进程」里执行一段 ESM 代码（模拟部署重启后的新进程），返回 stdout。
// envDelete 用于从继承的环境中真正移除某些键（合并无法表达删除）。
function runInNewProcess(code, { envPatch = {}, envDelete = [] } = {}) {
  const env = { ...process.env, ...envPatch };
  for (const k of envDelete) delete env[k];
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
}
const childSign = (payload, opts) =>
  runInNewProcess(
    `import { signToken } from ${JSON.stringify(TOKEN_MODULE_URL)};\n` +
      `process.stdout.write(signToken(${JSON.stringify(payload)}));`,
    opts
  );
const childVerify = (token, opts) =>
  runInNewProcess(
    `import { verifyToken } from ${JSON.stringify(TOKEN_MODULE_URL)};\n` +
      `const p = verifyToken(${JSON.stringify(token)});\n` +
      `process.stdout.write(p ? 'OK' : 'FAIL');`,
    opts
  );

// 篡改：翻转签名首字节（长度不变 → 必须靠 HMAC 比对拦下）
function tamperSig(token) {
  const [p, s] = token.split('.');
  const b = Buffer.from(s, 'base64url');
  b[0] ^= 0xff;
  return `${p}.${b.toString('base64url')}`;
}
// 篡改：改 payload（提权 isRoot）但保留原签名 → 签名失配
function tamperPayload(token) {
  const [p, s] = token.split('.');
  const body = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  body.isRoot = !body.isRoot;
  body.userId = 99999;
  return `${Buffer.from(JSON.stringify(body)).toString('base64url')}.${s}`;
}

async function pwdLogin() {
  const r = await request(app).post('/api/admin/login').send({ password: ROOT_PASS });
  return r;
}

describe('CR-04 §1 无状态签名：签发/校验纯函数', () => {
  it('round-trip：payload 字段完整，默认 exp=30 天', () => {
    const secret = 'unit-secret';
    const now = Math.floor(Date.now() / 1000);
    const t = signToken({ userId: 7, username: 'u7', name: '张三', isRoot: false }, { secret });
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // 两段 base64url
    const p = verifyToken(t, { secret });
    expect(p).toMatchObject({ userId: 7, username: 'u7', name: '张三', isRoot: false });
    expect(p.exp - p.iat).toBe(TOKEN_TTL_SECONDS);
    expect(p.iat).toBeGreaterThanOrEqual(now - 2);
  });

  it('同一密钥、不同「实例」互相可校验；换密钥则失败', () => {
    const t = signToken({ userId: 1 }, { secret: 'A' });
    expect(verifyToken(t, { secret: 'A' })).toBeTruthy();
    expect(verifyToken(t, { secret: 'B' })).toBeNull();
  });

  it('篡改签名 / 篡改 payload / 畸形 / 过期 → null', () => {
    const secret = 'unit-secret';
    const t = signToken({ userId: 1, isRoot: false }, { secret });
    expect(verifyToken(tamperSig(t), { secret })).toBeNull();
    expect(verifyToken(tamperPayload(t), { secret })).toBeNull();
    expect(verifyToken('', { secret })).toBeNull();
    expect(verifyToken('not-a-token', { secret })).toBeNull();
    expect(verifyToken('a.b.c', { secret })).toBeNull();
    expect(verifyToken(null, { secret })).toBeNull();
    const past = signToken({ userId: 1, exp: Math.floor(Date.now() / 1000) - 5 }, { secret });
    expect(verifyToken(past, { secret })).toBeNull();
  });
});

describe('CR-04 §2 重启不失效（新进程 / 新 app 实例）', () => {
  it('①全新进程签发的 token，本进程 HTTP 直接放行（模拟部署重启）', async () => {
    // CR-06：非 root token 需库内存在 id/pwd_ver 匹配的行（最小适配：seed id=42、pv=0）
    db.prepare(
      "INSERT INTO admin_user(id,username,name,pwd_hash,pwd_salt,active,must_change_pwd,pwd_ver) VALUES(42,'dev','研发','x','y',1,0,0)"
    ).run();
    const token = childSign({ userId: 42, username: 'dev', name: '研发', isRoot: false });
    expect(token).toMatch(/\./);
    const r = await request(app).get('/api/admin/operators').set(bearer(token));
    expect(r.status).toBe(200);
  });

  it('②本进程签发的 token，交给全新进程校验 → OK', () => {
    const token = signToken({ userId: 42, username: 'dev', name: '研发', isRoot: false });
    expect(childVerify(token)).toBe('OK');
  });

  it('③两个独立 app 实例之间共享 token（不依赖任何每实例会话表）', async () => {
    const app2 = createApp({ db: openDb(':memory:'), adminPassword: ROOT_PASS, adminUser: ROOT_USER });
    const r = await request(app2).post('/api/admin/login').send({ password: ROOT_PASS });
    const token = r.body.data.token;
    const ok = await request(app).get('/api/admin/operators').set(bearer(token));
    expect(ok.status).toBe(200);
  });

  it('④登录返回的 token 可在另一「重启后」进程解析出同一主体', async () => {
    const r = await pwdLogin();
    const token = r.body.data.token;
    const out = runInNewProcess(
      `import { verifyToken } from ${JSON.stringify(TOKEN_MODULE_URL)};\n` +
        `const p = verifyToken(${JSON.stringify(token)});\n` +
        `process.stdout.write(p ? JSON.stringify({ isRoot: p.isRoot, name: p.name }) : 'FAIL');`
    );
    expect(JSON.parse(out)).toMatchObject({ isRoot: true, name: ROOT_USER });
  });
});

describe('CR-04 §3 非法 token → 401', () => {
  it('篡改签名 → 401', async () => {
    const token = (await pwdLogin()).body.data.token;
    const r = await request(app).get('/api/admin/operators').set(bearer(tamperSig(token)));
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('UNAUTHORIZED');
  });

  it('篡改 payload（提权 isRoot）→ 401', async () => {
    const token = (await pwdLogin()).body.data.token;
    const r = await request(app).get('/api/admin/operators').set(bearer(tamperPayload(token)));
    expect(r.status).toBe(401);
  });

  it('exp 过期 → 401', async () => {
    const expired = signToken({ userId: null, username: null, name: ROOT_USER, isRoot: true, exp: Math.floor(Date.now() / 1000) - 10 });
    const r = await request(app).get('/api/admin/operators').set(bearer(expired));
    expect(r.status).toBe(401);
  });

  it('无 token → 401', async () => {
    const r = await request(app).get('/api/admin/operators');
    expect(r.status).toBe(401);
  });
});

describe('CR-04 §4 双通道：Cookie + Bearer', () => {
  it('仅携带 httpOnly cookie（无 Authorization）→ 200', async () => {
    const r = await pwdLogin();
    expect(r.status).toBe(200);
    const setCookie = r.headers['set-cookie'] || [];
    const cookie = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('st_auth='));
    expect(cookie).toBeTruthy();
    const ok = await request(app).get('/api/admin/operators').set('Cookie', cookie);
    expect(ok.status).toBe(200);
  });

  it('登出后清 cookie，且旧 token 立即失效（撤销语义）', async () => {
    const token = (await pwdLogin()).body.data.token;
    const out = await request(app).post('/api/admin/logout').set(bearer(token));
    expect(out.status).toBe(200);
    const r = await request(app).get('/api/admin/operators').set(bearer(token));
    expect(r.status).toBe(401);
  });
});

describe('CR-04 §5 ADMIN_PASSWORD 单口令兜底不变', () => {
  it('正确口令 → 200（isRoot，userId=null，name=ADMIN_USER）', async () => {
    const r = await pwdLogin();
    expect(r.status).toBe(200);
    expect(r.body.data.token).toBeTruthy();
    expect(r.body.data.user.id).toBeNull();
    expect(r.body.data.user.name).toBe(ROOT_USER);
    const ok = await request(app).get('/api/admin/operators').set(bearer(r.body.data.token));
    expect(ok.status).toBe(200);
  });

  it('错误口令 → 401（文案统一）', async () => {
    const r = await request(app).post('/api/admin/login').send({ password: 'wrong-pass' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('UNAUTHORIZED');
    expect(r.body.message).toBe('用户名或密码错误');
  });
});

describe('CR-04 §6 密钥文件：自动生成 / 权限 / 跨进程共享 / 位置', () => {
  it('文件不存在则自动生成 32 字节 hex，目录 0700、文件 0600；跨进程一致', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr04-secret-'));
    const file = path.join(dir, 'nested', 'auth-secret');
    // 子进程：显式去掉 AUTH_SECRET（否则优先级更高），改走 AUTH_SECRET_FILE 自动生成路径
    const opts = { envPatch: { AUTH_SECRET_FILE: file }, envDelete: ['AUTH_SECRET'] };

    const tokenA = childSign({ userId: 1, name: 'n' }, opts);
    expect(fs.existsSync(file)).toBe(true);

    // 权限与内容（不打印密钥本身）
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const st = fs.statSync(file);
    expect(st.mode & 0o777).toBe(0o600);
    const hex = fs.readFileSync(file, 'utf8').trim();
    expect(hex).toMatch(/^[0-9a-f]{64}$/); // 32 字节 = 64 hex
    expect(tokenA).not.toContain(hex); // 签名 token 不泄漏密钥内容

    // 第二个「新进程」用同一文件 → 同一密钥 → 可校验第一个进程签发的 token
    expect(childVerify(tokenA, opts)).toBe('OK');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('默认密钥文件位于 server/ 之外（防 rsync --delete 部署误删）', () => {
    const p = defaultSecretFile();
    expect(p.startsWith(SERVER_DIR + path.sep)).toBe(false);
    expect(p.endsWith(path.join('.safety-timer', 'auth-secret'))).toBe(true);
  });

  it('env AUTH_SECRET 优先级最高（不落任何文件）', () => {
    // 本测试进程已由 vitest 配置注入固定 AUTH_SECRET，直接验证其生效
    expect(process.env.AUTH_SECRET).toBeTruthy();
    const t = childSign({ userId: 9 }, { envPatch: { AUTH_SECRET: 'child-env-secret' } });
    expect(childVerify(t, { envPatch: { AUTH_SECRET: 'child-env-secret' } })).toBe('OK');
    expect(childVerify(t, { envPatch: { AUTH_SECRET: 'other' } })).toBe('FAIL');
  });
});
