// CR-04：无状态 HMAC 签名 token —— 重启 / 多进程均有效，不依赖任何进程内状态。
// ---------------------------------------------------------------------------
// 背景（已取证）：原实现用进程内 Map 保存 token → 每次 systemctl restart 部署后
// 全体 token 立即失效，浏览器仍持旧 token → 保存时 401「未登录」。本模块改为
// 自包含签名 token：校验只依赖「密钥 + 签名 + exp」，无需任何服务端会话表。
//
// 结构：base64url(JSON payload) + "." + base64url(HMAC-SHA256(payloadB64, secret))
// payload：{ userId, username, name, isRoot, iat, exp, jti }
//   · exp 默认 30 天；jti 为每次签发的随机唯一标识（同秒同主体亦不重复）
//
// 密钥来源（优先级从高到低），全程绝不打印/落盘明文以外的任何日志：
//   1) process.env.AUTH_SECRET                （直接作为 HMAC key 字节）
//   2) process.env.AUTH_SECRET_FILE           （文件内容为 64 位 hex = 32 字节）
//   3) ~/.safety-timer/auth-secret            （默认；文件不存在则自动生成）
// ⚠️ 密钥文件必须位于 server/ 之外：生产同步脚本会 `rsync --delete` 整个 server/，
//    放在 server/ 内会在下次部署时被删除，导致密钥轮换 → 再次全体掉线。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** token 默认有效期：30 天 */
export const TOKEN_TTL_SECONDS = 30 * 24 * 3600;
export const TOKEN_TTL_MS = TOKEN_TTL_SECONDS * 1000;

/** 默认密钥文件路径（位于 server/ 之外，见文件头说明） */
export function defaultSecretFile() {
  return path.join(os.homedir(), '.safety-timer', 'auth-secret');
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * 读取密钥文件；不存在则生成 32 字节随机 hex 并写入（目录 0700、文件 0600）。
 * 用 'wx' 独占创建避免多进程首启竞争写出不同密钥；EEXIST 时回读已存在文件。
 * 返回文件中的 hex 字符串（调用方负责转 Buffer）。绝不打印内容。
 */
function readOrCreateSecretHex(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* 已存在目录或不支持 chmod：忽略（best-effort 加固） */
  }

  const hex = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, `${hex}\n`, { mode: 0o600, flag: 'wx' });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* ignore */
    }
    return hex;
  } catch (e) {
    if (e.code === 'EEXIST') return fs.readFileSync(file, 'utf8').trim(); // 竞争失败方回读
    throw e;
  }
}

/**
 * 解析当前密钥（每次调用即时解析，不做进程内缓存 → 完全无状态、可测试、
 * 环境变量变更即时生效）。返回 Buffer。
 */
export function getSecret() {
  const env = process.env.AUTH_SECRET;
  if (env && String(env).trim()) return Buffer.from(String(env).trim(), 'utf8');
  const file = process.env.AUTH_SECRET_FILE || defaultSecretFile();
  return Buffer.from(readOrCreateSecretHex(file), 'hex');
}

function hmac(payloadB64, key) {
  return crypto.createHmac('sha256', key).update(payloadB64).digest();
}

/**
 * 签发 token。
 * CR-06：payload 增 role('admin'|'operator'，缺省 admin)、operatorId(nullable)、pv(number，缺省 0)。
 * pv 为账号口令版本号（pwd_ver），校验时与库内比对；改密/重置 → pv+1 → 旧 token 失效。
 * @param {{userId?:number|null, username?:string|null, name?:string|null, isRoot?:boolean, role?:string, operatorId?:number|null, pv?:number, iat?:number, exp?:number, jti?:string}} payload
 * @param {{secret?:string|Buffer, ttlSeconds?:number}} [opts] secret 仅测试注入用
 */
export function signToken(payload = {}, { secret, ttlSeconds } = {}) {
  const key = secret !== undefined ? Buffer.from(secret) : getSecret();
  const now = Math.floor(Date.now() / 1000);
  const body = {
    userId: payload.userId ?? null,
    username: payload.username ?? null,
    name: payload.name ?? null,
    isRoot: !!payload.isRoot,
    role: payload.role === 'operator' ? 'operator' : 'admin',
    operatorId: payload.operatorId ?? null,
    pv: Number.isFinite(Number(payload.pv)) ? Number(payload.pv) : 0,
    iat: payload.iat ?? now,
    // jti：随机唯一标识，保证同一秒内同主体的多次签发也各不相同（登出撤销需可区分单次签发）
    jti: payload.jti ?? crypto.randomBytes(16).toString('hex'),
    exp: payload.exp ?? now + (ttlSeconds ?? TOKEN_TTL_SECONDS),
  };
  const payloadB64 = b64url(JSON.stringify(body));
  return `${payloadB64}.${b64url(hmac(payloadB64, key))}`;
}

/**
 * 校验 token：纯函数、无状态 —— 只做 签名比对（timingSafeEqual）+ exp 未过期。
 * @returns {object|null} 通过则返回 payload，否则 null（任何异常一律 null）。
 */
export function verifyToken(token, { secret } = {}) {
  if (typeof token !== 'string' || !token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!payloadB64 || !sigB64 || sigB64.includes('.')) return null; // 只允许两段

  let provided;
  let key;
  try {
    provided = Buffer.from(sigB64, 'base64url');
    key = secret !== undefined ? Buffer.from(secret) : getSecret();
  } catch {
    return null;
  }

  const expected = hmac(payloadB64, key);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;

  let body;
  try {
    body = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;

  // CR-06 向后兼容：旧 token 无 role → admin；无 pv → 0；无 operatorId → null。
  if (body.role !== 'operator') body.role = 'admin';
  if (body.operatorId === undefined) body.operatorId = null;
  if (typeof body.pv !== 'number' || !Number.isFinite(body.pv)) body.pv = 0;

  const now = Math.floor(Date.now() / 1000);
  if (typeof body.exp !== 'number' || body.exp <= now) return null; // 过期 → 无效
  return body;
}
