// CR-09（详细工时优化 · ⑩暂停强制备注 / ⑧时间轴归位）验收。
// 红线：不碰现网；本用例仅内存库。
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { startSession, stopSession, pauseSession, resumeSession, addRemark } from '../services/timer.js';
import { toDetailCsvString, toDetailAoa, DETAIL_COLUMNS } from '../services/export.js';
import { fmtDateTime, parseTs, fmtDay } from '../lib/time.js';

const PAX = 'cr09-pass';
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let db;
let app;
let opId;
let vId;

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, adminPassword: PAX });
  opId = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('张伟','安全员A',10)").run().lastInsertRowid);
  vId = Number(db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES('LSVAB1234K5678901','工位A',1)").run().lastInsertRowid);
});

describe('⑩ 暂停强制备注（前端拦截 + 后端校验 REMARK_REQUIRED/400）', () => {
  it('无备注暂停 → 400 REMARK_REQUIRED，且不改变状态、不建段', async () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    const r = await request(app).post(`/api/sessions/${session.id}/pause`).send({ operatorId: opId });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('REMARK_REQUIRED');
    expect(db.prepare('SELECT status FROM timer_session WHERE id=?').get(session.id).status).toBe('running');
    expect(db.prepare("SELECT COUNT(*) n FROM timer_segment WHERE session_id=? AND kind='pause'").get(session.id).n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM remark WHERE session_id=?').get(session.id).n).toBe(0);
  });

  it('空白备注（空格）暂停 → 400 REMARK_REQUIRED', async () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    const r = await request(app).post(`/api/sessions/${session.id}/pause`).send({ operatorId: opId, remark: '   ' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('REMARK_REQUIRED');
  });

  it('带备注暂停 → 200 paused，备注与暂停同事务落库（作者=安全员姓名）', async () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    const r = await request(app)
      .post(`/api/sessions/${session.id}/pause`)
      .send({ operatorId: opId, remark: '配合吊装作业，暂停计时' });
    expect(r.status).toBe(200);
    expect(r.body.data.session.status).toBe('paused');
    const rem = db.prepare('SELECT * FROM remark WHERE session_id=?').all(session.id);
    expect(rem).toHaveLength(1);
    expect(rem[0].content).toBe('配合吊装作业，暂停计时');
    expect(rem[0].author).toBe('张伟');
    expect(rem[0].ts).toBeTruthy();
  });

  it('恢复 / 停止 不强制备注', async () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    pauseSession(db, session.id, opId, { remark: '暂停一次' });
    const rr = await request(app).post(`/api/sessions/${session.id}/resume`).send({ operatorId: opId });
    expect(rr.status).toBe(200);
    expect(rr.body.data.session.status).toBe('running');
    const rs = await request(app).post(`/api/sessions/${session.id}/stop`).send({ operatorId: opId });
    expect(rs.status).toBe(200);
    expect(rs.body.data.session.status).toBe('stopped');
  });

  it('service 层：pauseSession 缺备注直接抛 REMARK_REQUIRED', () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    try {
      pauseSession(db, session.id, opId);
      throw new Error('should not reach');
    } catch (e) {
      expect(e.code).toBe('REMARK_REQUIRED');
      expect(e.http).toBe(400);
    }
  });
});

describe('⑫ 暂停以「点击时刻」为准（at）', () => {
  const shiftOpenStart = (sid, ts) =>
    db.prepare("UPDATE timer_segment SET started_at=? WHERE session_id=? AND kind='work'").run(ts, sid);

  it('at 在合法区间（≥开段起点 且 ≤ now）→ 工作段终点/暂停段起点/备注 ts 均= at', async () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    shiftOpenStart(session.id, '2026-09-30 09:00:00');
    const at = '2026-09-30 09:00:30';
    const r = await request(app)
      .post(`/api/sessions/${session.id}/pause`)
      .send({ operatorId: opId, remark: '点按即停', at });
    expect(r.status).toBe(200);
    const segs = db.prepare('SELECT * FROM timer_segment WHERE session_id=? ORDER BY id').all(session.id);
    expect(segs).toHaveLength(2);
    expect(segs[0].kind).toBe('work');
    expect(segs[0].ended_at).toBe(at); // 工作段在点击瞬间关闭
    expect(segs[0].seconds).toBe(30);
    expect(segs[1].kind).toBe('pause');
    expect(segs[1].started_at).toBe(at); // 暂停段自点击瞬间起
    expect(db.prepare('SELECT ts FROM remark WHERE session_id=?').get(session.id).ts).toBe(at);
  });

  it('at 早于开段起点 → 回退服务器 now', async () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    shiftOpenStart(session.id, '2026-09-30 09:00:00');
    const bad = '2026-09-30 08:59:59';
    await request(app).post(`/api/sessions/${session.id}/pause`).send({ operatorId: opId, remark: '越界', at: bad });
    const segs = db.prepare('SELECT * FROM timer_segment WHERE session_id=? ORDER BY id').all(session.id);
    expect(segs[0].ended_at).not.toBe(bad);
    expect(segs[0].ended_at).toBe(segs[1].started_at);
    expect(segs[0].ended_at.startsWith(fmtDay())).toBe(true);
  });

  it('at 在未来 → 回退服务器 now', async () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    const bad = '2099-01-01 00:00:00';
    await request(app).post(`/api/sessions/${session.id}/pause`).send({ operatorId: opId, remark: '未来', at: bad });
    const segs = db.prepare('SELECT * FROM timer_segment WHERE session_id=? ORDER BY id').all(session.id);
    expect(segs[0].ended_at).not.toBe(bad);
    expect(segs[0].ended_at).toBe(segs[1].started_at);
  });

  it('at 缺失/非法 → 回退服务器 now（⑩ 行为不变）', async () => {
    const bads = [undefined, '', 'not-a-time'];
    for (let i = 0; i < bads.length; i++) {
      const at = bads[i];
      // 同人同车当天结束后不可再开 → 每轮换一辆车
      const vid = Number(db.prepare('INSERT INTO vehicle(vin,station,sort) VALUES(?,?,90)').run(`LSBAD00000000000${i}`, `越界工位${i}`).lastInsertRowid);
      const { session } = startSession(db, { operatorId: opId, vehicleId: vid });
      const r = await request(app)
        .post(`/api/sessions/${session.id}/pause`)
        .send({ operatorId: opId, remark: '无at', ...(at === undefined ? {} : { at }) });
      expect(r.status).toBe(200);
      const segs = db.prepare('SELECT * FROM timer_segment WHERE session_id=? ORDER BY id').all(session.id);
      expect(segs[0].ended_at).toBe(segs[1].started_at);
      expect(segs[1].started_at).toBeTruthy();
      expect(Math.abs(parseTs(segs[1].started_at) - parseTs(fmtDateTime()))).toBeLessThan(60000);
      stopSession(db, session.id, opId);
    }
  });

  it('服务层直接调用：pauseSession(db,id,op,{remark,at}) 同样生效', () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    shiftOpenStart(session.id, '2026-09-30 10:00:00');
    const at = '2026-09-30 10:00:07';
    pauseSession(db, session.id, opId, { remark: '服务层 at', at });
    const segs = db.prepare('SELECT * FROM timer_segment WHERE session_id=? ORDER BY id').all(session.id);
    expect(segs[0].ended_at).toBe(at);
    expect(segs[1].started_at).toBe(at);
    expect(fmtDateTime).toBeTypeOf('function');
  });
});

describe('⑧ 详细工时时间轴：segments 返回 + 备注按 ts 就近归段', () => {
  it('列表接口回 segments；备注按 ts 归段（暂停段带⑩备注；工作段无备注→「未填」）', async () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    pauseSession(db, session.id, opId, { remark: '暂停A-换胎' });
    resumeSession(db, session.id, opId);
    addRemark(db, session.id, opId, '工作中的额外说明');
    stopSession(db, session.id, opId);

    // 显式时间轴（避开同秒歧义）：work 09:00–09:05 / pause 09:05–09:10 / work 09:10–09:20
    const segs = db.prepare('SELECT id,kind FROM timer_segment WHERE session_id=? ORDER BY id').all(session.id);
    expect(segs.map((s) => s.kind)).toEqual(['work', 'pause', 'work']);
    const setSeg = db.prepare('UPDATE timer_segment SET started_at=?, ended_at=? WHERE id=?');
    setSeg.run('2026-09-30 09:00:00', '2026-09-30 09:05:00', segs[0].id);
    setSeg.run('2026-09-30 09:05:00', '2026-09-30 09:10:00', segs[1].id);
    setSeg.run('2026-09-30 09:10:00', '2026-09-30 09:20:00', segs[2].id);
    const rems = db.prepare('SELECT id FROM remark WHERE session_id=? ORDER BY id').all(session.id);
    const setTs = db.prepare('UPDATE remark SET ts=? WHERE id=?');
    setTs.run('2026-09-30 09:06:00', rems[0].id); // 归暂停段
    setTs.run('2026-09-30 09:15:00', rems[1].id); // 归末工作段

    const l = await request(app).post('/api/admin/login').send({ password: PAX });
    const token = l.body.data.token;
    const r = await request(app).get(`/api/admin/sessions/detail?operatorId=${opId}`).set(bearer(token));
    expect(r.status).toBe(200);
    const row = r.body.data.list.find((x) => x.id === session.id);
    expect(row).toBeTruthy();
    expect(row.segments).toHaveLength(3);
    for (const s of row.segments) {
      expect(typeof s.startedAt).toBe('string');
      expect('endedAt' in s).toBe(true);
      expect(typeof s.seconds).toBe('number');
    }

    // 归位规则：备注归「段 startedAt ≤ ts 中最末一段」（同秒冲突归后段）
    const ownerOf = (segs, ts) => {
      let pick = segs[0];
      for (const g of segs) if (g.startedAt <= ts) pick = g;
      return pick;
    };
    const mapped = row.segments.map((seg) => ({
      kind: seg.kind,
      notes: row.remarks.filter((x) => ownerOf(row.segments, x.ts) === seg).map((x) => x.content),
    }));
    expect(mapped[0].notes).toEqual([]); // 工作段无备注 → 前端显示「未填」
    expect(mapped[1].notes).toEqual(['暂停A-换胎']);
    expect(mapped[2].notes).toEqual(['工作中的额外说明']);
  });

  it('导出（CSV/xlsx）时间轴：⑬ 只输出暂停行（无「计时」行），无暂停则留空', () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    pauseSession(db, session.id, opId, { remark: '暂停A' });
    resumeSession(db, session.id, opId);
    stopSession(db, session.id, opId);
    const segs = db.prepare('SELECT id FROM timer_segment WHERE session_id=? ORDER BY id').all(session.id);
    const setSeg = db.prepare('UPDATE timer_segment SET started_at=?, ended_at=? WHERE id=?');
    setSeg.run('2026-09-30 09:00:00', '2026-09-30 09:05:00', segs[0].id);
    setSeg.run('2026-09-30 09:05:00', '2026-09-30 09:10:00', segs[1].id);
    setSeg.run('2026-09-30 09:10:00', '2026-09-30 09:20:00', segs[2].id);
    // 暂停备注 ts 归入暂停段
    const rid = db.prepare('SELECT id FROM remark WHERE session_id=? ORDER BY id').get(session.id).id;
    db.prepare('UPDATE remark SET ts=? WHERE id=?').run('2026-09-30 09:06:00', rid);

    const csv = toDetailCsvString(db, {});
    expect(csv).toContain('详细工时（时间轴）');
    // ⑬：只有暂停行
    expect(csv).toContain('09:05–09:10 暂停：暂停A');
    expect(csv).not.toContain('计时：');
    expect(csv).not.toContain('09:00–09:05');
    expect(csv).not.toContain('09:10–09:20');
    // ⑪：暂停次数列保留；主人令 2026-10-07：暂停开始/结束时间两列已剔除
    expect(DETAIL_COLUMNS).toContain('暂停次数');
    expect(csv.split('\r\n')[0]).toContain('暂停次数,详细工时（时间轴）');
    const outRow = csv.split('\r\n')[1];
    expect(outRow).toContain(',1,09:05–09:10 暂停：暂停A');
  });

  it('⑬ 无暂停会话：时间轴列留空', () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    stopSession(db, session.id, opId);
    const aoa = toDetailAoa(db, {});
    const row = aoa.find((r) => r[2] === 'LSVAB1234K5678901' || r[3] === session.workOrderNo);
    expect(row).toBeTruthy();
    expect(row[14]).toBe('');
    expect(String(toDetailCsvString(db, {}))).not.toContain('计时：');
  });

  it('进行中会话：末段 endedAt 为 null（→ 前端显示「进行中」）', async () => {
    const { session } = startSession(db, { operatorId: opId, vehicleId: vId });
    const l = await request(app).post('/api/admin/login').send({ password: PAX });
    const r = await request(app).get(`/api/admin/sessions/detail?operatorId=${opId}`).set(bearer(l.body.data.token));
    const row = r.body.data.list.find((x) => x.id === session.id);
    expect(row.segments).toHaveLength(1);
    expect(row.segments[0].kind).toBe('work');
    expect(row.segments[0].endedAt).toBeNull();
  });
});
