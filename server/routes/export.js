import { Router } from 'express';
import { ERR } from '../lib/errors.js';
import { reqScope } from '../lib/scope.js';
import {
  exportFileName,
  toXlsxBuffer,
  toCsvString,
  toDetailXlsxBuffer,
  toDetailCsvString,
} from '../services/export.js';

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * 导出处理器（可复用）：GET ?date=YYYY-MM-DD&format=xlsx|csv（或 from/to/operatorId/vin）。
 * 公开 /api/export 与后台别名 /api/admin/export 语义完全一致。
 */
export function exportHandler(db) {
  return (req, res) => {
    const format = (req.query.format || 'xlsx').toLowerCase();
    if (format !== 'xlsx' && format !== 'csv') throw ERR.VALIDATION('format 仅支持 xlsx / csv');
    const filters = {
      date: req.query.date || undefined,
      from: req.query.from || undefined,
      to: req.query.to || undefined,
      operatorId: req.query.operatorId || undefined,
      vin: req.query.vin || undefined,
      scope: reqScope(req, db),
    };
    const filename = exportFileName(filters, format);
    res.setHeader('Content-Disposition', contentDisposition(filename));
    if (format === 'csv') {
      const csv = toCsvString(db, filters);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send(csv);
    }
    const buf = toXlsxBuffer(db, filters);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);
  };
}

/**
 * CR-08（需求⑥）：详细工时（含备注）导出处理器。
 * GET ?date=YYYY-MM-DD&format=xlsx|csv（或 from/to/operatorId/vin）。
 * 列含「排班备注 + 计时备注」。仅后台可用（挂在 /api/admin/export/detail）。
 */
export function detailExportHandler(db) {
  return (req, res) => {
    const format = (req.query.format || 'xlsx').toLowerCase();
    if (format !== 'xlsx' && format !== 'csv') throw ERR.VALIDATION('format 仅支持 xlsx / csv');
    const filters = {
      date: req.query.date || undefined,
      from: req.query.from || undefined,
      to: req.query.to || undefined,
      operatorId: req.query.operatorId || undefined,
      vin: req.query.vin || undefined,
      scope: reqScope(req, db),
    };
    const base = exportFileName(filters, format).replace(/\.(xlsx|csv)$/i, '');
    const filename = `${base}_详细工时.${format}`;
    res.setHeader('Content-Disposition', contentDisposition(filename));
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send(toDetailCsvString(db, filters));
    }
    const buf = toDetailXlsxBuffer(db, filters);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);
  };
}

/** GET /api/export（公开） */
export function exportRouter(db) {
  const r = Router();
  r.get('/', exportHandler(db));
  return r;
}
