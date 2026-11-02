import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { startSession } from '../services/timer.js';

let dir;
let file;
let c1;
let c2;
let opId;
let vId;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-conc-'));
  file = path.join(dir, 'test.db');
  c1 = openDb(file);
  c2 = openDb(file);
  opId = Number(c1.prepare("INSERT INTO operator(name,label) VALUES('张伟','安全员A')").run().lastInsertRowid);
  vId = Number(c1.prepare("INSERT INTO vehicle(vin,station) VALUES('LSVAB1234K5678901','工位A')").run().lastInsertRowid);
});

afterAll(() => {
  try { c1.close(); c2.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("C1′ 并发兜底：ux_active_operator 唯一索引", () => {
  it('DB 层：同一 operator 第二条进行中会话被唯一索引拒绝', () => {
    const ts = '2026-09-29 09:00:00';
    c1.prepare(
      `INSERT INTO timer_session(work_order_no,operator_id,vehicle_id,operator_name,vin,status,start_at)
       VALUES('WO-20260929-900',?,?, '张伟','X','running',?)`
    ).run(opId, vId, ts);
    expect(() =>
      c2.prepare(
        `INSERT INTO timer_session(work_order_no,operator_id,vehicle_id,operator_name,vin,status,start_at)
         VALUES('WO-20260929-901',?,?, '张伟','X','running',?)`
      ).run(opId, vId, ts)
    ).toThrowError(/UNIQUE constraint failed: timer_session\.operator_id/);
    // 清理
    c1.prepare("DELETE FROM timer_session WHERE work_order_no IN ('WO-20260929-900','WO-20260929-901')").run();
  });

  it('第二连接 start：回落到 OPERATOR_BUSY（同 C1）', () => {
    const { session } = startSession(c1, { operatorId: opId, vehicleId: vId });
    expect(session.status).toBe('running');
    try {
      startSession(c2, { operatorId: opId, vehicleId: vId });
      throw new Error('should not reach');
    } catch (e) {
      expect(e.code).toBe('OPERATOR_BUSY');
      expect(e.http).toBe(409);
      expect(e.data.activeSession.workOrderNo).toBe(session.workOrderNo);
    }
    // 全库仅 1 条进行中
    expect(c1.prepare("SELECT COUNT(*) n FROM timer_session WHERE operator_id=? AND status IN ('running','paused')").get(opId).n).toBe(1);
  });

  it('工单号并发唯一：连续 start 不重复', () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const o = Number(c1.prepare("INSERT INTO operator(name) VALUES(?)").run(`并发安全员${i}`).lastInsertRowid);
      ids.push(startSession(c1, { operatorId: o, vehicleId: vId }).session.workOrderNo);
    }
    expect(new Set(ids).size).toBe(5);
  });
});
