import { http } from './client';
import type {
  Operator,
  Vehicle,
  SessionDetail,
  SessionPage,
  Session,
  SessionDetailRow,
  BatchOpenResult,
  Remark,
  AdminVehicle,
  ImportResult,
  Organization,
  Supplier,
  Initiator,
  AdminUser,
  Shift,
  Schedule,
  ScheduleBoard,
  BatchAssignResult,
  CopyResult,
  LoginLogPage,
} from '@/types';

/* 基础数据 */
export async function getOperators(params: { active?: number; q?: string } = {}) {
  return (await http.get('/operators', { params })) as unknown as Operator[];
}
export async function getVehicles(params: { active?: number; q?: string } = {}) {
  return (await http.get('/vehicles', { params })) as unknown as Vehicle[];
}
/** 发起人公开列表（H5 计时页下拉用；与 operators/vehicles 同口径） */
export async function getInitiators(params: { active?: number; q?: string } = {}) {
  return (await http.get('/initiators', { params })) as unknown as Initiator[];
}

/* 会话 */
export async function getActiveSession(operatorId: number) {
  return (await http.get('/sessions/active', { params: { operatorId } })) as unknown as SessionDetail | null;
}
// CR-03：发起人改由登录账号推导，前端不再传 initiatorId
export async function startSession(operatorId: number, vehicleId: number, idemKey?: string) {
  return (await http.post(
    '/sessions/start',
    { operatorId, vehicleId },
    { headers: idemKey ? { 'Idempotency-Key': idemKey } : {} }
  )) as unknown as { session: Session };
}
// CR-09（需求⑩）：暂停必须带备注
export async function pauseSession(id: number, operatorId: number, remark: string, at?: string) {
  return (await http.post(`/sessions/${id}/pause`, { operatorId, remark, at })) as unknown as { session: Session };
}
export async function resumeSession(id: number, operatorId: number) {
  return (await http.post(`/sessions/${id}/resume`, { operatorId })) as unknown as { session: Session };
}
export async function stopSession(id: number, operatorId: number, idemKey?: string) {
  return (await http.post(
    `/sessions/${id}/stop`,
    { operatorId },
    { headers: idemKey ? { 'Idempotency-Key': idemKey } : {} }
  )) as unknown as { session: Session };
}
export async function addRemark(id: number, operatorId: number, content: string) {
  return (await http.post(`/sessions/${id}/remarks`, { operatorId, content })) as unknown as { remark: Remark };
}
export async function getSessionDetail(id: number) {
  return (await http.get(`/sessions/${id}`)) as unknown as SessionDetail;
}
export async function listSessions(params: { date?: string; from?: string; to?: string; operatorId?: number; vin?: string; page?: number; pageSize?: number } = {}) {
  return (await http.get('/sessions', { params })) as unknown as SessionPage;
}

/* 导出（公开，直接下载） */
export function exportUrl(params: { date?: string; from?: string; to?: string; operatorId?: number; vin?: string; format: 'xlsx' | 'csv' }) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  });
  return `/api/export?${q.toString()}`;
}

/* 后台管理 */
// CR-06：本人账号接口（/admin/me、/admin/me/password），独立文件定义，这里统一 re-export
export { adminMe, adminChangePassword } from './adminAuth';

// CR-03：用户名 + 密码登录（返回 token 与当前登录用户，供发起人/页面展示用）
export async function adminLogin(username: string, password: string) {
  // skipAuthRedirect：登录接口失败由登录页自行提示（“用户名或密码错误”），不走全局登录失效跳转
  return (await http.post('/admin/login', { username, password }, { skipAuthRedirect: true })) as unknown as {
    token: string;
    user: { id: number; username: string; name: string; role?: string };
    /* CR-06：登录响应含 mustChangePwd，true 则强制先改密 */
    mustChangePwd?: boolean;
  };
}
export async function adminLogout() {
  return (await http.post('/admin/logout')) as unknown as { ok: boolean };
}
export async function adminListOperators(params: { active?: number | ''; q?: string } = {}) {
  return (await http.get('/admin/operators', { params })) as unknown as Operator[];
}
export async function adminCreateOperator(body: Partial<Operator>) {
  return (await http.post('/admin/operators', body)) as unknown as Operator;
}
export async function adminUpdateOperator(id: number, body: Partial<Operator>) {
  return (await http.put(`/admin/operators/${id}`, body)) as unknown as Operator;
}
export async function adminDeleteOperator(id: number) {
  return (await http.delete(`/admin/operators/${id}`)) as unknown as Operator;
}
export async function adminImportOperators(file: File) {
  const fd = new FormData();
  fd.append('file', file);
  return (await http.post('/admin/operators/import', fd)) as unknown as ImportResult;
}
/* CR-06：安全员 H5 登录账号（设/重置、清除） */
export async function adminSetOperatorAccount(id: number, body: { username: string; password: string }) {
  return (await http.post(`/admin/operators/${id}/account`, body)) as unknown as Operator;
}
export async function adminClearOperatorAccount(id: number) {
  return (await http.delete(`/admin/operators/${id}/account`)) as unknown as Operator;
}
export async function adminListVehicles(params: { active?: number | ''; q?: string } = {}) {
  return (await http.get('/admin/vehicles', { params })) as unknown as AdminVehicle[];
}
export async function adminCreateVehicle(body: Partial<AdminVehicle>) {
  return (await http.post('/admin/vehicles', body)) as unknown as AdminVehicle;
}
export async function adminUpdateVehicle(id: number, body: Partial<AdminVehicle>) {
  return (await http.put(`/admin/vehicles/${id}`, body)) as unknown as AdminVehicle;
}
export async function adminDeleteVehicle(id: number) {
  return (await http.delete(`/admin/vehicles/${id}`)) as unknown as AdminVehicle;
}
export async function adminImportVehicles(file: File) {
  const fd = new FormData();
  fd.append('file', file);
  return (await http.post('/admin/vehicles/import', fd)) as unknown as ImportResult;
}

/* ---------- CR-01：字典（组织 / 供应商 / 发起人） ---------- */
function dictApi(base: string) {
  return {
    list: async (params: { active?: number | ''; q?: string } = {}) =>
      (await http.get(`/admin/${base}`, { params })) as unknown as any[],
    create: async (body: any) => (await http.post(`/admin/${base}`, body)) as unknown as any,
    update: async (id: number, body: any) => (await http.put(`/admin/${base}/${id}`, body)) as unknown as any,
    remove: async (id: number) => (await http.delete(`/admin/${base}/${id}`)) as unknown as any,
    importCsv: async (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return (await http.post(`/admin/${base}/import`, fd)) as unknown as ImportResult;
    },
  };
}

const orgApi = dictApi('organizations');
const supApi = dictApi('suppliers');
const iniApi = dictApi('initiators');

export const adminOrganizations = {
  list: (params?: { active?: number | ''; q?: string }) => orgApi.list(params) as Promise<Organization[]>,
  create: (b: Partial<Organization>) => orgApi.create(b) as Promise<Organization>,
  update: (id: number, b: Partial<Organization>) => orgApi.update(id, b) as Promise<Organization>,
  remove: (id: number) => orgApi.remove(id) as Promise<Organization>,
  importCsv: (f: File) => orgApi.importCsv(f),
};
export const adminSuppliers = {
  list: (params?: { active?: number | ''; q?: string }) => supApi.list(params) as Promise<Supplier[]>,
  create: (b: Partial<Supplier>) => supApi.create(b) as Promise<Supplier>,
  update: (id: number, b: Partial<Supplier>) => supApi.update(id, b) as Promise<Supplier>,
  remove: (id: number) => supApi.remove(id) as Promise<Supplier>,
  importCsv: (f: File) => supApi.importCsv(f),
};
export const adminInitiators = {
  list: (params?: { active?: number | ''; q?: string }) => iniApi.list(params) as Promise<Initiator[]>,
  create: (b: Partial<Initiator>) => iniApi.create(b) as Promise<Initiator>,
  update: (id: number, b: Partial<Initiator>) => iniApi.update(id, b) as Promise<Initiator>,
  remove: (id: number) => iniApi.remove(id) as Promise<Initiator>,
  importCsv: (f: File) => iniApi.importCsv(f),
};

/* ---------- CR-03：后台管理员账号 ---------- */
export const adminUsers = {
  list: async (params: { active?: number | ''; q?: string } = {}) =>
    (await http.get('/admin/users', { params })) as unknown as AdminUser[],
  create: async (b: { username: string; name?: string; password: string; role?: string; orgId?: number | null; supplierId?: number | null }) =>
    (await http.post('/admin/users', b)) as unknown as AdminUser,
  update: async (id: number, b: { name?: string; active?: 0 | 1; role?: string; orgId?: number | null; supplierId?: number | null }) =>
    (await http.put(`/admin/users/${id}`, b)) as unknown as AdminUser,
  resetPassword: async (id: number, password: string) =>
    (await http.post(`/admin/users/${id}/password`, { password })) as unknown as { ok: true },
  remove: async (id: number) => (await http.delete(`/admin/users/${id}`)) as unknown as { ok: true },
};

/* ---------- 2026-10-08 需求②：审批中心 ---------- */
export const approvals = {
  flows: async () => (await http.get('/admin/approvals/flows')) as unknown as any[],
  flowOptions: async () => (await http.get('/admin/approvals/flow-options')) as unknown as any[],
  options: async () => (await http.get('/admin/approvals/options')) as unknown as any,
  createFlow: async (b: { code: string; name: string }) => (await http.post('/admin/approvals/flows', b)) as unknown as any,
  updateFlow: async (id: number, b: { name?: string; active?: number; fields?: any[] }) =>
    (await http.put(`/admin/approvals/flows/${id}`, b)) as unknown as any,
  deleteFlow: async (id: number) => (await http.delete(`/admin/approvals/flows/${id}`)) as unknown as any,
  setSteps: async (id: number, steps: any[]) =>
    (await http.put(`/admin/approvals/flows/${id}/nodes`, { steps })) as unknown as any,
  setNodes: async (id: number, nodes: { approverId?: number | null; approverRole?: string | null; label?: string }[]) =>
    (await http.put(`/admin/approvals/flows/${id}/nodes`, { nodes })) as unknown as any,
  requests: async (params: { status?: string; scope?: string } = {}) =>
    (await http.get('/admin/approvals/requests', { params })) as unknown as any[],
  submit: async (b: { kind: string; targetUserId: number; orgId?: number | null; supplierId?: number | null; reason?: string }) =>
    (await http.post('/admin/approvals/requests', b)) as unknown as any,
  detail: async (id: number) => (await http.get(`/admin/approvals/requests/${id}`)) as unknown as any,
  approve: async (id: number, comment?: string) =>
    (await http.post(`/admin/approvals/requests/${id}/approve`, { comment })) as unknown as any,
  reject: async (id: number, comment?: string) =>
    (await http.post(`/admin/approvals/requests/${id}/reject`, { comment })) as unknown as any,
  cancel: async (id: number) => (await http.post(`/admin/approvals/requests/${id}/cancel`, {})) as unknown as any,
};

/* ---------- CR-01：后台计时记录 / 导出 ---------- */
export async function adminListSessions(
  params: { date?: string; from?: string; to?: string; operatorId?: number; vin?: string; page?: number; pageSize?: number } = {}
) {
  try {
    return (await http.get('/admin/sessions', { params })) as unknown as SessionPage;
  } catch (e: any) {
    // §11.4 的 /api/admin/sessions 尚未就绪时，回退到同口径的公开 /api/sessions
    if (e?.http === 404) return (await http.get('/sessions', { params })) as unknown as SessionPage;
    throw e;
  }
}

export function adminExportUrl(params: {
  date?: string;
  from?: string;
  to?: string;
  operatorId?: number;
  vin?: string;
  format: 'xlsx' | 'csv';
}) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  });
  return `/api/admin/export?${q.toString()}`;
}

/* ---------- CR-08（需求⑥）：详细工时（含备注）查看/导出 ---------- */
export async function adminListSessionDetail(
  params: { date?: string; from?: string; to?: string; operatorId?: number; vin?: string; page?: number; pageSize?: number } = {}
) {
  return (await http.get('/admin/sessions/detail', { params })) as unknown as {
    list: SessionDetailRow[];
    page: number;
    pageSize: number;
    total: number;
  };
}

export function adminDetailExportUrl(params: {
  date?: string;
  from?: string;
  to?: string;
  operatorId?: number;
  vin?: string;
  format: 'xlsx' | 'csv';
}) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  });
  return `/api/admin/export/detail?${q.toString()}`;
}

/* ---------- CR-08（需求①）：批量开号 ---------- */
export async function adminBatchOpenOperatorAccounts() {
  return (await http.post('/admin/operators/accounts/batch')) as unknown as BatchOpenResult;
}

/* ---------- CR-07：班次字典 + 排班 ---------- */
export const adminShifts = {
  list: async (params: { active?: number | ''; q?: string } = {}) =>
    (await http.get('/admin/shifts', { params })) as unknown as Shift[],
  create: async (b: { name: string; startTime?: string | null; endTime?: string | null; sort?: number }) =>
    (await http.post('/admin/shifts', b)) as unknown as Shift,
  update: async (id: number, b: Partial<Shift>) => (await http.put(`/admin/shifts/${id}`, b)) as unknown as Shift,
  remove: async (id: number) => (await http.delete(`/admin/shifts/${id}`)) as unknown as Shift,
};

export const adminSchedules = {
  list: async (params: {
    date?: string;
    from?: string;
    to?: string;
    operatorId?: number;
    vehicleId?: number;
    shiftId?: number;
    status?: string;
  } = {}) => (await http.get('/admin/schedules', { params })) as unknown as Schedule[],
  board: async (date?: string) =>
    (await http.get('/admin/schedules/board', { params: { date } })) as unknown as ScheduleBoard,
  create: async (b: { workDate: string; shiftId?: number | null; operatorId: number; vehicleId: number; note?: string }) =>
    (await http.post('/admin/schedules', b)) as unknown as Schedule,
  batch: async (b: { workDate: string; shiftId?: number | null; operatorIds: number[]; vehicleIds: number[]; mode: 'cross' | 'pair' }) =>
    (await http.post('/admin/schedules/batch', b)) as unknown as BatchAssignResult,
  copy: async (b: { fromDate: string; toDate: string; shiftId?: number | null }) =>
    (await http.post('/admin/schedules/copy', b)) as unknown as CopyResult,
  update: async (id: number, b: Partial<Schedule> & { shiftId?: number | null; operatorId?: number; vehicleId?: number }) =>
    (await http.put(`/admin/schedules/${id}`, b)) as unknown as Schedule,
  remove: async (id: number) => (await http.delete(`/admin/schedules/${id}`)) as unknown as Schedule,
  importCsv: async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return (await http.post('/admin/schedules/import', fd)) as unknown as ImportResult;
  },
};

/* ---------- CR-11：日志查看（登录记录；admin 独占） ---------- */
export async function adminListLoginLogs(
  params: {
    account?: string;
    source?: '' | 'admin' | 'h5';
    result?: '' | 'ok' | 'fail';
    role?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  } = {}
) {
  return (await http.get('/admin/logs', { params })) as unknown as LoginLogPage;
}
