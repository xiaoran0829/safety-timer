import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../db.js';
import { nextWorkOrderNo } from '../services/woSeq.js';

let db;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('工单号规则（冻结规格 §2）', () => {
  it('格式 WO-YYYYMMDD-序号，3 位补零', () => {
    expect(nextWorkOrderNo(db, '20260929')).toBe('WO-20260929-001');
  });

  it('同一天自增', () => {
    expect(nextWorkOrderNo(db, '20260929')).toBe('WO-20260929-001');
    expect(nextWorkOrderNo(db, '20260929')).toBe('WO-20260929-002');
    expect(nextWorkOrderNo(db, '20260929')).toBe('WO-20260929-003');
  });

  it('跨天重置为 001，且互不影响', () => {
    expect(nextWorkOrderNo(db, '20260929')).toBe('WO-20260929-001');
    expect(nextWorkOrderNo(db, '20260929')).toBe('WO-20260929-002');
    expect(nextWorkOrderNo(db, '20260930')).toBe('WO-20260930-001');
    expect(nextWorkOrderNo(db, '20260930')).toBe('WO-20260930-002');
    expect(nextWorkOrderNo(db, '20260929')).toBe('WO-20260929-003');
  });

  it('超过 999 自动扩位为 4 位且不截断', () => {
    db.prepare('INSERT INTO wo_sequence(day,last_seq) VALUES(?,?)').run('20260929', 999);
    expect(nextWorkOrderNo(db, '20260929')).toBe('WO-20260929-1000');
    expect(nextWorkOrderNo(db, '20260929')).toBe('WO-20260929-1001');
  });
});
