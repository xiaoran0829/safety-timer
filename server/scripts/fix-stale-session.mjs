#!/usr/bin/env node
// 单会话停止订正脚本（CR-13 配套）
// 用途：把悬挂会话订正为 stopped（示例：WO-20261005-006 / id=31）。
// 安全约束：默认 dry-run（只读、不写）；--apply 才写，且先落快照；--rollback 按快照还原。
// 不碰生产：请对【生产库副本】或运维窗口内执行；技术线不直写生产。
//
// 用法：
//   node fix-stale-session.mjs --db <path> --session 31 --end-at "2026-10-05 19:32:30"            # dry-run
//   node fix-stale-session.mjs --db <path> --session 31 --end-at "..." --apply                   # 执行（先写快照）
//   node fix-stale-session.mjs --db <path> --rollback <snapshot.json>                            # 回滚
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db.js';
import { fmtDateTime, fmtDuration, parseTs } from '../lib/time.js';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

const DB = arg('db');
const SID = Number(arg('session', '0'));
const END_AT = arg('end-at', '');
const APPLY = has('apply');
const ROLLBACK = arg('rollback', '');

if (!DB) {
  console.error('缺少 --db <path>');
  process.exit(2);
}
const db = openDb(DB);

function snapshot(sid) {
  const s = db.prepare('SELECT * FROM timer_session WHERE id=?').get(sid);
  if (!s) throw new Error(`会话不存在：${sid}`);
  const segs = db.prepare('SELECT * FROM timer_segment WHERE session_id=?').all(sid);
  const maxRemarkId = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM remark WHERE session_id=?').get(sid).m;
  return { takenAt: fmtDateTime(), session: s, segments: segs, maxRemarkId };
}

function showPlan(sid, endAt) {
  const s = db.prepare('SELECT * FROM timer_session WHERE id=?').get(sid);
  if (!s) throw new Error(`会话不存在：${sid}`);
  const openSeg = db
    .prepare('SELECT * FROM timer_segment WHERE session_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(sid);
  const endMs = parseTs(endAt);
  if (endMs === null || Number.isNaN(endMs)) throw new Error(`--end-at 非法：${endAt}`);
  let net = 0;
  let pause = 0;
  for (const g of db.prepare('SELECT * FROM timer_segment WHERE session_id=?').all(sid)) {
    const isOpen = g.ended_at === null;
    const secs = isOpen
      ? Math.max(0, Math.floor((endMs - parseTs(g.started_at)) / 1000))
      : Number(g.seconds || 0);
    if (g.kind === 'work') net += secs;
    else pause += secs;
  }
  console.log('== 订正计划（dry-run）==');
  console.log('库文件         :', path.resolve(DB));
  console.log('会话           :', s.id, s.work_order_no, '| 当前状态:', s.status, '| 安全员:', s.operator_name);
  console.log('拟置 end_at    :', endAt);
  console.log('开放段         :', openSeg ? `id=${openSeg.id} kind=${openSeg.kind} started_at=${openSeg.started_at}` : '（无）');
  console.log(`结算           : net=${net}s (${fmtDuration(net)})  pause=${pause}s (${fmtDuration(pause)})`);
  console.log('影响面         : timer_session 1 行 + timer_segment 开放段 1 行；单事务；不增删行、不改结构、不波及他单');
  return { s, openSeg, net, pause, endAt };
}

function applyFix(sid, endAt) {
  const snap = snapshot(sid);
  const snapFile = path.resolve(process.cwd(), `backups/fix-session-${sid}-${Date.now()}.snapshot.json`);
  fs.mkdirSync(path.dirname(snapFile), { recursive: true });
  fs.writeFileSync(snapFile, JSON.stringify(snap, null, 2));
  console.log('快照已写：', snapFile);

  const plan = showPlan(sid, endAt);
  const run = db.transaction(() => {
    const cur = db.prepare('SELECT * FROM timer_session WHERE id=?').get(sid);
    if (cur.status !== 'running' && cur.status !== 'paused') throw new Error(`会话状态为 ${cur.status}，无需订正`);
    const openSeg = db
      .prepare('SELECT * FROM timer_segment WHERE session_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(sid);
    if (openSeg) {
      const secs = Math.max(0, Math.floor((parseTs(endAt) - parseTs(openSeg.started_at)) / 1000));
      db.prepare('UPDATE timer_segment SET ended_at=?, seconds=? WHERE id=?').run(endAt, secs, openSeg.id);
    }
    db.prepare("UPDATE timer_session SET status='stopped', end_at=?, net_seconds=?, pause_seconds=? WHERE id=?").run(
      endAt,
      plan.net,
      plan.pause,
      sid
    );
    db.prepare('INSERT INTO remark(session_id,ts,content,author) VALUES(?,?,?,?)').run(
      sid,
      endAt,
      '数据订正：悬挂单停止（运维窗口/五门禁）',
      '系统'
    );
  });
  run.immediate();
  const after = db.prepare('SELECT id,work_order_no,status,end_at,net_seconds,pause_seconds FROM timer_session WHERE id=?').get(sid);
  console.log('== 执行完成 ==');
  console.table(after);
  console.log('回滚命令：node fix-stale-session.mjs --db', DB, '--rollback', snapFile);
}

function rollback(file) {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = snap.session;
  const run = db.transaction(() => {
    db.prepare('UPDATE timer_session SET status=?, end_at=?, net_seconds=?, pause_seconds=? WHERE id=?').run(
      s.status,
      s.end_at,
      s.net_seconds,
      s.pause_seconds,
      s.id
    );
    for (const g of snap.segments) {
      db.prepare('UPDATE timer_segment SET started_at=?, ended_at=?, seconds=? WHERE id=?').run(
        g.started_at,
        g.ended_at,
        g.seconds,
        g.id
      );
    }
    // 删除订正新增的备注（id > 快照时的最大 id）
    if (snap.maxRemarkId != null) {
      db.prepare('DELETE FROM remark WHERE session_id=? AND id>?').run(s.id, snap.maxRemarkId);
    }
  });
  run.immediate();
  console.log('== 已按快照回滚 ==', file);
  console.table(db.prepare('SELECT id,status,end_at,net_seconds,pause_seconds FROM timer_session WHERE id=?').get(s.id));
}

try {
  if (ROLLBACK) {
    rollback(ROLLBACK);
  } else if (!SID) {
    console.error('缺少 --session <id>');
    process.exit(2);
  } else if (APPLY) {
    if (!END_AT) {
      console.error('--apply 需同时给 --end-at');
      process.exit(2);
    }
    applyFix(SID, END_AT);
  } else {
    showPlan(SID, END_AT || '2099-01-01 00:00:00');
    console.log('\n(dry-run；确认无误后加 --apply 执行)');
  }
} catch (e) {
  console.error('[FATAL]', e && e.message ? e.message : e);
  process.exit(1);
}
