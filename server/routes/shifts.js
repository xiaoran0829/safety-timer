// CR-07 班次字典 API（白/夜班…）。前缀 /api/admin，需登录（挂载于 adminRouter 内）。
// GET/POST/PUT + 软删(active=0)，风格对齐既有 dicts.js。
import { Router } from 'express';
import { sendOk } from '../lib/http.js';
import { ERR } from '../lib/errors.js';

const dto = (r) =>
  r
    ? {
        id: r.id,
        name: r.name,
        startTime: r.start_time ?? null,
        endTime: r.end_time ?? null,
        sort: r.sort,
        active: r.active,
      }
    : null;

const str = (v) => (v === undefined || v === null ? null : String(v).trim() || null);
// 开始：00:00–23:59；结束：允许 24:00（与前端一致；生产「夜班」= 15:00–24:00）
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIME_END_RE = /^(?:([01]\d|2[0-3]):[0-5]\d|24:00)$/;

function normTime(v, field, { allow24 = false } = {}) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  const re = allow24 ? TIME_END_RE : TIME_RE;
  if (!re.test(s)) throw ERR.VALIDATION(`${field} 格式应为 HH:mm${allow24 ? '（或 24:00）' : ''}`);
  return s;
}

export function shiftsRouter(db) {
  const r = Router();

  r.get('/', (req, res) => {
    const where = [];
    const args = [];
    if (req.query.active !== undefined && req.query.active !== '' && req.query.active !== null) {
      where.push('active = ?');
      args.push(Number(req.query.active));
    }
    const q = (req.query.q || '').trim();
    if (q) {
      where.push('name LIKE ?');
      args.push(`%${q}%`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM shift ${w} ORDER BY active DESC, sort ASC, id ASC`).all(...args);
    sendOk(res, rows.map(dto));
  });

  r.post('/', (req, res) => {
    const b = req.body || {};
    const name = String(b.name ?? '').trim();
    if (!name) throw ERR.VALIDATION('name 必填');
    const startTime = normTime(b.startTime ?? b.start_time, 'startTime');
    const endTime = normTime(b.endTime ?? b.end_time, 'endTime', { allow24: true });
    // CR-08 批2（需求②）：班次开始/结束时间必填
    if (!startTime) throw ERR.VALIDATION('startTime 必填（格式 HH:mm）');
    if (!endTime) throw ERR.VALIDATION('endTime 必填（格式 HH:mm）');
    const sort = Number(b.sort) || 0;
    try {
      const info = db
        .prepare('INSERT INTO shift(name,start_time,end_time,sort,active) VALUES(?,?,?,?,1)')
        .run(name, startTime, endTime, sort);
      sendOk(res, dto(db.prepare('SELECT * FROM shift WHERE id=?').get(Number(info.lastInsertRowid))), 201);
    } catch (e) {
      if (/UNIQUE constraint failed/i.test(e.message)) throw ERR.CONFLICT('同名班次已存在');
      throw e;
    }
  });

  r.put('/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM shift WHERE id=?').get(id);
    if (!cur) throw ERR.NOT_FOUND('班次不存在');
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : cur.name;
    if (!name) throw ERR.VALIDATION('name 不能为空');
    const startTime = b.startTime !== undefined || b.start_time !== undefined ? normTime(b.startTime ?? b.start_time, 'startTime') : cur.start_time;
    const endTime = b.endTime !== undefined || b.end_time !== undefined ? normTime(b.endTime ?? b.end_time, 'endTime', { allow24: true }) : cur.end_time;
    // CR-08 批2（需求②）：班次开始/结束时间必填（更新后不得为空）
    if (!startTime) throw ERR.VALIDATION('startTime 必填（格式 HH:mm）');
    if (!endTime) throw ERR.VALIDATION('endTime 必填（格式 HH:mm）');
    const sort = b.sort !== undefined ? Number(b.sort) || 0 : cur.sort;
    const active = b.active !== undefined ? (Number(b.active) ? 1 : 0) : cur.active;
    try {
      db.prepare('UPDATE shift SET name=?,start_time=?,end_time=?,sort=?,active=? WHERE id=?').run(
        name,
        startTime,
        endTime,
        sort,
        active,
        id
      );
    } catch (e) {
      if (/UNIQUE constraint failed/i.test(e.message)) throw ERR.CONFLICT('同名班次已存在');
      throw e;
    }
    sendOk(res, dto(db.prepare('SELECT * FROM shift WHERE id=?').get(id)));
  });

  // 软删：置 active=0（审计口径，不做物理删除）
  r.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM shift WHERE id=?').get(id);
    if (!cur) throw ERR.NOT_FOUND('班次不存在');
    db.prepare('UPDATE shift SET active=0 WHERE id=?').run(id);
    sendOk(res, dto(db.prepare('SELECT * FROM shift WHERE id=?').get(id)));
  });

  return r;
}
