// 2026-10-08 老板需求②：审批中心（A档 —— 节点/审批人顺序可自定义）。仅内存库。
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';

const ROOT_PASS = 'appr-root-pass';
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let db, app, orgA, orgB;
const mkUser = (root, body) => request(app).post('/api/admin/users').set(bearer(root)).send(body);
const login = (u, p) => request(app).post('/api/admin/login').send({ username: u, password: p });
const rootLogin = async () => (await request(app).post('/api/admin/login').send({ password: ROOT_PASS })).body.data.token;

let root, engId, engTok, aTok, bTok, aId, bId;

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: ROOT_PASS, adminUser: '管理员' });
  orgA = Number(db.prepare("INSERT INTO organization(name) VALUES('组织A')").run().lastInsertRowid);
  orgB = Number(db.prepare("INSERT INTO organization(name) VALUES('组织B')").run().lastInsertRowid);
  root = await rootLogin();
  const eng = await mkUser(root, { username: 'eng1', password: 'abc123', role: 'engineer', orgId: orgA, mustChange: false });
  engId = eng.body.data.id;
  engTok = (await login('eng1', 'abc123')).body.data.token;
  const A = await mkUser(root, { username: 'auditA', password: 'abc123', role: 'engineer', mustChange: false });
  const B = await mkUser(root, { username: 'auditB', password: 'abc123', role: 'engineer', mustChange: false });
  aId = A.body.data.id; bId = B.body.data.id;
  aTok = (await login('auditA', 'abc123')).body.data.token;
  bTok = (await login('auditB', 'abc123')).body.data.token;
});

async function setNodes(ids) {
  const flows = await request(app).get('/api/admin/approvals/flows').set(bearer(root));
  const flow = flows.body.data.find((f) => f.code === 'org_change');
  return request(app)
    .put(`/api/admin/approvals/flows/${flow.id}/nodes`)
    .set(bearer(root))
    .send({ nodes: ids.map((id) => ({ approverId: id })) });
}

const submit = (tok, body) => request(app).post('/api/admin/approvals/requests').set(bearer(tok)).send(body);
const todo = (tok) => request(app).get('/api/admin/approvals/requests?scope=todo').set(bearer(tok));

describe('需求② 审批中心（A档）', () => {
  it('默认流程存在，节点顺序可自定义', async () => {
    const flows = await request(app).get('/api/admin/approvals/flows').set(bearer(root));
    expect(flows.status).toBe(200);
    const flow = flows.body.data.find((f) => f.code === 'org_change');
    expect(flow).toBeTruthy();
    const r = await setNodes([bId, aId]);
    expect(r.status).toBe(200);
    expect(r.body.data.nodes.map((n) => n.approverId)).toEqual([bId, aId]);
  });

  it('逐节点审批：全部通过 → 自动改绑所属单位', async () => {
    await setNodes([aId, bId]);
    const s = await submit(engTok, { kind: 'org_change', targetUserId: engId, orgId: orgB, reason: '换到B组织' });
    expect(s.status).toBe(201);
    const rid = s.body.data.id;
    expect(s.body.data.status).toBe('pending');

    // 第一节点审批人待办可见
    expect((await todo(aTok)).body.data.map((x) => x.id)).toContain(rid);
    expect((await todo(bTok)).body.data.map((x) => x.id)).not.toContain(rid);

    // 非当前节点审批人 → 403
    const noPerm = await request(app).post(`/api/admin/approvals/requests/${rid}/approve`).set(bearer(bTok)).send({});
    expect(noPerm.status).toBe(403);

    // 甲通过 → 进入第二节点
    const a1 = await request(app).post(`/api/admin/approvals/requests/${rid}/approve`).set(bearer(aTok)).send({ comment: '同意' });
    expect(a1.status).toBe(200);
    expect(a1.body.data.status).toBe('pending');
    expect(a1.body.data.currentSeq).toBe(2);
    expect(db.prepare('SELECT org_id FROM admin_user WHERE id=?').get(engId).org_id).toBe(orgA);

    // 乙通过 → 终审通过 + 改绑
    const b1 = await request(app).post(`/api/admin/approvals/requests/${rid}/approve`).set(bearer(bTok)).send({ comment: '同意' });
    expect(b1.status).toBe(200);
    expect(b1.body.data.status).toBe('approved');
    expect(db.prepare('SELECT org_id FROM admin_user WHERE id=?').get(engId).org_id).toBe(orgB);

    // 留痕
    const detail = await request(app).get(`/api/admin/approvals/requests/${rid}`).set(bearer(root));
    expect(detail.body.data.logs.map((l) => l.action)).toEqual(['submit', 'approve', 'approve', 'apply']);
  });

  it('驳回 → 结束且不改绑', async () => {
    await setNodes([aId, bId]);
    const rid = (await submit(engTok, { kind: 'org_change', targetUserId: engId, orgId: orgB })).body.data.id;
    const rej = await request(app).post(`/api/admin/approvals/requests/${rid}/reject`).set(bearer(aTok)).send({ comment: '不同意' });
    expect(rej.status).toBe(200);
    expect(rej.body.data.status).toBe('rejected');
    expect(db.prepare('SELECT org_id FROM admin_user WHERE id=?').get(engId).org_id).toBe(orgA);
  });

  it('非本人/非管理员不能代提交他人换单位申请', async () => {
    await setNodes([aId]);
    const r = await submit(aTok, { kind: 'org_change', targetUserId: engId, orgId: orgB });
    expect(r.status).toBe(403);
  });

  it('本人可查看自己的申请列表', async () => {
    await setNodes([aId]);
    await submit(engTok, { kind: 'org_change', targetUserId: engId, orgId: orgB });
    const mine = await request(app).get('/api/admin/approvals/requests?scope=mine').set(bearer(engTok));
    expect(mine.body.data.length).toBe(1);
    expect(mine.body.data[0].requesterName).toBeTruthy();
  });
});
