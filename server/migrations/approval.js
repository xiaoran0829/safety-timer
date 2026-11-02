// 2026-10-08 老板需求②：审批中心（流程模板 + 节点/审批人顺序 + 会签 + 自定义申请字段 + SP 单号）。
// 幂等建表/补列，独立迁移模块，避免与其它改动互相干扰。
/** 2026-10-08：各流程默认可自定义的「申请字段」（管理员可增删改） */
export const DEFAULT_FIELDS = {
  org_change: [
    { key: 'vin', label: '车架号', type: 'select', source: 'vehicles', required: false },
    { key: 'orgId', label: '目标组织', type: 'select', source: 'organizations', required: false },
    { key: 'supplierId', label: '目标供应商', type: 'select', source: 'suppliers', required: false },
    { key: 'targetUserId', label: '目标账号', type: 'select', source: 'users', required: false },
    { key: 'reason', label: '说明', type: 'textarea', source: null, required: false },
  ],
  force_stop: [{ key: 'remark', label: '强制结束原因', type: 'textarea', source: null, required: true }],
  // 2026-10-14 老板：任务延时（进行中工单 → 任务结束时间往后调）；发起人=车队管理员，审批人=工程师
  task_delay: [
    { key: 'sessionId', label: '工单', type: 'select', source: 'active_sessions', required: true },
    { key: 'extendEndAt', label: '延时后结束时间', type: 'datetime', source: null, required: true },
    { key: 'reason', label: '延时原因', type: 'textarea', source: null, required: false },
  ],
};

export function ensureApprovalSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS approval_flow (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  fields     TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS approval_flow_node (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id       INTEGER NOT NULL REFERENCES approval_flow(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  approver_id   INTEGER REFERENCES admin_user(id),
  approver_role TEXT,
  label         TEXT,
  mode          TEXT    NOT NULL DEFAULT 'any',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS ix_flow_node ON approval_flow_node(flow_id, seq);

CREATE TABLE IF NOT EXISTS approval_request (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  no             TEXT,
  flow_id        INTEGER NOT NULL REFERENCES approval_flow(id),
  kind           TEXT    NOT NULL,
  requester_id   INTEGER,
  requester_name TEXT,
  target_user_id INTEGER REFERENCES admin_user(id),
  payload        TEXT,
  reason         TEXT,
  status         TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
  current_seq    INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS ix_appr_req ON approval_request(status, id);

CREATE TABLE IF NOT EXISTS approval_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER NOT NULL REFERENCES approval_request(id) ON DELETE CASCADE,
  seq           INTEGER,
  approver_id   INTEGER,
  approver_name TEXT,
  action        TEXT    NOT NULL CHECK(action IN ('submit','approve','reject','cancel','apply')),
  comment       TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS ix_appr_log ON approval_log(request_id, id);

-- 2026-10-08 老板：全流程自定义 → 会签（mode='all' 需该步全部审批人通过）
CREATE TABLE IF NOT EXISTS approval_tally (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL REFERENCES approval_request(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  node_id     INTEGER NOT NULL,
  approver_id INTEGER,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tally ON approval_tally(request_id, seq, node_id);

-- 2026-10-08 老板：审批单号 SP-YYYYMMDD001（按天重置）
CREATE TABLE IF NOT EXISTS approval_sequence (
  day      TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);
`);

  // 幂等补列
  const nodeCols = new Set(db.pragma('table_info(approval_flow_node)').map((c) => c.name));
  if (!nodeCols.has('mode')) db.exec("ALTER TABLE approval_flow_node ADD COLUMN mode TEXT NOT NULL DEFAULT 'any'");
  const flowCols = new Set(db.pragma('table_info(approval_flow)').map((c) => c.name));
  if (!flowCols.has('fields')) db.exec('ALTER TABLE approval_flow ADD COLUMN fields TEXT');
  const reqCols = new Set(db.pragma('table_info(approval_request)').map((c) => c.name));
  if (!reqCols.has('no')) db.exec('ALTER TABLE approval_request ADD COLUMN no TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_appr_no ON approval_request(no)');

  // 默认流程：换组织/供应商（单节点 → admin 角色可审）
  const has = db.prepare("SELECT id FROM approval_flow WHERE code='org_change'").get();
  if (!has) {
    const info = db.prepare("INSERT INTO approval_flow(code,name,fields) VALUES('org_change','换组织/供应商申请',?)").run(
      JSON.stringify(DEFAULT_FIELDS.org_change)
    );
    db.prepare("INSERT INTO approval_flow_node(flow_id,seq,approver_role,label) VALUES(?,1,'admin','管理员审批')").run(
      Number(info.lastInsertRowid)
    );
  }
  // 默认流程：强制结束进行中工单（2026-10-08 老板：强制更改工单也要有审批流）
  const fs = db.prepare("SELECT id FROM approval_flow WHERE code='force_stop'").get();
  if (!fs) {
    const info = db.prepare("INSERT INTO approval_flow(code,name,fields) VALUES('force_stop','强制结束进行中工单',?)").run(
      JSON.stringify(DEFAULT_FIELDS.force_stop)
    );
    db.prepare("INSERT INTO approval_flow_node(flow_id,seq,approver_role,label) VALUES(?,1,'admin','管理员确认')").run(
      Number(info.lastInsertRowid)
    );
  }
  // 默认流程：任务延时（2026-10-14 老板：发起人=车队管理员，审批人=工程师）
  const td = db.prepare("SELECT id FROM approval_flow WHERE code='task_delay'").get();
  if (!td) {
    const info = db.prepare("INSERT INTO approval_flow(code,name,fields) VALUES('task_delay','任务延时申请',?)").run(
      JSON.stringify(DEFAULT_FIELDS.task_delay)
    );
    db.prepare("INSERT INTO approval_flow_node(flow_id,seq,approver_role,label) VALUES(?,1,'engineer','工程师审批')").run(
      Number(info.lastInsertRowid)
    );
  }

  // 回填默认字段（仅当为空）：老流程补默认字段，未知流程给空数组（= 不限制，legacy 提交）
  for (const f of db.prepare('SELECT id,code,fields FROM approval_flow').all()) {
    if (f.fields != null && String(f.fields).trim() !== '') continue;
    const dflt = DEFAULT_FIELDS[f.code] || [];
    db.prepare('UPDATE approval_flow SET fields=? WHERE id=?').run(JSON.stringify(dflt), f.id);
  }
}
