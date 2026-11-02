// CR-07 后台排班 API。前缀 /api/admin，需登录（挂载于 adminRouter 内）。
// 端点：GET /  POST /  POST /batch  POST /copy  POST /import  GET /board  PUT /:id  DELETE /:id
import { Router } from 'express';
import multer from 'multer';
import { sendOk } from '../lib/http.js';
import { ERR } from '../lib/errors.js';
import { readUploadRows } from '../lib/spreadsheet.js';
import { currentUser } from '../middleware/auth.js';
import {
  listSchedules,
  createSchedule,
  batchAssign,
  copySchedules,
  updateSchedule,
  cancelSchedule,
  importSchedules,
  scheduleBoard,
} from '../services/schedule.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

/** 留痕主体：登录账号姓名/用户名（后台路由已过 requireAdmin） */
function actor(req) {
  const u = currentUser(req);
  return (u && (u.name || u.username)) || 'admin';
}

export function schedulesRouter(db) {
  const r = Router();

  r.get('/', (req, res) => {
    sendOk(
      res,
      listSchedules(db, {
        date: req.query.date,
        from: req.query.from,
        to: req.query.to,
        operatorId: req.query.operatorId,
        vehicleId: req.query.vehicleId,
        shiftId: req.query.shiftId,
        status: req.query.status,
      })
    );
  });

  r.get('/board', (req, res) => {
    sendOk(res, scheduleBoard(db, req.query.date));
  });

  r.post('/', (req, res) => {
    sendOk(res, createSchedule(db, req.body || {}, actor(req)), 201);
  });

  r.post('/batch', (req, res) => {
    sendOk(res, batchAssign(db, req.body || {}, actor(req)), 201);
  });

  r.post('/copy', (req, res) => {
    sendOk(res, copySchedules(db, req.body || {}, actor(req)), 201);
  });

  r.post('/import', upload.single('file'), (req, res) => {
    const rows = readUploadRows(req);
    sendOk(res, importSchedules(db, rows, actor(req)), 201);
  });

  r.put('/:id', (req, res) => {
    sendOk(res, updateSchedule(db, req.params.id, req.body || {}, actor(req)));
  });

  r.delete('/:id', (req, res) => {
    sendOk(res, cancelSchedule(db, req.params.id, actor(req)));
  });

  return r;
}
