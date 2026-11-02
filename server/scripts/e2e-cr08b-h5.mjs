// CR-08 批2 · H5 五项逐条端到端（本地临时 DB + 真实 app + SCHEDULE_ENFORCE=1；零碰生产）
// 运行：node scripts/e2e-cr08b-h5.mjs   （证据：stdout + /tmp/cr08h5-e2e.json）
process.env.SCHEDULE_ENFORCE = '1';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { hashPassword } from '../middleware/auth.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-cr08b-h5-'));
const db = openDb(path.join(dir, 'e2e.db'));
const app = createApp({ db, adminPassword: 'e2e-pass' });
const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let pass = 0;
let fail = 0;
const transcript = [];
function ok(cond, msg) {
  (cond ? pass++ : fail++);
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  transcript.push({ ok: !!cond, msg });
}
async function j(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  transcript.push({ method, url, status: res.status, body: data });
  return { status: res.status, data };
}

/* ---------- 时间工具（运行时自适应，不依赖固定时刻） ---------- */
const pad = (n) => String(n).padStart(2, '0');
const hmOf = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const plusMin = (d, m) => new Date(d.getTime() + m * 60000);
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const nowMin = now.getHours() * 60 + now.getMinutes();

// 班次A：全天（覆盖“现在”→ 迟到/早退放行用）
const FULL = { start: '00:00', end: '23:59' };
// 班次B：未来 2h 起（“现在”早于开始 → #2 用）；对 22:00 后运行做兜底
let lateStartMin = Math.min(nowMin + 120, 1437);
let lateEndMin = Math.min(lateStartMin + 60, 1439);
if (lateStartMin <= nowMin) throw new Error('运行时兜底失败：lateStart<=now，请在非深夜运行');
const LATE = { start: `${pad(Math.floor(lateStartMin / 60))}:${pad(lateStartMin % 60)}`, end: `${pad(Math.floor(lateEndMin / 60))}:${pad(lateEndMin % 60)}` };

console.log(`\n# CR-08 批2 · H5 五项 E2E  base=${base}  TODAY=${TODAY}`);
console.log(`# 班次A 全天=${FULL.start}-${FULL.end}｜班次B 未来=${LATE.start}-${LATE.end}（当前 ${hmOf(now)}）\n`);

/* ---------- 造数 ---------- */
const shiftFull = Number(db.prepare("INSERT INTO shift(name,start_time,end_time,sort,active) VALUES('全天',?,?,10,1)").run(FULL.start, FULL.end).lastInsertRowid);
const shiftLate = Number(db.prepare("INSERT INTO shift(name,start_time,end_time,sort,active) VALUES('晚班',?,?,20,1)").run(LATE.start, LATE.end).lastInsertRowid);

const orgId = Number(db.prepare("INSERT INTO organization(name,code,sort) VALUES('E2E组织','E2E-ORG',1)").run().lastInsertRowid);
const supId = Number(db.prepare("INSERT INTO supplier(name,code,sort) VALUES('E2E供应商','E2E-SUP',1)").run().lastInsertRowid);
const mkVehicle = (vin) => Number(db.prepare("INSERT INTO vehicle(vin,station,org_id,supplier_id,sort,active) VALUES(?, '工位A', ?, ?, 1, 1)").run(vin, orgId, supId).lastInsertRowid);
const vehIn = mkVehicle('E2EIN000000000001');
const vehLate = mkVehicle('E2ELATE00000000001');
const vehUn = mkVehicle('E2EUNSCH0000000001');

function mkOperator(name, username, pwd) {
  const { hash, salt } = hashPassword(pwd);
  return Number(
    db.prepare("INSERT INTO operator(name,label,sort,active,employed,username,pwd_hash,pwd_salt,must_change_pwd,pwd_ver) VALUES(?, '安全员A', 10, 1, 1, ?, ?, ?, 0, 1)")
      .run(name, username, hash, salt).lastInsertRowid
  );
}
const opAll = mkOperator('张伟', 'e2e_zhangwei', 'pwd-zhangwei');
const opEarly = mkOperator('李强', 'e2e_liqiang', 'pwd-liqiang');

// 排班：A → 全天/vehIn/下发人=排班员X + 备注；B → 晚班/vehLate/下发人=排班员Y
db.prepare("INSERT INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,note,created_by) VALUES(?,?,?,?,'planned',?,?)")
  .run(TODAY, shiftFull, opAll, vehIn, '排班备注-早班', '排班员X');
db.prepare("INSERT INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,note,created_by) VALUES(?,?,?,?,'planned',?,?)")
  .run(TODAY, shiftLate, opEarly, vehLate, null, '排班员Y');

/* ---------- 登录（H5 安全员） ---------- */
async function h5Login(username, password) {
  const r = await j('POST', '/api/h5/login', { username, password });
  return r.data?.data?.token;
}
const tokAll = await h5Login('e2e_zhangwei', 'pwd-zhangwei');
const tokEarly = await h5Login('e2e_liqiang', 'pwd-liqiang');
const H = (t) => ({ Authorization: `Bearer ${t}` });
console.log(`[登录] 张伟 token=${tokAll ? 'ok' : 'FAIL'} ; 李强 token=${tokEarly ? 'ok' : 'FAIL'}`);

/* ---------- #5 只看本人车 ---------- */
console.log('\n[需求⑤] H5 只看「排给我的车」');
let r = await j('GET', '/api/h5/my-vehicles', null, H(tokAll));
const myVins = (r.data?.data || []).map((x) => x.vin);
ok(r.status === 200 && myVins.includes('E2EIN000000000001') && !myVins.includes('E2EUNSCH0000000001'), `/my-vehicles 仅含本人排班车（${JSON.stringify(myVins)}）`);
ok((r.data?.data || [])[0]?.shiftName === '全天' && (r.data?.data || [])[0]?.shiftStart === FULL.start, 'my-vehicles 带班次时间窗');

/* ---------- #5 未排班车硬拦 ---------- */
console.log('\n[需求⑤] 非排班车 → 硬拦 403 NOT_SCHEDULED');
r = await j('POST', '/api/sessions/start', { vehicleId: vehUn }, H(tokAll));
ok(r.status === 403 && r.data?.code === 'NOT_SCHEDULED', `start(未排班车) → ${r.status} ${r.data?.code}`);

/* ---------- #2 早于班次开始 → 拦 ---------- */
console.log('\n[需求②] 早于班次开始 → 拦 403 BEFORE_SHIFT_START');
r = await j('POST', '/api/sessions/start', { vehicleId: vehLate }, H(tokEarly));
ok(r.status === 403 && r.data?.code === 'BEFORE_SHIFT_START', `start(未到班次) → ${r.status} ${r.data?.code}`);
ok(r.data?.data?.shiftStart === LATE.start, `回执带 shiftStart=${r.data?.data?.shiftStart}`);

/* ---------- 迟到/早退放行（班次内放行）+ #4 发起人 + ⑧排班备注快照 ---------- */
console.log('\n[放行] 班次内开始 → 201（迟到/早退放行，工时按实际）');
r = await j('POST', '/api/sessions/start', { vehicleId: vehIn }, H(tokAll));
const sd = r.data?.data;
const sid = sd?.session?.id ?? (typeof sd === 'number' ? sd : sd?.id);
ok(r.status === 201 && !!sid, `start(班次内) → ${r.status} sid=${sid}`);
r = await j('GET', `/api/sessions/${sid}`, null, H(tokAll));
const sess = r.data?.data?.session || {};
console.log('\n[需求④] 发起人 = 排班下发人（created_by）');
ok(sess.initiatorName === '排班员X' && sess.initiatorId === null, `initiatorName=${JSON.stringify(sess.initiatorName)} initiatorId=${sess.initiatorId}`);
console.log('\n[需求③] 排班备注快照');
ok(sess.scheduleNote === '排班备注-早班', `scheduleNote=${JSON.stringify(sess.scheduleNote)}`);

/* ---------- ⑥ 计时备注（弹窗→接口） ---------- */
console.log('\n[需求⑥] 计时备注（RemarkDialog → POST /:id/remarks）');
r = await j('POST', `/api/sessions/${sid}/remarks`, { content: '冒烟备注-A' }, H(tokAll));
ok(r.status === 201, `addRemark → ${r.status}`);
r = await j('GET', `/api/sessions/${sid}`, null, H(tokAll));
const remarks = r.data?.data?.remarks || [];
ok(remarks.length === 1 && remarks[0].content === '冒烟备注-A', `备注已落库：${JSON.stringify(remarks.map((x) => x.content))}`);

/* ---------- #7 同人+同车+当天 已结束 → 当天锁定 ---------- */
console.log('\n[需求⑦] 同人+同车+当天 已有 stopped → 409 DAY_CLOSED');
r = await j('POST', `/api/sessions/${sid}/stop`, {}, H(tokAll));
ok(r.status === 200 && (r.data?.data?.session?.status ?? r.data?.data?.status) === 'stopped', `stop → ${r.status} ${r.data?.data?.session?.status ?? r.data?.data?.status}`);
r = await j('POST', '/api/sessions/start', { vehicleId: vehIn }, H(tokAll));
ok(r.status === 409 && r.data?.code === 'DAY_CLOSED', `再次 start(同人同车当天) → ${r.status} ${r.data?.code}`);
r = await j('GET', '/api/h5/my-vehicles', null, H(tokAll));
ok((r.data?.data || [])[0]?.done === true, `my-vehicles 标记 done=true`);

/* ---------- 汇总 ---------- */
console.log(`\n===== 结果：pass=${pass} fail=${fail} =====`);
fs.writeFileSync('/tmp/cr08h5-e2e.json', JSON.stringify({ base, TODAY, FULL, LATE, pass, fail, transcript }, null, 2));
server.close();
process.exit(fail === 0 ? 0 : 1);
