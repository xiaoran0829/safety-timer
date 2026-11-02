import { h5http } from './h5Client';
import type {
  H5LoginResult,
  H5MeResult,
  Operator,
  Vehicle,
  ScheduledVehicle,
  Initiator,
  SessionDetail,
  SessionPage,
  Session,
  Remark,
} from '@/types';

/* ---------- CR-06：H5 账号登录 / 改密 / 登出 ---------- */

export async function h5Login(username: string, password: string) {
  // skipAuthRedirect：登录失败由登录页自行提示（“账号或密码错误”），不走全局登录失效跳转
  return (await h5http.post(
    '/h5/login',
    { username, password },
    { skipAuthRedirect: true }
  )) as unknown as H5LoginResult;
}

export async function h5Me() {
  // skipAuthRedirect：路由守卫自行处理，避免与守卫重复跳转
  return (await h5http.get('/h5/me', { skipAuthRedirect: true })) as unknown as H5MeResult;
}

export async function h5Logout() {
  return (await h5http.post('/h5/logout')) as unknown as { ok: boolean };
}

export async function h5ChangePassword(oldPassword: string, newPassword: string) {
  return (await h5http.post('/h5/password', { oldPassword, newPassword })) as unknown as { token: string };
}

/* ---------- CR-06：H5 业务接口（带 st_op_token 的调用） ---------- */

export async function getOperators(params: { active?: number; q?: string } = {}) {
  return (await h5http.get('/operators', { params })) as unknown as Operator[];
}
export async function getVehicles(params: { active?: number; q?: string } = {}) {
  return (await h5http.get('/vehicles', { params })) as unknown as Vehicle[];
}
/* CR-07 口径 B：我今天的排班车辆（需 operator token，后端按 token 的 operatorId 判定） */
export async function getMyVehicles(params: { date?: string } = {}) {
  return (await h5http.get('/h5/my-vehicles', { params })) as unknown as ScheduledVehicle[];
}
export async function getMySchedule(params: { from?: string; to?: string } = {}) {
  return (await h5http.get('/h5/my-schedule', { params })) as unknown as unknown[];
}
export async function getInitiators(params: { active?: number; q?: string } = {}) {
  return (await h5http.get('/initiators', { params })) as unknown as Initiator[];
}

export async function getActiveSession(operatorId: number) {
  return (await h5http.get('/sessions/active', { params: { operatorId } })) as unknown as SessionDetail | null;
}
export async function startSession(operatorId: number, vehicleId: number, odometerOut: number, idemKey?: string) {
  return (await h5http.post(
    '/sessions/start',
    { operatorId, vehicleId, odometerOut },
    { headers: idemKey ? { 'Idempotency-Key': idemKey } : {} }
  )) as unknown as { session: Session };
}
// CR-09（需求⑩）：暂停必须带备注（后端校验 REMARK_REQUIRED）
export async function pauseSession(id: number, operatorId: number, remark: string, at?: string) {
  return (await h5http.post(`/sessions/${id}/pause`, { operatorId, remark, at })) as unknown as { session: Session };
}
export async function resumeSession(id: number, operatorId: number) {
  return (await h5http.post(`/sessions/${id}/resume`, { operatorId })) as unknown as { session: Session };
}
export async function stopSession(id: number, operatorId: number, odometerIn: number, idemKey?: string) {
  return (await h5http.post(
    `/sessions/${id}/stop`,
    { operatorId, odometerIn },
    { headers: idemKey ? { 'Idempotency-Key': idemKey } : {} }
  )) as unknown as { session: Session };
}
export async function addRemark(id: number, operatorId: number, content: string) {
  return (await h5http.post(`/sessions/${id}/remarks`, { operatorId, content })) as unknown as { remark: Remark };
}
export async function getSessionDetail(id: number) {
  return (await h5http.get(`/sessions/${id}`)) as unknown as SessionDetail;
}
export async function listSessions(
  params: { date?: string; from?: string; to?: string; operatorId?: number; vin?: string; page?: number; pageSize?: number } = {}
) {
  return (await h5http.get('/sessions', { params })) as unknown as SessionPage;
}

/* 导出（公开，直接下载；无法附带 Authorization 头，沿用公开链接） */
export function exportUrl(params: {
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
  return `/api/export?${q.toString()}`;
}
