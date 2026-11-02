// 导入支持 Excel(.xlsx)：统一解析工具 + 三处导入端到端。
//  - §1 工具单测（CSV 回落 / xlsx 解析 / 魔数识别 / 请求读取）——恒绿。
//  - §2 集成：车架号 / 安全员 / 排班 三处 /import 上传 .xlsx —— tech 接线后生效（未接线自动 skip）。
// 红线：模板列口径不变、导出 11 列（export.js）不动、timer_session 字段不动。
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import XLSX from 'xlsx';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { parseSpreadsheet, parseExcel, isExcelName, readUploadRows } from '../lib/spreadsheet.js';

const PAX = 'xlsx-pass';

/** 用 SheetJS 在内存生成 .xlsx Buffer（不落盘）。 */
function xlsxBuf(aoa, sheet = 'Sheet1') {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe('spreadsheet 工具（CSV + Excel 统一解析）', () => {
  it('isExcelName 识别 .xlsx/.xls（大小写不敏感），CSV 不算', () => {
    expect(isExcelName('a.xlsx')).toBe(true);
    expect(isExcelName('a.XLS')).toBe(true);
    expect(isExcelName('a.csv')).toBe(false);
    expect(isExcelName('')).toBe(false);
  });

  it('CSV 回落：parseSpreadsheet 文本走 parseCsv，输出同形二维数组', () => {
    expect(parseSpreadsheet('name,label\n张伟,安全员A\n')).toEqual([
      ['name', 'label'],
      ['张伟', '安全员A'],
    ]);
  });

  it('xlsx：二维数组行、值统一转字符串、全空行丢弃', () => {
    const buf = xlsxBuf([
      ['vin', 'station'],
      ['LSVAB1234K5678901', '工位A'],
      ['', ''],
      [12345, '工位B'],
    ]);
    const rows = parseExcel(buf);
    expect(rows[0]).toEqual(['vin', 'station']);
    expect(rows[1]).toEqual(['LSVAB1234K5678901', '工位A']);
    expect(rows[2]).toEqual(['12345', '工位B']); // 数字 → 字符串，长数字不丢精度
    expect(rows).toHaveLength(3); // 空行被丢弃
  });

  it('无扩展名时按 ZIP 魔数(PK\\x03\\x04) 自动识别为 Excel', () => {
    const buf = xlsxBuf([['a'], ['1']]);
    expect(parseSpreadsheet(buf, '')).toEqual([['a'], ['1']]);
  });

  it('损坏的 Excel（zip 魔数但内容非法）→ 抛校验错误（不静默）', () => {
    const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('garbage-not-a-real-zip')]);
    expect(() => parseExcel(broken)).toThrow();
  });

  it('二进制误传（非 xlsx 的二进制）→ 抛校验错误，绝不静默当 CSV', () => {
    const bin = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]), Buffer.from('EOF')]);
    expect(() => parseSpreadsheet(bin, 'report.pdf')).toThrow();
    expect(() => parseSpreadsheet(bin, '')).toThrow();
  });

  it('Excel 另存为的 GBK/ANSI CSV → 正常解析（中文用户高频路径）', () => {
    // "车架号,工位" 的 GBK 字节（b3b5 bcdc bac5 2c b9a4 ce bb）
    const gbk = Buffer.concat([
      Buffer.from([0xb3, 0xb5, 0xbc, 0xdc, 0xba, 0xc5, 0x2c, 0xb9, 0xa4, 0xce, 0xbb]),
      Buffer.from('\nLSVAB1234K5678901,A\n', 'utf8'),
    ]);
    expect(parseSpreadsheet(gbk, 'gbk.csv')).toEqual([
      ['车架号', '工位'],
      ['LSVAB1234K5678901', 'A'],
    ]);
    // 不含中文的非法 UTF-8 → 仍按二进制拒绝（防止 pdf/图片 蒙混过关）
    expect(() => parseSpreadsheet(Buffer.from([0x80, 0x81, 0x82, 0x83, 0x0a]), 'x.csv')).toThrow();
  });

  it('readUploadRows：multipart(file) / body.csv / 缺文件三种情形', () => {
    const buf = xlsxBuf([['vin'], ['V1']]);
    expect(readUploadRows({ file: { buffer: buf, originalname: 'v.xlsx' } })).toEqual([['vin'], ['V1']]);
    expect(readUploadRows({ body: { csv: 'a,b\n1,2' } })).toEqual([['a', 'b'], ['1', '2']]);
    expect(() => readUploadRows({ body: {} })).toThrow();
  });
});

describe('三处导入支持 .xlsx（集成；tech 接线后生效）', () => {
  let wired;

  beforeAll(async () => {
    const db = openDb(':memory:');
    const app = createApp({ db, adminPassword: PAX });
    const l = await request(app).post('/api/admin/login').send({ password: PAX });
    const token = l.body.data.token;
    const buf = xlsxBuf([['vin', 'station'], ['LSVWRED0000000001', '工位X']]);
    const r = await request(app)
      .post('/api/admin/vehicles/import')
      .set(bearer(token))
      .attach('file', buf, 'vehicles.xlsx');
    wired =
      r.status === 201 &&
      !!db.prepare("SELECT 1 FROM vehicle WHERE vin='LSVWRED0000000001'").get();
    db.close();
  });

  let db;
  let app;
  let token;
  beforeEach(async () => {
    db = openDb(':memory:');
    app = createApp({ db, adminPassword: PAX });
    const l = await request(app).post('/api/admin/login').send({ password: PAX });
    token = l.body.data.token;
  });

  it('① 车架号导入 .xlsx（带表头）', async (ctx) => {
    if (!wired) return ctx.skip();
    const buf = xlsxBuf([
      ['vin', 'station'],
      ['LSVAB1234K5678901', '工位A'],
      ['LSVAB1234K5678902', '工位B'],
    ]);
    const r = await request(app)
      .post('/api/admin/vehicles/import')
      .set(bearer(token))
      .attach('file', buf, 'vehicles.xlsx');
    expect(r.status).toBe(201);
    expect(r.body.data.inserted).toBe(2);
    expect(db.prepare("SELECT station FROM vehicle WHERE vin='LSVAB1234K5678901'").get().station).toBe('工位A');
  });

  it('② 安全员导入 .xlsx（带表头）', async (ctx) => {
    if (!wired) return ctx.skip();
    const buf = xlsxBuf([
      ['name', 'label'],
      ['张伟', '安全员A'],
      ['李强', '安全员B'],
    ]);
    const r = await request(app)
      .post('/api/admin/operators/import')
      .set(bearer(token))
      .attach('file', buf, 'operators.xlsx');
    expect(r.status).toBe(201);
    expect(r.body.data.inserted).toBe(2);
    expect(db.prepare("SELECT label FROM operator WHERE name='张伟'").get().label).toBe('安全员A');
  });

  it('③ 排班导入 .xlsx（日期,班次,安全员,车架号）', async (ctx) => {
    if (!wired) return ctx.skip();
    const opId = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('张伟','安全员A',10)").run().lastInsertRowid);
    db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES('LSVAB1234K5678901','工位A',1)").run();
    const buf = xlsxBuf([
      ['日期', '班次', '安全员', '车架号'],
      ['2026-09-30', '白班', '张伟', 'LSVAB1234K5678901'],
    ]);
    const r = await request(app)
      .post('/api/admin/schedules/import')
      .set(bearer(token))
      .attach('file', buf, 'schedules.xlsx');
    expect(r.status).toBe(201);
    expect(r.body.data.inserted).toBe(1);
    const row = db.prepare("SELECT operator_id, status FROM schedule WHERE work_date='2026-09-30'").get();
    expect(row.operator_id).toBe(opId);
    expect(row.status).toBe('planned');
  });

  it('④ CSV 回归：同一端点仍接受 .csv（行为不变）', async (ctx) => {
    if (!wired) return ctx.skip();
    const r = await request(app)
      .post('/api/admin/vehicles/import')
      .set(bearer(token))
      .attach('file', Buffer.from('vin,station\nLSVAB1234K5678909,工位Z\n', 'utf8'), 'vehicles.csv');
    expect(r.status).toBe(201);
    expect(r.body.data.inserted).toBe(1);
  });

  it('⑤ 脏数据闸门：二进制误传 → 400 且零落库（2026-09-29 事故回归）', async (ctx) => {
    if (!wired) return ctx.skip();
    const bin = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00]), Buffer.from([0x00, 0x01, 0x00, 0x02]), Buffer.from('xlsx-as-csv-garbage')]);
    // 伪装：扩展名不是 excel、也不是合法 zip → 走 CSV 分支 → 触发二进制闸门
    const r = await request(app)
      .post('/api/admin/vehicles/import')
      .set(bearer(token))
      .attach('file', bin, 'dirty.dat');
    expect(r.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM vehicle').get().c).toBe(0);
  });
});

// 字典域（组织/供应商/发起人）走同一个 dictRouter /import handler
// （dicts.js:108）——接线一处即全支持。
describe('字典/发起人 导入支持 .xlsx（集成；tech 接线后生效）', () => {
  let wired;

  beforeAll(async () => {
    const db = openDb(':memory:');
    const app = createApp({ db, adminPassword: PAX });
    const l = await request(app).post('/api/admin/login').send({ password: PAX });
    const token = l.body.data.token;
    const buf = xlsxBuf([['name', 'code'], ['WIREDCHK组织', 'CHK1']]);
    const r = await request(app)
      .post('/api/admin/organizations/import')
      .set(bearer(token))
      .attach('file', buf, 'orgs.xlsx');
    wired = r.status === 201 && !!db.prepare("SELECT 1 FROM organization WHERE name='WIREDCHK组织'").get();
    db.close();
  });

  let app;
  let token;
  beforeEach(async () => {
    const db = openDb(':memory:');
    app = createApp({ db, adminPassword: PAX });
    const l = await request(app).post('/api/admin/login').send({ password: PAX });
    token = l.body.data.token;
  });

  it('组织导入 .xlsx（名称,编码,排序）', async (ctx) => {
    if (!wired) return ctx.skip();
    const buf = xlsxBuf([['名称', '编码', '排序'], ['分公司A', 'ORG-A', 1], ['分公司B', 'ORG-B', 2]]);
    const r = await request(app)
      .post('/api/admin/organizations/import')
      .set(bearer(token))
      .attach('file', buf, 'orgs.xlsx');
    expect(r.status).toBe(201);
    expect(r.body.data.inserted).toBe(2);
  });

  it('供应商导入 .xlsx', async (ctx) => {
    if (!wired) return ctx.skip();
    const buf = xlsxBuf([['名称', '编码', '排序'], ['供应商甲', 'SUP-1', 1]]);
    const r = await request(app)
      .post('/api/admin/suppliers/import')
      .set(bearer(token))
      .attach('file', buf, 'suppliers.xlsx');
    expect(r.status).toBe(201);
    expect(r.body.data.inserted).toBe(1);
  });

  it('发起人导入 .xlsx', async (ctx) => {
    if (!wired) return ctx.skip();
    const buf = xlsxBuf([['姓名', '部门', '排序'], ['赵六', '一车间', 1]]);
    const r = await request(app)
      .post('/api/admin/initiators/import')
      .set(bearer(token))
      .attach('file', buf, 'initiators.xlsx');
    expect(r.status).toBe(201);
    expect(r.body.data.inserted).toBe(1);
  });
});

// 单一实现对齐（2026-09-29 18:04 虾米在 202 直改 import-file.js 后的口径合并）：
// .xls（OLE2 魔数）识别、无扩展名兜底、缺文件文案与「支持 CSV / Excel」一致。
describe('spreadsheet 工具：.xls(.xlsm) 与魔数兜底（合并虾米版口径）', () => {
  const aoa = [['vin', 'station'], ['LSVAB1234K5678901', '工位A']];
  const xlsBuf = () => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'S');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
  };
  it('.xls 名（OLE2）可解析', () => {
    const rows = parseSpreadsheet(xlsBuf(), 'vehicles.xls');
    expect(rows[1][0]).toBe('LSVAB1234K5678901');
  });
  it('无扩展名但 OLE2 魔数 → 仍识别为 Excel', () => {
    const buf = xlsBuf();
    expect(buf.subarray(0, 4).toString('hex')).toBe('d0cf11e0');
    const rows = parseSpreadsheet(buf, '');
    expect(rows[1][1]).toBe('工位A');
  });
  it('isExcelName 覆盖 .xlsx/.xlsm/.xls（大小写不敏感）', () => {
    expect(isExcelName('a.XLSX')).toBe(true);
    expect(isExcelName('a.xlsm')).toBe(true);
    expect(isExcelName('a.XLS')).toBe(true);
    expect(isExcelName('a.csv')).toBe(false);
  });
  it('缺文件报错文案含「支持 CSV / Excel」', () => {
    expect(() => readUploadRows({ body: {} })).toThrow(/支持 CSV \/ Excel/);
  });
});
