import { Router } from 'express';
import { sendOk } from '../lib/http.js';
import { scopeSql } from '../lib/scope.js';

// 车架号查询（CR-01 §11.5：新增组织/供应商/默认发起人带名）
const VEH_SELECT = `
  SELECT v.*,
         o.name AS org_name,
         s.name AS supplier_name,
         i.name AS initiator_name
  FROM vehicle v
  LEFT JOIN organization o ON o.id = v.org_id
  LEFT JOIN supplier s     ON s.id = v.supplier_id
  LEFT JOIN initiator i    ON i.id = v.default_initiator_id
`;

/** GET /api/vehicles?active=1&q=（含占用态 occupied + 组织/供应商/默认发起人） */
export function vehiclesRouter(db) {
  const r = Router();
  r.get('/', (req, res) => {
    const active = req.query.active === undefined ? 1 : Number(req.query.active);
    const q = (req.query.q || '').trim();
    const where = ['v.active = ?'];
    const args = [active];
    if (q) {
      where.push('(v.vin LIKE ? OR v.station LIKE ?)');
      args.push(`%${q}%`, `%${q}%`);
    }
    const rows = db
      .prepare(`${VEH_SELECT} WHERE ${where.join(' AND ')} ORDER BY v.sort ASC, v.id ASC`)
      .all(...args);
    const occStmt = db.prepare(
      "SELECT id, operator_name FROM timer_session WHERE vehicle_id=? AND status IN ('running','paused') ORDER BY id DESC LIMIT 1"
    );
    const data = rows.map((v) => {
      const o = occStmt.get(v.id);
      return {
        id: v.id,
        vin: v.vin,
        station: v.station,
        active: v.active,
        orgName: v.org_name ?? null,
        supplierName: v.supplier_name ?? null,
        defaultInitiatorId: v.default_initiator_id ?? null,
        defaultInitiatorName: v.initiator_name ?? null,
        occupied: o ? { sessionId: o.id, operatorName: o.operator_name } : null,
      };
    });
    sendOk(res, data);
  });
  return r;
}

/** 后台用 DTO：含挂靠 ID + 名称（兼容旧 org/supplier 文本字段） */
export function vehicleDto(r) {
  return {
    id: r.id,
    vin: r.vin,
    station: r.station,
    org: r.org,
    supplier: r.supplier,
    orgId: r.org_id ?? null,
    supplierId: r.supplier_id ?? null,
    defaultInitiatorId: r.default_initiator_id ?? null,
    orgName: r.org_name ?? null,
    supplierName: r.supplier_name ?? null,
    defaultInitiatorName: r.initiator_name ?? null,
    active: r.active,
    sort: r.sort,
  };
}

export function getVehicleRow(db, id) {
  return db.prepare(`${VEH_SELECT} WHERE v.id=?`).get(Number(id));
}

export function listVehiclesAdmin(db, { active, q, scope } = {}) {
  const where = [];
  const args = [];
  // 2026-10-08 需求③：非管理员仅可见本单位（组织/供应商）车辆
  if (scope && scope.type !== 'all') {
    const sc = scopeSql(scope, 'v');
    where.push(sc.sql);
    args.push(...sc.args);
  }
  if (active !== undefined && active !== '' && active !== null) {
    where.push('v.active = ?');
    args.push(Number(active));
  }
  if (q) {
    where.push('(v.vin LIKE ? OR v.station LIKE ?)');
    args.push(`%${q}%`, `%${q}%`);
  }
  const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(`${VEH_SELECT} ${wsql} ORDER BY v.active DESC, v.sort ASC, v.id ASC`)
    .all(...args)
    .map(vehicleDto);
}
