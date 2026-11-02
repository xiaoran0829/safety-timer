import { Router } from 'express';
import multer from 'multer';
import { sendOk } from '../lib/http.js';
import { ERR } from '../lib/errors.js';
import { readUploadRows } from '../lib/spreadsheet.js';
import { isValidVin, normalizeVin, VIN_HINT } from '../lib/vin.js';
import {
  issueToken,
  revokeToken,
  requireAdmin,
  requirePerm,
  currentUser,
  verifyPassword,
  verifyPasswordHash,
  hashPassword,
  extractToken,
  COOKIE_NAME,
  COOKIE_MAX_AGE_MS,
} from '../middleware/auth.js';
import { normalizeRole } from '../lib/roles.js';
import { reqScope, inScope } from '../lib/scope.js';
import { usersRouter } from './users.js';
// 2026-10-08 需求②：审批中心
import { approvalsRouter, submitForceStop } from './approvals.js';
import { listOperatorsAdmin, operatorDto } from './operators.js';
import { listSessionsHandler } from './sessions.js';
import { exportHandler, detailExportHandler } from './export.js';
import { listSessionDetails } from '../services/timer.js';
import { forceStopSession } from '../services/timer.js';
import { listVehiclesAdmin, vehicleDto, getVehicleRow } from './vehicles.js';
import { DICT_ROUTES, dictRouter } from './dicts.js';
import { shiftsRouter } from './shifts.js';
import { schedulesRouter } from './schedules.js';
import { logsRouter } from './logs.js';
// CR-11：登录日志写入（登录成功/失败两分支）
import { writeLoginLog } from '../services/loginLog.js';
// CR-12：登录限流（账号连续失败锁定 + IP 失败上限）——回补进仓（prod 既有、仓内缺失，避免部署 --delete 丢功能）
import { loginRateLimit } from '../middleware/rateLimit.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const MIN_PWD = 6;

const isHeader = (cell, names) => names.some((n) => String(cell || '').trim().toLowerCase() === n);

const str = (v) => (v === undefined || v === null ? null : String(v).trim() || null);

/** operator 扩展字段（CR-01 §11.2）：employeeNo/groupName/employed，兼容 snake_case 入参 */
function empFields(b, cur = {}) {
  const employeeNo =
    b.employeeNo !== undefined ? str(b.employeeNo)
    : b.employee_no !== undefined ? str(b.employee_no)
    : (cur.employee_no ?? null);
  const groupName =
    b.groupName !== undefined ? str(b.groupName)
    : b.group_name !== undefined ? str(b.group_name)
    : (cur.group_name ?? null);
  const employed = b.employed !== undefined ? (Number(b.employed) ? 1 : 0) : (cur.employed ?? 1);
  return { employeeNo, groupName, employed };
}

/** vehicle 挂靠字段（CR-01 §11.2）：org_id/supplier_id/default_initiator_id */
const REF_TABLES = { org_id: 'organization', supplier_id: 'supplier', default_initiator_id: 'initiator' };
function refFields(db, b, cur = {}) {
  const out = {};
  for (const key of Object.keys(REF_TABLES)) {
    if (b[key] === undefined) {
      out[key] = cur[key] ?? null;
      continue;
    }
    if (b[key] === null || b[key] === '') {
      out[key] = null;
      continue;
    }
    const n = Number(b[key]);
    if (!Number.isInteger(n) || n <= 0) throw ERR.VALIDATION(`${key} 非法`);
    const hit = db.prepare(`SELECT 1 FROM ${REF_TABLES[key]} WHERE id=?`).get(n);
    if (!hit) throw ERR.VALIDATION(`${key} 引用的记录不存在`);
    out[key] = n;
  }
  return out;
}

/* ---------- CR-08（需求①）：安全员开号工具 ---------- */

/** 开号默认口令 = 工号后 6 位（首登强制改密）。 */
function defaultPwdFromEmpNo(employeeNo) {
  const s = String(employeeNo ?? '').trim();
  return s ? s.slice(-6) : '';
}

/**
 * 为单个安全员开号（账号=工号，默认口令=工号后6位，must_change_pwd=1）。
 * @returns {{ok:boolean, reason?:string, username?:string}}
 */
function openAccount(db, id, employeeNo) {
  const username = String(employeeNo ?? '').trim();
  if (!username) return { ok: false, reason: '缺工号' };
  const pwd = defaultPwdFromEmpNo(employeeNo);
  if (pwd.length < MIN_PWD) return { ok: false, reason: `工号不足 ${MIN_PWD} 位，请手工开号` };
  const { hash, salt } = hashPassword(pwd);
  try {
    db.prepare(
      'UPDATE operator SET username=?, pwd_hash=?, pwd_salt=?, pwd_ver=COALESCE(pwd_ver,0)+1, must_change_pwd=1 WHERE id=?'
    ).run(username, hash, salt, id);
  } catch (e) {
    if (/UNIQUE constraint failed: operator\.username/.test(e.message)) {
      return { ok: false, reason: `账号 ${username} 已被占用` };
    }
    throw e;
  }
  return { ok: true, username };
}

export function adminRouter(db, { adminPassword = 'safety-timer', adminUser } = {}) {
  const r = Router();

  /* ---------- 登录 / 登出 ---------- */
  // 账号登录：{username,password}；单口令兑底：仅 {password} → env ADMIN_PASSWORD（isRoot=true）。
  // 失败统一 401 '用户名或密码错误'（防用户名枚举）；缺参 400 VALIDATION。
  // CR-06：响应增 mustChangePwd；active=0 → 403 ACCOUNT_INACTIVE；token 带 pv(pwd_ver)。
  r.post('/login', loginRateLimit({ db, source: 'admin' }), (req, res) => {
    const b = req.body || {};
    const pwd = b.password;
    const username = b.username === undefined || b.username === null ? '' : String(b.username).trim();
    // CR-11：失败留痕（缺参/口令错/停用 均记），再原样抛出
    const fail = (err) => {
      writeLoginLog(db, { account: username || null, role: null, source: 'admin', result: 'fail', reason: (err && err.code) || 'ERROR', req });
      return err;
    };
    let payload;
    let mustChangePwd = false;
    let loginRole = 'admin';
    try {
      if (pwd === undefined || pwd === null || String(pwd) === '') throw ERR.VALIDATION('口令必填');
      if (!username) {
        // 兑底通道：单口令（CEO①）——始终保留，防锁死
        if (!verifyPassword(pwd, adminPassword)) throw ERR.UNAUTHORIZED('用户名或密码错误');
        payload = {
          userId: null,
          username: null,
          name: adminUser || process.env.ADMIN_USER || '管理员',
          isRoot: true,
          role: 'admin',
          pv: 0,
        };
      } else {
        const row = db.prepare('SELECT * FROM admin_user WHERE username=?').get(username);
        if (!row || !verifyPasswordHash(pwd, row.pwd_hash, row.pwd_salt)) {
          throw ERR.UNAUTHORIZED('用户名或密码错误');
        }
        // 口令正确后再区分「停用」：口令错仍统一 401（防枚举）
        if (row.active !== 1) throw ERR.ACCOUNT_INACTIVE();
        payload = {
          userId: row.id,
          username: row.username,
          name: row.name,
          isRoot: false,
          role: 'admin',
          pv: Number(row.pwd_ver ?? 0),
        };
        mustChangePwd = Number(row.must_change_pwd ?? 0) === 1;
        loginRole = normalizeRole(row.role); // CR-10：后台角色（库内）
      }
    } catch (e) {
      throw fail(e);
    }

    const token = issueToken(payload);
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE_MS });
    // CR-11：登录成功留痕
    writeLoginLog(db, { account: payload.username ?? null, name: payload.name, role: loginRole, source: 'admin', result: 'ok', req });
    sendOk(res, {
      token,
      user: { id: payload.userId, username: payload.username, name: payload.name, role: loginRole },
      mustChangePwd,
    });
  });

  r.post('/logout', (req, res) => {
    revokeToken(extractToken(req));
    res.clearCookie(COOKIE_NAME);
    sendOk(res, { ok: true });
  });

  // 以下全部需要登录
  r.use(requireAdmin);

  /* ---------- CR-10：模块级权限闸门（读写分离；仅「账号管理」为 admin 独占） ---------- */
  // 注意：具体路径先挂（/sessions/detail 先于 /sessions），否则前缀匹配顺序会错。
  r.use('/operators', requirePerm('operators'));
  r.use('/vehicles', requirePerm('vehicles'));
  r.use('/organizations', requirePerm('dicts'));
  r.use('/suppliers', requirePerm('dicts'));
  r.use('/initiators', requirePerm('dicts'));
  r.use('/shifts', requirePerm('schedules'));
  r.use('/schedules', requirePerm('schedules'));
  r.use('/users', requirePerm('users'));
  r.use('/approvals', requirePerm('approvals')); // 2026-10-08 需求②
  r.use('/logs', requirePerm('logs')); // CR-11：日志查看（admin 独占）
  r.use('/sessions/detail', requirePerm('detail'));
  r.use('/export/detail', requirePerm('detail'));
  r.use('/sessions', requirePerm('sessions'));
  r.use('/export', requirePerm('sessions'));

  /* ---------- CR-06：当前账号 / 本人改密（闸门白名单） ---------- */
  r.get('/me', (req, res) => {
    const me = req.authUser || currentUser(req);
    const row = me && me.userId != null ? db.prepare('SELECT * FROM admin_user WHERE id=?').get(me.userId) : null;
    if (!row) {
      // isRoot 兑底通道：无 DB 行
      sendOk(res, {
        id: null,
        username: (me && me.username) ?? null,
        name: (me && me.name) ?? null,
        active: 1,
        role: normalizeRole(me && me.adminRole), // CR-10
        mustChangePwd: false,
      });
      return;
    }
    sendOk(res, {
      id: row.id,
      username: row.username,
      name: row.name,
      active: row.active,
      role: normalizeRole(row.role), // CR-10
      mustChangePwd: Number(row.must_change_pwd ?? 0) === 1,
      // 2026-10-08 需求③④：本人所属组织/供应商
      orgId: row.org_id ?? null,
      supplierId: row.supplier_id ?? null,
      orgName: row.org_id != null ? ((db.prepare('SELECT name FROM organization WHERE id=?').get(row.org_id) || {}).name ?? null) : null,
      supplierName: row.supplier_id != null ? ((db.prepare('SELECT name FROM supplier WHERE id=?').get(row.supplier_id) || {}).name ?? null) : null,
    });
  });

  r.post('/me/password', (req, res) => {
    const me = currentUser(req);
    if (!me || me.userId == null) throw ERR.NOT_FOUND('账号不存在');
    const row = db.prepare('SELECT * FROM admin_user WHERE id=?').get(me.userId);
    if (!row) throw ERR.NOT_FOUND('账号不存在');
    const b = req.body || {};
    if (!verifyPasswordHash(b.oldPassword, row.pwd_hash, row.pwd_salt)) throw ERR.INVALID_OLD_PASSWORD();
    const newPwd = b.newPassword === undefined || b.newPassword === null ? '' : String(b.newPassword);
    if (newPwd.length < MIN_PWD || newPwd.trim() === '') throw ERR.VALIDATION(`口令长度不得少于 ${MIN_PWD} 位`);
    const { hash, salt } = hashPassword(newPwd);
    const nextVer = Number(row.pwd_ver ?? 0) + 1;
    db.prepare(
      "UPDATE admin_user SET pwd_hash=?, pwd_salt=?, pwd_ver=?, must_change_pwd=0, updated_at=datetime('now','+8 hours') WHERE id=?"
    ).run(hash, salt, nextVer, row.id);
    // 重新签发：新 pv 生效 → 旧 token 立即失效
    const token = issueToken({
      userId: row.id,
      username: row.username,
      name: row.name,
      isRoot: false,
      role: 'admin',
      pv: nextVer,
    });
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE_MS });
    sendOk(res, { token });
  });

  /* ---------- CR-01：后台鉴权别名（语义与公开接口一致） ---------- */
  r.get('/sessions', listSessionsHandler(db));
  // CR-08（需求⑥）：详细工时（含排班备注快照 + 计时备注）列表
  r.get('/sessions/detail', (req, res) => {
    const { date, from, to, operatorId, vin, page, pageSize } = req.query;
    sendOk(res, listSessionDetails(db, { date, from, to, operatorId, vin, page, pageSize, scope: reqScope(req, db) }));
  });
  // CR-13：管理员强制结束（纠偏）；替代直改库。须先填备注（默认「管理员强制结束」）。
  r.post('/sessions/:id/force-stop', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw ERR.VALIDATION('会话 id 非法');
    const me = req.authUser || currentUser(req);
    const author = (me && (me.name || me.username)) || '管理员';
    const rawRemark = req.body && typeof req.body.remark === 'string' ? req.body.remark.trim() : '';
    // 2026-10-08 老板：强制更改进行中工单也走审批流（flow code='force_stop' 启用时）
    const pending = submitForceStop(db, req, { sessionId: id, remark: rawRemark });
    if (pending) {
      sendOk(res, { pending: true, request: pending, message: `已提交审批 ${pending.no || ''}` });
      return;
    }
    const out = forceStopSession(db, id, { remark: rawRemark, author });
    sendOk(res, { session: out.session, remark: out.remark });
  });
  r.get('/export', exportHandler(db));
  // CR-08（需求⑥）：详细工时（含备注）导出
  r.get('/export/detail', detailExportHandler(db));

  /* ---------- 字典：组织 / 供应商 / 发起人（§11.4） ---------- */
  for (const { mount, spec } of DICT_ROUTES) r.use(mount, dictRouter(db, spec));

  /* ---------- CR-07：班次字典 + 排班 ---------- */
  r.use('/shifts', shiftsRouter(db));
  r.use('/schedules', schedulesRouter(db));

  /* ---------- CR-03：后台账号管理 ---------- */
  r.use('/users', usersRouter(db));

  /* ---------- 2026-10-08 需求②：审批中心 ---------- */
  r.use('/approvals', approvalsRouter(db));

  /* ---------- CR-11：日志查看（登录记录；admin 独占） ---------- */
  r.use('/logs', logsRouter(db));

  /* ---------- 安全员 ---------- */
  r.get('/operators', (req, res) => {
    sendOk(res, listOperatorsAdmin(db, { active: req.query.active, q: req.query.q }));
  });

  r.post('/operators', (req, res) => {
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : '';
    if (!name) throw ERR.VALIDATION('name 必填');
    const label = b.label !== undefined ? b.label : null;
    const phone = b.phone !== undefined ? b.phone : null;
    const sort = Number(b.sort) || 0;
    const { employeeNo, groupName, employed } = empFields(b, {});
    if (!String(employeeNo ?? '').trim()) throw ERR.VALIDATION('工号必填');
    try {
      const info = db
        .prepare(
          'INSERT INTO operator(name,label,phone,employee_no,group_name,employed,active,sort) VALUES(?,?,?,?,?,?,1,?)'
        )
        .run(name, label, phone, employeeNo, groupName, employed, sort);
      sendOk(res, operatorDto(db.prepare('SELECT * FROM operator WHERE id=?').get(Number(info.lastInsertRowid))), 201);
    } catch (e) {
      if (/UNIQUE constraint failed: operator\.name/.test(e.message)) throw ERR.CONFLICT('同名安全员已存在');
      throw e;
    }
  });

  r.put('/operators/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM operator WHERE id=?').get(id);
    if (!cur) throw ERR.NOT_FOUND('安全员不存在');
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : cur.name;
    const label = b.label !== undefined ? b.label : cur.label;
    const phone = b.phone !== undefined ? b.phone : cur.phone;
    const sort = b.sort !== undefined ? Number(b.sort) || 0 : cur.sort;
    const active = b.active !== undefined ? (Number(b.active) ? 1 : 0) : cur.active;
    const { employeeNo, groupName, employed } = empFields(b, cur);
    try {
      db.prepare(
        'UPDATE operator SET name=?,label=?,phone=?,employee_no=?,group_name=?,employed=?,sort=?,active=? WHERE id=?'
      ).run(name, label, phone, employeeNo, groupName, employed, sort, active, id);
    } catch (e) {
      if (/UNIQUE constraint failed: operator\.name/.test(e.message)) throw ERR.CONFLICT('同名安全员已存在');
      throw e;
    }
    sendOk(res, operatorDto(db.prepare('SELECT * FROM operator WHERE id=?').get(id)));
  });

  r.delete('/operators/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM operator WHERE id=?').get(id);
    if (!cur) throw ERR.NOT_FOUND('安全员不存在');
    db.prepare('UPDATE operator SET active=0 WHERE id=?').run(id); // 软删
    sendOk(res, operatorDto(db.prepare('SELECT * FROM operator WHERE id=?').get(id)));
  });

  /* ---------- CR-08（需求①）：批量开号（未开号的全量） ---------- */
  r.post('/operators/accounts/batch', (req, res) => {
    const targets = db
      .prepare(
        "SELECT id,name,employee_no FROM operator WHERE active=1 AND (username IS NULL OR username='') ORDER BY sort ASC, id ASC"
      )
      .all();
    const result = { total: targets.length, created: 0, skipped: 0, errors: [] };
    const tx = db.transaction(() => {
      for (const o of targets) {
        const r2 = openAccount(db, o.id, o.employee_no);
        if (r2.ok) result.created++;
        else {
          result.skipped++;
          result.errors.push({ id: o.id, name: o.name, employeeNo: o.employee_no ?? null, reason: r2.reason });
        }
      }
    });
    tx();
    sendOk(res, result);
  });

  /* ---------- CR-06：安全员 H5 登录账号（设/重置、清空） ---------- */
  r.post('/operators/:id/account', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM operator WHERE id=?').get(id);
    if (!cur) throw ERR.NOT_FOUND('安全员不存在');
    const b = req.body || {};
    const username = String(b.username ?? '').trim() || String(cur.employee_no ?? '').trim();
    if (!username) throw ERR.VALIDATION('请先填工号（或手动填写账号）');
    const pwd = b.password === undefined || b.password === null ? '' : String(b.password);
    if (pwd.length < MIN_PWD || pwd.trim() === '') throw ERR.VALIDATION(`口令长度不得少于 ${MIN_PWD} 位`);
    const { hash, salt } = hashPassword(pwd);
    try {
      db.prepare(
        'UPDATE operator SET username=?, pwd_hash=?, pwd_salt=?, pwd_ver=COALESCE(pwd_ver,0)+1, must_change_pwd=1 WHERE id=?'
      ).run(username, hash, salt, id);
    } catch (e) {
      if (/UNIQUE constraint failed: operator\.username/.test(e.message)) throw ERR.CONFLICT('用户名已存在');
      throw e;
    }
    sendOk(res, operatorDto(db.prepare('SELECT * FROM operator WHERE id=?').get(id)));
  });

  r.delete('/operators/:id/account', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM operator WHERE id=?').get(id);
    if (!cur) throw ERR.NOT_FOUND('安全员不存在');
    db.prepare(
      'UPDATE operator SET username=NULL, pwd_hash=NULL, pwd_salt=NULL, pwd_ver=COALESCE(pwd_ver,0)+1, must_change_pwd=0 WHERE id=?'
    ).run(id);
    sendOk(res, operatorDto(db.prepare('SELECT * FROM operator WHERE id=?').get(id)));
  });

  r.post('/operators/import', upload.single('file'), (req, res) => {
    const rows = readUploadRows(req);
    const result = { inserted: 0, skipped: 0, accountsOpened: 0, errors: [] };
    const ins = db.prepare(
      'INSERT OR IGNORE INTO operator(name,label,phone,employee_no,group_name,employed,active,sort) VALUES(?,?,?,?,?,?,1,?)'
    );
    const exists = db.prepare('SELECT 1 FROM operator WHERE name=? AND active=1');
    // 有表头则按列名映射（兼容新增列）；否则按位置：name,label,phone,sort,employee_no,group_name,employed
    const hasHeader = rows.length && isHeader(rows[0][0], ['name', '姓名']);
    const hmap = {};
    if (hasHeader) rows[0].forEach((h, i) => (hmap[String(h || '').trim().toLowerCase()] = i));
    const col = (row, i, keys) => {
      if (hasHeader) {
        for (const k of keys) if (hmap[k] !== undefined) return row[hmap[k]];
        return undefined;
      }
      return row[i];
    };
    const tx = db.transaction(() => {
      rows.forEach((row, i) => {
        if (i === 0 && hasHeader) return;
        const name = String(col(row, 0, ['name', '姓名']) || '').trim();
        if (!name) return;
        if (exists.get(name)) {
          result.skipped++;
          return;
        }
        const label = str(col(row, 1, ['label', '标签']));
        const phone = str(col(row, 2, ['phone', '电话', '手机']));
        const employeeNo = str(col(row, 4, ['employee_no', 'employeeno', '工号']));
        const groupName = str(col(row, 5, ['group_name', 'groupname', '分组']));
        const empRaw = col(row, 6, ['employed', '在职']);
        const employed = empRaw === undefined || empRaw === '' ? 1 : Number(empRaw) ? 1 : 0;
        const sort = Number(col(row, 3, ['sort', '排序'])) || 0;
        const info = ins.run(name, label, phone, employeeNo, groupName, employed, sort);
        if (info.changes) {
          result.inserted++;
          // CR-08（需求①）：导入后自动开号（仅当有工号；失败不影响建人）
          const ar = openAccount(db, Number(info.lastInsertRowid), employeeNo);
          if (ar.ok) result.accountsOpened++;
          else if (ar.reason && ar.reason !== '缺工号') {
            result.errors.push({ line: i + 1, name, reason: `已建人但未开号：${ar.reason}` });
          }
        } else {
          result.skipped++;
          result.errors.push({ line: i + 1, name, reason: '冲突或重复' });
        }
      });
    });
    tx();
    sendOk(res, result, 201);
  });

  /* ---------- 车架号 ---------- */
  r.get('/vehicles', (req, res) => {
    // 2026-10-08 需求③：按登录账号所属单位过滤
    sendOk(res, listVehiclesAdmin(db, { active: req.query.active, q: req.query.q, scope: reqScope(req, db) }));
  });

  r.post('/vehicles', (req, res) => {
    const b = req.body || {};
    const vin = b.vin !== undefined ? String(b.vin).trim() : '';
    if (!vin) throw ERR.VALIDATION('vin 必填');
    const station = b.station !== undefined ? b.station : null;
    let { org_id, supplier_id, default_initiator_id } = refFields(db, b, {});
    // 2026-10-08 需求③④：工程师只能把车建到自己的组织
    const scope = reqScope(req, db);
    if (scope.type === 'org') org_id = scope.id;
    try {
      const info = db
        .prepare(
          'INSERT INTO vehicle(vin,station,org_id,supplier_id,default_initiator_id,active,sort) VALUES(?,?,?,?,?,1,?)'
        )
        .run(vin, station, org_id, supplier_id, default_initiator_id, Number(b.sort) || 0);
      sendOk(res, vehicleDto(getVehicleRow(db, Number(info.lastInsertRowid))), 201);
    } catch (e) {
      if (/UNIQUE constraint failed: vehicle\.vin/.test(e.message)) throw ERR.CONFLICT('车架号已存在');
      throw e;
    }
  });

  r.put('/vehicles/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = getVehicleRow(db, id);
    if (!cur) throw ERR.NOT_FOUND('车架号不存在');
    if (!inScope(reqScope(req), cur)) throw ERR.NO_PERMISSION('无权操作其他单位的车辆');
    const b = req.body || {};
    const vin = b.vin !== undefined ? String(b.vin).trim() : cur.vin;
    const station = b.station !== undefined ? b.station : cur.station;
    const org = b.org !== undefined ? b.org : cur.org;
    const supplier = b.supplier !== undefined ? b.supplier : cur.supplier;
    const sort = b.sort !== undefined ? Number(b.sort) || 0 : cur.sort;
    const active = b.active !== undefined ? (Number(b.active) ? 1 : 0) : cur.active;
    const { org_id: oid0, supplier_id, default_initiator_id } = refFields(db, b, cur);
    // 2026-10-08 需求③④：工程师只能操作本组织车辆，且不得改挂到其他组织
    const scope = reqScope(req, db);
    const org_id = scope.type === 'org' ? scope.id : oid0;
    try {
      db.prepare(
        'UPDATE vehicle SET vin=?,station=?,org=?,supplier=?,org_id=?,supplier_id=?,default_initiator_id=?,sort=?,active=? WHERE id=?').run(
        vin, station, org, supplier, org_id, supplier_id, default_initiator_id, sort, active, id
      );
    } catch (e) {
      if (/UNIQUE constraint failed: vehicle\.vin/.test(e.message)) throw ERR.CONFLICT('车架号已存在');
      throw e;
    }
    sendOk(res, vehicleDto(getVehicleRow(db, id)));
  });

  r.delete('/vehicles/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = getVehicleRow(db, id);
    if (!cur) throw ERR.NOT_FOUND('车架号不存在');
    if (!inScope(reqScope(req), cur)) throw ERR.NO_PERMISSION('无权操作其他单位的车辆');
    db.prepare('UPDATE vehicle SET active=0 WHERE id=?').run(id); // 软删
    sendOk(res, vehicleDto(getVehicleRow(db, id)));
  });

  r.post('/vehicles/import', upload.single('file'), (req, res) => {
    const rows = readUploadRows(req);
    const result = { inserted: 0, skipped: 0, errors: [] };
    const ins = db.prepare(
      'INSERT OR IGNORE INTO vehicle(vin,station,org,supplier,org_id,supplier_id,default_initiator_id,active,sort) VALUES(?,?,?,?,?,?,?,1,?)'
    );
    const exists = db.prepare('SELECT 1 FROM vehicle WHERE vin=?');
    const hasHeader = rows.length && isHeader(rows[0][0], ['vin', '车架号']);
    const hmap = {};
    if (hasHeader) rows[0].forEach((h, i) => (hmap[String(h || '').trim().toLowerCase()] = i));
    const col = (row, i, keys) => {
      if (hasHeader) {
        for (const k of keys) if (hmap[k] !== undefined) return row[hmap[k]];
        return undefined;
      }
      return row[i];
    };
    const num = (v) => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : null;
    };
    const tx = db.transaction(() => {
      rows.forEach((row, i) => {
        if (i === 0 && hasHeader) return;
        const rawVin = col(row, 0, ['vin', '车架号']);
        const vin = normalizeVin(rawVin);
        if (!vin) {
          result.skipped++;
          result.errors.push({ line: i + 1, vin: '', reason: '车架号为空' });
          return;
        }
        if (!isValidVin(vin)) {
          result.skipped++;
          result.errors.push({
            line: i + 1,
            vin: String(rawVin ?? '').slice(0, 32),
            reason: VIN_HINT,
          });
          return;
        }
        if (exists.get(vin)) {
          result.skipped++;
          return;
        }
        const info = ins.run(
          vin,
          str(col(row, 1, ['station', '工位', '工位号'])),
          str(col(row, 2, ['org', '组织'])),
          str(col(row, 3, ['supplier', '供应商'])),
          num(col(row, 5, ['org_id'])),
          num(col(row, 6, ['supplier_id'])),
          num(col(row, 7, ['default_initiator_id'])),
          Number(col(row, 4, ['sort', '排序'])) || 0
        );
        if (info.changes) result.inserted++;
        else {
          result.skipped++;
          result.errors.push({ line: i + 1, vin, reason: '冲突或重复' });
        }
      });
    });
    tx();
    sendOk(res, result, 201);
  });

  return r;
}

