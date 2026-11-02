// 导出（冻结规格 §6）：服务端生成，列序固定，空列留空。
// CR-08（老板需求③）：在固定 11 列后追加第 12 列「排班备注」（调度备注快照）。
import XLSX from 'xlsx';
import { fmtDuration, nowDate, compactDay } from '../lib/time.js';

export const EXPORT_COLUMNS = [
  '组织',
  '供应商',
  '车架号',
  '工单号',
  '试验开始时间',
  '发起人',
  '安全员',
  '实验总里程',
  '试验实际时长',
  // 主人令（2026-10-08）：在「试验实际时长」之后插入「有效计费时长（h）」（= net_seconds/3600，两位小数）
  '有效计费时长（h）',
  '总计费时长',
  '不计费时长',
  // CR-08：新增第 12 列（末尾追加，前 11 列顺序不变）
  '排班备注',
];

/** CR-08（需求⑥）+ CR-09（需求⑧）：详细工时（含时间轴）导出列 */
export const DETAIL_COLUMNS = [
  '组织',
  '供应商',
  '车架号',
  '工单号',
  '试验开始时间',
  '试验结束时间',
  '发起人',
  '安全员',
  // 主人令（2026-10-09）：详细工时新增「行驶里程（km）」= 收车里程 − 出车里程
  '行驶里程（km）',
  '试验实际时长',
  // 主人令（2026-10-08）：在「试验实际时长」之后插入「有效计费时长（h）」（= net_seconds/3600，两位小数）
  '有效计费时长（h）',
  '暂停时长',
  '状态',
  '排班备注',
  // CR-09（需求⑪）：暂停次数 + 暂停开始/结束时间（多段「；」并列），置于时间轴列之前
  '暂停次数',
  // 主人令（2026-10-07 09:37）：剔除原 N/O 列「暂停开始时间」「暂停结束时间」
  // CR-09（需求⑧）：原平铺「计时备注」→ 时间轴（多点–多点 + 该段备注）
  '详细工时（时间轴）',
];

/** 查询符合条件的会话（CR-01：组织/供应商/发起人读 timer_session 快照，不依赖档案现状） */
function queryRows(db, { date, from, to, operatorId, vin } = {}) {
  const where = [];
  const args = [];
  if (date) {
    where.push('start_at >= ? AND start_at < ?');
    args.push(`${date} 00:00:00`, `${date} 23:59:59`);
  }
  if (from) {
    where.push('start_at >= ?');
    args.push(`${from} 00:00:00`);
  }
  if (to) {
    where.push('start_at <= ?');
    args.push(`${to} 23:59:59`);
  }
  if (operatorId) {
    where.push('operator_id = ?');
    args.push(Number(operatorId));
  }
  if (vin) {
    where.push('vin LIKE ?');
    args.push(`%${vin}%`);
  }
  const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // 仅导出已停止（有终值）的会话，进行中不计入正式报表
  const conn = wsql ? `${wsql} AND status='stopped'` : `WHERE status='stopped'`;
  return db
    .prepare(`SELECT s.* FROM timer_session s ${conn} ORDER BY s.start_at ASC, s.id ASC`)
    .all(...args);
}

/** 行 → 列数组（顺序不可变；CR-01：组织/供应商/发起人 由快照列带出；CR-08：第 12 列排班备注） */
export function rowToCells(r) {
  return [
    r.org_name ?? '', // 1 组织（timer_session 快照）
    r.supplier_name ?? '', // 2 供应商（快照）
    r.vin ?? '', // 3 车架号
    r.work_order_no ?? '', // 4 工单号
    (r.start_at || '').slice(0, 16), // 5 试验开始时间 YYYY-MM-DD HH:mm
    r.initiator_name ?? '', // 6 发起人（快照）
    r.operator_name ?? '', // 7 安全员
    '', // 8 实验总里程（本期留空）
    fmtDuration(r.net_seconds), // 9 试验实际时长 HH:MM:SS
    (Number(r.net_seconds || 0) / 3600).toFixed(2), // 10 有效计费时长（h）（主人令 2026-10-08；与页面 billableHours 同口径）
    '', // 11 总计费时长（本期留空）
    '', // 12 不计费时长（本期留空）
    r.schedule_note ?? '', // 13 排班备注（CR-08 快照；历史行可能为空）
  ];
}

export function buildMatrix(db, filters) {
  const rows = queryRows(db, filters);
  return [EXPORT_COLUMNS, ...rows.map(rowToCells)];
}

export function exportFileName(filters = {}, ext) {
  let tag;
  if (filters.date) tag = String(filters.date).replace(/-/g, '');
  else if (filters.from) tag = `${String(filters.from).replace(/-/g, '')}-${String(filters.to || filters.from).replace(/-/g, '')}`;
  else tag = compactDay(nowDate());
  return `安全员计时_${tag}.${ext}`;
}

export function toXlsxBuffer(db, filters) {
  const aoa = buildMatrix(db, filters);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = EXPORT_COLUMNS.map((c) => ({ wch: Math.max(12, c.length * 2 + 4) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '安全员计时');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** CSV：UTF-8 带 BOM，逗号分隔，字段含逗号/引号/换行时按 RFC4180 转义 */
export function toCsvString(db, filters) {
  const aoa = buildMatrix(db, filters);
  return aoaToCsv(aoa);
}

/* ---------------- CR-08（需求⑥）：详细工时（含备注）导出 ---------------- */

function detailRows(db, { date, from, to, operatorId, vin } = {}) {
  const where = [];
  const args = [];
  if (date) {
    where.push('start_at >= ? AND start_at < ?');
    args.push(`${date} 00:00:00`, `${date} 23:59:59`);
  }
  if (from) {
    where.push('start_at >= ?');
    args.push(`${from} 00:00:00`);
  }
  if (to) {
    where.push('start_at <= ?');
    args.push(`${to} 23:59:59`);
  }
  if (operatorId) {
    where.push('operator_id = ?');
    args.push(Number(operatorId));
  }
  if (vin) {
    where.push('vin LIKE ?');
    args.push(`%${vin}%`);
  }
  const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT s.* FROM timer_session s ${wsql} ORDER BY s.start_at ASC, s.id ASC`)
    .all(...args);
  const remStmt = db.prepare('SELECT ts, content FROM remark WHERE session_id=? ORDER BY id');
  const segStmt = db.prepare(
    'SELECT kind, started_at, ended_at FROM timer_segment WHERE session_id=? ORDER BY id'
  );
  const statusText = { running: '进行中', paused: '已暂停', stopped: '已结束' };
  const hhmm = (s) => (s || '').slice(11, 16);
  // CR-09（需求⑪）：暂停段汇总（次数）。
  // 主人令（2026-10-07）：原「暂停开始/结束时间」两列已剔除，此处只保留次数。
  const pauseCount = (seps) => seps.filter((g) => g.kind === 'pause').length;
  // CR-09（需求⑧ + ⑬）：备注归段 = 段 started_at ≤ ts 中最末一段（同秒冲突归后段；距末段之后归末段）
  const ownerOf = (seps, ts) => {
    let pick = seps[0] || null;
    for (const g of seps) if (g.started_at <= ts) pick = g;
    return pick;
  };
  // CR-09（需求⑬）：导出时间轴**只输出暂停段**（去掉「计时」行）；无暂停 → 留空
  const timelineText = (sid, sepsIn) => {
    const all = sepsIn || segStmt.all(sid);
    const seps = all.filter((g) => g.kind === 'pause');
    if (!seps.length) return '';
    const rems = remStmt.all(sid);
    return seps
      .map((g) => {
        const notes = rems.filter((x) => ownerOf(all, x.ts) === g).map((x) => x.content);
        const span = `${hhmm(g.started_at)}–${g.ended_at ? hhmm(g.ended_at) : '进行中'}`;
        return `${span} 暂停：${notes.length ? notes.join('；') : '未填'}`;
      })
      .join('\n');
  };
  return rows.map((r) => {
    const seps = segStmt.all(r.id);
    return [
      r.org_name ?? '',
      r.supplier_name ?? '',
      r.vin ?? '',
      r.work_order_no ?? '',
      (r.start_at || '').slice(0, 16),
      (r.end_at || '').slice(0, 16),
      r.initiator_name ?? '',
      r.operator_name ?? '',
      // 主人令（2026-10-09）：行驶里程 = 收车里程 − 出车里程（缺任一则留空）
      r.odometer_out != null && r.odometer_in != null
        ? Number(r.odometer_in) - Number(r.odometer_out)
        : '',
      fmtDuration(r.net_seconds),
      (Number(r.net_seconds || 0) / 3600).toFixed(2), // 主人令（2026-10-08）：有效计费时长（h）
      fmtDuration(r.pause_seconds),
      statusText[r.status] || r.status,
      r.schedule_note ?? '',
      pauseCount(seps) || '',
      // 主人令（2026-10-07）：暂停开始/结束时间两列已剔除，暂停时刻仍见时间轴
      timelineText(r.id, seps),
    ];
  });
}

function aoaToCsv(aoa) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = aoa.map((row) => row.map(esc).join(',')).join('\r\n');
  return '\ufeff' + body + '\r\n';
}

function aoaToXlsx(aoa, sheetName, { wrapCol } = {}) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = aoa[0].map((c, i) => ({ wch: i === wrapCol ? 52 : Math.max(12, String(c).length * 2 + 4) }));
  if (wrapCol != null) {
    // CR-09（需求⑧）：时间轴列自动换行，并按行数设置行高
    ws['!rows'] = aoa.map((row, ri) => {
      if (ri === 0) return null;
      const lines = String(row[wrapCol] ?? '').split('\n').length;
      return lines > 1 ? { hpt: 16 * lines } : null;
    });
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = 1; R <= range.e.r; R++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: wrapCol });
      if (ws[addr]) ws[addr].s = { alignment: { wrapText: true, vertical: 'top' } };
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function toDetailAoa(db, filters) {
  return [DETAIL_COLUMNS, ...detailRows(db, filters)];
}

export function toDetailXlsxBuffer(db, filters) {
  return aoaToXlsx(toDetailAoa(db, filters), '详细工时', {
    wrapCol: DETAIL_COLUMNS.length - 1,
  });
}

export function toDetailCsvString(db, filters) {
  return aoaToCsv(toDetailAoa(db, filters));
}
