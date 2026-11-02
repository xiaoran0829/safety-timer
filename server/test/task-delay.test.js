// 2026-10-14 老板：任务延时（进行中工单 → 任务结束时间往后调；发起人=车队管理员，审批人=工程师）
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { sweepTimeoutSessions, resolveShiftEnd } from '../services/autoEnd.js';
import { getSessionRow } from '../services/timer.js';

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let db, app, root, orgA, supA, fleetTok, engTok, runSid;

const mkUser = async (username, role, { orgId, supplierId } = {}) => {
  const r = await request(app)
    .post('/api/admin/users')
    .set(bearer(root))
    .send({ username, password: 'abc123', role, orgId, supplierId, mustChange: false });
  const t = (await request(app).post('/api/admin/login').send({ username, password: 'abc123' })).body.data.token;
  return { id: r.body.data.id, token: t };
};
const submit = (b, tok) => request(app).post('/api/admin/approvals/requests').set(bearer(tok)).send(b);

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: 'p-taskdelay', adminUser: '管理员' });
  orgA = Number(db.prepare("INSERT INTO organization(name,code,active,sort,see_all) VALUES('组织A','A',1,1,0)").run().lastInsertRowid);
  supA = Number(db.prepare("INSERT INTO supplier(name,code,active,sort) VALUES('供应商A','SA',1,1)").run().lastInsertRowid);
  db.prepare('INSERT INTO vehicle(vin,station,org_id,supplier_id,active,sort) VALUES(?,?,?,?,1,0)').run('VIN-A', '站', orgA, supA);
  const opId = Number(db.prepare("INSERT INTO operator(name) VALUES('张三')").run().lastInsertRowid);
  const vId = db.prepare('SELECT id FROM vehicle WHERE vin=?').get('VIN-A').id;
  const shiftDan = db.prepare("SELECT id FROM shift WHERE name='白班'").get().id;
  db.prepare("INSERT INTO schedule(work_date,shift_id,operator_id,vehicle_id,status) VALUES('2026-10-14',?,?,?,'planned')").run(shiftDan, opId, vId);
  runSid = Number(
    db
      .prepare("INSERT INTO timer_session(work_order_no,operator_id,vehicle_id,operator_name,vin,status,start_at,net_seconds) VALUES('WO-RUN',?,?,'张三','VIN-A','running','2026-10-14 08:00:00',600)")
      .run(opId, vId).lastInsertRowid
  );
  root = (await request(app).post('/api/admin/login').send({ password: 'p-taskdelay' })).body.data.token;
  const fleet = await mkUser('fleet1', 'fleet_admin', { supplierId: supA });
  fleetTok = fleet.token;
  const eng = await mkUser('eng1', 'engineer', { orgId: orgA });
  engTok = eng.token;
});

describe('任务延时审批流（发起人=车队管理员，审批人=工程师）', () => {
  it('默认流程存在，审批节点=工程师角色', async () => {
    const flows = await request(app).get('/api/admin/approvals/flows').set(bearer(root));
    const f = flows.body.data.find((x) => x.code === 'task_delay');
    expect(f).toBeTruthy();
    expect(f.nodes.map((n) => n.approverRole)).toContain('engineer');
  });

  it('flow-options 含 task_delay 且可手工发起', async () => {
    const r = await request(app).get('/api/admin/approvals/flow-options').set(bearer(fleetTok));
    const f = r.body.data.find((x) => x.code === 'task_delay');
    expect(f).toBeTruthy();
    expect(f.submittable).toBe(true);
  });

  it('/options 返回进行中工单（车队管理员只见本供应商，含当前结束时间）', async () => {
    const o = await request(app).get('/api/admin/approvals/options').set(bearer(fleetTok));
    expect(o.body.data.activeSessions.map((s) => s.id)).toContain(runSid);
    expect(o.body.data.activeSessions[0].curEndAt).toBe('2026-10-14 20:00:00'); // 白班结束时间
  });

  it('车队管理员发起 → 工程师审批通过 → 写入计划结束时间', async () => {
    const s = await submit({ kind: 'task_delay', sessionId: runSid, extendEndAt: '2026-10-14 22:30:00', reason: '任务未完成' }, fleetTok);
    expect(s.status).toBe(201);
    expect(s.body.data.status).toBe('pending');
    expect(s.body.data.payload.workOrderNo).toBe('WO-RUN');
    const rid = s.body.data.id;

    expect(getSessionRow(db, runSid).plan_end_at).toBeNull(); // 未生效

    const ap = await request(app).post(`/api/admin/approvals/requests/${rid}/approve`).set(bearer(engTok)).send({ comment: '同意' });
    expect(ap.body.data.status).toBe('approved');
    expect(getSessionRow(db, runSid).plan_end_at).toBe('2026-10-14 22:30:00');
  });

  it('非车队管理员（工程师）发起 → 403', async () => {
    const s = await submit({ kind: 'task_delay', sessionId: runSid, extendEndAt: '2026-10-14 22:30:00' }, engTok);
    expect(s.status).toBe(403);
    expect(s.body.code).toBe('NO_PERMISSION');
  });

  it('已结束工单发起 → 409', async () => {
    db.prepare("UPDATE timer_session SET status='stopped', end_at='2026-10-14 20:00:00' WHERE id=?").run(runSid);
    const s = await submit({ kind: 'task_delay', sessionId: runSid, extendEndAt: '2026-10-14 22:30:00' }, fleetTok);
    expect(s.status).toBe(409);
    expect(s.body.code).toBe('INVALID_STATE');
  });

  it('延时后结束时间非法/早于当前结束时间 → 400', async () => {
    const badFmt = await submit({ kind: 'task_delay', sessionId: runSid, extendEndAt: 'not-a-time' }, fleetTok);
    expect(badFmt.status).toBe(400);

    const early = await submit({ kind: 'task_delay', sessionId: runSid, extendEndAt: '2026-10-14 19:00:00' }, fleetTok);
    expect(early.status).toBe(400);
  });

  it('计划结束时间优先于班次结束时间（autoEnd 自动结束口径）', async () => {
    db.prepare('UPDATE timer_session SET plan_end_at=? WHERE id=?').run('2026-10-14 23:00:00', runSid);
    db.prepare("INSERT INTO timer_segment(session_id,kind,started_at) VALUES(?,?,?)").run(runSid, 'work', '2026-10-14 08:00:00');
    const row = getSessionRow(db, runSid);
    expect(resolveShiftEnd(db, row)).toBe('2026-10-14 20:00:00'); // 班次结束时间仍可推导

    // 已过班次结束(20:00)但未过计划结束(23:00) → 不自动结束
    const at = new Date(Date.UTC(2026, 9, 14, 20, 30));
    expect(sweepTimeoutSessions(db, { bufferMin: 0, at }).ended).toHaveLength(0);

    // 过计划结束(23:00) → 自动结束，end=计划结束时间
    const at2 = new Date(Date.UTC(2026, 9, 14, 23, 31));
    const r = sweepTimeoutSessions(db, { bufferMin: 0, at: at2 });
    expect(r.ended).toHaveLength(1);
    expect(getSessionRow(db, runSid).end_at).toBe('2026-10-14 23:00:00');
  });
});
