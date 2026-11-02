// CR-03：后台账号管理（用户名 + 密码）。全部需登录（挂载于 adminRouter 的 /users 下）。
// DTO 仅返回 {id,username,name,active,createdAt,updatedAt}，**绝不返回 pwd_hash/pwd_salt**。
// 防锁死守卫：不能删除/禁用「自己」，不能删除/禁用「最后一个 active=1 的管理员」。
import { Router } from 'express';
import { sendOk } from '../lib/http.js';
import { ERR } from '../lib/errors.js';
import { currentUser, hashPassword } from '../middleware/auth.js';
import { ROLES, normalizeRole } from '../lib/roles.js';
import { validateRoleScope } from '../lib/scope.js';

const MIN_PWD = 6;

/** DB 行 → 账号 DTO（**绝不含 hash/salt**） */
const USER_SELECT = `SELECT u.*, o.name AS org_name, s.name AS supplier_name
  FROM admin_user u
  LEFT JOIN organization o ON o.id = u.org_id
  LEFT JOIN supplier s ON s.id = u.supplier_id`;

/** DB 行 → 账号 DTO（**绝不含 hash/salt**） */
const toUserDto = (row) =>
  row
    ? {
        id: row.id,
        username: row.username,
        name: row.name,
        active: row.active,
        role: normalizeRole(row.role), // CR-10：后台角色
        // 2026-10-08 需求③④：所属组织/供应商（工程师↔组织，车队↔供应商）
        orgId: row.org_id ?? null,
        orgName: row.org_name ?? null,
        supplierId: row.supplier_id ?? null,
        supplierName: row.supplier_name ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at ?? null,
      }
    : null;

function assertRef(db, table, id, label) {
  if (id == null) return;
  const row = db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(Number(id));
  if (!row) throw ERR.VALIDATION(`${label}不存在`);
}

function weakPassword(pwd) {
  const s = pwd === undefined || pwd === null ? '' : String(pwd);
  return s.length < MIN_PWD || s.trim() === '';
}

function activeAdminCount(db) {
  // CR-10：只统计 role='admin' 的启用账号（防「最后一个管理员」被降级/禁用/删除）
  return db.prepare("SELECT COUNT(*) AS n FROM admin_user WHERE active=1 AND role='admin'").get().n;
}

/** 校验 role 入参：合法返回归一化值，非法抛 VALIDATION */
function pickRole(v, fallback) {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const s = String(v).trim();
  if (!ROLES.includes(s)) throw ERR.VALIDATION('role 非法（admin|engineer|fleet_admin）');
  return s;
}

export function usersRouter(db) {
  const r = Router();

  /* 列表：?active= &q= */
  r.get('/', (req, res) => {
    const where = [];
    const args = [];
    if (req.query.active !== undefined && req.query.active !== '' && req.query.active !== null) {
      where.push('u.active = ?');
      args.push(Number(req.query.active) ? 1 : 0);
    }
    const q = String(req.query.q || '').trim();
    if (q) {
      where.push('(u.username LIKE ? OR u.name LIKE ?)');
      args.push(`%${q}%`, `%${q}%`);
    }
    const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`${USER_SELECT} ${wsql} ORDER BY u.active DESC, u.id ASC`).all(...args);
    sendOk(res, rows.map(toUserDto));
  });

  /* 建号：{username,name?,password}；username 唯一（允许中文），name 缺省=username */
  // CR-06：默认 must_change_pwd=1（首次登录后强制改密）；mustChange:false 可显式关闭。
  r.post('/', (req, res) => {
    const b = req.body || {};
    const username = String(b.username ?? '').trim();
    if (!username) throw ERR.VALIDATION('username 必填');
    if (weakPassword(b.password)) throw ERR.VALIDATION(`口令长度不得少于 ${MIN_PWD} 位`);
    const name = b.name === undefined || b.name === null ? username : String(b.name).trim() || username;
    const mustChange = b.mustChange === false ? 0 : 1;
    const role = pickRole(b.role, 'admin'); // CR-10：缺省 admin
    // 2026-10-08 需求④：角色↔单位映射校验
    const numOrNull = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : Number(v));
    const { orgId, supplierId } = validateRoleScope(role, numOrNull(b.orgId), numOrNull(b.supplierId), ERR);
    assertRef(db, 'organization', orgId, '所属组织');
    assertRef(db, 'supplier', supplierId, '所属供应商');
    const { hash, salt } = hashPassword(String(b.password));
    try {
      const info = db
        .prepare('INSERT INTO admin_user(username,name,pwd_hash,pwd_salt,active,role,must_change_pwd,org_id,supplier_id) VALUES(?,?,?,?,1,?,?,?,?)')
        .run(username, name, hash, salt, role, mustChange, orgId, supplierId);
      sendOk(res, toUserDto(db.prepare(`${USER_SELECT} WHERE u.id=?`).get(Number(info.lastInsertRowid))), 201);
    } catch (e) {
      if (/UNIQUE constraint failed: admin_user\.username/.test(e.message)) throw ERR.CONFLICT('用户名已存在');
      throw e;
    }
  });

  /* 改 name/active/role（不改用户名；改密走 /:id/password） */
  r.put('/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM admin_user WHERE id=?').get(id);
    if (!cur) throw ERR.NOT_FOUND('账号不存在');
    const me = currentUser(req);
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() || cur.name : cur.name;
    const active = b.active !== undefined ? (Number(b.active) ? 1 : 0) : cur.active;
    const role = pickRole(b.role, normalizeRole(cur.role)); // CR-10

    // CR-10 防锁死：把最后一个启用管理员降级 → 拦（含「自己降自己」）
    if (normalizeRole(cur.role) === 'admin' && role !== 'admin') {
      if (me && me.userId != null && Number(me.userId) === id) throw ERR.INVALID_STATE('不能降级当前登录账号');
      if (activeAdminCount(db) <= 1) throw ERR.INVALID_STATE('不能降级最后一个管理员账号');
    }

    if (active === 0 && cur.active === 1) {
      if (me && me.userId != null && Number(me.userId) === id) throw ERR.INVALID_STATE('不能禁用当前登录账号');
      if (normalizeRole(cur.role) === 'admin' && activeAdminCount(db) <= 1)
        throw ERR.INVALID_STATE('不能禁用最后一个启用的管理员账号');
    }

    // 2026-10-08 需求③④：所属组织/供应商（仅管理员可改；换单位须走审批流程，见需求②）
    const numOrNull = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : Number(v));
    const nextOrg = b.orgId !== undefined ? numOrNull(b.orgId) : (cur.org_id ?? null);
    const nextSup = b.supplierId !== undefined ? numOrNull(b.supplierId) : (cur.supplier_id ?? null);
    const { orgId, supplierId } = validateRoleScope(role, nextOrg, nextSup, ERR);
    assertRef(db, 'organization', orgId, '所属组织');
    assertRef(db, 'supplier', supplierId, '所属供应商');
    db.prepare("UPDATE admin_user SET name=?, active=?, role=?, org_id=?, supplier_id=?, updated_at=datetime('now','+8 hours') WHERE id=?").run(
      name,
      active,
      role,
      orgId,
      supplierId,
      id
    );
    sendOk(res, toUserDto(db.prepare(`${USER_SELECT} WHERE u.id=?`).get(id)));
  });

  /* 重置口令：{password}；CR-06：pwd_ver+1 且 must_change_pwd=1（重置自己同走此逻辑，不得绕过） */
  r.post('/:id/password', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM admin_user WHERE id=?').get(id);
    if (!cur) throw ERR.NOT_FOUND('账号不存在');
    const b = req.body || {};
    if (weakPassword(b.password)) throw ERR.VALIDATION(`口令长度不得少于 ${MIN_PWD} 位`);
    const { hash, salt } = hashPassword(String(b.password));
    db.prepare(
      "UPDATE admin_user SET pwd_hash=?, pwd_salt=?, pwd_ver=COALESCE(pwd_ver,0)+1, must_change_pwd=1, updated_at=datetime('now','+8 hours') WHERE id=?"
    ).run(hash, salt, id);
    sendOk(res, { ok: true, mustChangePwd: true });
  });

  /* 硬删（守卫见上） */
  r.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM admin_user WHERE id=?').get(id);
    if (!cur) throw ERR.NOT_FOUND('账号不存在');
    const me = currentUser(req);
    if (me && me.userId != null && Number(me.userId) === id) throw ERR.INVALID_STATE('不能删除当前登录账号');
    if (cur.active === 1 && normalizeRole(cur.role) === 'admin' && activeAdminCount(db) <= 1)
      throw ERR.INVALID_STATE('不能删除最后一个启用的管理员账号');
    db.prepare('DELETE FROM admin_user WHERE id=?').run(id);
    sendOk(res, { ok: true });
  });

  return r;
}
