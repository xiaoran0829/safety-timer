import { http } from './client';
import type { AdminMe } from '@/types';

/**
 * CR-06：后台「本人」账号接口（当前登录管理员）。
 * 独立文件便于与后端并行开发；由 `@/api/index.ts` 统一 re-export。
 */

/** GET /api/admin/me → {id,username,name,active,mustChangePwd} */
export async function adminMe() {
  return (await http.get('/admin/me')) as unknown as AdminMe;
}

/** POST /api/admin/me/password {oldPassword,newPassword} → {token}（新 token 覆盖旧 token） */
export async function adminChangePassword(oldPassword: string, newPassword: string) {
  return (await http.post('/admin/me/password', { oldPassword, newPassword })) as unknown as { token: string };
}
