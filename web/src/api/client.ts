import axios, { type AxiosInstance } from 'axios';

export const TOKEN_KEY = 'st_admin_token';

export interface ApiError extends Error {
  code?: string;
  http?: number;
  data?: any;
}

// 允许单个请求标记「跳过全局 401 处理」——登录接口自身用它来避免被全局跳转吃掉
declare module 'axios' {
  export interface AxiosRequestConfig {
    skipAuthRedirect?: boolean;
  }
}

export const http: AxiosInstance = axios.create({ baseURL: '/api', timeout: 15000 });

http.interceptors.request.use((cfg) => {
  const token = localStorage.getItem(TOKEN_KEY);
  // CR-05：token 缺失/脏值（历史 bug 曾写入字符串 "undefined"）时不要下发 Authorization，
  // 否则坏 header 会顶掉同时下发的有效 Cookie，导致 401。
  const bad = !token || token === 'undefined' || token === 'null';
  if (bad) {
    delete cfg.headers.Authorization;
    if (token) localStorage.removeItem(TOKEN_KEY);
  } else {
    cfg.headers.Authorization = `Bearer ${token}`;
  }
  return cfg;
});

const ADMIN_LOGIN_PATH = '/admin/login';
const ADMIN_PASSWORD_PATH = '/admin/password';

/** 并发 401 防抖：首个 401 进入处理后置 true，其余直接返回，保证只弹一次、只跳一次 */
let redirecting = false;
/** 并发 403 强制改密防抖 */
let pwdRedirecting = false;

/**
 * 仅后台管理接口（/admin/**，登录接口除外）需要「登录失效」兜底。
 * H5 公开接口（/operators、/vehicles、/initiators、/sessions、/export 等）不在其列，
 * 避免把无鉴权请求的错误误判为后台登录失效而跳登录页。
 */
function isAdminApi(url?: string): boolean {
  if (!url) return false;
  return url.startsWith('/admin') && !url.startsWith(ADMIN_LOGIN_PATH);
}

/** 当前是否已在后台登录页（在其上不再跳转，避免死循环） */
function onLoginPage(): boolean {
  return window.location.pathname === ADMIN_LOGIN_PATH;
}

/** 后台 token 失效：清 token → 提示 → 跳登录页（防重复/防抖） */
export async function handleAuthExpired(): Promise<void> {
  if (redirecting || onLoginPage()) return;
  redirecting = true;
  try {
    localStorage.removeItem(TOKEN_KEY);
    // 动态引入，避免 element-plus / router 被打进 H5 首屏包
    const { ElMessage } = await import('element-plus');
    ElMessage.warning('登录已过期，请重新登录');
    const { default: router } = await import('@/router');
    await router.replace(ADMIN_LOGIN_PATH);
  } catch {
    // 兜底：路由不可用时直接整页跳转
    window.location.replace(ADMIN_LOGIN_PATH);
  } finally {
    redirecting = false;
  }
}

/** CR-06：后台未改密（403 MUST_CHANGE_PASSWORD）→ 强制跳 /admin/password（防重复） */
export async function handleMustChangePassword(): Promise<void> {
  if (pwdRedirecting || window.location.pathname === ADMIN_PASSWORD_PATH) return;
  pwdRedirecting = true;
  try {
    const { ElMessage } = await import('element-plus');
    ElMessage.warning('请先修改初始密码');
    const { default: router } = await import('@/router');
    await router.replace(ADMIN_PASSWORD_PATH);
  } catch {
    window.location.replace(ADMIN_PASSWORD_PATH);
  } finally {
    pwdRedirecting = false;
  }
}

// 后端成功包装 {ok:true,data}；失败 {ok:false,code,message,data?}
// CR-05：这里必须把外层包装剥掉只返回 data，否则所有调用方（列表/会话/登录）拿到的是
// {ok,data} 对象，视图与 startSession().session 全部取不到值。
http.interceptors.response.use(
  (res) => {
    const body: any = res.data;
    if (body && typeof body === 'object' && body.ok === true && 'data' in body) return body.data;
    return body;
  },
  (err) => {
    const status = err?.response?.status;
    const cfg = err?.config ?? {};
    const body = err?.response?.data;
    // 仅后台接口的 401 触发全局登录失效处理；登录接口与 H5 公开接口不受影响
    if (status === 401 && !cfg.skipAuthRedirect && isAdminApi(cfg.url)) {
      void handleAuthExpired();
    }
    // CR-06：后台接口 403 MUST_CHANGE_PASSWORD → 强制改密
    if (status === 403 && body?.code === 'MUST_CHANGE_PASSWORD' && !cfg.skipAuthRedirect && isAdminApi(cfg.url)) {
      void handleMustChangePassword();
    }
    const e: ApiError = new Error(body?.message || err?.message || '网络错误');
    e.code = body?.code;
    e.http = err?.response?.status;
    e.data = body?.data;
    return Promise.reject(e);
  }
);
