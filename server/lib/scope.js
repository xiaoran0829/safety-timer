// 2026-10-08 老板需求③④：账号按「所属组织/供应商」隔离 + 角色映射（工程师↔组织，车队↔供应商）。
// 纯函数，无副作用，便于单测。

/** 由后台角色 + 绑定单位 → 数据可见范围 */
export function scopeOf(adminRole, orgId, supplierId) {
  if (adminRole === 'engineer') return { type: 'org', id: orgId == null ? null : Number(orgId) };
  if (adminRole === 'fleet_admin') return { type: 'supplier', id: supplierId == null ? null : Number(supplierId) };
  return { type: 'all', id: null }; // admin / isRoot
}

/** 取当前请求主体的数据范围（须在 requireAdmin 之后；无主体按 all，用于兼容 isRoot） */
export function reqScope(req, db) {
  const me = (req && req.authUser) || null;
  if (!me) return { type: 'all', id: null };
  return effectiveScope(db, scopeOf(me.adminRole, me.orgId, me.supplierId));
}

/** 组织 see_all=1（如「长安科技项目」）→ 该组织账号可见「全部组织」的车辆/工单；
 *  其它组织仍只可见本单位（老板 2026-10-08：长安科技项目可看其他组织工单，其他组织只能看各自组织）。 */
export function effectiveScope(db, scope) {
  if (!scope || scope.type !== 'org' || scope.id == null || !db) return scope;
  const o = db.prepare('SELECT see_all FROM organization WHERE id=?').get(scope.id);
  return o && Number(o.see_all) === 1 ? { type: 'all', id: null } : scope;
}

/** 单车是否在范围内 */
export function inScope(scope, vehicle) {
  if (!scope || scope.type === 'all') return true;
  if (scope.id == null) return false; // 未绑定单位 → 看不到任何车（默认拒绝）
  const col = scope.type === 'org' ? vehicle.org_id : vehicle.supplier_id;
  return col != null && Number(col) === Number(scope.id);
}

/** 生成列表过滤 SQL 片段（默认别名 v） */
export function scopeSql(scope, alias = 'v') {
  if (!scope || scope.type === 'all') return { sql: '', args: [] };
  if (scope.id == null) return { sql: '1=0', args: [] };
  const col = scope.type === 'org' ? 'org_id' : 'supplier_id';
  return { sql: `${alias}.${col} = ?`, args: [Number(scope.id)] };
}

/** 角色↔单位映射（宽松口径：单位可空，空 = 看不到任何车辆，属默认拒绝）。
 * 工程师只绑组织、车队只绑供应商；admin 不绑单位。前端编辑弹窗会强制选择，后端保持兼容。 */
export function normalizeRoleScope(role, orgId, supplierId) {
  if (role === "engineer") return { orgId: orgId ?? null, supplierId: null };
  if (role === "fleet_admin") return { orgId: null, supplierId: supplierId ?? null };
  return { orgId: null, supplierId: null };
}

/** 兼容别名（旧调用点） */
export const validateRoleScope = normalizeRoleScope;
