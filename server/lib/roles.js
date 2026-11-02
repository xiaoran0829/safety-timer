// CR-10：后台角色 + 模块权限矩阵（纯函数，无副作用，便于单测）。
// 设计要点：
//  - token 里的 role 仍只表示「后台 / H5 安全员」（admin|operator），后台内部角色单独由库列 admin_user.role 承载。
//  - 后台角色从库读 → 改角色即时生效、无需重登；isRoot（env 单口令兜底）视同 admin。
//  - 读写分离：GET（读）宽、写（POST/PUT/DELETE/import）严 —— 见 READ_MATRIX / WRITE_MATRIX。

/** 全部后台角色 */
export const ROLES = ['admin', 'engineer', 'fleet_admin'];

/** 模块键（与前端 nav / 路由 meta.perm 一一对应） */
export const PERM_KEYS = ['operators', 'vehicles', 'dicts', 'schedules', 'users', 'sessions', 'detail', 'logs', 'approvals'];

const ALL = ['admin', 'engineer', 'fleet_admin'];

/** 读权限（GET）：operators / vehicles 对全部后台角色放行（「计时记录 / 详细工时」筛选下拉依赖） */
export const READ_MATRIX = {
  operators: ALL, // 安全员列表（筛选依赖）
  vehicles: ALL, // 车架号列表（筛选依赖）
  dicts: ALL, // 组织 / 供应商 / 发起人
  schedules: ALL, // 排班 + 班次字典
  users: ['admin'], // 账号管理：admin 独占
  sessions: ALL, // 计时记录
  detail: ALL, // 详细工时
  logs: ['admin'], // CR-11：日志查看：admin 独占
  approvals: ALL, // 2026-10-08 需求②：审批中心（读）
};

/** 写权限（POST/PUT/DELETE/import）：strict，仅 users 为 admin 独占；schedules 三角色全放行（主人 15:49 口径） */
export const WRITE_MATRIX = {
  operators: ['admin', 'fleet_admin'], // 工程师不可改安全员
  vehicles: ['admin', 'engineer'], // 车队管理员不可改车架号
  dicts: ALL, // 组织 / 供应商 / 发起人：三角色均可维护
  schedules: ALL, // 排班：三角色全放行
  users: ['admin'], // 账号管理：admin 独占
  sessions: ALL,
  detail: ALL,
  logs: ['admin'], // CR-11：日志查看：admin 独占
  approvals: ALL, // 2026-10-08 需求②：审批中心（写）
};

/** 归一化库内 role：非法/空值 → admin（存量账号默认 admin） */
export function normalizeRole(role) {
  return ROLES.includes(role) ? role : 'admin';
}

/**
 * 是否允许访问某模块。
 * @param {string} role 后台角色（admin|engineer|fleet_admin）
 * @param {string} key  模块键
 * @param {'read'|'write'} mode 访问模式（GET→read，其余→write）
 */
export function canAccess(role, key, mode = 'read') {
  const table = mode === 'write' ? WRITE_MATRIX : READ_MATRIX;
  const allow = table[key];
  if (!allow) return false;
  return allow.includes(normalizeRole(role));
}
