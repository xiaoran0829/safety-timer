// CR-07 H5 排班接口：默认只列「今天排给我的车」。
// CR-08 批2（需求⑤）：H5 仅列本人当日排班车，后端硬拦非排班车（已取消 allowUnscheduled 放行口）。
//
// 身份：CR-06 已合入 → 直接用 operator token（requireOperator + req.authUser.operatorId），
// 不再接受 query/body 的 operatorId（防越权）。本路由先于 CR-06 的 /api/h5 登录路由挂载，
// 且仅对自身路径加 requireOperator（不使用路由级 use，避免挡住 CR-06 的 /login）。
import { Router } from 'express';
import { sendOk } from '../lib/http.js';
import { requireOperator, currentUser } from '../middleware/auth.js';
import { myScheduledVehicles, mySchedule } from '../services/schedule.js';

export function h5Router(db) {
  const r = Router();

  // 我今天的排班车辆（含班次时间窗 + 占用态）
  r.get('/my-vehicles', requireOperator, (req, res) => {
    const me = currentUser(req);
    sendOk(res, myScheduledVehicles(db, { operatorId: me.operatorId, date: req.query.date }));
  });

  // 我的排班日历
  r.get('/my-schedule', requireOperator, (req, res) => {
    const me = currentUser(req);
    sendOk(res, mySchedule(db, { operatorId: me.operatorId, from: req.query.from, to: req.query.to }));
  });

  return r;
}
