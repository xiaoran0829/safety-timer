export interface Operator {
  id: number;
  name: string;
  label: string | null;
  phone: string | null;
  active: number;
  sort: number;
  /* CR-01：工号 / 分组 / 在职状态 */
  employeeNo?: string | null;
  groupName?: string | null;
  employed?: number;
  /* CR-06：H5 登录账号状态（后台列表 DTO，绝不返回 hash/salt） */
  username?: string | null;
  hasAccount?: boolean;
}

/* CR-06：H5 安全员登录态里的操作者（登录 / me 返回的精简 operator） */
export interface H5Operator {
  id: number;
  name: string;
  label?: string | null;
  groupName?: string | null;
}

/* CR-06：POST /api/h5/login 返回 */
export interface H5LoginResult {
  token: string;
  operator: H5Operator;
  mustChangePwd: boolean;
}

/* CR-06：GET /api/h5/me 返回 */
export interface H5MeResult {
  operator: H5Operator;
  mustChangePwd: boolean;
}

/* CR-06：GET /api/admin/me 返回 */
export interface AdminMe {
  /* 2026-10-08 需求③④：所属组织/供应商 */
  orgId?: number | null;
  orgName?: string | null;
  supplierId?: number | null;
  supplierName?: string | null;
  id: number | null;
  username: string | null;
  name: string | null;
  active: number;
  mustChangePwd: boolean;
  /* CR-10：后台角色 */
  role: AdminRole;
}

/* CR-01 字典 */
export interface Organization {
  id: number;
  name: string;
  code: string | null;
  active: number;
  sort: number;
  /** 2026-10-08：可见全部组织（如「长安科技项目」） */
  see_all?: number;
}
export interface Supplier {
  id: number;
  name: string;
  code: string | null;
  active: number;
  sort: number;
}
export interface Initiator {
  id: number;
  name: string;
  department: string | null;
  active: number;
  sort: number;
}

/* CR-10：后台角色（与后端 server/lib/roles.js 一致） */
export type AdminRole = 'admin' | 'engineer' | 'fleet_admin';

/* CR-03：后台管理员账号（接口 DTO，绝不返回 hash/salt） */
export interface AdminUser {
  id: number;
  username: string;
  name: string;
  active: number;
  /* CR-10：后台角色 */
  role?: AdminRole;
  createdAt: string;
  updatedAt?: string | null;
  /* CR-06：是否须改密（后端未返回时前端跳过展示） */
  mustChangePwd?: boolean | number;
  /* 2026-10-08 需求③④：所属组织/供应商（工程师↔组织，车队↔供应商） */
  orgId?: number | null;
  orgName?: string | null;
  supplierId?: number | null;
  supplierName?: string | null;
}

/** 车架号上的默认发起人（§11.5 /api/vehicles 返回 flat 字段） */

export interface Vehicle {
  id: number;
  vin: string;
  station: string | null;
  active: number;
  occupied: { sessionId: number; operatorName: string } | null;
  /* CR-01 挂靠信息 */
  orgId?: number | null;
  supplierId?: number | null;
  orgName?: string | null;
  supplierName?: string | null;
  defaultInitiatorId?: number | null;
  defaultInitiatorName?: string | null;
  /* CR-07 口径 B：排班标记 */
  scheduled?: boolean;
  unscheduled?: boolean;
  shiftName?: string | null;
  shiftStart?: string | null;
  shiftEnd?: string | null;
  done?: boolean;
  started?: boolean;
}

/** CR-07：H5「我今天的排班车辆」（/api/h5/my-vehicles） */
export interface ScheduledVehicle {
  scheduleId: number;
  vehicleId: number;
  vin: string;
  shiftId: number | null;
  shiftName: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  occupied: { sessionId: number; operatorName: string } | null;
  done: boolean;
  started: boolean;
}

export interface AdminVehicle extends Omit<Vehicle, 'occupied'> {
  org?: string | null;
  supplier?: string | null;
  sort: number;
  occupied?: { sessionId: number; operatorName: string } | null;
}

export type SessionStatus = 'running' | 'paused' | 'stopped';

export interface Session {
  id: number;
  workOrderNo: string;
  operatorId: number;
  vehicleId: number;
  operatorName: string;
  vin: string;
  status: SessionStatus;
  startAt: string;
  endAt: string | null;
  netSeconds: number;
  pauseSeconds: number;
  createdAt: string;
  /* CR-01 快照 */
  orgName?: string | null;
  supplierName?: string | null;
  initiatorId?: number | null;
  initiatorName?: string | null;
  /* CR-08（需求③）：排班备注快照 */
  scheduleNote?: string | null;
  /* 2026-10-08 需求①：出车/收车里程（km） */
  odometerOut?: number | null;
  odometerIn?: number | null;
  /* 2026-10-14 老板：任务延时 —— 计划结束时间 */
  planEndAt?: string | null;
}

/* CR-08（需求⑥）：详细工时（含备注）列表行 = Session + 计时备注聚合 */
export interface SessionDetailRow extends Session {
  scheduleNote: string | null;
  remarks: { ts: string; content: string; author: string | null }[];
  remarkText: string;
  /* CR-09（需求⑧）：时间轴——计时/暂停段 */
  segments: { kind: 'work' | 'pause'; startedAt: string; endedAt: string | null; seconds: number }[];
}

/* CR-08（需求①）：批量开号结果 */
export interface BatchOpenResult {
  total: number;
  created: number;
  skipped: number;
  errors: { id?: number; name?: string; employeeNo?: string | null; reason: string }[];
}

export interface Segment {
  id: number;
  sessionId: number;
  kind: 'work' | 'pause';
  startedAt: string;
  endedAt: string | null;
  seconds: number;
}

export interface Remark {
  id: number;
  sessionId: number;
  ts: string;
  content: string;
  author: string | null;
}

export interface SessionDetail {
  session: Session;
  segments: Segment[];
  remarks: Remark[];
}

export interface SessionPage {
  list: Session[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ImportResult {
  inserted: number;
  skipped: number;
  accountsOpened?: number;
  errors: { line: number; reason: string }[];
}

/* ---------- CR-07：班次字典 + 排班 ---------- */
export interface Shift {
  id: number;
  name: string;
  startTime: string | null;
  endTime: string | null;
  sort: number;
  active: number;
}

export type ScheduleStatus = 'planned' | 'cancelled';

export interface Schedule {
  id: number;
  workDate: string;
  shiftId: number | null;
  shiftName: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  operatorId: number;
  operatorName: string | null;
  vehicleId: number;
  vin: string | null;
  status: ScheduleStatus;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt?: string | null;
  done: boolean;
  sessionCount: number;
  activeSessions: number;
  stoppedSessions: number;
}

export interface ScheduleBoard {
  date: string;
  planned: number;
  started: number;
  done: number;
  unfinished: number;
  unscheduledVehicles: { id: number; vin: string; station: string | null }[];
}

export interface BatchAssignResult {
  workDate: string;
  shiftId: number | null;
  mode: 'cross' | 'pair';
  inserted: number;
  skipped: number;
  conflicts: { operatorId: number; vehicleId: number; reason: string }[];
}

export interface CopyResult {
  fromDate: string;
  toDate: string;
  shiftId: number | null;
  sourceCount: number;
  inserted: number;
  skipped: number;
  conflicts: { operatorId: number; vehicleId: number; reason: string }[];
}

/* CR-11：登录日志（后台「日志查看」） */
export interface LoginLog {
  id: number;
  account: string | null;
  name: string | null;
  role: string | null;
  source: 'admin' | 'h5';
  result: 'ok' | 'fail';
  reason: string | null;
  ip: string | null;
  ua: string | null;
  createdAt: string;
}

export interface LoginLogPage {
  total: number;
  page: number;
  pageSize: number;
  items: LoginLog[];
}
