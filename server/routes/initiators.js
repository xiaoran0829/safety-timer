import { Router } from 'express';
import { sendOk } from '../lib/http.js';

/**
 * GET /api/initiators
 * 公开只读：为 H5 下拉提供**启用中**的发起人（active=1，按 sort 升序）。
 * 仅暴露 {id,name,department}。管理端 /api/admin/initiators 语义不变（可见停用、含 active/sort）。
 */
export function initiatorsRouter(db) {
  const r = Router();
  r.get('/', (_req, res) => {
    const rows = db
      .prepare('SELECT id,name,department FROM initiator WHERE active=1 ORDER BY sort ASC, id ASC')
      .all();
    sendOk(res, rows.map((i) => ({ id: i.id, name: i.name, department: i.department ?? null })));
  });
  return r;
}
