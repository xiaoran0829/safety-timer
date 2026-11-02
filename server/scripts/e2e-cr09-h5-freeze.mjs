// CR-09（需求⑭）· H5「点按暂停即冻结秒表」本地端到端（真实浏览器 + 真实 app；零碰生产）
// 运行：node scripts/e2e-cr09-h5-freeze.mjs
// 断言：点按「暂停」→（备注弹窗期间）显示秒数冻结不增长；取消/关闭 → 解冻恢复跳动；提交 → 以服务端为准
process.env.SCHEDULE_ENFORCE = '1';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { hashPassword } from '../middleware/auth.js';

const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const DEBUG_PORT = Number(process.env.CDP_PORT || 9336);
const EVID_DIR = path.resolve(process.cwd(), '../docs/evidence/cr09');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const results = [];
function ok(cond, msg, extra = '') {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  ' + extra : ''}`);
  results.push({ ok: !!cond, msg, extra });
}

/* ---------- 本地实例（临时库） ---------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-cr09-freeze-'));
const db = openDb(path.join(dir, 'freeze.db'));
const app = createApp({ db, adminPassword: 'freeze-pass' });
const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(`\n# CR-09 ⑭ H5 秒表冻结 E2E  base=${base}`);

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

/* 造数：全天班次 + 人/车 + 今日排班 */
db.prepare("INSERT INTO shift(name,start_time,end_time,sort,active) VALUES('全天','00:00','23:59',10,1)").run();
const shiftId = Number(db.prepare('SELECT id FROM shift ORDER BY id DESC LIMIT 1').get().id);
const vehId = Number(db.prepare("INSERT INTO vehicle(vin,station,sort,active) VALUES('LSFREEZE0000000001','工位F',1,1)").run().lastInsertRowid);
const { hash, salt } = hashPassword('freeze123');
const opId = Number(
  db
    .prepare(
      "INSERT INTO operator(name,label,sort,active,employed,employee_no,username,pwd_hash,pwd_salt,must_change_pwd,pwd_ver) VALUES('冻结员','安全员F',10,1,1,'F900001','freezeop',?,?,0,1)"
    )
    .run(hash, salt).lastInsertRowid
);
db.prepare(
  "INSERT INTO schedule(work_date,shift_id,operator_id,vehicle_id,status,note,created_by) VALUES(?,?,?,?,'planned',?,?)"
).run(TODAY, shiftId, opId, vehId, '本地冒烟排班备注', 'admin');

/* ---------- 前端静态资源（用最新构建） ---------- */
const publicDir = path.resolve(process.cwd(), 'public');
const distDir = path.resolve(process.cwd(), '../web/dist');
if (!fs.existsSync(path.join(distDir, 'index.html'))) throw new Error('缺少 web/dist，请先 npm run build');
fs.rmSync(publicDir, { recursive: true, force: true });
fs.mkdirSync(publicDir, { recursive: true });
fs.cpSync(distDir, publicDir, { recursive: true });

/* ---------- 登录取 token（H5 同源 API） ---------- */
const loginRes = await fetch(`${base}/api/h5/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'freezeop', password: 'freeze123' }),
});
const loginJson = await loginRes.json();
const token = loginJson?.data?.token;
ok(loginRes.status === 200 && !!token, 'H5 登录 200 且拿到 token');
const vehRes = await fetch(`${base}/api/h5/my-vehicles`, { headers: { Authorization: `Bearer ${token}` } });
const vehJson = await vehRes.json();
const vehicle = (vehJson?.data?.list || vehJson?.data || [])[0];
ok(!!vehicle, 'H5 我的车辆可见', JSON.stringify(vehicle));

/* ---------- 启 Chrome（headless + CDP） ---------- */
const chromeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chrome-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${chromeDir}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--window-size=420,900',
    'about:blank',
  ],
  { stdio: 'ignore' }
);
let target = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
  } catch {
    /* 等待 */
  }
  await sleep(500);
}
if (!target) throw new Error('Chrome CDP 未就绪');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let mid = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  }
});
const send = (method, params = {}) => new Promise((res) => { const i = ++mid; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};
const shot = async (f) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
};
const clickBtn = (label) =>
  ev(`(()=>{const b=[...document.querySelectorAll('.van-button')].find(x=>(x.innerText||'').trim()===${JSON.stringify(label)});if(!b)return 'NOTFOUND';b.click();return 'OK';})()`);
const timerText = () => ev(`(document.querySelector('.timer-value')||{}).innerText || ''`);

await send('Page.enable');
await send('Runtime.enable');

/* 预置登录态（H5 token + 车辆），再进入工作页 */
await send('Page.navigate', { url: `${base}/login` });
await sleep(1200);
await ev(`(()=>{localStorage.setItem('st_op_token', ${JSON.stringify(token)});return 1;})()`);
await send('Page.navigate', { url: `${base}/work` });
await sleep(2200);
ok((await ev('location.pathname')) === '/work', '进入 /work 工作页', String(await ev('location.pathname')));

/* 真实 UI 流程：换车 → 选车（拿到车架号） */
await clickBtn('换车');
await sleep(1600);
await ev(`(()=>{const c=document.querySelector('.'+'card');if(c)c.click();return c?'OK':'NO';})()`);
await sleep(1600);
const vinShown = await ev(`document.body.innerText.includes('LSFREEZE0000000001')`);
ok((await ev('location.pathname')) === '/work' && vinShown === true, '选车后回到 /work 且已挂车架号');

/* 开始计时 */
await clickBtn('开始计时');
await sleep(2500);
const tRun = await timerText();
ok((await ev(`document.body.innerText.includes('计时中')`)) === true, '状态=计时中');
ok(/^00:00:0[1-9]$/.test(tRun) || tRun !== '00:00:00', '秒表在跳动', tRun);

/* 点按「暂停」→ 弹窗期间秒表应冻结 */
await ev(`(()=>{window.__t0=${JSON.stringify(tRun)};return 1;})()`);
const clickRes = await clickBtn('暂停');
ok(clickRes === 'OK', '点按「暂停」成功');
await sleep(900);
const tClick = await timerText();
await sleep(3500);
const tAfter = await timerText();
ok((await ev(`!!document.querySelector('.van-dialog')`)) === true, '暂停备注弹窗已弹出');
ok(tClick === tAfter, '⑭ 弹窗期间秒表冻结（3.5s 内不增长）', `点击≈${tClick} → 之后=${tAfter}`);
await shot(path.join(EVID_DIR, 'h5-pause-freeze.png'));

/* 取消 → 解冻，秒表自然跳回（符合「其实还在工作」） */
await ev(`(()=>{const b=document.querySelector('.van-dialog__cancel');if(b)b.click();return 1;})()`);
await sleep(2600);
const tCancel = await timerText();
ok(tCancel !== tAfter, '⑭ 取消后秒表解冻恢复跳动', `${tAfter} → ${tCancel}`);

/* 再次点暂停并提交 → 以服务端为准（status=paused，秒表停） */
await clickBtn('暂停');
await sleep(1200);
await ev(`(()=>{const a=document.querySelector('.van-dialog textarea');const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;set.call(a,'冻结冒烟-配合吊装');a.dispatchEvent(new Event('input',{bubbles:true}));return 1;})()`);await sleep(300);
await ev(`(()=>{const b=document.querySelector('.van-dialog__confirm');if(b)b.click();return 1;})()`);
await sleep(2000);
const pausedOk = await ev(`document.body.innerText.includes('已暂停')`);
ok(pausedOk === true, '提交备注后 → 已暂停（以服务端为准）');
const tPaused1 = await timerText();
await sleep(2600);
const tPaused2 = await timerText();
ok(tPaused1 === tPaused2, '⑭ 暂停后秒表保持不动', `${tPaused1} == ${tPaused2}`);

ws.close();
chrome.kill('SIGKILL');
server.close();
fs.rmSync(publicDir, { recursive: true, force: true });

console.log(`\n== pass=${pass} fail=${fail} ==`);
const out = { at: new Date().toISOString(), base, pass, fail, results };
fs.writeFileSync('/tmp/cr09-h5-freeze.json', JSON.stringify(out, null, 2));
console.log('WROTE /tmp/cr09-h5-freeze.json');
process.exit(fail ? 1 : 0);
