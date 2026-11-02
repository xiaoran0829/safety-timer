// 端到端冒烟：真起 Express（含静态托管），走 HTTP 全流程。仅本地临时端口+临时 DB，不触碰生产。
// 运行：node scripts/e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db.js';
import { createApp } from '../app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-e2e-'));
const db = openDb(path.join(dir, 'e2e.db'));
const app = createApp({ db, adminPassword: 'e2e-pass' });

const opId = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('张伟','安全员A',10)").run().lastInsertRowid);
const op2 = Number(db.prepare("INSERT INTO operator(name,label,sort) VALUES('李强','安全员B',20)").run().lastInsertRowid);
// CR-01：字典 + 车架号挂靠
const orgId = Number(db.prepare("INSERT INTO organization(name,code,sort) VALUES('某组织A','ORG-A',1)").run().lastInsertRowid);
const supId = Number(db.prepare("INSERT INTO supplier(name,code,sort) VALUES('某供应商A','SUP-A',1)").run().lastInsertRowid);
const iniId = Number(db.prepare("INSERT INTO initiator(name,department,sort) VALUES('张三','技术部',1)").run().lastInsertRowid);
const vId = Number(
  db
    .prepare("INSERT INTO vehicle(vin,station,org_id,supplier_id,default_initiator_id,sort) VALUES('LSVAB1234K5678901','工位A',?,?,?,1)")
    .run(orgId, supId, iniId).lastInsertRowid
);

const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
}

async function j(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data, headers: res.headers, ct };
}

try {
  console.log('[1] 基础数据');
  let r = await j('GET', '/api/operators?active=1');
  ok(r.status === 200 && r.data.data.length === 2, 'GET /operators 返回 2 人');

  console.log('[2] 开始计时 + 互斥');
  r = await j('POST', '/api/sessions/start', { operatorId: opId, vehicleId: vId });
  ok(r.status === 201 && /^WO-\d{8}-001$/.test(r.data.data.session.workOrderNo), `start 201，工单号 ${r.data?.data?.session?.workOrderNo}`);
  const sid = r.data.data.session.id;
  r = await j('POST', '/api/sessions/start', { operatorId: opId, vehicleId: vId });
  ok(r.status === 409 && r.data.code === 'OPERATOR_BUSY' && r.data.data.activeSession.id === sid, '重复 start → 409 OPERATOR_BUSY + activeSession');
  r = await j('POST', '/api/sessions/start', { operatorId: op2, vehicleId: vId });
  ok(r.status === 201, 'C2/Q5：他人对同车可继续（软提示）');
  const sid2 = r.data.data.session.id;

  console.log('[3] 暂停/恢复/备注');
  r = await j('POST', `/api/sessions/${sid}/pause`, { operatorId: opId, remark: '配合吊装' });
  ok(r.data.data.session.status === 'paused', 'pause → paused');
  r = await j('POST', `/api/sessions/${sid}/remarks`, { operatorId: opId, content: '补充说明' });
  ok(r.status === 201 && r.data.data.remark.ts, 'remark 201 带时间戳');
  r = await j('POST', `/api/sessions/${sid}/resume`, { operatorId: opId });
  ok(r.data.data.session.status === 'running', 'resume → running');
  r = await j('GET', `/api/sessions/active?operatorId=${opId}`);
  ok(r.data.data.session.id === sid && r.data.data.remarks.length === 2, 'active 含 segments/remarks');

  console.log('[4] 停止 + 记录查询');
  r = await j('POST', `/api/sessions/${sid}/stop`, { operatorId: opId });
  ok(r.data.data.session.status === 'stopped' && typeof r.data.data.session.netSeconds === 'number', 'stop → stopped（净时长已结算）');
  r = await j('GET', `/api/sessions?page=1&pageSize=50`);
  ok(r.data.data.total >= 2, `记录列表 total=${r.data.data.total}`);

  console.log('[5] 导出');
  const resCsv = await fetch(`${base}/api/export?format=csv`);
  const csvBytes = Buffer.from(await resCsv.arrayBuffer());
  const hasBom = csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf;
  const csv = csvBytes.toString('utf8').replace(/^\ufeff/, '');
  ok(resCsv.status === 200 && hasBom, 'CSV 200 + 带 BOM(EF BB BF)');
  ok(csv.includes('组织,供应商,车架号,工单号,试验开始时间,发起人,安全员,实验总里程,试验实际时长,总计费时长,不计费时长'), 'CSV 表头 11 列定序');
  // CR-01：组织/供应商/发起人 由快照自动带出（应有值）；里程/计费 3 列留空
  const dataRow = (csv.trim().split(/\r?\n/)[1] || '').split(',');
  ok(dataRow[0] === '某组织A', `导出 组织 自动带出：${dataRow[0]}`);
  ok(dataRow[1] === '某供应商A', `导出 供应商 自动带出：${dataRow[1]}`);
  ok(dataRow[5] === '张三', `导出 发起人 自动带出：${dataRow[5]}`);
  ok(dataRow[7] === '' && dataRow[9] === '' && dataRow[10] === '', '里程/总计费/不计费 3 列留空');
  r = await j('GET', '/api/vehicles?active=1');
  ok(r.data.data[0].orgName === '某组织A' && r.data.data[0].defaultInitiatorName === '张三', '/vehicles 返回 orgName/supplierName/defaultInitiatorName');
  const resX = await fetch(`${base}/api/export?format=xlsx`);
  const buf = Buffer.from(await resX.arrayBuffer());
  ok(resX.status === 200 && buf.length > 1000, `xlsx 200 + 二进制 ${buf.length}B`);
  ok(/filename\*=UTF-8''/.test(resX.headers.get('content-disposition') || ''), 'xlsx 中文文件名 RFC5987');

  console.log('[6] 后台鉴权 + 维护 + 导入');
  r = await j('GET', '/api/admin/operators');
  ok(r.status === 401, '未登录 401');
  r = await j('POST', '/api/admin/login', { password: 'e2e-pass' });
  const token = r.data.data.token;
  ok(r.status === 200 && token, '登录成功下发 token');
  const auth = { Authorization: `Bearer ${token}` };
  r = await j('POST', '/api/admin/operators', { name: '王五', label: '安全员C' }, auth);
  ok(r.status === 201, '后台新增安全员');
  r = await j('POST', '/api/admin/operators', { name: '王五' }, auth);
  ok(r.status === 409 && r.data.code === 'CONFLICT', '重名 → 409 CONFLICT');
  // CSV 导入
  const fd = new FormData();
  fd.append('file', new Blob(['name,label\n赵六,安全员E\n钱七,安全员F\n'], { type: 'text/csv' }), 'ops.csv');
  const imp = await fetch(`${base}/api/admin/operators/import`, { method: 'POST', headers: auth, body: fd });
  const impData = await imp.json();
  ok(imp.status === 201 && impData.data.inserted === 2, `CSV 导入 inserted=${impData.data?.inserted}`);
  // CR-01 字典 API
  r = await j('POST', '/api/admin/organizations', { name: '某组织B', code: 'ORG-B' }, auth);
  ok(r.status === 201, '后台新增组织 201');
  r = await j('POST', '/api/admin/organizations', { name: '某组织B' }, auth);
  ok(r.status === 409 && r.data.code === 'CONFLICT', '组织重名 → 409 CONFLICT');
  const fdi = new FormData();
  fdi.append('file', new Blob(['name,department\n李四,生产部\n'], { type: 'text/csv' }), 'ini.csv');
  const impI = await fetch(`${base}/api/admin/initiators/import`, { method: 'POST', headers: auth, body: fdi });
  const impIData = await impI.json();
  ok(impI.status === 201 && impIData.data.inserted === 1, `发起人 CSV 导入 inserted=${impIData.data?.inserted}`);
  r = await j('POST', '/api/admin/operators', { name: '离职者', employeeNo: 'E9', employed: 0 }, auth);
  ok(r.status === 201 && r.data.data.employed === 0, '后台新增离职安全员');
  r = await j('GET', '/api/operators?active=1');
  ok(r.data.data.every((o) => o.name !== '离职者'), '离职者不出现在选人页');

  console.log('[7] C6 幂等');
  const key = 'e2e-idem-1';
  const a = await j('POST', '/api/sessions/start', { operatorId: op2, vehicleId: vId }, { 'Idempotency-Key': key });
  // op2 已有进行中(sid2) → busy；改用新 operator
  await j('POST', `/api/sessions/${sid2}/stop`, { operatorId: op2 });
  const c1 = await j('POST', '/api/sessions/start', { operatorId: op2, vehicleId: vId }, { 'Idempotency-Key': key });
  const c2 = await j('POST', '/api/sessions/start', { operatorId: op2, vehicleId: vId }, { 'Idempotency-Key': key });
  ok(c1.status === 201 && c2.status === 200 && c1.data.data.session.id === c2.data.data.session.id, '同 Idempotency-Key 重放返回同一会话');

  console.log('[8] SPA 静态托管');
  const page = await fetch(`${base}/work`);
  const html = await page.text();
  ok(page.status === 200 && html.includes('<div id="app">'), 'SPA 路由回退返回 index.html');

  console.log('[9] CR-01-BE2：公开 initiators + 后台别名');
  r = await j('GET', '/api/initiators'); // 无需登录
  ok(r.status === 200 && Array.isArray(r.data.data), 'GET /api/initiators 公开可访问');
  ok(r.data.data.every((i) => i.name && 'department' in i && !('active' in i)), 'initiators 仅返回 {id,name,department}');
  ok(r.data.data.find((i) => i.name === '张三') && r.data.data.find((i) => i.name === '李四'), 'initiators 含启用发起人（张三/李四）');
  // 停用一个发起人后应消失
  r = await j('GET', '/api/admin/initiators', undefined, auth);
  const li = r.data.data.find((i) => i.name === '李四');
  await j('DELETE', `/api/admin/initiators/${li.id}`, undefined, auth);
  r = await j('GET', '/api/initiators');
  ok(!r.data.data.find((i) => i.name === '李四'), '停用发起人不出现在公开下拉');

  r = await j('GET', '/api/admin/sessions');
  ok(r.status === 401, '/api/admin/sessions 未登录 401');
  r = await j('GET', '/api/admin/sessions?page=1&pageSize=50', undefined, auth);
  const pubSess = await j('GET', '/api/sessions?page=1&pageSize=50');
  ok(r.status === 200 && r.data.data.total === pubSess.data.data.total, '/api/admin/sessions 语义同公开');

  r = await j('GET', '/api/admin/export?format=csv');
  ok(r.status === 401, '/api/admin/export 未登录 401');
  const admExp = await fetch(`${base}/api/admin/export?format=csv`, { headers: auth });
  const pubExp = await fetch(`${base}/api/export?format=csv`);
  const admCsv = (await admExp.text()).replace(/^\ufeff/, '');
  const pubCsv = (await pubExp.text()).replace(/^\ufeff/, '');
  ok(admExp.status === 200 && admCsv === pubCsv, '/api/admin/export 与公开导出一致');
  const admCols = admCsv.trim().split(/\r?\n/)[1].split(',');
  ok(admCols[0] === '某组织A' && admCols[1] === '某供应商A' && admCols[5] === '张三', 'admin 导出 组织/供应商/发起人 3 列带出');

  console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  server.close();
  try {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
