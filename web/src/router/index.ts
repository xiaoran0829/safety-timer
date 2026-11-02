import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAppStore } from '@/stores/app';
import { useAdminStore, type PermKey } from '@/stores/admin';
import { TOKEN_KEY } from '@/api/client';
import { OP_TOKEN_KEY } from '@/api/h5Client';
import { h5Me } from '@/api/h5';

const routes: RouteRecordRaw[] = [
  /* CR-06：H5 选人页下线，/ 重定向 /vin；OperatorPicker.vue 文件保留便于回滚 */
  { path: '/', redirect: '/vin' },

  /* CR-06：H5 登录 / 强制改密（两者均无需业务登录守卫；改密页仅需有 token） */
  { path: '/login', name: 'h5Login', component: () => import('@/views/h5/LoginView.vue') },
  {
    path: '/change-password',
    name: 'h5ChangePassword',
    component: () => import('@/views/h5/ChangePasswordView.vue'),
    meta: { needOpToken: true },
  },

  /* CR-06：H5 业务页需登录（且非强制改密态） */
  { path: '/vin', name: 'vin', component: () => import('@/views/VinPicker.vue'), meta: { needOperator: true } },
  { path: '/work', name: 'work', component: () => import('@/views/WorkView.vue'), meta: { needOperator: true } },
  { path: '/records', name: 'records', component: () => import('@/views/RecordsView.vue'), meta: { needOperator: true } },

  /* CR-01：PC 管理后台（Element Plus，路由懒加载与 H5 隔离） */
  { path: '/admin/login', name: 'adminLogin', component: () => import('@/views/admin/AdminLogin.vue') },
  {
    path: '/admin',
    component: () => import('@/views/admin/AdminLayout.vue'),
    meta: { needAdmin: true },
    children: [
      { path: '', redirect: '/admin/operators' },
      { path: 'operators', name: 'adminOperators', component: () => import('@/views/admin/OperatorsAdmin.vue'), meta: { perm: 'operators' } },
      { path: 'vehicles', name: 'adminVehicles', component: () => import('@/views/admin/VehiclesAdmin.vue'), meta: { perm: 'vehicles' } },
      { path: 'dicts', name: 'adminDicts', component: () => import('@/views/admin/DictAdmin.vue'), meta: { perm: 'dicts' } },
      { path: 'users', name: 'adminUsers', component: () => import('@/views/admin/UsersAdmin.vue'), meta: { perm: 'users' } },
      /* 2026-10-08 需求②：审批中心 */
      { path: 'approvals', name: 'adminApprovals', component: () => import('@/views/admin/ApprovalAdmin.vue'), meta: { perm: 'approvals' } },
      { path: 'schedules', name: 'adminSchedules', component: () => import('@/views/admin/ScheduleAdmin.vue'), meta: { perm: 'schedules' } },
      { path: 'sessions', name: 'adminSessions', component: () => import('@/views/admin/SessionsAdmin.vue'), meta: { perm: 'sessions' } },
      { path: 'detail', name: 'adminDetail', component: () => import('@/views/admin/DetailAdmin.vue'), meta: { perm: 'detail' } },
      /* CR-11：日志查看（登录记录；admin 独占） */
      { path: 'logs', name: 'adminLogs', component: () => import('@/views/admin/LogsAdmin.vue'), meta: { perm: 'logs' } },
      /* CR-06：后台本人改密 */
      { path: 'password', name: 'adminPassword', component: () => import('@/views/admin/ChangePassword.vue') },
    ],
  },

  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const store = useAppStore();
  const hasOpToken = !!localStorage.getItem(OP_TOKEN_KEY);

  if (to.meta.needAdmin) {
    if (!localStorage.getItem(TOKEN_KEY)) return { path: '/admin/login' };
    // CR-10：拉取当前账号角色（/api/admin/me）；失败 → 视为登录失效
    const admin = useAdminStore();
    const me = await admin.load();
    if (!me) {
      try {
        localStorage.removeItem(TOKEN_KEY);
      } catch {
        /* ignore */
      }
      return { path: '/admin/login' };
    }
    const perm = to.meta.perm as PermKey | undefined;
    if (perm && !admin.can(perm)) return { path: admin.firstAllowedPath() };
  }

  // 改密页需要 token
  if (to.meta.needOpToken && !hasOpToken) return { path: '/login' };

  if (to.meta.needOperator) {
    if (!hasOpToken) return { path: '/login' };
    // 每个会话校验一次（刷新后 store 重置 → 重新校验一次）
    if (!store.authChecked) {
      try {
        const me = await h5Me();
        store.setOperator(me.operator);
        store.markAuthChecked(!!me.mustChangePwd);
      } catch {
        store.clearOperator();
        return { path: '/login' };
      }
    }
    if (store.mustChangePwd) return { path: '/change-password' };
  }

  return true;
});

export default router;
