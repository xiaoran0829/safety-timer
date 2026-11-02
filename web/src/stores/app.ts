import { defineStore } from 'pinia';
import type { H5Operator, Vehicle } from '@/types';

const KEY = 'st_app_state';
interface Persisted {
  /* CR-06：仅持久化车辆选择；操作者不再落 sessionStorage，改由 /api/h5/me 登录后回填 */
  vehicle: Vehicle | null;
}

function load(): Persisted {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted> & { vehicle?: Vehicle | null };
      return { vehicle: p?.vehicle ?? null };
    }
  } catch {
    /* ignore */
  }
  return { vehicle: null };
}

export const useAppStore = defineStore('app', {
  state: () => ({
    operator: null as H5Operator | null,
    vehicle: null as Vehicle | null,
    /* CR-06：本会话是否已用 /api/h5/me 校验过；刷新后重置为 false，守卫重新校验一次 */
    authChecked: false,
    /* CR-06：当前是否需要强制改密（来自登录响应或 /api/h5/me） */
    mustChangePwd: false,
  }),
  getters: {
    operatorId: (s) => s.operator?.id ?? null,
    operatorName: (s) => s.operator?.name ?? '',
  },
  actions: {
    /** 登录/校验成功后回填操作者（不清车辆，保证刷新后车辆选择保留） */
    setOperator(o: H5Operator) {
      this.operator = o;
      this.persist();
    },
    setVehicle(v: Vehicle | null) {
      this.vehicle = v;
      this.persist();
    },
    /** 登录时重置车辆选择（新登录会话） */
    clearVehicle() {
      this.vehicle = null;
      this.persist();
    },
    markAuthChecked(mustChangePwd: boolean) {
      this.authChecked = true;
      this.mustChangePwd = mustChangePwd;
    },
    /** 退出登录/登录失效：清空内存态与持久化车辆 */
    clearOperator() {
      this.operator = null;
      this.vehicle = null;
      this.authChecked = false;
      this.mustChangePwd = false;
      try {
        sessionStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
    },
    persist() {
      try {
        sessionStorage.setItem(KEY, JSON.stringify({ vehicle: this.vehicle }));
      } catch {
        /* ignore */
      }
    },
    /** 仅恢复车辆选择；操作者由登录态（/api/h5/me）回填 */
    restore() {
      const p = load();
      this.vehicle = p.vehicle;
    },
  },
});
