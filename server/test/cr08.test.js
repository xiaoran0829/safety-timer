// CR-08（老板 7 条需求 · 批1）：③导出排班备注快照 / ⑥详细工时(含备注) / ①批量开号 + 导入自动开号。
// 红线：不碰现网；本用例仅内存库。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { startSession, stopSession, addRemark } from '../services/timer.js';
import { verifyPasswordHash } from '../middleware/auth.js';
import { fmtDay } from '../lib/time.js';
import { EXPORT_COLUMNS, DETAIL_COLUMNS, buildMatrix, toDetailAoa, toDetailCsvString, toDetailXlsxBuffer } from '../services/export.js';
import XLSX from 'xlsx';

const PAX = 'cr08-pass';
const D = fmtDay(); // 今天（startSession 按当天匹配排班）
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let db;
let app;
let token;
let opId;
let vId;
let shiftAll;

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: PAX });
  opId = Number(
    db.prepare("INSERT INTO operator(name,label,sort,employee_no) VALUES('张伟','安全员A',10,'A123456')").run()
      .lastInsertRowid
  );
  vId = Number(
    db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES('LSVAB1234K5678901','工位A',1)").run().lastInsertRowid
  );
  const l = await request(app).post('/api/admin/login').send({ password: PAX });
  token = l.body.data.token;
  // 用「全天」班次（00:00–23:59）以免受当前时刻影响（批2 #2 时间窗：开始早于班次开始会被拦）
  shiftAll = Number(
    db.prepare("INSERT INTO shift(name,start_time,end_time,sort,active) VALUES('全天','00:00','23:59',90,1)").run()
      .lastInsertRowid
  );
});

afterEach(() => {
  delete process.env.SCHEDULE_ENFORCE;
});

function schedule(note, createdBy = 'admin') {
  return Number(
    db
      .prepare(
        "INSERT INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,note,created_by) VALUES(?,?,?,?,'planned',?,?)"
      )
      .run(D, shiftAll, opId, vId, note, createdBy).lastInsertRowid
  );
}

describe('③ 排班备注快照 + 导出第12列', () => {
  it('开始计时快照排班备注；导出第12列带出', () => {
    schedule('配合吊装作业，注意安全');
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    expect(session.scheduleNote).toBe('配合吊装作业，注意安全');
    stopSession(db, session.id, opId);
    const m = buildMatrix(db, {});
    expect(m[0]).toEqual(EXPORT_COLUMNS);
    expect(m[0]).toHaveLength(13);
    expect(m[0][12]).toBe('排班备注');
    expect(m[1][12]).toBe('配合吊装作业，注意安全');
  });

  it('无排班时第12列为空（不误填）', () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    expect(session.scheduleNote).toBeNull();
    stopSession(db, session.id, opId);
    expect(buildMatrix(db, {})[1][12]).toBe('');
  });
});

describe('⑥ 详细工时（含备注）查看/导出', () => {
  it('列表含排班备注 + 计时备注（多条拼接）', async () => {
    schedule('排班备注X');
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    addRemark(db, session.id, opId, '暂停吊装');
    addRemark(db, session.id, opId, '已恢复');
    stopSession(db, session.id, opId);

    const res = await request(app).get('/api/admin/sessions/detail').set(bearer(token));
    expect(res.status).toBe(200);
    const row = res.body.data.list.find((x) => x.id === session.id);
    expect(row).toBeTruthy();
    expect(row.scheduleNote).toBe('排班备注X');
    expect(row.remarks.map((r) => r.content)).toEqual(['暂停吊装', '已恢复']);
    expect(row.remarkText).toBe('暂停吊装 / 已恢复');
  });

  it('详细工时导出列含 排班备注/暂停时间轴，且带出内容（⑬：计时段备注不入导出）', async () => {
    schedule('导出备注Y');
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    addRemark(db, session.id, opId, '现场备注Z');
    stopSession(db, session.id, opId);

    expect(DETAIL_COLUMNS).toContain('排班备注');
    expect(DETAIL_COLUMNS).toContain('详细工时（时间轴）');
    expect(DETAIL_COLUMNS).toContain('暂停次数');
    // 主人令 2026-10-07（剔除 N/O 列）：暂停开始/结束时间已从导出移除
    expect(DETAIL_COLUMNS).not.toContain('暂停开始时间');
    expect(DETAIL_COLUMNS).not.toContain('暂停结束时间');
    expect(DETAIL_COLUMNS[DETAIL_COLUMNS.length - 1]).toBe('详细工时（时间轴）');
    const csv = toDetailCsvString(db, {});
    expect(csv).toContain('排班备注');
    expect(csv).toContain('导出备注Y');
    // ⑬：本会话无暂停 → 时间轴列留空，且计时段备注不再入导出
    expect(csv).not.toContain('现场备注Z');
    expect(csv).not.toContain('计时：');

    const res = await request(app).get('/api/admin/export/detail?format=csv').set(bearer(token));
    expect(res.status).toBe(200);
    expect(String(res.text)).toContain('导出备注Y');
  });

  it('查看页含全部状态（进行中/暂停），与导出一致（收口2）', async () => {
    schedule('状态备注');
    // 进行中
    const { session: sRun } = startSession(db, { operatorId: opId, vehicleId: vId });
    // 另一辆车 + 另一安全员：暂停态（同一安全员不能同时开两车）
    const op2 = Number(db.prepare("INSERT INTO operator(name,label,sort,employee_no) VALUES('李强','安全员B',20,'B654321')").run().lastInsertRowid);
    const v2 = Number(db.prepare("INSERT INTO vehicle(vin,station) VALUES('LSVAB1234K5678902','工位B')").run().lastInsertRowid);
    db.prepare("INSERT INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,note,created_by) VALUES(?,?,?,?,'planned',?,?)").run(
      D, shiftAll, op2, v2, '暂停备注', 'admin'
    );
    const { session: sPause } = startSession(db, { operatorId: op2, vehicleId: v2 });
    db.prepare("UPDATE timer_session SET status='paused' WHERE id=?").run(sPause.id);

    const res = await request(app).get('/api/admin/sessions/detail').set(bearer(token));
    expect(res.status).toBe(200);
    const run = res.body.data.list.find((x) => x.id === sRun.id);
    const pause = res.body.data.list.find((x) => x.id === sPause.id);
    expect(run?.status).toBe('running');
    expect(pause?.status).toBe('paused');
    expect(DETAIL_COLUMNS).toContain('状态');
  });

  it('详细工时 xlsx：可被 SheetJS 回读，表头=DETAIL_COLUMNS 且状态列有值（收口4）', async () => {
    schedule('xlsx备注');
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    addRemark(db, session.id, opId, '二进制备注');
    stopSession(db, session.id, opId);

    const buf = toDetailXlsxBuffer(db, {});
    expect(Buffer.isBuffer(buf)).toBe(true);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 });
    expect(aoa[0]).toEqual(DETAIL_COLUMNS);
    expect(aoa[0]).toContain('状态');
    const row = aoa.find((r) => r[2] === 'LSVAB1234K5678901');
    expect(row).toBeTruthy();
    expect(aoa[0][8]).toBe('行驶里程（km）'); // 2026-10-09 新增：行驶里程列
    expect(row[12]).toBe('已结束'); // 状态列（中文化）——2026-10-09 行驶里程列插入后 +1
    // ⑪ 暂停列（在时间轴列之前）；主人令 2026-10-07：暂停开始/结束时间两列已剔除
    expect(aoa[0][14]).toBe('暂停次数');
    expect(aoa[0]).not.toContain('暂停开始时间');
    expect(aoa[0]).not.toContain('暂停结束时间');
    // ⑬ 时间轴列（末列）：只输出暂停行；本会话无暂停 → 留空
    expect(row[15]).toBe('');
  });

  it('详细工时：新增「行驶里程（km）」= 收车里程 − 出车里程（主人令 2026-10-09）', async () => {
    schedule('里程');
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId, odometerOut: 1000 });
    stopSession(db, session.id, opId, { admin: true, odometerIn: 1123 });
    const aoa = toDetailAoa(db, { operatorId: opId });
    expect(aoa[0][8]).toBe('行驶里程（km）');
    const row = aoa.find((r) => r[2] === 'LSVAB1234K5678901');
    expect(row).toBeTruthy();
    expect(row[8]).toBe(123);
  });
});

describe('① 批量开号 + 导入自动开号', () => {
  it('批量开号：账号=工号，默认口令=工号后6位，首登强制改密；缺工号跳过', async () => {
    const op2 = Number(
      db.prepare("INSERT INTO operator(name,label,sort,employee_no) VALUES('李四','安全员B',20,'B654321')").run()
        .lastInsertRowid
    );
    const op3 = Number(
      db.prepare("INSERT INTO operator(name,label,sort) VALUES('王五','安全员C',30)").run().lastInsertRowid
    );
    const res = await request(app).post('/api/admin/operators/accounts/batch').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.created).toBe(2);
    expect(res.body.data.skipped).toBe(1);

    const a = db.prepare('SELECT * FROM operator WHERE id=?').get(opId);
    expect(a.username).toBe('A123456');
    expect(Number(a.must_change_pwd)).toBe(1);
    expect(verifyPasswordHash('123456', a.pwd_hash, a.pwd_salt)).toBe(true); // 'A123456' 后6位

    const b = db.prepare('SELECT * FROM operator WHERE id=?').get(op2);
    expect(b.username).toBe('B654321');
    expect(verifyPasswordHash('654321', b.pwd_hash, b.pwd_salt)).toBe(true); // 'B654321' 后6位

    const c = db.prepare('SELECT * FROM operator WHERE id=?').get(op3);
    expect(c.username).toBeNull(); // 缺工号未开号
  });

  it('导入后自动开号（有工号即开）', async () => {
    const csv = ['姓名,工号', '赵六,C111222', '钱七,'].join('\r\n');
    const res = await request(app)
      .post('/api/admin/operators/import')
      .set(bearer(token))
      .attach('file', Buffer.from('\ufeff' + csv, 'utf8'), { filename: 'ops.csv', contentType: 'text/csv' });
    expect(res.status).toBe(201);
    expect(res.body.data.inserted).toBe(2);
    expect(res.body.data.accountsOpened).toBe(1);

    const zhao = db.prepare("SELECT * FROM operator WHERE name='赵六'").get();
    expect(zhao.username).toBe('C111222');
    expect(verifyPasswordHash('111222', zhao.pwd_hash, zhao.pwd_salt)).toBe(true);
    const qian = db.prepare("SELECT * FROM operator WHERE name='钱七'").get();
    expect(qian.username).toBeNull();
  });
});
