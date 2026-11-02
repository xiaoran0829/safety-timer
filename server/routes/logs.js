// CR-11：后台「日志查看」（admin 独占）。列表 + 筛选（账号/类型/结果/角色/时间范围）+ 分页。
// 权限：由 admin.js 的 r.use('/logs', requirePerm('logs')) 兜底；本路由不做角色判断。
import { Router } from 'express';
import { sendOk } from '../lib/http.js';
import { listLoginLogs } from '../services/loginLog.js';

export function logsRouter(db) {
  const r = Router();

  // GET /api/admin/logs?account=&source=admin|h5&result=ok|fail&role=&from=&to=&page=&pageSize=
  r.get('/', (req, res) => {
    const { account, source, result, role, from, to, page, pageSize } = req.query;
    sendOk(res, listLoginLogs(db, { account, source, result, role, from, to, page, pageSize }));
  });

  return r;
}
