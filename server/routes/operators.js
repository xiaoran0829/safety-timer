import { Router } from 'express';
import { sendOk } from '../lib/http.js';

/** 安全员 DTO（CR-01 §11.5：新增 employeeNo / groupName） */
const dto = (r) => ({
  id: r.id,
  name: r.name,
  label: r.label,
  phone: r.phone,
  active: r.active,
  sort: r.sort,
  employeeNo: r.employee_no ?? null,
  groupName: r.group_name ?? null,
});

/** 后台用 DTO：附在职状态 + CR-06 H5 账号状态（**绝不返回 pwd_hash/pwd_salt**） */
export const operatorDto = (r) =>
  r
    ? {
        ...dto(r),
        employed: r.employed ?? 1,
        username: r.username ?? null,
        hasAccount: !!(r.username && r.pwd_hash),
      }
    : null;

/**
 * GET /api/operators?active=1&q=
 * CR-01（§11.5）：仅返回 active=1 AND employed=1（在职且启用）。
 */
export function operatorsRouter(db) {
  const r = Router();
  r.get('/', (req, res) => {
    const active = req.query.active === undefined ? 1 : Number(req.query.active);
    const q = (req.query.q || '').trim();
    const where = ['active = ?', 'employed = 1'];
    const args = [active];
    if (q) {
      where.push('(name LIKE ? OR label LIKE ? OR employee_no LIKE ? OR group_name LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const rows = db
      .prepare(`SELECT * FROM operator WHERE ${where.join(' AND ')} ORDER BY sort ASC, id ASC`)
      .all(...args);
    sendOk(res, rows.map(dto));
  });
  return r;
}

/** 后台用：含停用/离职 */
export function listOperatorsAdmin(db, { active, q } = {}) {
  const where = [];
  const args = [];
  if (active !== undefined && active !== '' && active !== null) {
    where.push('active = ?');
    args.push(Number(active));
  }
  if (q) {
    where.push('(name LIKE ? OR label LIKE ? OR employee_no LIKE ? OR group_name LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM operator ${wsql} ORDER BY active DESC, sort ASC, id ASC`).all(...args).map(operatorDto);
}

export { dto };
