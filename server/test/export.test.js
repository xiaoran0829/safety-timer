import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../db.js';
import { startSession, stopSession } from '../services/timer.js';
import { EXPORT_COLUMNS, buildMatrix, toCsvString, exportFileName, toXlsxBuffer } from '../services/export.js';
import XLSX from 'xlsx';

let db;
let opId;
let vId;

beforeEach(() => {
  db = openDb(':memory:');
  opId = Number(db.prepare("INSERT INTO operator(name,label) VALUES('张伟','安全员A')").run().lastInsertRowid);
  vId = Number(db.prepare("INSERT INTO vehicle(vin,station,org,supplier) VALUES('LSVAB1234K5678901','工位A','某厂','某供应商')").run().lastInsertRowid);
});

function makeStoppedWithNet(net) {
  const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
  db.prepare('UPDATE timer_session SET start_at=? WHERE id=?').run('2026-09-29 09:00:00', session.id);
  db.prepare('DELETE FROM timer_segment WHERE session_id=?').run(session.id);
  db.prepare('INSERT INTO timer_segment(session_id,kind,started_at,ended_at,seconds) VALUES(?,?,?,?,?)').run(
    session.id, 'work', '2026-09-29 09:00:00', '2026-09-29 09:00:00', net
  );
  return stopSession(db, session.id, opId).session;
}

describe('导出列（冻结规格 §6，顺序不可变）', () => {
  it('13 列表头严格定序（2026-10-08：试验实际时长后插有效计费时长；CR-08 排班备注仍末尾）', () => {
    expect(EXPORT_COLUMNS).toEqual([
      '组织', '供应商', '车架号', '工单号', '试验开始时间', '发起人', '安全员', '实验总里程', '试验实际时长', '有效计费时长（h）', '总计费时长', '不计费时长', '排班备注',
    ]);
    const m = buildMatrix(db, {});
    expect(m[0]).toEqual(EXPORT_COLUMNS);
  });

  it('系统列填值；无字典挂靠时 组织/供应商/发起人为空，里程/计费留空（CR-01 快照）', () => {
    makeStoppedWithNet(3661); // 01:01:01
    const m = buildMatrix(db, {});
    const row = m[1];
    expect(row).toHaveLength(13);
    expect(row[0]).toBe(''); // 组织（快照为空）
    expect(row[1]).toBe(''); // 供应商（快照为空）
    expect(row[2]).toBe('LSVAB1234K5678901');
    expect(row[3]).toMatch(/^WO-\d{8}-001$/);
    expect(row[4]).toBe('2026-09-29 09:00'); // 到分钟
    expect(row[5]).toBe(''); // 发起人（快照为空）
    expect(row[6]).toBe('张伟');
    expect(row[7]).toBe(''); // 里程
    expect(row[8]).toBe('01:01:01');
    expect(row[9]).toBe('1.02'); // 有效计费时长（h）= 3661/3600
    expect(row[10]).toBe(''); // 总计费
    expect(row[11]).toBe(''); // 不计费
    expect(row[12]).toBe(''); // 排班备注（无排班时为空）
  });

  it('仅导出已停止会话（进行中不计入正式报表）', () => {
    startSession(db, { operatorId: opId, vehicleId: vId }); // 进行中
    const m = buildMatrix(db, {});
    expect(m).toHaveLength(1); // 仅表头
  });

  it('CSV：UTF-8 带 BOM，逗号转义', () => {
    makeStoppedWithNet(60);
    const csv = toCsvString(db, {});
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('LSVAB1234K5678901');
    expect(csv.split('\r\n')[0]).toContain('组织,供应商,车架号');
  });

  it('文件名：安全员计时_YYYYMMDD.ext', () => {
    expect(exportFileName({ date: '2026-09-29' }, 'xlsx')).toBe('安全员计时_20260929.xlsx');
    expect(exportFileName({ date: '2026-09-29' }, 'csv')).toBe('安全员计时_20260929.csv');
  });

  it('xlsx：可被 SheetJS 回读，表头一致', () => {
    makeStoppedWithNet(125);
    const buf = toXlsxBuffer(db, {});
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 });
    expect(aoa[0]).toEqual(EXPORT_COLUMNS);
    expect(aoa[1][8]).toBe('00:02:05');
    expect(aoa[1][9]).toBe('0.03'); // 有效计费时长（h）= 125/3600
  });
});
