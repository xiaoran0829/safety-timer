import { Router } from 'express';
import { sendOk } from '../lib/http.js';
import { ERR } from '../lib/errors.js';
import { reqScope } from '../lib/scope.js';
import { isAdmin, currentUser, mustChangeGateIfLoggedIn } from '../middleware/auth.js';
import { withIdempotency } from '../lib/idempotency.js';
import {
  startSession,
  pauseSession,
  resumeSession,
  stopSession,
  addRemark,
  getActiveDetail,
  getSessionDetail,
  listSessions,
} from '../services/timer.js';

function ownerId(req) {
  // CR-06：有 operator token → 以 token.operatorId 为准（忽略 body/query 传入）；
  // 无 token（旧 H5 / 脚本）/admin token → 保持现状（body/query）。
  const user = currentUser(req);
  if (user && user.role === 'operator' && user.operatorId != null) return Number(user.operatorId);
  const v = req.body?.operatorId ?? req.query.operatorId;
  return v === undefined || v === null || v === '' ? null : Number(v);
}

/** 会话列表处理器（可复用）：公开 /api/sessions 与后台别名 /api/admin/sessions 语义一致。 */
export function listSessionsHandler(db) {
  return (req, res) => {
    const { date, from, to, operatorId, vin, page, pageSize } = req.query;
    sendOk(res, listSessions(db, { date, from, to, operatorId, vin, page, pageSize, scope: reqScope(req, db) }));
  };
}

export function sessionsRouter(db) {
  const r = Router();

  // 2026-10-08 需求①：H5 安全员登录态 → 开始/停止必须填里程（后台/脚本不强制）
  const isOperatorReq = (req) => {
    const u = currentUser(req);
    return !!(u && u.role === 'operator');
  };

  // CR-06 补丁：公开路由也挂「登录态才生效」的强制改密闸门（无 token 行为不变）。
  r.use(mustChangeGateIfLoggedIn);

  // 注意：/active 必须先于 /:id 注册
  r.get('/active', (req, res) => {
    const operatorId = ownerId(req);
    if (!operatorId) throw ERR.VALIDATION('operatorId 必填');
    sendOk(res, getActiveDetail(db, operatorId));
  });

  r.post('/start', (req, res) => {
    if (isOperatorReq(req) && (req.body?.odometerOut === undefined || req.body?.odometerOut === null || req.body?.odometerOut === '')) {
      throw ERR.ODOMETER_REQUIRED('开始计时前请填写出车里程数');
    }
    const key = req.get('Idempotency-Key');
    // CR-06：operator 登录态下 operatorId 以 token 为准（防篡改他人 id）
    // CR-08 批2（需求④）：发起人由后端按「排班下发人」(schedule.created_by) 快照，不再取登录用户姓名
    // CR-08 批2（需求⑤）：非排班车一律硬拦（已取消 allowUnscheduled 放行口）
    const { replayed, result } = withIdempotency(db, key, 'start', () =>
      startSession(db, {
        operatorId: ownerId(req),
        vehicleId: req.body?.vehicleId,
        initiatorId: req.body?.initiatorId,
        odometerOut: req.body?.odometerOut,
      })
    );
    sendOk(res, result, replayed ? 200 : 201);
  });

  r.post('/:id/pause', (req, res) => {
    // CR-09（需求⑩）：暂停带备注（同事务写入；空→REMARK_REQUIRED）
    // CR-09（需求⑫）：可带「点击时刻」at（秒精度），以点击瞬间停表；越界回退服务器 now
    sendOk(
      res,
      pauseSession(db, req.params.id, ownerId(req), {
        admin: isAdmin(req),
        remark: req.body?.remark,
        at: req.body?.at,
      })
    );
  });

  r.post('/:id/resume', (req, res) => {
    sendOk(res, resumeSession(db, req.params.id, ownerId(req), { admin: isAdmin(req) }));
  });

  r.post('/:id/stop', (req, res) => {
    if (isOperatorReq(req) && (req.body?.odometerIn === undefined || req.body?.odometerIn === null || req.body?.odometerIn === '')) {
      throw ERR.ODOMETER_REQUIRED('停止计时前请填写收车里程数');
    }
    const key = req.get('Idempotency-Key');
    const { replayed, result } = withIdempotency(db, key, `stop:${req.params.id}`, () =>
      stopSession(db, req.params.id, ownerId(req), { admin: isAdmin(req), odometerIn: req.body?.odometerIn })
    );
    sendOk(res, result, replayed ? 200 : 200);
  });

  r.post('/:id/remarks', (req, res) => {
    const result = addRemark(db, req.params.id, ownerId(req), req.body?.content, { admin: isAdmin(req) });
    sendOk(res, result, 201);
  });

  r.get('/', listSessionsHandler(db));

  r.get('/:id', (req, res) => {
    sendOk(res, getSessionDetail(db, req.params.id));
  });

  return r;
}
