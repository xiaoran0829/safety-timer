// CR-09 样张生成：造一段带暂停备注的会话，导出「详细工时（时间轴）」CSV + xlsx。
// 仅本地内存/临时库，不碰生产。
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db.js';
import { startSession, pauseSession, resumeSession, stopSession, addRemark } from '../services/timer.js';
import { toDetailCsvString, toDetailXlsxBuffer } from '../services/export.js';

const outDir = process.argv[2] || '/tmp/cr09-sample';
fs.mkdirSync(outDir, { recursive: true });

const dbFile = path.join(outDir, 'sample.db');
fs.rmSync(dbFile, { force: true });
const db = openDb(dbFile);

db.prepare("INSERT INTO operator(name,label,sort) VALUES('张伟','安全员A',10)").run();
const op = 1;
const v1 = Number(db.prepare("INSERT INTO vehicle(vin,station,sort) VALUES('LSVAB1234K5678901','工位A',1)").run().lastInsertRowid);
db.prepare(
  "INSERT INTO timer_session(work_order_no,operator_id,vehicle_id,operator_name,vin,status,start_at,org_name,supplier_name,initiator_name,schedule_note) VALUES('WO-20260930-001',?,?,'张伟','LSVAB1234K5678901','stopped','2026-09-30 09:00:00','飞书AI','供应商A','排班员X','早班-3DOCC')"
).run(op, v1);
const sid = Number(db.prepare('SELECT id FROM timer_session ORDER BY id DESC LIMIT 1').get().id);

// 段：work / pause / work / pause / work（⑪ 多段暂停演示）
const seg = (kind, s, e) => {
  const sec = Math.round((new Date(e.replace(' ', 'T')) - new Date(s.replace(' ', 'T'))) / 1000);
  return db.prepare('INSERT INTO timer_segment(session_id,kind,started_at,ended_at,seconds) VALUES(?,?,?,?,?)').run(sid, kind, s, e, sec);
};
seg('work', '2026-09-30 09:00:00', '2026-09-30 09:05:00');
seg('pause', '2026-09-30 09:05:00', '2026-09-30 09:10:00');
seg('work', '2026-09-30 09:10:00', '2026-09-30 09:12:00');
seg('pause', '2026-09-30 09:12:00', '2026-09-30 09:14:00');
seg('work', '2026-09-30 09:14:00', '2026-09-30 09:20:00');

// 备注：暂停段 1 条 + 末工作段 2 条（同段并列）
const rem = (ts, content, author) => db.prepare('INSERT INTO remark(session_id,ts,content,author) VALUES(?,?,?,?)').run(sid, ts, content, author);
rem('2026-09-30 09:06:00', '配合吊装作业，暂停计时', '张伟');
rem('2026-09-30 09:15:00', '已完成第一项试验', '张伟');
rem('2026-09-30 09:16:00', '补充：记录里程数', '张伟');
db.prepare("UPDATE timer_session SET end_at='2026-09-30 09:20:00', net_seconds=780, pause_seconds=420 WHERE id=?").run(sid);

const csv = toDetailCsvString(db, {});
const xlsx = toDetailXlsxBuffer(db, {});
fs.writeFileSync(path.join(outDir, 'detail-timeline-sample.csv'), csv);
fs.writeFileSync(path.join(outDir, 'detail-timeline-sample.xlsx'), xlsx);
console.log(csv);
console.log('WROTE', outDir);
