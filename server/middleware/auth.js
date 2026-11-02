// 后台/安全员鉴权（冻结规格 §5.5 / CR-03 / CR-04 / CR-06）：账号或单口令登录 → httpOnly Cookie（或 Bearer Token）
// CR-04：token 改为「无状态 HMAC 签名」（见 lib/token.js）——重启 / 多进程均有效，
//        彻底修复「服务重启后浏览器旧 token 全部 401 → 一直提示未登录」的根因。
// CR-06：① payload 增 role/operatorId/pv；校验时按 role 查库比对 pwd_ver（改密/重置后旧 token 立即失效）；
//        ② 新增 requireOperator（H5 安全员），operator cookie 名 st_op（admin 保持 st_auth）；
//        ③ 强制改密闸门：must_change_pwd=1 时仅放行白名单路径，其余 403 MUST_CHANGE_PASSWORD。
import crypto from 'node:crypto';
import { ERR } from '../lib/errors.js';
import { signToken, verifyToken, TOKEN_TTL_MS } from '../lib/token.js';
import { canAccess, normalizeRole } from '../lib/roles.js';

export const COOKIE_NAME = 'st_auth'; // 后台管理员
export const OP_COOKIE_NAME = 'st_op'; // H5 安全员
/** Cookie 有效期与 token 有效期对齐（30 天），避免 Cookie 先于 token 过期。 */
export const COOKIE_MAX_AGE_MS = TOKEN_TTL_MS;

/**
 * 登出撤销「叠加层」：best-effort、仅当前进程内有效。
 * 注意：token 本体是无状态的（签名 + exp 即可校验，见 verifyToken），此集合
 * 只用于保留「登出后旧 token 立即失效」的语义；服务重启后该集合清空，
 * 但**已签发的有效 token 不会因重启而失效**（CR-04 修复的核心目标）。
 */
const REVOKED = new Set();
const digest = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/** CR-06 强制改密闸门白名单：must_change_pwd=1 时仍可访问（供「先改密」闭环）。 */
const CHANGE_PWD_WHITELIST = new Set([
  '/api/admin/me',
  '/api/admin/me/password',
  '/api/admin/logout',
  '/api/h5/me',
  '/api/h5/password',
  '/api/h5/logout',
]);

/** 内部哨兵：签名通过但与库内 pwd_ver 不一致 → 401 TOKEN_STALE（区别于「未登录」）。 */
const STALE = Symbol('token-stale');

/**
 * 下发 token（无状态签名）。
 * @param {{userId?:number|null, username?:string|null, name?:string|null, isRoot?:boolean, role?:string, operatorId?:number|null, pv?:number}} payload
 */
export function issueToken(payload = {}) {
  return signToken({
    userId: payload.userId ?? null,
    username: payload.username ?? null,
    name: payload.name ?? null,
    isRoot: !!payload.isRoot,
    role: payload.role === 'operator' ? 'operator' : 'admin',
    operatorId: payload.operatorId ?? null,
    pv: Number(payload.pv) || 0,
  });
}

/** 登出：把该 token 记入进程内撤销集合（无状态 token 的 no-op 亦可接受，这里保留登出语义）。 */
export function revokeToken(t) {
  if (t) REVOKED.add(digest(t));
}

/** 常量时间比较（env 单口令兜底路径保留） */
export function verifyPassword(input, expected) {
  const a = Buffer.from(String(input ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** scrypt 加盐派生（Node 内置，零新依赖）：返回 hex 存储的 { hash, salt }。明文不落盘。 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return { hash: hash.toString('hex'), salt: salt.toString('hex') };
}

/** 校验 scrypt 派生口令（常量时间）；任何异常一律视为不匹配 */
export function verifyPasswordHash(password, hashHex, saltHex) {
  if (!hashHex || !saltHex) return false;
  try {
    const salt = Buffer.from(String(saltHex), 'hex');
    const expected = Buffer.from(String(hashHex), 'hex');
    const actual = crypto.scryptSync(String(password), salt, 32);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function bearerToken(req) {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
}

/**
 * 取请求 token：Bearer 为双角色通用通道；Cookie 按角色取（admin→st_auth，operator→st_op）。
 * role 缺省时优先 st_auth，再退 st_op（供 currentUser 等无角色语境使用）。
 */
function tokenFromReq(req, role) {
  const b = bearerToken(req);
  if (b) return b;
  if (role === 'operator') return req.cookies?.[OP_COOKIE_NAME] || null;
  if (role === 'admin') return req.cookies?.[COOKIE_NAME] || null;
  return req.cookies?.[COOKIE_NAME] || req.cookies?.[OP_COOKIE_NAME] || null;
}

/**
 * 解析并校验请求主体（签名 + exp + 撤销 + role + pwd_ver）。
 * @returns {object|typeof STALE|null} 主体对象 / STALE / null（未登录或非法）
 */
function resolvePrincipal(req, expectRole) {
  const t = tokenFromReq(req, expectRole);
  if (!t) return null;
  if (REVOKED.has(digest(t))) return null;
  const p = verifyToken(t);
  if (!p) return null;

  const role = p.role === 'operator' ? 'operator' : 'admin';
  if (expectRole && role !== expectRole) return null; // 角色不符 → 视为未登录

  const db = req.db || null;
  let mustChangePwd = false;
  let adminRole = 'admin';
  let adminOrgId = null;
  let adminSupplierId = null;

  if (role === 'admin') {
    // isRoot（env 单口令兜底通道）无 DB 行 → 跳过比对，视同 admin
    if (!p.isRoot && db && p.userId != null) {
      const row = db
        .prepare('SELECT id,pwd_ver,must_change_pwd,role,org_id,supplier_id FROM admin_user WHERE id=?')
        .get(p.userId);
      // CR-06 收紧：账号已被（硬）删除 → 行不存在 → 旧 token 立即失效；
      // 行存在则比对 pwd_ver（旧 token 默认 pv=0，改密/重置后不一致）。
      if (!row) return STALE;
      if (Number(row.pwd_ver ?? 0) !== Number(p.pv ?? 0)) return STALE;
      mustChangePwd = Number(row.must_change_pwd ?? 0) === 1;
      // CR-10：后台角色从库读 → 改角色即时生效，无需重登/不产生 TOKEN_STALE
      adminRole = normalizeRole(row.role);
      // 2026-10-08 需求③④：数据范围绑定（改绑即时生效）
      adminOrgId = row.org_id ?? null;
      adminSupplierId = row.supplier_id ?? null;
    }
  } else if (db && p.operatorId != null) {
    const row = db
      .prepare('SELECT id,pwd_ver,must_change_pwd FROM operator WHERE id=?')
      .get(p.operatorId);
    // CR-06 收紧：安全员行不存在 → 旧 token 立即失效；存在则比对 pwd_ver。
    if (!row) return STALE;
    if (Number(row.pwd_ver ?? 0) !== Number(p.pv ?? 0)) return STALE;
    mustChangePwd = Number(row.must_change_pwd ?? 0) === 1;
  }

  return {
    role,
    userId: p.userId ?? null,
    operatorId: p.operatorId ?? null,
    username: p.username ?? null,
    name: p.name ?? null,
    isRoot: !!p.isRoot,
    mustChangePwd,
    // CR-10：后台角色（operator 主体时为 null）
    adminRole: role === 'admin' ? adminRole : null,
    // 2026-10-08 需求③④：所属组织/供应商（operator 主体时为 null）
    orgId: role === 'admin' ? adminOrgId : null,
    supplierId: role === 'admin' ? adminSupplierId : null,
  };
}

function inChangePwdWhitelist(req) {
  const p = String(req.originalUrl || '').split('?')[0];
  return CHANGE_PWD_WHITELIST.has(p);
}

/** 强制改密闸门：requireAdmin/requireOperator 通过后，未改密且路径不在白名单 → 403 */
function gateMustChange(req, principal, next) {
  if (principal.mustChangePwd && !inChangePwdWhitelist(req)) return next(ERR.MUST_CHANGE_PASSWORD());
  req.authUser = principal;
  next();
}

/** 当前登录主体（供发起人取值/审计）；未登录/失效返回 null */
export function currentUser(req) {
  const a = resolvePrincipal(req);
  return a === STALE ? null : a;
}

export function requireAdmin(req, res, next) {
  const a = resolvePrincipal(req, 'admin');
  if (a === STALE) return next(ERR.TOKEN_STALE());
  if (!a) return next(ERR.UNAUTHORIZED());
  gateMustChange(req, a, next);
}

/** CR-06：H5 安全员登录态校验（仅接受 role=operator 的 token） */
export function requireOperator(req, res, next) {
  const a = resolvePrincipal(req, 'operator');
  if (a === STALE) return next(ERR.TOKEN_STALE());
  if (!a) return next(ERR.UNAUTHORIZED());
  gateMustChange(req, a, next);
}

export function extractToken(req) {
  return tokenFromReq(req);
}

/**
 * CR-10：模块级权限闸门（必须挂在 requireAdmin 之后）。
 * 读（GET）宽 / 写（其余方法）严，矩阵见 lib/roles.js。越权 → 403 NO_PERMISSION。
 * @param {string} key 模块键（operators|vehicles|dicts|schedules|users|sessions|detail）
 */
export function requirePerm(key) {
  return function permGuard(req, res, next) {
    const me = req.authUser || null;
    const role = normalizeRole(me && me.adminRole);
    const mode = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write';
    if (!canAccess(role, key, mode)) return next(ERR.NO_PERMISSION());
    next();
  };
}

/**
 * CR-06 补丁：公开路由（如 /api/sessions/*）的「登录态才闸门」。
 * 仅当请求携带了**可解析的登录态**（operator 或 admin token 解析成功）且 mustChangePwd===1
 * → 403 MUST_CHANGE_PASSWORD；无 token / token 非法 / token 已 STALE → 原样放行（公开行为不变）。
 * 目的：阻止未改密的安全员用 token 直接打公开业务路由绕过「不先改密就不能干活」。
 */
export function mustChangeGateIfLoggedIn(req, res, next) {
  const a = resolvePrincipal(req);
  if (a && a !== STALE && a.mustChangePwd) return next(ERR.MUST_CHANGE_PASSWORD());
  next();
}

/** 是否已登录后台（用于 admin 例外：可越权操作任意会话） */
export function isAdmin(req) {
  const a = resolvePrincipal(req);
  return !!(a && a !== STALE && a.role === 'admin');
}
