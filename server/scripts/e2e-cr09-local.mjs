// CR-09 本地功能冒烟：产线副本 DB + 同代码，真 HTTP。
// 仅本地：DB = 生产备份副本，端口 19383。不碰生产。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db.js';
import { hashPassword } from '../middleware/auth.js';
import { fmtDateTime, nowDate } from '../lib/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
const OUT = '/tmp/cr09-smoke';
const SRC = process.env.SRC_DB;
if (!SRC) {
  console.error('缺少 SRC_DB：请指定一份本机数据库副本路径，例如 SRC_DB=/path/to/safety-timer.db node scripts/e2e-cr09-local.mjs');
  process.exit(2);
}
const PORT = 19383;
fs.mkdirSync(OUT, { recursive: true });
const DB = path.join(OUT, 'run.db');
fs.rmSync(DB, { force: true });
fs.rmSync(DB + '-wal', { force: true });
fs.copyFileSync(SRC, DB);

const D = new Date().toISOString().slice(0, 10);
const db = openDb(DB);
const opId = 900;
const vId = 901;
db.prepare("INSERT INTO operator(id,name,label,sort,active,employed,employee_no,username,pwd_hash,pwd_salt,must_change_pwd,pwd_ver) VALUES(?,?,?,?,1,1,?,?,?,?,0,1)").run(
  opId, '冒烟员', '安全员S', 90, 'S900001', 'smoke900', '', ''
);
const { hash, salt } = hashPassword('smoke-pass');
db.prepare('UPDATE operator SET pwd_hash=?, pwd_salt=? WHERE id=?').run(hash, salt, opId);
db.prepare("INSERT INTO vehicle(id,vin,station,sort) VALUES(?,?,?,90)").run(vId, 'LSMOKE000000000001', '冒烟工位');
db.prepare("INSERT INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,note,created_by) VALUES(?,1,?,?,'planned',?,?)").run(
  D, opId, vId, '本地冒烟排班备注', 'admin'
);
db.close();

const log = [];
const child = spawn('node', ['index.js'], {
  cwd: SERVER_DIR,
  env: { ...process.env, DB_FILE: DB, PORT: String(PORT), SCHEDULE_ENFORCE: '1', ADMIN_PASSWORD: 'safety-timer', AUTH_SECRET: 'smoke-secret' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => log.push(String(d)));
child.stderr.on('data', (d) => log.push(String(d)));

const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (m, p, body, tok) => {
  const r = await fetch(B + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let b = null;
  const t = await r.text();
  try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
};

const results = [];
const ok = (n, c, extra = '') => { results.push([n, c, extra]); console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${extra}`); };

try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const h = await fetch(B + '/api/health'); up = h.ok; } catch {} }
  if (!up) throw new Error('server not up: ' + log.join(''));

  const login = await j('POST', '/api/h5/login', { username: 'smoke900', password: 'smoke-pass' });
  ok('H5 登录 200', login.status === 200, JSON.stringify(login.body));
  const tok = login.body?.data?.token;

  const start = await j('POST', '/api/sessions/start', { vehicleId: vId }, tok);
  ok('开始计时 201', start.status === 201, JSON.stringify(start.body));
  const sid = start.body?.data?.session?.id;

  const p1 = await j('POST', `/api/sessions/${sid}/pause`, {}, tok);
  ok('⑩ 空备注暂停 → 400 REMARK_REQUIRED', p1.status === 400 && p1.body?.code === 'REMARK_REQUIRED', JSON.stringify(p1.body));

  const p2 = await j('POST', `/api/sessions/${sid}/pause`, { remark: '   ' }, tok);
  ok('⑩ 空白备注 → 400 REMARK_REQUIRED', p2.status === 400 && p2.body?.code === 'REMARK_REQUIRED', JSON.stringify(p2.body));

  // ⑫：等 6s 后模拟「点击时刻」= now-5s（≥ 开段起点），提交已过 5s
  await sleep(6000);
  const clickAt = fmtDateTime(new Date(nowDate().getTime() - 5000));
  const p3 = await j('POST', `/api/sessions/${sid}/pause`, { remark: '本地冒烟-配合吊装', at: clickAt }, tok);
  ok('⑩ 有备注暂停 → 200 paused', p3.status === 200 && p3.body?.data?.session?.status === 'paused', JSON.stringify(p3.body?.data?.session));

  const r1 = await j('POST', `/api/sessions/${sid}/resume`, {}, tok);
  ok('恢复 → 200 running', r1.status === 200 && r1.body?.data?.session?.status === 'running');
  await j('POST', `/api/sessions/${sid}/remarks`, { content: '工作中的额外说明' }, tok);
  const s1 = await j('POST', `/api/sessions/${sid}/stop`, {}, tok);
  ok('停止 → 200 stopped', s1.status === 200 && s1.body?.data?.session?.status === 'stopped');

  const adm = await j('POST', '/api/admin/login', { password: 'safety-timer' });
  const atok = adm.body?.data?.token;
  const det = await j('GET', `/api/admin/sessions/detail?operatorId=${opId}`, undefined, atok);
  const row = det.body?.data?.list?.[0];
  ok('⑧ 列表含 segments', Array.isArray(row?.segments) && row.segments.length >= 3, `segs=${row?.segments?.length}`);
  ok('⑧ 段字段齐', row?.segments?.[0] && 'kind' in row.segments[0] && 'startedAt' in row.segments[0] && 'endedAt' in row.segments[0]);

  // ⑫：暂停段起点 = 点击时刻（非提交时刻），工作段终点 = 点击时刻
  const pseg = (row?.segments || []).find((s) => s.kind === 'pause');
  ok('⑫ 暂停段起点 = 点击时刻（非提交时刻）', pseg && pseg.startedAt === clickAt, `clickAt=${clickAt} got=${pseg?.startedAt}`);
  ok('⑫ 工作段终点 = 点击时刻', row?.segments?.[0]?.endedAt === clickAt, `got=${row?.segments?.[0]?.endedAt}`);
  ok('⑫ 暂停段起点早于提交时刻（差≈5s）', pseg && clickAt < fmtDateTime(), `${clickAt} < ${fmtDateTime()}`);

  const csv = await fetch(B + `/api/admin/export/detail?format=csv&operatorId=${opId}`, { headers: { Authorization: `Bearer ${atok}` } }).then((r) => r.text());
  ok('⑧ 导出表头含「详细工时（时间轴）」', csv.includes('详细工时（时间轴）'));
  ok('⑧ 导出含暂停段备注文本', csv.includes('本地冒烟-配合吊装'));
  ok('⑬ 计时段备注不入导出（副作用，页面仍有）', !csv.includes('工作中的额外说明'));
  ok('⑧ 导出含段行（HH:MM–HH:MM 暂停）', /\d{2}:\d{2}–\d{2}:\d{2} 暂停：/.test(csv));
  ok('⑬ 导出时间轴不含「计时：」行', !csv.includes('计时：'), csv.split('\n').slice(-1)[0]?.slice(0, 40));
  ok('⑬ 导出时间轴行数=暂停段数', (csv.match(/暂停：/g) || []).length === 1, `暂停行=${(csv.match(/暂停：/g) || []).length}`);
  const hdr = csv.split('\r\n')[0];
  // 2026-10-07 主人令：导出剔除 N/O 列「暂停开始时间」「暂停结束时间」→ 16→14 列，时间轴列 P→N。
  ok('⑪ 导出表头含 暂停次数/详细工时（时间轴）', hdr.includes('暂停次数,详细工时（时间轴）'), hdr.slice(-60));
  ok('⑪ 导出表头不含 暂停开始/结束时间', !hdr.includes('暂停开始时间') && !hdr.includes('暂停结束时间'), hdr.slice(-60));
  ok('⑪ 行含 暂停次数=1', (csv.split('\r\n')[1] || '').includes(',1,'), (csv.split('\r\n')[1] || '').slice(-60));
  const fs2 = fs;
  fs2.writeFileSync('/tmp/cr09-smoke-export.csv', csv);
} catch (e) {
  ok('脚本异常', false, String(e));
} finally {
  child.kill('SIGTERM');
  await sleep(400);
  const fail = results.filter((r) => !r[1]).length;
  console.log(`\n== pass=${results.length - fail} fail=${fail} ==`);
  process.exit(fail ? 1 : 0);
}
