// CR-01（§11.4）字典 API：组织 / 供应商 / 发起人
// 前缀 /api/admin，需登录（挂载于 adminRouter 内）。GET/POST/PUT + 软删(active=0) + CSV 导入(multipart)。
import { Router } from 'express';
import multer from 'multer';
import { sendOk } from '../lib/http.js';
import { ERR } from '../lib/errors.js';
import { readUploadRows } from '../lib/spreadsheet.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const isHeader = (cell, names) => names.some((n) => String(cell || '').trim().toLowerCase() === n);

function insertSql(table, extra, flag) {
  const cols = ['name', ...(extra ? [extra] : []), ...(flag ? [flag] : []), 'active', 'sort'].join(',');
  const qs = ['?', ...(extra ? ['?'] : []), ...(flag ? ['?'] : []), '1', '?'].join(',');
  return `INSERT INTO ${table}(${cols}) VALUES(${qs})`;
}

function updateSql(table, extra, flag) {
  const sets = ['name=?', ...(extra ? [`${extra}=?`] : []), ...(flag ? [`${flag}=?`] : []), 'sort=?', 'active=?'].join(',');
  return `UPDATE ${table} SET ${sets} WHERE id=?`;
}

/**
 * 生成字典 CRUD 路由。
 * @param {import('better-sqlite3').Database} db
 * @param {{table:string, extra:string|null, unique:boolean, label:string}} spec
 *   extra 为附加字段（organization/supplier=code，initiator=department）
 */
export function dictRouter(db, spec) {
  const { table, extra = null, flag = null, unique = false, label = '记录' } = spec;
  const r = Router();

  const dto = (row) => {
    if (!row) return null;
    const out = { id: row.id, name: row.name, active: row.active, sort: row.sort };
    if (extra) out[extra] = row[extra];
    if (flag) out[flag] = Number(row[flag] ?? 0);
    return out;
  };

  r.get('/', (req, res) => {
    const where = [];
    const args = [];
    if (req.query.active !== undefined && req.query.active !== '' && req.query.active !== null) {
      where.push('active = ?');
      args.push(Number(req.query.active));
    }
    const q = (req.query.q || '').trim();
    if (q) {
      where.push(extra ? `(name LIKE ? OR ${extra} LIKE ?)` : '(name LIKE ?)');
      args.push(`%${q}%`);
      if (extra) args.push(`%${q}%`);
    }
    const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM ${table} ${wsql} ORDER BY active DESC, sort ASC, id ASC`).all(...args);
    sendOk(res, rows.map(dto));
  });

  r.post('/', (req, res) => {
    const b = req.body || {};
    const name = String(b.name ?? '').trim();
    if (!name) throw ERR.VALIDATION('name 必填');
    const extraVal = extra ? (b[extra] === undefined || b[extra] === null ? null : String(b[extra]).trim() || null) : null;
    const sort = Number(b.sort) || 0;
    const flagVal = flag ? (b[flag] === undefined ? 0 : (Number(b[flag]) ? 1 : 0)) : null;
    try {
      const info = db.prepare(insertSql(table, extra, flag)).run(name, ...(extra ? [extraVal] : []), ...(flag ? [flagVal] : []), sort);
      sendOk(res, dto(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(Number(info.lastInsertRowid))), 201);
    } catch (e) {
      if (unique && /UNIQUE constraint failed/.test(e.message)) throw ERR.CONFLICT('同名已存在');
      throw e;
    }
  });

  r.put('/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!cur) throw ERR.NOT_FOUND(`${label}不存在`);
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : cur.name;
    if (!name) throw ERR.VALIDATION('name 不能为空');
    const extraVal = extra ? (b[extra] !== undefined ? (b[extra] === null ? null : String(b[extra]).trim() || null) : cur[extra]) : null;
    const sort = b.sort !== undefined ? Number(b.sort) || 0 : cur.sort;
    const active = b.active !== undefined ? (Number(b.active) ? 1 : 0) : cur.active;
    const flagVal = flag ? (b[flag] !== undefined ? (Number(b[flag]) ? 1 : 0) : Number(cur[flag] ?? 0)) : null;
    try {
      db.prepare(updateSql(table, extra, flag)).run(name, ...(extra ? [extraVal] : []), ...(flag ? [flagVal] : []), sort, active, id);
    } catch (e) {
      if (unique && /UNIQUE constraint failed/.test(e.message)) throw ERR.CONFLICT('同名已存在');
      throw e;
    }
    sendOk(res, dto(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)));
  });

  // 软删：置 active=0（审计口径，不做物理删除）
  r.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!cur) throw ERR.NOT_FOUND(`${label}不存在`);
    db.prepare(`UPDATE ${table} SET active=0 WHERE id=?`).run(id);
    sendOk(res, dto(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)));
  });

  r.post('/import', upload.single('file'), (req, res) => {
    const rows = readUploadRows(req);
    const result = { inserted: 0, skipped: 0, errors: [] };
    const exists = db.prepare(`SELECT 1 FROM ${table} WHERE name=?`);
    const ins = db.prepare(insertSql(table, extra, flag));
    const tx = db.transaction(() => {
      rows.forEach((row, i) => {
        if (i === 0 && isHeader(row[0], ['name', '名称', '姓名'])) return;
        const name = String(row[0] || '').trim();
        if (!name) return;
        if (exists.get(name)) {
          result.skipped++;
          return;
        }
        const extraVal = extra && row[1] ? String(row[1]).trim() : null;
        const info = ins.run(name, ...(extra ? [extraVal] : []), ...(flag ? [0] : []), Number(row[extra ? 2 : 1]) || 0);
        if (info.changes) result.inserted++;
        else {
          result.skipped++;
          result.errors.push({ line: i + 1, name, reason: '冲突或重复' });
        }
      });
    });
    tx();
    sendOk(res, result, 201);
  });

  return r;
}

/** 三个字典路由（供 adminRouter 挂载） */
export const DICT_ROUTES = [
  { mount: '/organizations', spec: { table: 'organization', extra: 'code', flag: 'see_all', unique: true, label: '组织' } },
  { mount: '/suppliers', spec: { table: 'supplier', extra: 'code', unique: true, label: '供应商' } },
  { mount: '/initiators', spec: { table: 'initiator', extra: 'department', unique: false, label: '发起人' } },
];
