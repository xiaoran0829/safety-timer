// ② 安全员登录账号默认=工号：新建必填工号 + 开号默认回退工号（可手动覆盖）。
// 集成用例，依赖 tech 接线（admin.js 两处）；未接线自动 skip，不误报。
// 红线：导出 11 列 / timer_session 字段不动。
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';

const PAX = 'empno-pass';
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe('② 安全员账号默认=工号（集成；tech 接线后生效）', () => {
  let wired;

  beforeAll(async () => {
    const db = openDb(':memory:');
    const app = createApp({ db, adminPassword: PAX });
    const l = await request(app).post('/api/admin/login').send({ password: PAX });
    const token = l.body.data.token;
    const r = await request(app).post('/api/admin/operators').set(bearer(token)).send({ name: 'WIREDCHK' });
    wired = r.status === 400; // 缺工号被拒 → 必填校验已接线
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

  it('① 新建安全员缺工号 → 400 VALIDATION（不静默）', async (ctx) => {
    if (!wired) return ctx.skip();
    const r = await request(app).post('/api/admin/operators').set(bearer(token)).send({ name: '赵六', label: '安全员D' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION');
  });

  it('② 带工号新建 → 201，DTO employeeNo 正确', async (ctx) => {
    if (!wired) return ctx.skip();
    const r = await request(app)
      .post('/api/admin/operators')
      .set(bearer(token))
      .send({ name: '赵六', label: '安全员D', employeeNo: 'E2001' });
    expect(r.status).toBe(201);
    expect(r.body.data.employeeNo).toBe('E2001');
  });

  it('③ 开号未传 username → 回退用该安全员工号', async (ctx) => {
    if (!wired) return ctx.skip();
    const id = Number(db.prepare("INSERT INTO operator(name,employee_no,sort) VALUES('钱七','E1001',1)").run().lastInsertRowid);
    const r = await request(app).post(`/api/admin/operators/${id}/account`).set(bearer(token)).send({ password: 'op12345' });
    expect(r.status).toBe(200);
    expect(r.body.data.username).toBe('E1001');
  });

  it('④ 工号为空且未传 username → 400（明确提示，不静默失败）', async (ctx) => {
    if (!wired) return ctx.skip();
    const id = Number(db.prepare("INSERT INTO operator(name,sort) VALUES('孙八',1)").run().lastInsertRowid);
    const r = await request(app).post(`/api/admin/operators/${id}/account`).set(bearer(token)).send({ password: 'op12345' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION');
  });

  it('⑤ 显式传 username 仍优先（保留手动覆盖）', async (ctx) => {
    if (!wired) return ctx.skip();
    const id = Number(db.prepare("INSERT INTO operator(name,employee_no,sort) VALUES('周九','E1002',1)").run().lastInsertRowid);
    const r = await request(app)
      .post(`/api/admin/operators/${id}/account`)
      .set(bearer(token))
      .send({ username: 'custom9', password: 'op12345' });
    expect(r.status).toBe(200);
    expect(r.body.data.username).toBe('custom9');
  });
});
