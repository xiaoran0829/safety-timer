// 2026-10-08 老板：流程配置支持全流程自定义 —— 每步可多人 + 会签(all)/任一人(any)。
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let db, app, root, orgA, orgB, aId, bId, cId, engId, engTok, aTok, bTok, cTok, flowId;

const mkUser = async (username, role, orgId) => {
  const r = await request(app).post('/api/admin/users').set(bearer(root)).send({ username, password: 'abc123', role, orgId, mustChange: false });
  const t = (await request(app).post('/api/admin/login').send({ username, password: 'abc123' })).body.data.token;
  return { id: r.body.data.id, token: t };
};

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: 'p-appr3', adminUser: '管理员' });
  orgA = Number(db.prepare("INSERT INTO organization(name) VALUES('组织A')").run().lastInsertRowid);
  orgB = Number(db.prepare("INSERT INTO organization(name) VALUES('组织B')").run().lastInsertRowid);
  root = (await request(app).post('/api/admin/login').send({ password: 'p-appr3' })).body.data.token;
  const eng = await mkUser('eng1', 'engineer', orgA);
  engId = eng.id;
  engTok = eng.token;
  const A = await mkUser('apA', 'engineer', null);
  const B = await mkUser('apB', 'engineer', null);
  const C = await mkUser('apC', 'engineer', null);
  aId = A.id; aTok = A.token;
  bId = B.id; bTok = B.token;
  cId = C.id; cTok = C.token;
  const flows = await request(app).get('/api/admin/approvals/flows').set(bearer(root));
  flowId = flows.body.data.find((f) => f.code === 'org_change').id;
});

const setSteps = (steps) => request(app).put(`/api/admin/approvals/flows/${flowId}/nodes`).set(bearer(root)).send({ steps });
const submit = () => request(app).post('/api/admin/approvals/requests').set(bearer(engTok)).send({ kind: 'org_change', targetUserId: engId, orgId: orgB });
const approve = (tok, id) => request(app).post(`/api/admin/approvals/requests/${id}/approve`).set(bearer(tok)).send({ comment: 'ok' });

describe('全流程自定义（步骤/多人/会签）', () => {
  it('mode=all（会签）：全部通过才进入下一步', async () => {
    const r = await setSteps([
      { mode: 'all', approvers: [{ approverId: aId }, { approverId: bId }] },
      { mode: 'any', approvers: [{ approverId: cId }] },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.data.nodes.map((n) => [n.seq, n.mode])).toEqual([
      [1, 'all'],
      [1, 'all'],
      [2, 'any'],
    ]);

    const rid = (await submit()).body.data.id;
    const r1 = await approve(aTok, rid);
    expect(r1.body.data.status).toBe('pending');
    expect(r1.body.data.currentSeq).toBe(1); // 会签未齐
    const r2 = await approve(bTok, rid);
    expect(r2.body.data.status).toBe('pending');
    expect(r2.body.data.currentSeq).toBe(2); // 会签齐 → 下一步
    const r3 = await approve(cTok, rid);
    expect(r3.body.data.status).toBe('approved');
    expect(db.prepare('SELECT org_id FROM admin_user WHERE id=?').get(engId).org_id).toBe(orgB);
  });

  it('mode=any：任一人通过即进入下一步', async () => {
    await setSteps([{ mode: 'any', approvers: [{ approverId: aId }, { approverId: bId }] }, { mode: 'any', approvers: [{ approverId: cId }] }]);
    const rid = (await submit()).body.data.id;
    const r1 = await approve(bTok, rid);
    expect(r1.body.data.currentSeq).toBe(2);
    const r2 = await approve(cTok, rid);
    expect(r2.body.data.status).toBe('approved');
  });

  it('同一人在同一步重复审批 → 403（该节点已审过）', async () => {
    await setSteps([{ mode: 'all', approvers: [{ approverId: aId }, { approverId: bId }] }]);
    const rid = (await submit()).body.data.id;
    expect((await approve(aTok, rid)).body.data.status).toBe('pending');
    expect((await approve(aTok, rid)).status).toBe(403); // 同一步同一人无可审节点
  });

  it('角色审批节点可用（approverRole）', async () => {
    const r = await setSteps([{ mode: 'any', approvers: [{ approverRole: 'engineer' }] }]);
    expect(r.status).toBe(200);
    const rid = (await submit()).body.data.id;
    const ok = await approve(bTok, rid);
    expect(ok.body.data.status).toBe('approved');
  });

  it('非法角色 / 空步骤 → 400', async () => {
    expect((await setSteps([{ mode: 'any', approvers: [{ approverRole: 'nope' }] }])).status).toBe(400);
    expect((await setSteps([{ mode: 'any', approvers: [] }])).status).toBe(400);
  });

  it('流程可新建 / 改名 / 停用 / 删除', async () => {
    const c = await request(app).post('/api/admin/approvals/flows').set(bearer(root)).send({ code: 'leave', name: '请假审批' });
    expect(c.status).toBe(201);
    const fid = c.body.data.id;
    const u = await request(app).put(`/api/admin/approvals/flows/${fid}`).set(bearer(root)).send({ name: '请假审批(改)', active: 0 });
    expect(u.body.data.name).toBe('请假审批(改)');
    expect(u.body.data.active).toBe(0);
    expect((await request(app).delete(`/api/admin/approvals/flows/${fid}`).set(bearer(root))).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) n FROM approval_flow WHERE id=?').get(fid).n).toBe(0);
  });
});
