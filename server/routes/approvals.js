// 2026-10-08 老板需求②：审批中心
//  - 流程模板/步骤/审批人可全流程自定义（含会签 all / 任一人 any）
//  - 流程可自定义「申请字段」（fields）
//  - 审批单号 SP-YYYYMMDD001
//  - 业务：换组织/供应商（kind='org_change'）、强制结束进行中工单（kind='force_stop'）
import { Router } from 'express';
import { sendOk } from '../lib/http.js';
import { ERR } from '../lib/errors.js';
import { normalizeRole, ROLES } from '../lib/roles.js';
import { reqScope, inScope } from '../lib/scope.js';
import { compactDay, parseTs, fmtDateTime } from '../lib/time.js';
import { forceStopSession } from '../services/timer.js';
import { resolveShiftEnd } from '../services/autoEnd.js';

/* ---------------- helpers ---------------- */
function parseJson(s, dflt) {
  try {
    const v = JSON.parse(s || 'null');
    return v == null ? dflt : v;
  } catch {
    return dflt;
  }
}

/** 解析「延时后结束时间」：兼容 'YYYY-MM-DD HH:mm[:ss]'；非法返回 NaN。 */
function parseEndAt(s) {
  const t = String(s == null ? '' : s).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return NaN;
  const [, Y, Mo, D, H, Mi, S] = m.map((x) => (x == null ? 0 : Number(x)));
  return Date.UTC(Y, Mo - 1, D, H, Mi, S || 0);
}
const flowFields = (row) => {
  const f = parseJson(row && row.fields, null);
  return Array.isArray(f) ? f : null;
};

const FIELD_TYPES = ['text', 'textarea', 'select', 'number', 'datetime'];
const FIELD_SOURCES = ['organizations', 'suppliers', 'vehicles', 'users', 'active_sessions'];
const NUMERIC_KEYS = ['orgId', 'supplierId', 'targetUserId', 'sessionId', 'operatorId', 'vehicleId'];

/** 校验并规范化「申请字段」定义 */
function normalizeFields(input) {
  if (!Array.isArray(input)) throw ERR.VALIDATION('fields 必须是数组');
  const out = [];
  const seen = new Set();
  input.forEach((f, i) => {
    const key = String((f && f.key) || '').trim();
    const label = String((f && f.label) || '').trim();
    // 字段名支持中文/字母/数字/下划线（不能空格、引号、特殊符号）
    if (!/^[\p{L}_][\p{L}\p{N}_.\-]{0,29}$/u.test(key))
      throw ERR.VALIDATION(`第 ${i + 1} 个字段名非法（支持中文/字母/数字/下划线，30 字以内，不能含空格）`);
    if (!label) throw ERR.VALIDATION(`第 ${i + 1} 个字段缺 label`);
    if (seen.has(key)) throw ERR.VALIDATION(`字段 key 重复：${key}`);
    seen.add(key);
    const type = FIELD_TYPES.includes(f && f.type) ? f.type : 'text';
    const source = f && f.source && FIELD_SOURCES.includes(f.source) ? f.source : null;
    out.push({ key, label, type, source, required: !!(f && f.required) });
  });
  return out;
}

/** 审批单号 SP-YYYYMMDD001（按天重置，>999 自然扩位） */
export function nextApprovalNo(db, day = compactDay()) {
  db.prepare('INSERT INTO approval_sequence(day,last_seq) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET last_seq=last_seq+1').run(day);
  const row = db.prepare("SELECT 'SP-'||?||printf('%03d', last_seq) AS no FROM approval_sequence WHERE day=?").get(day, day);
  return row.no;
}

const nodeDto = (r) => ({
  id: r.id,
  seq: r.seq,
  approverId: r.approver_id ?? null,
  approverRole: r.approver_role ?? null,
  label: r.label ?? null,
  mode: r.mode || 'any', // any=任一人通过 / all=会签
});
const toFlowDto = (db, r) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  active: r.active,
  fields: flowFields(r) || [],
  createdAt: r.created_at,
  nodes: db.prepare('SELECT * FROM approval_flow_node WHERE flow_id=? ORDER BY seq, id').all(r.id).map(nodeDto),
});

const parsePayload = (s) => parseJson(s, {}) || {};

const toRequestDto = (row) => ({
  id: row.id,
  no: row.no ?? null,
  flowId: row.flow_id,
  kind: row.kind,
  requesterId: row.requester_id ?? null,
  requesterName: row.requester_name ?? null,
  targetUserId: row.target_user_id ?? null,
  targetUserName: row.target_user_name ?? null,
  payload: parsePayload(row.payload),
  reason: row.reason ?? null,
  status: row.status,
  currentSeq: row.current_seq,
  createdAt: row.created_at,
  updatedAt: row.updated_at ?? null,
});

const REQ_SELECT = `SELECT q.*, tu.name AS target_user_name
  FROM approval_request q
  LEFT JOIN admin_user tu ON tu.id = q.target_user_id`;

/* ---------------- 强制结束工单 → 审批（供 admin 路由调用） ---------------- */
/** 若已启用 code='force_stop' 流程，则生成待审批申请并返回 {id,no}；否则返回 null（调用方直接执行）。 */
export function submitForceStop(db, req, { sessionId, remark = '' } = {}) {
  const flow = db.prepare("SELECT * FROM approval_flow WHERE code='force_stop' AND active=1").get();
  if (!flow) return null;
  if (!db.prepare('SELECT 1 FROM approval_flow_node WHERE flow_id=?').get(flow.id)) return null;
  const s = db.prepare('SELECT * FROM timer_session WHERE id=?').get(Number(sessionId));
  if (!s) throw ERR.NOT_FOUND('会话不存在');
  if (s.status !== 'running' && s.status !== 'paused') throw ERR.INVALID_STATE('会话已结束，无需强制结束');
  const dup = db
    .prepare("SELECT id,no FROM approval_request WHERE kind='force_stop' AND status='pending' AND payload LIKE ?")
    .get(`%"sessionId":${s.id}%`);
  if (dup) return { id: dup.id, no: dup.no, duplicate: true };

  const p = (req && req.authUser) || null;
  const no = nextApprovalNo(db);
  const payload = JSON.stringify({ sessionId: s.id, workOrderNo: s.work_order_no, vin: s.vin, remark: remark || '' });
  const info = db
    .prepare(
      'INSERT INTO approval_request(no,flow_id,kind,requester_id,requester_name,target_user_id,payload,reason,status,current_seq) VALUES(?,?,?,?,?,NULL,?,?,?,1)'
    )
    .run(no, flow.id, 'force_stop', p && p.userId != null ? p.userId : null, p ? p.name || p.username || null : null, payload, remark || null, 'pending');
  const rid = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO approval_log(request_id,seq,approver_id,approver_name,action,comment) VALUES(?,?,?,?,?,?)').run(
    rid,
    1,
    p && p.userId != null ? p.userId : null,
    p ? p.name || p.username || null : null,
    'submit',
    remark || null
  );
  return { id: rid, no };
}

/* ---------------- 路由 ---------------- */
export function approvalsRouter(db) {
  const r = Router();

  const me = (req) => req.authUser || null;
  const isAdmin = (req) => normalizeRole(me(req) && me(req).adminRole) === 'admin';
  /** 流程配置（模板/节点/字段）仅管理员可见/可改 */
  const requireAdminOnly = (req) => {
    if (!isAdmin(req)) throw ERR.NO_PERMISSION('仅管理员可管理审批流程');
  };

  function canApprove(principal, node) {
    if (!principal || !node) return false;
    if (normalizeRole(principal.adminRole) === 'admin') return true;
    if (node.approver_id != null && Number(node.approver_id) === Number(principal.userId)) return true;
    if (node.approver_role && normalizeRole(principal.adminRole) === node.approver_role) return true;
    return false;
  }
  function log(req, requestId, seq, action, comment) {
    const p = me(req);
    db.prepare('INSERT INTO approval_log(request_id,seq,approver_id,approver_name,action,comment) VALUES(?,?,?,?,?,?)').run(
      requestId,
      seq ?? null,
      p && p.userId != null ? p.userId : null,
      p ? p.name || p.username || null : null,
      action,
      comment || null
    );
  }
  function stepNodesOf(flowId, seq) {
    return db.prepare('SELECT * FROM approval_flow_node WHERE flow_id=? AND seq=? ORDER BY id').all(flowId, seq);
  }

  /* ---------------- 流程模板（仅管理员） ---------------- */
  r.get('/flows', (req, res) => {
    requireAdminOnly(req);
    sendOk(res, db.prepare('SELECT * FROM approval_flow ORDER BY id').all().map((f) => toFlowDto(db, f)));
  });

  r.post('/flows', (req, res) => {
    requireAdminOnly(req);
    const b = req.body || {};
    const code = String(b.code ?? '').trim();
    const name = String(b.name ?? '').trim();
    if (!code || !name) throw ERR.VALIDATION('code 与 name 必填');
    const fields = b.fields !== undefined ? normalizeFields(b.fields) : [];
    try {
      const info = db.prepare('INSERT INTO approval_flow(code,name,fields) VALUES(?,?,?)').run(code, name, JSON.stringify(fields));
      sendOk(res, toFlowDto(db, db.prepare('SELECT * FROM approval_flow WHERE id=?').get(Number(info.lastInsertRowid))), 201);
    } catch (e) {
      if (/UNIQUE constraint failed: approval_flow\.code/.test(e.message)) throw ERR.CONFLICT('流程编码已存在');
      throw e;
    }
  });

  r.put('/flows/:id', (req, res) => {
    requireAdminOnly(req);
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM approval_flow WHERE id=?').get(id);
    if (!cur) throw ERR.NOT_FOUND('流程不存在');
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() || cur.name : cur.name;
    const active = b.active !== undefined ? (Number(b.active) ? 1 : 0) : cur.active;
    const fields = b.fields !== undefined ? JSON.stringify(normalizeFields(b.fields)) : cur.fields;
    db.prepare("UPDATE approval_flow SET name=?, active=?, fields=?, updated_at=datetime('now','+8 hours') WHERE id=?").run(name, active, fields, id);
    sendOk(res, toFlowDto(db, db.prepare('SELECT * FROM approval_flow WHERE id=?').get(id)));
  });

  r.delete('/flows/:id', (req, res) => {
    requireAdminOnly(req);
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM approval_flow WHERE id=?').get(id);
    if (!cur) throw ERR.NOT_FOUND('流程不存在');
    db.prepare('DELETE FROM approval_flow WHERE id=?').run(id);
    sendOk(res, { ok: true });
  });

  /** 覆盖式设置步骤：steps=[{mode:'any'|'all', approvers:[{approverId?|approverRole?,label?}]}]（旧版 nodes 兼容） */
  r.put('/flows/:id/nodes', (req, res) => {
    requireAdminOnly(req);
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM approval_flow WHERE id=?').get(id);
    if (!cur) throw ERR.NOT_FOUND('流程不存在');
    const body = req.body || {};
    let steps = Array.isArray(body.steps) ? body.steps : null;
    if (!steps) {
      const nodes = Array.isArray(body.nodes) ? body.nodes : [];
      steps = nodes.map((n) => ({ mode: (n && n.mode) || 'any', approvers: [n] }));
    }
    if (!steps.length) throw ERR.VALIDATION('至少需要一个审批步骤');
    const ins = db.prepare('INSERT INTO approval_flow_node(flow_id,seq,approver_id,approver_role,label,mode) VALUES(?,?,?,?,?,?)');
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM approval_flow_node WHERE flow_id=?').run(id);
      steps.forEach((st, si) => {
        const mode = st && st.mode === 'all' ? 'all' : 'any';
        const approvers = Array.isArray(st && st.approvers) ? st.approvers : [];
        if (!approvers.length) throw ERR.VALIDATION(`第 ${si + 1} 步至少需要一个审批人`);
        approvers.forEach((a) => {
          const approverId = a && a.approverId != null && a.approverId !== '' ? Number(a.approverId) : null;
          const approverRole = a && a.approverRole ? String(a.approverRole) : null;
          const label = a && a.label ? String(a.label) : null;
          if (approverId == null && !approverRole) throw ERR.VALIDATION(`第 ${si + 1} 步需指定审批人或角色`);
          if (approverRole && !ROLES.includes(approverRole)) throw ERR.VALIDATION(`第 ${si + 1} 步审批角色非法：${approverRole}`);
          if (approverId != null && !db.prepare('SELECT 1 FROM admin_user WHERE id=?').get(approverId))
            throw ERR.VALIDATION(`第 ${si + 1} 步的审批人不存在`);
          ins.run(id, si + 1, approverId, approverRole, label, mode);
        });
      });
    });
    tx();
    sendOk(res, toFlowDto(db, db.prepare('SELECT * FROM approval_flow WHERE id=?').get(id)));
  });

  /* ---------------- 发起用：可用流程 + 可选对象（按申请人可见范围） ---------------- */
  r.get('/flow-options', (req, res) => {
    sendOk(
      res,
      db
        .prepare('SELECT * FROM approval_flow WHERE active=1 ORDER BY id')
        .all()
        .map((f) => ({
          id: f.id,
          code: f.code,
          name: f.name,
          fields: flowFields(f) || [],
          // 系统流程（强制结束工单）只能由对应操作触发，不在「发起申请」里手选
          submittable: f.code !== 'force_stop',
        }))
    );
  });

  /** 申请人可见的对象（车辆严格按组织/供应商范围过滤；组织/供应商字典为全量可选目标） */
  r.get('/options', (req, res) => {
    const scope = reqScope(req, db);
    const all = !scope || scope.type === 'all';
    let vrows;
    if (all) vrows = db.prepare('SELECT * FROM vehicle WHERE active=1 ORDER BY vin').all();
    else if (scope.id == null) vrows = [];
    else {
      const col = scope.type === 'org' ? 'org_id' : 'supplier_id';
      vrows = db.prepare(`SELECT * FROM vehicle WHERE active=1 AND ${col}=? ORDER BY vin`).all(Number(scope.id));
    }
    const orgName = (id) => (id == null ? null : ((db.prepare('SELECT name FROM organization WHERE id=?').get(id) || {}).name ?? null));
    const supName = (id) => (id == null ? null : ((db.prepare('SELECT name FROM supplier WHERE id=?').get(id) || {}).name ?? null));
    const busy = new Set(db.prepare("SELECT DISTINCT vin FROM timer_session WHERE status IN ('running','paused')").all().map((x) => x.vin));
    const vehicles = vrows.map((v) => ({
      vin: v.vin,
      orgId: v.org_id ?? null,
      supplierId: v.supplier_id ?? null,
      orgName: orgName(v.org_id),
      supplierName: supName(v.supplier_id),
      busy: busy.has(v.vin), // 有未完结工单 → 不允许调配
    }));

    const p = me(req);
    let users = [];
    if (isAdmin(req)) users = db.prepare('SELECT id,name,role FROM admin_user WHERE active=1 ORDER BY id').all();
    else if (scope && scope.type === 'org' && scope.id != null)
      users = db.prepare('SELECT id,name,role FROM admin_user WHERE active=1 AND (org_id=? OR id=?) ORDER BY id').all(Number(scope.id), p && p.userId != null ? p.userId : -1);
    else if (scope && scope.type === 'supplier' && scope.id != null)
      users = db.prepare('SELECT id,name,role FROM admin_user WHERE active=1 AND (supplier_id=? OR id=?) ORDER BY id').all(Number(scope.id), p && p.userId != null ? p.userId : -1);
    else users = p && p.userId != null ? db.prepare('SELECT id,name,role FROM admin_user WHERE id=?').all(p.userId) : [];

    // 2026-10-14 老板：进行中的工单（供「任务延时」申请选择），按范围过滤；附当前结束时间
    let activeRows;
    if (all) activeRows = db.prepare("SELECT * FROM timer_session WHERE status IN ('running','paused') ORDER BY id DESC").all();
    else if (scope.id == null) activeRows = [];
    else {
      const col = scope.type === 'org' ? 'v.org_id' : 'v.supplier_id';
      activeRows = db
        .prepare(`SELECT ts.* FROM timer_session ts JOIN vehicle v ON v.id=ts.vehicle_id WHERE ts.status IN ('running','paused') AND ${col}=? ORDER BY ts.id DESC`)
        .all(Number(scope.id));
    }
    const activeSessions = activeRows.map((ts) => ({
      id: ts.id,
      workOrderNo: ts.work_order_no,
      vin: ts.vin,
      operatorName: ts.operator_name,
      startAt: ts.start_at,
      planEndAt: ts.plan_end_at ?? null,
      curEndAt: ts.plan_end_at || resolveShiftEnd(db, ts),
    }));

    sendOk(res, {
      scope,
      vehicles,
      users,
      activeSessions,
      organizations: db.prepare('SELECT id,name FROM organization WHERE active=1 ORDER BY sort,id').all(),
      suppliers: db.prepare('SELECT id,name FROM supplier WHERE active=1 ORDER BY sort,id').all(),
    });
  });

  /* ---------------- 申请 ---------------- */
  r.get('/requests', (req, res) => {
    const status = String(req.query.status || '').trim();
    const scope = String(req.query.scope || 'all').trim();
    const p = me(req);
    const where = [];
    const args = [];
    if (status) {
      where.push('q.status = ?');
      args.push(status);
    }
    if (scope === 'mine') {
      where.push('q.requester_id = ?');
      args.push(p && p.userId != null ? p.userId : -1);
    }
    let rows = db.prepare(`${REQ_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY q.id DESC`).all(...args).map(toRequestDto);
    if (scope === 'todo') {
      rows = rows.filter((x) => {
        if (x.status !== 'pending') return false;
        const done = new Set(db.prepare('SELECT node_id FROM approval_tally WHERE request_id=? AND seq=?').all(x.id, x.currentSeq).map((r) => r.node_id));
        return stepNodesOf(x.flowId, x.currentSeq).some((n) => canApprove(p, n) && !done.has(n.id));
      });
    }
    sendOk(res, rows);
  });

  r.post('/requests', (req, res) => {
    const b = req.body || {};
    const kind = String(b.kind || 'org_change').trim();
    const flow = db.prepare('SELECT * FROM approval_flow WHERE code=? AND active=1').get(kind);
    if (!flow) throw ERR.VALIDATION('流程不存在或未启用');
    if (kind === 'force_stop') throw ERR.VALIDATION('该流程只能由「强制结束工单」操作触发，不能手工发起');
    const p = me(req);
    const defs = flowFields(flow);
    const payload = {};

    if (defs && defs.length) {
      // 按流程自定义字段收集（管理员可增删改；字段名允许中文）
      const bySource = {};
      for (const f of defs) {
        const raw = b[f.key];
        const empty = raw === undefined || raw === null || raw === '';
        if (empty) {
          if (f.required) throw ERR.VALIDATION(`请填写${f.label || f.key}`);
          continue;
        }
        let val;
        if (f.type === 'number' || NUMERIC_KEYS.includes(f.key)) {
          const n = Number(raw);
          if (!Number.isFinite(n)) throw ERR.VALIDATION(`${f.label || f.key} 必须是数字`);
          val = n;
        } else {
          val = typeof raw === 'string' ? raw.trim() : raw;
        }
        payload[f.key] = val;
        // 记录该字段「语义来源」，用于把中文/自定义字段名映射回系统识别键
        if (f.source && !(f.source in bySource)) bySource[f.source] = val;
      }
      // 语义别名：字段名改成中文也能正常改绑（车辆→vin / 组织→orgId / 供应商→supplierId / 账号→targetUserId）
      const aliasNum = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : v);
      if (bySource.vehicles !== undefined && payload.vin === undefined) payload.vin = String(bySource.vehicles);
      if (bySource.organizations !== undefined && payload.orgId === undefined) payload.orgId = aliasNum(bySource.organizations);
      if (bySource.suppliers !== undefined && payload.supplierId === undefined) payload.supplierId = aliasNum(bySource.suppliers);
      if (bySource.users !== undefined && payload.targetUserId === undefined) payload.targetUserId = aliasNum(bySource.users);
    } else {
      // 兼容旧版（未自定义字段的流程）
      if (b.orgId !== undefined) payload.orgId = b.orgId === null || b.orgId === '' ? null : Number(b.orgId);
      if (b.supplierId !== undefined) payload.supplierId = b.supplierId === null || b.supplierId === '' ? null : Number(b.supplierId);
    }

    let targetUserId = null;
    // 2026-10-14 老板：任务延时（发起人=车队管理员，审批人=工程师）
    if (kind === 'task_delay') {
      const role = normalizeRole(p && p.adminRole);
      if (role !== 'fleet_admin' && role !== 'admin') throw ERR.NO_PERMISSION('仅车队管理员可发起任务延时申请');
      const sid = payload.sessionId;
      if (!sid) throw ERR.VALIDATION('请选择工单');
      const sess = db.prepare('SELECT * FROM timer_session WHERE id=?').get(Number(sid));
      if (!sess) throw ERR.NOT_FOUND('工单不存在');
      if (sess.status !== 'running' && sess.status !== 'paused') throw ERR.INVALID_STATE('该工单已结束，无需延时');
      const endMs = parseEndAt(payload.extendEndAt);
      if (Number.isNaN(endMs)) throw ERR.VALIDATION('延时后结束时间格式非法（YYYY-MM-DD HH:mm）');
      const curEnd = sess.plan_end_at || resolveShiftEnd(db, sess);
      if (curEnd) {
        const curMs = parseTs(curEnd);
        if (curMs !== null && !Number.isNaN(curMs) && endMs <= curMs) throw ERR.VALIDATION('延时后结束时间需晚于当前结束时间');
      }
      payload.sessionId = Number(sid);
      payload.workOrderNo = sess.work_order_no;
      payload.vin = sess.vin;
      payload.operatorName = sess.operator_name;
      payload.extendEndAt = fmtDateTime(new Date(endMs));
    } else if (payload.vin) {
      const vin = String(payload.vin).trim();
      const veh = db.prepare('SELECT * FROM vehicle WHERE vin=?').get(vin);
      if (!veh) throw ERR.NOT_FOUND('车架号不存在');
      if (!isAdmin(req) && !inScope(reqScope(req, db), veh)) throw ERR.NO_PERMISSION('只能对本单位车辆提交申请');
      // 2026-10-08 老板：车辆有未完结工单不允许调配
      const act0 = db.prepare("SELECT work_order_no FROM timer_session WHERE vin=? AND status IN ('running','paused') LIMIT 1").get(vin);
      if (act0) throw ERR.INVALID_STATE(`该车辆有未完结工单（${act0.work_order_no}），不能调配`);
      const orgId = payload.orgId == null || payload.orgId === '' ? null : Number(payload.orgId);
      const supplierId = payload.supplierId == null || payload.supplierId === '' ? null : Number(payload.supplierId);
      if (orgId == null && supplierId == null) throw ERR.VALIDATION('请至少指定目标组织或供应商');
      if (orgId != null && !db.prepare('SELECT 1 FROM organization WHERE id=?').get(orgId)) throw ERR.VALIDATION('目标组织不存在');
      if (supplierId != null && !db.prepare('SELECT 1 FROM supplier WHERE id=?').get(supplierId)) throw ERR.VALIDATION('目标供应商不存在');
      payload.vin = vin;
      payload.orgId = orgId;
      payload.supplierId = supplierId;
    } else if (payload.targetUserId) {
      targetUserId = Number(payload.targetUserId);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) throw ERR.VALIDATION('targetUserId 非法');
      if (!db.prepare('SELECT 1 FROM admin_user WHERE id=?').get(targetUserId)) throw ERR.NOT_FOUND('目标账号不存在');
      if (!isAdmin(req) && !(p && Number(p.userId) === targetUserId)) throw ERR.NO_PERMISSION('只能为本账号提交申请');
    } else if (kind === 'org_change') {
      throw ERR.VALIDATION('请选择车架号（或目标账号）');
    }

    if (!db.prepare('SELECT 1 FROM approval_flow_node WHERE flow_id=?').get(flow.id)) throw ERR.VALIDATION('该流程未配置审批步骤');

    const no = nextApprovalNo(db);
    const info = db
      .prepare(
        'INSERT INTO approval_request(no,flow_id,kind,requester_id,requester_name,target_user_id,payload,reason,status,current_seq) VALUES(?,?,?,?,?,?,?,?,?,1)'
      )
      .run(
        no,
        flow.id,
        kind,
        p && p.userId != null ? p.userId : null,
        p ? p.name || p.username || null : null,
        targetUserId,
        JSON.stringify(payload),
        b.reason ? String(b.reason) : null,
        'pending'
      );
    const rid = Number(info.lastInsertRowid);
    log(req, rid, 1, 'submit', b.reason ? String(b.reason) : null);
    sendOk(res, toRequestDto(db.prepare(`${REQ_SELECT} WHERE q.id=?`).get(rid)), 201);
  });

  r.get('/requests/:id', (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare(`${REQ_SELECT} WHERE q.id=?`).get(id);
    if (!row) throw ERR.NOT_FOUND('申请不存在');
    const logs = db.prepare('SELECT * FROM approval_log WHERE request_id=? ORDER BY id').all(id).map((l) => ({
      id: l.id,
      seq: l.seq ?? null,
      approverName: l.approver_name ?? null,
      action: l.action,
      comment: l.comment ?? null,
      createdAt: l.created_at,
    }));
    sendOk(res, { request: toRequestDto(row), logs });
  });

  function act(req, res, action) {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM approval_request WHERE id=?').get(id);
    if (!row) throw ERR.NOT_FOUND('申请不存在');
    if (row.status !== 'pending') throw ERR.INVALID_STATE('该申请已结束');
    const stepNodes = stepNodesOf(row.flow_id, row.current_seq);
    const p = me(req);
    const tallyNodes = new Set(
      db.prepare('SELECT node_id FROM approval_tally WHERE request_id=? AND seq=?').all(id, row.current_seq).map((r) => r.node_id)
    );
    const node = stepNodes.find((n) => canApprove(p, n) && !tallyNodes.has(n.id));
    if (!node) throw ERR.NO_PERMISSION('当前节点无权审批（或本步您已审批过）');
    const comment = req.body && req.body.comment ? String(req.body.comment) : null;

    if (action === 'reject') {
      db.prepare("UPDATE approval_request SET status='rejected', updated_at=datetime('now','+8 hours') WHERE id=?").run(id);
      log(req, id, row.current_seq, 'reject', comment);
      return sendOk(res, toRequestDto(db.prepare(`${REQ_SELECT} WHERE q.id=?`).get(id)));
    }

    db.prepare('INSERT OR IGNORE INTO approval_tally(request_id,seq,node_id,approver_id) VALUES(?,?,?,?)').run(
      id,
      row.current_seq,
      node.id,
      p && p.userId != null ? p.userId : null
    );
    log(req, id, row.current_seq, 'approve', node.label ? `[${node.label}] ${comment || ''}` : comment);

    const approvedIds = new Set(
      db.prepare('SELECT node_id FROM approval_tally WHERE request_id=? AND seq=?').all(id, row.current_seq).map((r) => r.node_id)
    );
    const needAll = stepNodes.some((n) => (n.mode || 'any') === 'all');
    const stepDone = needAll ? stepNodes.every((n) => approvedIds.has(n.id)) : approvedIds.size > 0;
    if (!stepDone) return sendOk(res, toRequestDto(db.prepare(`${REQ_SELECT} WHERE q.id=?`).get(id)));

    const next = db.prepare('SELECT * FROM approval_flow_node WHERE flow_id=? AND seq=? LIMIT 1').get(row.flow_id, row.current_seq + 1);
    if (next) {
      db.prepare("UPDATE approval_request SET current_seq=?, updated_at=datetime('now','+8 hours') WHERE id=?").run(row.current_seq + 1, id);
      return sendOk(res, toRequestDto(db.prepare(`${REQ_SELECT} WHERE q.id=?`).get(id)));
    }
    applyRequest(req, row, id);
    db.prepare("UPDATE approval_request SET status='approved', updated_at=datetime('now','+8 hours') WHERE id=?").run(id);
    sendOk(res, toRequestDto(db.prepare(`${REQ_SELECT} WHERE q.id=?`).get(id)));
  }

  function applyRequest(req, row, id) {
    const payload = parsePayload(row.payload);
    if (row.kind === 'force_stop') {
      const sid = Number(payload.sessionId);
      const s = db.prepare('SELECT * FROM timer_session WHERE id=?').get(sid);
      if (!s) throw ERR.NOT_FOUND('会话不存在');
      if (s.status === 'running' || s.status === 'paused') {
        forceStopSession(db, sid, { remark: payload.remark || '审批通过后强制结束', author: row.requester_name || '管理员' });
        log(req, id, row.current_seq, 'apply', `已强制结束工单 ${s.work_order_no}`);
      } else {
        log(req, id, row.current_seq, 'apply', `工单 ${s.work_order_no} 已结束，跳过`);
      }
      return;
    }
    if (row.kind === 'org_change' && payload.vin) {
      const veh = db.prepare('SELECT * FROM vehicle WHERE vin=?').get(String(payload.vin));
      if (!veh) throw ERR.NOT_FOUND('车架号不存在');
      const orgId = payload.orgId == null ? veh.org_id : Number(payload.orgId);
      const supplierId = payload.supplierId == null ? veh.supplier_id : Number(payload.supplierId);
      const orgName = orgId != null ? ((db.prepare('SELECT name FROM organization WHERE id=?').get(orgId) || {}).name ?? null) : null;
      const supName = supplierId != null ? ((db.prepare('SELECT name FROM supplier WHERE id=?').get(supplierId) || {}).name ?? null) : null;
      db.prepare('UPDATE vehicle SET org_id=?, supplier_id=?, org=?, supplier=? WHERE id=?').run(orgId, supplierId, orgName, supName, veh.id);
      log(req, id, row.current_seq, 'apply', `已改绑车架号 ${payload.vin} → 组织:${orgName || '—'} / 供应商:${supName || '—'}`);
      return;
    }
    if (row.kind === 'org_change') {
      const target = db.prepare('SELECT * FROM admin_user WHERE id=?').get(row.target_user_id);
      if (!target) throw ERR.NOT_FOUND('目标账号不存在');
      const role = normalizeRole(target.role);
      const orgId = payload.orgId == null ? null : Number(payload.orgId);
      const supplierId = payload.supplierId == null ? null : Number(payload.supplierId);
      if (role === 'engineer' && orgId == null) throw ERR.VALIDATION('该账号为工程师，申请未指定所属组织');
      if (role === 'fleet_admin' && supplierId == null) throw ERR.VALIDATION('该账号为车队角色，申请未指定所属供应商');
      if (orgId != null && !db.prepare('SELECT 1 FROM organization WHERE id=?').get(orgId)) throw ERR.VALIDATION('目标组织不存在');
      if (supplierId != null && !db.prepare('SELECT 1 FROM supplier WHERE id=?').get(supplierId)) throw ERR.VALIDATION('目标供应商不存在');
      db.prepare("UPDATE admin_user SET org_id=?, supplier_id=?, updated_at=datetime('now','+8 hours') WHERE id=?").run(
        role === 'engineer' ? orgId : null,
        role === 'fleet_admin' ? supplierId : null,
        target.id
      );
      log(req, id, row.current_seq, 'apply', '已按审批结果更新所属单位');
      return;
    }
    // 2026-10-14 老板：任务延时 —— 审批通过后写回工单计划结束时间
    if (row.kind === 'task_delay') {
      const sid = Number(payload.sessionId);
      const sess = db.prepare('SELECT * FROM timer_session WHERE id=?').get(sid);
      if (!sess) throw ERR.NOT_FOUND('工单不存在');
      const endAt = payload.extendEndAt ? String(payload.extendEndAt) : null;
      if (!endAt) throw ERR.VALIDATION('延时后结束时间缺失');
      db.prepare('UPDATE timer_session SET plan_end_at=? WHERE id=?').run(endAt, sid);
      log(req, id, row.current_seq, 'apply', `已延时工单 ${sess.work_order_no}：任务结束时间 → ${endAt}`);
      return;
    }
    throw ERR.VALIDATION(`暂不支持的申请类型：${row.kind}`);
  }

  r.post('/requests/:id/approve', (req, res) => act(req, res, 'approve'));
  r.post('/requests/:id/reject', (req, res) => act(req, res, 'reject'));

  r.post('/requests/:id/cancel', (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM approval_request WHERE id=?').get(id);
    if (!row) throw ERR.NOT_FOUND('申请不存在');
    if (row.status !== 'pending') throw ERR.INVALID_STATE('该申请已结束');
    const p = me(req);
    if (!isAdmin(req) && !(p && Number(p.userId) === Number(row.requester_id))) throw ERR.NO_PERMISSION('只能撤销自己的申请');
    db.prepare("UPDATE approval_request SET status='cancelled', updated_at=datetime('now','+8 hours') WHERE id=?").run(id);
    log(req, id, row.current_seq, 'cancel', req.body && req.body.comment ? String(req.body.comment) : null);
    sendOk(res, toRequestDto(db.prepare(`${REQ_SELECT} WHERE q.id=?`).get(id)));
  });

  return r;
}
