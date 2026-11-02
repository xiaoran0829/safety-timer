// CR-06：H5 安全员登录（账号 = operator.username + 口令）。
// 口令仅存 scrypt 派生值 + 随机盐（均 hex），明文永不落盘/入库/日志。
// 登录 → 只下发操作员 DTO {id,name,label,groupName}；cookie 名 st_op（与后台 st_auth 分离）。
import { Router } from 'express';
import { sendOk } from '../lib/http.js';
import { ERR } from '../lib/errors.js';
import {
  issueToken,
  revokeToken,
  requireOperator,
  currentUser,
  verifyPasswordHash,
  hashPassword,
  extractToken,
  OP_COOKIE_NAME,
  COOKIE_MAX_AGE_MS,
} from '../middleware/auth.js';
// CR-11：登录日志写入（安全员 H5 登录成功/失败）
import { writeLoginLog } from '../services/loginLog.js';
// CR-12：登录限流（安全员连续失败锁定 + IP 失败上限）——回补进仓
import { loginRateLimit } from '../middleware/rateLimit.js';

const MIN_PWD = 6;

/** 操作员摘要 DTO（**绝不含 pwd_hash/pwd_salt**） */
const opSummary = (row) => ({
  id: row.id,
  name: row.name,
  label: row.label ?? null,
  groupName: row.group_name ?? null,
});

export function h5Router(db) {
  const r = Router();

  /* ---------- 登录（公开） ---------- */
  r.post('/login', loginRateLimit({ db, source: 'h5' }), (req, res) => {
    const b = req.body || {};
    const username = String(b.username ?? '').trim();
    const pwd = b.password;
    if (!username || pwd === undefined || pwd === null || String(pwd) === '') {
      writeLoginLog(db, { account: username || null, role: 'operator', source: 'h5', result: 'fail', reason: 'VALIDATION', req });
      throw ERR.VALIDATION('用户名与密码必填');
    }
    const row = db
      .prepare("SELECT * FROM operator WHERE username=? AND username IS NOT NULL AND username <> ''")
      .get(username);
    // 无账号 / 未开通（无口令）/ 口令错 → 统一 401（不泄露账号是否存在）
    if (!row || !row.pwd_hash || !row.pwd_salt || !verifyPasswordHash(String(pwd), row.pwd_hash, row.pwd_salt)) {
      writeLoginLog(db, { account: username, name: row ? row.name : null, role: 'operator', source: 'h5', result: 'fail', reason: 'INVALID_CREDENTIALS', req });
      throw ERR.INVALID_CREDENTIALS('用户名或密码错误');
    }
    if (row.active !== 1 || row.employed !== 1) {
      writeLoginLog(db, { account: username, name: row.name, role: 'operator', source: 'h5', result: 'fail', reason: 'ACCOUNT_INACTIVE', req });
      throw ERR.ACCOUNT_INACTIVE();
    }

    const token = issueToken({ role: 'operator', operatorId: row.id, name: row.name, pv: Number(row.pwd_ver ?? 0) });
    res.cookie(OP_COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE_MS });
    // CR-11：登录成功留痕
    writeLoginLog(db, { account: row.username, name: row.name, role: 'operator', source: 'h5', result: 'ok', req });
    sendOk(res, {
      token,
      operator: opSummary(row),
      mustChangePwd: Number(row.must_change_pwd ?? 0) === 1,
    });
  });

  // 以下均需安全员登录态（闸门白名单含 /api/h5/me|password|logout）
  r.use(requireOperator);

  r.post('/logout', (req, res) => {
    revokeToken(extractToken(req));
    res.clearCookie(OP_COOKIE_NAME);
    sendOk(res, { ok: true });
  });

  r.get('/me', (req, res) => {
    const me = currentUser(req);
    const row = me && me.operatorId != null ? db.prepare('SELECT * FROM operator WHERE id=?').get(me.operatorId) : null;
    if (!row) throw ERR.UNAUTHORIZED();
    sendOk(res, {
      operator: opSummary(row),
      mustChangePwd: Number(row.must_change_pwd ?? 0) === 1,
    });
  });

  // 本人改密：{oldPassword,newPassword}（口径与后台一致）
  r.post('/password', (req, res) => {
    const me = currentUser(req);
    if (!me || me.operatorId == null) throw ERR.UNAUTHORIZED();
    const row = db.prepare('SELECT * FROM operator WHERE id=?').get(me.operatorId);
    if (!row) throw ERR.UNAUTHORIZED();
    const b = req.body || {};
    if (!verifyPasswordHash(b.oldPassword, row.pwd_hash, row.pwd_salt)) throw ERR.INVALID_OLD_PASSWORD();
    const newPwd = b.newPassword === undefined || b.newPassword === null ? '' : String(b.newPassword);
    if (newPwd.length < MIN_PWD || newPwd.trim() === '') throw ERR.VALIDATION(`口令长度不得少于 ${MIN_PWD} 位`);
    const { hash, salt } = hashPassword(newPwd);
    const nextVer = Number(row.pwd_ver ?? 0) + 1;
    db.prepare('UPDATE operator SET pwd_hash=?, pwd_salt=?, pwd_ver=?, must_change_pwd=0 WHERE id=?').run(
      hash,
      salt,
      nextVer,
      row.id
    );
    // 重新签发：新 pv 生效 → 旧 token 立即失效
    const token = issueToken({ role: 'operator', operatorId: row.id, name: row.name, pv: nextVer });
    res.cookie(OP_COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE_MS });
    sendOk(res, { token });
  });

  return r;
}
