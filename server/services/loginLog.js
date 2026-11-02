// CR-11：登录日志读写服务。
// 设计要点：
//  - 写日志**绝不抛错**：任何异常都被吞掉（日志失败不能影响登录本身）。
//  - 只记登录元数据；**绝不落口令/派生值/盐/令牌**。
import { fmtDateTime } from '../lib/time.js';

/** 取客户端 IP：优先 req.ip（已设 trust proxy 时会解析 XFF）；退化到 XFF 首段 / socket 对端。 */
export function clientIp(req) {
  if (!req) return null;
  const ip = req.ip || null;
  if (ip) return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  const sock = req.socket && req.socket.remoteAddress;
  if (sock) return sock.startsWith('::ffff:') ? sock.slice(7) : sock;
  return null;
}

/** UA：截断到 300 字符，避免异常超长串撑爆库。 */
export function clientUa(req) {
  const ua = req && req.headers && req.headers['user-agent'];
  if (!ua) return null;
  return String(ua).slice(0, 300);
}

/**
 * 写一条登录日志（永不抛错）。
 * @param {import('better-sqlite3').Database} db
 * @param {{account?:string|null,name?:string|null,role?:string|null,source:'admin'|'h5',
 *          result:'ok'|'fail',reason?:string|null,req?:any,at?:string}} e
 * @returns {boolean} 是否写入成功
 */
export function writeLoginLog(db, e = {}) {
  try {
    if (!db) return false;
    const str = (v) => (v === undefined || v === null ? null : String(v).slice(0, 200) || null);
    const source = e.source === 'h5' ? 'h5' : 'admin';
    const result = e.result === 'ok' ? 'ok' : 'fail';
    db.prepare(
      `INSERT INTO login_log(account,name,role,source,result,reason,ip,ua,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`
    ).run(
      str(e.account),
      str(e.name),
      str(e.role),
      source,
      result,
      str(e.reason),
      clientIp(e.req),
      clientUa(e.req),
      e.at || fmtDateTime()
    );
    return true;
  } catch {
    return false; // 日志失败不影响主流程
  }
}

/**
 * 查询登录日志（分页 + 筛选）。只读。
 * @param {import('better-sqlite3').Database} db
 * @param {{account?:string,source?:string,result?:string,role?:string,from?:string,to?:string,page?:*,pageSize?:*}} q
 */
export function listLoginLogs(db, q = {}) {
  const where = [];
  const args = [];
  const acct = String(q.account ?? '').trim();
  if (acct) {
    where.push('account LIKE ?');
    args.push(`%${acct}%`);
  }
  if (q.source === 'admin' || q.source === 'h5') {
    where.push('source = ?');
    args.push(q.source);
  }
  if (q.result === 'ok' || q.result === 'fail') {
    where.push('result = ?');
    args.push(q.result);
  }
  if (q.role) {
    where.push('role = ?');
    args.push(String(q.role));
  }
  // 时间范围：按 created_at（'YYYY-MM-DD HH:MM:SS' 文本可直接比较）
  const from = String(q.from ?? '').trim();
  const to = String(q.to ?? '').trim();
  if (from) {
    where.push('created_at >= ?');
    args.push(from.length <= 10 ? `${from} 00:00:00` : from);
  }
  if (to) {
    where.push('created_at <= ?');
    args.push(to.length <= 10 ? `${to} 23:59:59` : to);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 20));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM login_log ${clause}`).get(...args).n;
  const rows = db
    .prepare(
      `SELECT id,account,name,role,source,result,reason,ip,ua,created_at
       FROM login_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, (page - 1) * pageSize);
  return {
    total,
    page,
    pageSize,
    items: rows.map((r) => ({
      id: r.id,
      account: r.account ?? null,
      name: r.name ?? null,
      role: r.role ?? null,
      source: r.source,
      result: r.result,
      reason: r.reason ?? null,
      ip: r.ip ?? null,
      ua: r.ua ?? null,
      createdAt: r.created_at,
    })),
  };
}
