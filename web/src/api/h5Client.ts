import axios, { type AxiosInstance } from 'axios';

/**
 * CR-06：H5 安全员端独立 axios 实例。
 * - token key = `st_op_token`（与后台 `st_admin_token` 分开，互不覆盖）
 * - 语义对齐 admin 端 client.ts：请求拦截器（脏 token 不下发 Authorization）、响应剥壳、401/403 全局处理。
 */
export const OP_TOKEN_KEY = 'st_op_token';

export interface H5ApiError extends Error {
  code?: string;
  http?: number;
  data?: any;
}

export const h5http: AxiosInstance = axios.create({ baseURL: '/api', timeout: 15000 });

// 请求拦截：与 client.ts 同语义，token 缺失/脏值时不下发 Authorization，
// 避免坏 header 顶掉同时下发的有效 Cookie 导致 401。
h5http.interceptors.request.use((cfg) => {
  const token = localStorage.getItem(OP_TOKEN_KEY);
  const bad = !token || token === 'undefined' || token === 'null';
  if (bad) {
    delete cfg.headers.Authorization;
    if (token) localStorage.removeItem(OP_TOKEN_KEY);
  } else {
    cfg.headers.Authorization = `Bearer ${token}`;
  }
  return cfg;
});

const LOGIN_PATH = '/login';
const CHANGE_PWD_PATH = '/change-password';

/** 并发 401 防抖 */
let redirecting = false;
/** 并发 403 强制改密防抖 */
let pwdRedirecting = false;

/** 当前是否已在 H5 登录页（在其上不再跳转，避免死循环） */
function onLoginPage(): boolean {
  return window.location.pathname === LOGIN_PATH;
}

/** H5 登录失效：清 token → 提示 → 跳 /login */
export async function handleH5AuthExpired(): Promise<void> {
  if (redirecting || onLoginPage()) return;
  redirecting = true;
  try {
    localStorage.removeItem(OP_TOKEN_KEY);
    const { showToast } = await import('vant');
    showToast('登录已过期，请重新登录');
    const { default: router } = await import('@/router');
    await router.replace(LOGIN_PATH);
  } catch {
    window.location.replace(LOGIN_PATH);
  } finally {
    redirecting = false;
  }
}

/** 未改密（403 MUST_CHANGE_PASSWORD）：强制跳 H5 改密页 */
export async function handleH5MustChangePassword(): Promise<void> {
  if (pwdRedirecting || window.location.pathname === CHANGE_PWD_PATH) return;
  pwdRedirecting = true;
  try {
    const { showToast } = await import('vant');
    showToast('请先修改初始密码');
    const { default: router } = await import('@/router');
    await router.replace(CHANGE_PWD_PATH);
  } catch {
    window.location.replace(CHANGE_PWD_PATH);
  } finally {
    pwdRedirecting = false;
  }
}

// 后端成功包装 {ok:true,data}；失败 {ok:false,code,message,data?}
// 这里把外层包装剥掉只返回 data，与 client.ts 一致。
h5http.interceptors.response.use(
  (res) => {
    const body: any = res.data;
    if (body && typeof body === 'object' && body.ok === true && 'data' in body) return body.data;
    return body;
  },
  (err) => {
    const status = err?.response?.status;
    const cfg = err?.config ?? {};
    const body = err?.response?.data;
    const code = body?.code;
    if (status === 401 && !cfg.skipAuthRedirect) {
      void handleH5AuthExpired();
    } else if (status === 403 && code === 'MUST_CHANGE_PASSWORD' && !cfg.skipAuthRedirect) {
      void handleH5MustChangePassword();
    }
    const e: H5ApiError = new Error(body?.message || err?.message || '网络错误');
    e.code = code;
    e.http = status;
    e.data = body?.data;
    return Promise.reject(e);
  }
);
