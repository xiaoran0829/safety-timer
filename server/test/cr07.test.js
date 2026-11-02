// CR-07 排班域验收：shift 字典 / schedule 指派（批量/复制/导入/看板）/ H5 草案 / 起点口径 B（开关）。
// 口径锁定：允许多车（无「一人一派」约束）；唯一约束=同日期同班次一车一派；shift_id 可空。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { startSession } from '../services/timer.js';
import { hashPassword } from '../middleware/auth.js';
import { ensureScheduleSchema } from '../migrations/schedule.js';
import Database from 'better-sqlite3';

const PAX = 'cr07-pass';
const D1 = '2026-09-30';
const D2 = '2026-10-01';

let db;
let app;
let token;
let opId; // 张伟
let op2; // 李强
let vId; // 车1
let v2; // 车2
let shiftDay;
let shiftNight;

const bearer = (t = token) => ({ Authorization: `Bearer ${t}` });

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: PAX });
  opId = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('张伟','安全员A',10)").run().lastInsertRowid);
  op2 = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('李强','安全员B',20)").run().lastInsertRowid);
  // CR-06：给安全员开通 H5 账号（口令仅存派生值+盐）
  const cred = (id, username, pwd) => {
    const { hash, salt } = hashPassword(pwd);
    db.prepare(
      "UPDATE operator SET username=?, pwd_hash=?, pwd_salt=?, pwd_ver=0, must_change_pwd=0, employed=1 WHERE id=?"
    ).run(username, hash, salt, id);
  };
  cred(opId, 'zhangwei', 'op1234');
  cred(op2, 'liqiang', 'op1234');
  vId = Number(db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES('LSVAB1234K5678901','工位A',1)").run().lastInsertRowid);
  v2 = Number(db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES('LSVAB1234K5678902','工位B',2)").run().lastInsertRowid);
  const l = await request(app).post('/api/admin/login').send({ password: PAX });
  token = l.body.data.token;
  shiftDay = Number(db.prepare("SELECT id FROM shift WHERE name='白班'").get().id);
  shiftNight = Number(db.prepare("SELECT id FROM shift WHERE name='夜班'").get().id);
});

afterEach(() => {
  delete process.env.SCHEDULE_ENFORCE;
});

describe('CR-07 §1 表与默认班次', () => {
  it('shift/schedule/schedule_override 建表，默认白/夜班幂等存在', () => {
    const names = db.prepare('SELECT name FROM shift ORDER BY sort').all().map((r) => r.name);
    expect(names).toEqual(['白班', '夜班']);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schedule'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schedule_override'").get()).toBeTruthy();
    // 拆列字段：updated_by（最后修改人）存在于表结构
    const cols = db.prepare('PRAGMA table_info(schedule)').all().map((c) => c.name);
    expect(cols).toContain('created_by');
    expect(cols).toContain('updated_by');
  });

  it('老库幂等补列：缺 updated_by 的存量库经 ensureScheduleSchema 自动 ALTER 补上（可重复调用）', () => {
    const legacy = new Database(':memory:'); // 裸库，不跑迁移，模拟改造前结构
    legacy.exec(`CREATE TABLE schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT, work_date TEXT NOT NULL, shift_id INTEGER, operator_id INTEGER NOT NULL,
      vehicle_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'planned', note TEXT, created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours')), updated_at TEXT
    );`);
    expect(legacy.prepare('PRAGMA table_info(schedule)').all().map((c) => c.name)).not.toContain('updated_by');
    ensureScheduleSchema(legacy);
    expect(legacy.prepare('PRAGMA table_info(schedule)').all().map((c) => c.name)).toContain('updated_by');
    ensureScheduleSchema(legacy); // 幂等：重复调用不报错
    expect(legacy.prepare('PRAGMA table_info(schedule)').all().map((c) => c.name)).toContain('updated_by');
  });

  it('唯一索引仅保留「一车一派」，**无**「一人一派」约束', () => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='ux_sched_veh'").get().sql;
    expect(sql).toMatch(/work_date/);
    expect(sql).toMatch(/vehicle_id/);
    const all = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='schedule'").all().map((r) => r.name);
    expect(all).not.toContain('ux_sched_op'); // 主人口径：允许一人多车/多班
  });
});

describe('CR-07 §2 班次字典 CRUD', () => {
  it('增/改/软删 + 未登录 401 + 同名 409', async () => {
    expect((await request(app).get('/api/admin/shifts')).status).toBe(401);
    const c = await request(app).post('/api/admin/shifts').set(bearer()).send({ name: '中班', startTime: '12:00', endTime: '20:00', sort: 30 });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ name: '中班', startTime: '12:00', endTime: '20:00', active: 1 });

    const dup = await request(app).post('/api/admin/shifts').set(bearer()).send({ name: '中班', startTime: '12:00', endTime: '20:00' });
    expect(dup.status).toBe(409);
    // CR-08 批2 #2：班次开始/结束时间必填
    const missTimes = await request(app).post('/api/admin/shifts').set(bearer()).send({ name: '晚班' });
    expect(missTimes.status).toBe(400);

    const up = await request(app).put(`/api/admin/shifts/${c.body.data.id}`).set(bearer()).send({ endTime: '21:00' });
    expect(up.body.data.endTime).toBe('21:00');

    const bad = await request(app).post('/api/admin/shifts').set(bearer()).send({ name: 'X', startTime: '9:00' });
    expect(bad.status).toBe(400);

    const del = await request(app).delete(`/api/admin/shifts/${c.body.data.id}`).set(bearer());
    expect(del.body.data.active).toBe(0);
  });

  it('结束时间允许 24:00（与后端一致；生产「夜班」= 15:00–24:00，收口B）', async () => {
    const night = await request(app).post('/api/admin/shifts').set(bearer()).send({ name: '夜班X', startTime: '15:00', endTime: '24:00', sort: 40 });
    expect(night.status).toBe(201);
    expect(night.body.data).toMatchObject({ startTime: '15:00', endTime: '24:00' });
    // 改存量班次为 24:00 收尾也应放行
    const up = await request(app).put(`/api/admin/shifts/${night.body.data.id}`).set(bearer()).send({ endTime: '24:00' });
    expect(up.status).toBe(200);
    expect(up.body.data.endTime).toBe('24:00');
    // 非法结束时间仍拦
    const bad = await request(app).post('/api/admin/shifts').set(bearer()).send({ name: 'Y', startTime: '08:00', endTime: '25:00' });
    expect(bad.status).toBe(400);
  });
});

describe('CR-07 §3 排班指派 / 冲突', () => {
  it('单条指派 + 列表回显（安全员名/车架号/班次名）', async () => {
    const c = await request(app).post('/api/admin/schedules').set(bearer()).send({ workDate: D1, shiftId: shiftDay, operatorId: opId, vehicleId: vId, note: '早班' });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ workDate: D1, operatorName: '张伟', vin: 'LSVAB1234K5678901', shiftName: '白班', status: 'planned', createdBy: '管理员' });

    const list = await request(app).get(`/api/admin/schedules?date=${D1}`).set(bearer());
    expect(list.body.data.length).toBe(1);
    expect(list.body.data[0].done).toBe(false);
  });

  it('同日期同班次「一车两派」→ 409；换班次则可（shift 维度）', async () => {
    await request(app).post('/api/admin/schedules').set(bearer()).send({ workDate: D1, shiftId: shiftDay, operatorId: opId, vehicleId: vId });
    const dup = await request(app).post('/api/admin/schedules').set(bearer()).send({ workDate: D1, shiftId: shiftDay, operatorId: op2, vehicleId: vId });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CONFLICT');
    // 夜班（不同班次）派同一车 → 允许
    const night = await request(app).post('/api/admin/schedules').set(bearer()).send({ workDate: D1, shiftId: shiftNight, operatorId: op2, vehicleId: vId });
    expect(night.status).toBe(201);
  });

  it('允许多车：同一人同日可派多车（无「一人一派」）', async () => {
    const a = await request(app).post('/api/admin/schedules').set(bearer()).send({ workDate: D1, shiftId: shiftDay, operatorId: opId, vehicleId: vId });
    const b = await request(app).post('/api/admin/schedules').set(bearer()).send({ workDate: D1, shiftId: shiftDay, operatorId: opId, vehicleId: v2 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const list = await request(app).get(`/api/admin/schedules?date=${D1}&operatorId=${opId}`).set(bearer());
    expect(list.body.data.length).toBe(2);
  });

  it('改派（换人）：冲突校验 + 取消（软删 status=cancelled）', async () => {
    const c = await request(app).post('/api/admin/schedules').set(bearer()).send({ workDate: D1, shiftId: shiftDay, operatorId: opId, vehicleId: vId });
    const id = c.body.data.id;
    const up = await request(app).put(`/api/admin/schedules/${id}`).set(bearer()).send({ operatorId: op2 });
    expect(up.body.data.operatorId).toBe(op2);
    const del = await request(app).delete(`/api/admin/schedules/${id}`).set(bearer());
    expect(del.body.data.status).toBe('cancelled');
    // 取消后同车同班次可再派（唯一索引仅约束 planned）
    const again = await request(app).post('/api/admin/schedules').set(bearer()).send({ workDate: D1, shiftId: shiftDay, operatorId: opId, vehicleId: vId });
    expect(again.status).toBe(201);
  });

  it('拆列：createdBy=发起人（不可被改派污染）+ updatedBy=最后修改人（口径①：未改过为空）', async () => {
    const c = await request(app).post('/api/admin/schedules').set(bearer()).send({ workDate: D1, shiftId: shiftDay, operatorId: opId, vehicleId: vId });
    const id = c.body.data.id;
    // 新建：发起人=下发人；未修改过 → updatedBy 为空
    expect(c.body.data.createdBy).toBe('管理员');
    expect(c.body.data.updatedBy).toBeNull();
    // 模拟原始「发起人」为他人，验证改派绝不覆盖 created_by
    db.prepare('UPDATE schedule SET created_by=? WHERE id=?').run('王主管', id);
    const up = await request(app).put(`/api/admin/schedules/${id}`).set(bearer()).send({ operatorId: op2 });
    expect(up.status).toBe(200);
    expect(up.body.data.createdBy).toBe('王主管'); // 发起人不变
    expect(up.body.data.updatedBy).toBe('管理员'); // 最后修改人=操作人
    // 取消同样只写 updated_by
    const del = await request(app).delete(`/api/admin/schedules/${id}`).set(bearer());
    expect(del.body.data.createdBy).toBe('王主管');
    expect(del.body.data.updatedBy).toBe('管理员');
    // 库面核对
    const row = db.prepare('SELECT created_by, updated_by FROM schedule WHERE id=?').get(id);
    expect(row).toMatchObject({ created_by: '王主管', updated_by: '管理员' });
  });
});

describe('CR-07 §4 批量 / 复制 / 导入', () => {
  it('批量 cross 交叉（同班次内一车一派 → 每车仅首个生效，其余记冲突）；pair 一一配对', async () => {
    const cross = await request(app).post('/api/admin/schedules/batch').set(bearer()).send({ workDate: D1, shiftId: shiftDay, operatorIds: [opId, op2], vehicleIds: [vId, v2], mode: 'cross' });
    expect(cross.status).toBe(201);
    // 同日期同班次内一车一派：2 车各落 1 条，另一名安全员在这两车上记冲突
    expect(cross.body.data.inserted).toBe(2);
    expect(cross.body.data.skipped).toBe(2);
    expect(cross.body.data.conflicts.length).toBe(2);

    const pair = await request(app).post('/api/admin/schedules/batch').set(bearer()).send({ workDate: D2, shiftId: shiftDay, operatorIds: [opId, op2], vehicleIds: [vId, v2], mode: 'pair' });
    expect(pair.body.data.inserted).toBe(2);
  });

  it('批量冲突计入 conflicts，不整批失败', async () => {
    await request(app).post('/api/admin/schedules').set(bearer()).send({ workDate: D1, shiftId: shiftDay, operatorId: opId, vehicleId: vId });
    const r = await request(app).post('/api/admin/schedules/batch').set(bearer()).send({ workDate: D1, shiftId: shiftDay, operatorIds: [op2], vehicleIds: [vId, v2], mode: 'cross' });
    expect(r.body.data.inserted).toBe(1); // v2 新派成功
    expect(r.body.data.skipped).toBe(1); // vId 冲突
    expect(r.body.data.conflicts[0].vehicleId).toBe(vId);
  });

  it('复制昨日：幂等（重复复制跳过）', async () => {
    await request(app).post('/api/admin/schedules').set(bearer()).send({ workDate: D1, shiftId: shiftDay, operatorId: opId, vehicleId: vId });
    const c1 = await request(app).post('/api/admin/schedules/copy').set(bearer()).send({ fromDate: D1, toDate: D2 });
    expect(c1.body.data.inserted).toBe(1);
    const c2 = await request(app).post('/api/admin/schedules/copy').set(bearer()).send({ fromDate: D1, toDate: D2 });
    expect(c2.body.data.inserted).toBe(0);
    expect(c2.body.data.skipped).toBe(1);
  });

  it('CSV 导入：日期,班次,安全员,车架号；幂等 + 错误明细', async () => {
    const csv = ['日期,班次,安全员,车架号', `${D1},白班,张伟,LSVAB1234K5678901`, `${D1},白班,查无此人,LSVAB1234K5678902`].join('\n');
    const r = await request(app).post('/api/admin/schedules/import').set(bearer()).attach('file', Buffer.from(csv), 'sched.csv');
    expect(r.status).toBe(201);
    expect(r.body.data.inserted).toBe(1);
    expect(r.body.data.errors.length).toBe(1);
    // 再次导入 → 幂等
    const r2 = await request(app).post('/api/admin/schedules/import').set(bearer()).attach('file', Buffer.from(csv), 'sched.csv');
    expect(r2.body.data.inserted).toBe(0);
  });
});

describe('CR-07 §5 当日看板（done 由计时记录推导）', () => {
  it('已排/已开始/已完成/未完成 + 未排班车', async () => {
    // 排 vId 给 opId（白班），v2 不排
    await request(app).post('/api/admin/schedules').set(bearer()).send({ workDate: D1, shiftId: shiftDay, operatorId: opId, vehicleId: vId });
    // 直接造一条当日已停止的计时记录 → done
    db.prepare(
      `INSERT INTO timer_session(work_order_no,operator_id,vehicle_id,operator_name,vin,status,start_at,end_at,net_seconds,pause_seconds)
       VALUES('WO-20260930-001',?,?,'张伟','LSVAB1234K5678901','stopped','${D1} 08:10:00','${D1} 09:10:00',3600,0)`
    ).run(opId, vId);

    const b = await request(app).get(`/api/admin/schedules/board?date=${D1}`).set(bearer());
    expect(b.body.data).toMatchObject({ date: D1, planned: 1, started: 1, done: 1, unfinished: 0 });
    expect(b.body.data.unscheduledVehicles.map((x) => x.vin)).toContain('LSVAB1234K5678902');
  });
});

describe('CR-07 §6 H5 接口（口径 B：仅列排给我的）', () => {
  const opLogin = async (username) =>
    (await request(app).post('/api/h5/login').send({ username, password: 'op1234' })).body.data.token;

  it('无 token / 仅带 query operatorId → 401（防越权）', async () => {
    await request(app).post('/api/admin/schedules').set(bearer()).send({ workDate: D1, shiftId: shiftDay, operatorId: opId, vehicleId: vId });
    expect((await request(app).get(`/api/h5/my-vehicles?date=${D1}`)).status).toBe(401);
    // 旧草案的 query 回退已移除
    expect((await request(app).get(`/api/h5/my-vehicles?date=${D1}&operatorId=${opId}`)).status).toBe(401);
    // 后台管理员 token 不适用（角色不符）
    expect((await request(app).get(`/api/h5/my-vehicles?date=${D1}`).set(bearer())).status).toBe(401);
  });

  it('用 CR-06 operator token → 只列排给他的车；他人为空', async () => {
    await request(app).post('/api/admin/schedules').set(bearer()).send({ workDate: D1, shiftId: shiftDay, operatorId: opId, vehicleId: vId });
    const t1 = await opLogin('zhangwei');
    const r = await request(app).get(`/api/h5/my-vehicles?date=${D1}`).set({ Authorization: `Bearer ${t1}` });
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBe(1);
    expect(r.body.data[0]).toMatchObject({ vehicleId: vId, vin: 'LSVAB1234K5678901', shiftName: '白班' });
    const t2 = await opLogin('liqiang');
    const other = await request(app).get(`/api/h5/my-vehicles?date=${D1}`).set({ Authorization: `Bearer ${t2}` });
    expect(other.body.data.length).toBe(0);
  });
});

describe('CR-07 §7 起点口径 B（env 开关默认关）', () => {
  it('默认关：非排班车可直接开始（行为不变）', () => {
    delete process.env.SCHEDULE_ENFORCE;
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    expect(session.id).toBeTruthy();
  });

  it('开启：非排班车 → 403 硬拦（CR-08 批2 #5：allowUnscheduled 不再放行/留痕）', () => {
    process.env.SCHEDULE_ENFORCE = '1';
    // 未排班 → 拒
    expect(() => startSession(db, { operatorId: opId, vehicleId: vId })).toThrow(/未排给您/);
    // 旧「确认放行」口已关闭：带 allowUnscheduled 仍拒
    expect(() => startSession(db, { operatorId: opId, vehicleId: vId, allowUnscheduled: true })).toThrow(/未排给您/);
    expect(db.prepare('SELECT COUNT(*) n FROM schedule_override').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM timer_session').get().n).toBe(0);
  });

  it('开启：已排班车无需确认即可开始（不产生越权留痕）', () => {
    process.env.SCHEDULE_ENFORCE = '1';
    const shiftAll = Number(
      db.prepare("INSERT INTO shift(name,start_time,end_time,sort,active) VALUES('全天','00:00','23:59',90,1)").run()
        .lastInsertRowid
    );
    db.prepare("INSERT INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,created_by) VALUES(?,?,?,?, 'planned','管理员')").run(
      new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10), // 今天（上海）
      shiftAll,
      opId,
      vId
    );
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    expect(session.id).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) n FROM schedule_override').get().n).toBe(0);
  });
});
