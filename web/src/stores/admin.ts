// CR-10：后台角色与菜单可见性（前端侧）。
// 说明：前端只负责「菜单可见 / 路由拦截」的体验，**真正的权限以后端 403 NO_PERMISSION 为准**。
// 矩阵与后端 server/lib/roles.js 的 READ_MATRIX 保持一致；角色由 /api/admin/me 每次登录后拉取。
import { defineStore } from 'pinia';
import { adminMe } from '@/api';
import type { AdminMe, AdminRole } from '@/types';

export const ALL_ROLES: AdminRole[] = ['admin', 'engineer', 'fleet_admin'];

/** 角色中文名（账号管理下拉 / 页头展示） */
export const ROLE_LABEL: Record<AdminRole, string> = {
  admin: '管理员',
  engineer: '工程师',
  fleet_admin: '车队管理员',
};

export type PermKey = 'operators' | 'vehicles' | 'dicts' | 'schedules' | 'users' | 'sessions' | 'detail' | 'logs' | 'approvals';

/** 模块权限矩阵（读口径）——与后端一致 */
export const PERM_MATRIX: Record<PermKey, AdminRole[]> = {
  operators: ['admin', 'fleet_admin'],
  vehicles: ['admin', 'engineer'],
  dicts: ALL_ROLES,
  schedules: ALL_ROLES,
  users: ['admin'],
  sessions: ALL_ROLES,
  detail: ALL_ROLES,
  logs: ['admin'], // CR-11：日志查看：admin 独占
  approvals: ALL_ROLES, // 2026-10-08 需求②：审批中心
};

/** 侧边菜单（顺序即展示顺序）；perm = 模块键 */
export const NAV_ITEMS: { key: PermKey; path: string; label: string }[] = [
  { key: 'operators', path: '/admin/operators', label: '安全员管理' },
  { key: 'vehicles', path: '/admin/vehicles', label: '车架号管理' },
  { key: 'dicts', path: '/admin/dicts', label: '组织·供应商' },
  { key: 'schedules', path: '/admin/schedules', label: '排班' },
  { key: 'users', path: '/admin/users', label: '账号管理' },
  { key: 'sessions', path: '/admin/sessions', label: '计时记录' },
  { key: 'detail', path: '/admin/detail', label: '详细工时' },
  { key: 'logs', path: '/admin/logs', label: '日志查看' },
  { key: 'approvals', path: '/admin/approvals', label: '审批中心' },
];

export const useAdminStore = defineStore('admin', {
  state: () => ({
    me: null as AdminMe | null,
    loaded: false,
    loading: false,
  }),
  getters: {
    role: (s): AdminRole | null => s.me?.role ?? null,
    isAdmin: (s): boolean => s.me?.role === 'admin',
    /** 当前角色可见的菜单 */
    navItems: (s) => (s.me ? NAV_ITEMS.filter((n) => PERM_MATRIX[n.key].includes(s.me!.role)) : []),
  },
  actions: {
    can(key: PermKey): boolean {
      const r = this.role;
      return !!r && PERM_MATRIX[key].includes(r);
    },
    /** 无权时的兜底落地页（第一个有权模块） */
    firstAllowedPath(): string {
      return this.navItems[0]?.path || '/admin/password';
    },
    /** 拉取当前登录账号（force=true 强制刷新角色） */
    async load(force = false): Promise<AdminMe | null> {
      if (this.loaded && !force) return this.me;
      if (this.loading) return this.me;
      this.loading = true;
      try {
        const me = await adminMe();
        this.me = me;
        this.loaded = true;
        return me;
      } catch {
        this.clear();
        return null;
      } finally {
        this.loading = false;
      }
    },
    clear() {
      this.me = null;
      this.loaded = false;
    },
  },
});
