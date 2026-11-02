// 车架号导入口的 VIN 校验（主人/CEO 2026-09-29 加固②）
// 口径：17 位字母数字、仅大写（容忍小写粘贴，自动转大写）、字母不含 I/O/Q；
//      不合法 → 跳过 + 计入 errors，**禁止落库**（2026-09-29 乱码事故治本）
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import XLSX from 'xlsx';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { isValidVin, normalizeVin, VIN_HINT } from '../lib/vin.js';

const PAX = 'test-pw-123456';
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
function xlsxBuf(aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('VIN 校验工具', () => {
  it('合法：17 位字母数字、无 I/O/Q', () => {
    expect(isValidVin('LSVAB1234K5678901')).toBe(true);
    expect(isValidVin('lsvab1234k5678901')).toBe(true); // 小写容忍，自动大写
  });
  it('非法：长度不符 / 含 I,O,Q / 含符号或空格', () => {
    expect(isValidVin('LSVAB1234K567890')).toBe(false); // 16
    expect(isValidVin('LSVAB1234K56789012')).toBe(false); // 18
    expect(isValidVin('LSVIB1234K5678901')).toBe(false); // I
    expect(isValidVin('LSVOB1234K5678901')).toBe(false); // O
    expect(isValidVin('LSVQB1234K5678901')).toBe(false); // Q
    expect(isValidVin('LSV-B1234K5678901')).toBe(false);
    expect(isValidVin('')).toBe(false);
    expect(isValidVin(null)).toBe(false);
  });
  it('归一化：去空白 + 大写', () => {
    expect(normalizeVin('  lsvab1234k5678901 ')).toBe('LSVAB1234K5678901');
  });
});

describe('车辆导入：VIN 闸门（不合法不落库）', () => {
  let db;
  let app;
  let token;
  beforeAll(() => {
    // 断言口径文案与 lib 一致
    expect(VIN_HINT).toContain('17');
  });
  beforeEach(async () => {
    db = openDb(':memory:');
    app = createApp({ db, adminPassword: PAX });
    const l = await request(app).post('/api/admin/login').send({ password: PAX });
    token = l.body.data.token;
  });

  it('混合数据：合法入库，非法跳过并计入 errors，库里只有合法的', async () => {
    const buf = xlsxBuf([
      ['车架号', '工位'],
      ['LSVAB1234K5678901', '工位A'], // 合法
      ['LSVAB1234K567890', '工位B'], // 16 位 → 跳过
      ['LSVIB1234K5678901', '工位C'], // 含 I → 跳过
      ['LSVQB1234K5678901', '工位D'], // 含 Q → 跳过
      ['PK\u0003\u0004乱码', '工位E'], // 乱码 → 跳过
      ['', '工位F'], // 空 → 跳过
      ['lsvab1234k5678902', '工位G'], // 小写合法 → 归一化入库
    ]);
    const r = await request(app)
      .post('/api/admin/vehicles/import')
      .set(bearer(token))
      .attach('file', buf, 'vehicles.xlsx');

    expect(r.status).toBe(201);
    expect(r.body.data.inserted).toBe(2);
    expect(r.body.data.skipped).toBe(5);
    expect(r.body.data.errors.length).toBe(5);
    expect(r.body.data.errors[0].reason).toContain('17');

    const vins = db.prepare('SELECT vin FROM vehicle ORDER BY vin').all().map((x) => x.vin);
    expect(vins).toEqual(['LSVAB1234K5678901', 'LSVAB1234K5678902']);
    expect(db.prepare('SELECT COUNT(*) c FROM vehicle').get().c).toBe(2);
  });

  it('CSV 路径同样生效（口径一致）', async () => {
    const csv = '车架号,工位\nLSVAB1234K5678901,工位A\nBADVIN,工位B\n';
    const r = await request(app)
      .post('/api/admin/vehicles/import')
      .set(bearer(token))
      .attach('file', Buffer.from(csv, 'utf8'), 'vehicles.csv');
    expect(r.status).toBe(201);
    expect(r.body.data.inserted).toBe(1);
    expect(r.body.data.skipped).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM vehicle').get().c).toBe(1);
  });
});
