/**
 * 批量补「车架号 → 组织/供应商」挂靠（数据治理工具）
 * ---------------------------------------------------------------------------
 * 背景（主人 2026-09-29）：有若干车架号的组织/供应商未建字典项或未挂靠。
 * 口径：**不新增车架号**（新车架号一律走后台/导入），只做
 *   ① 字典补建：organization / supplier 里缺的名字 → 新增（active=1，可后续在后台停用）
 *   ② 挂靠补齐：vehicle.org_id / supplier_id（并同步旧文本列 org/supplier，与后台 PUT 行为一致）
 *
 * 用法：
 *   node scripts/apply-vehicle-org-supplier.mjs rows.json            # 干跑（默认）
 *   node scripts/apply-vehicle-org-supplier.mjs rows.json --apply    # 落库
 * 环境变量 DB_FILE 指定库（默认 server/safety-timer.db）。
 *
 * rows.json 结构：
 *   { "rows": [ { "vin": "LS6BME2PXSA748586", "org": "中汽创智", "supplier": "贵州宽凳", "station": "工位A" } ] }
 *   · org / supplier / station 均可选；只写给出的字段。
 *
 * 安全：单事务（BEGIN IMMEDIATE）；未知 VIN 只报错不新建；干跑不写库。
 */
import fs from 'fs';
import { openDb } from '../db.js';

const DB_FILE = process.env.DB_FILE || new URL('../safety-timer.db', import.meta.url).pathname;
const [file, ...flags] = process.argv.slice(2);
const APPLY = flags.includes('--apply');
if (!file) {
  console.error('用法: node scripts/apply-vehicle-org-supplier.mjs rows.json [--apply]');
  process.exit(2);
}
const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = Array.isArray(payload) ? payload : payload.rows || [];
if (!rows.length) {
  console.error('输入为空：需要 [{ vin, org?, supplier?, station? }]');
  process.exit(2);
}

const db = openDb(DB_FILE);
const before = {
  org: db.prepare('SELECT COUNT(*) c FROM organization').get().c,
  sup: db.prepare('SELECT COUNT(*) c FROM supplier').get().c,
};

const findDict = (table, name) => db.prepare(`SELECT * FROM ${table} WHERE name = ?`).get(name);
const ensureDict = (table, name, newNames) => {
  const hit = findDict(table, name);
  if (hit) {
    if (!hit.active) newNames.reactivate.push(`${table}#${hit.id} ${name}（当前停用）`);
    return { id: hit.id, created: false, wasInactive: !hit.active };
  }
  if (!APPLY) {
    newNames.create.push(`${table} ${name}`);
    return { id: null, created: true };
  }
  const info = db.prepare(`INSERT INTO ${table}(name,active,sort) VALUES(?,1,0)`).run(name);
  newNames.create.push(`${table} ${name}`);
  return { id: Number(info.lastInsertRowid), created: true };
};

const plan = { dict: { create: [], reactivate: [] }, veh: [], unknown: [], errors: [] };

db.exec('BEGIN IMMEDIATE');
try {
  for (const row of rows) {
    const vin = String(row.vin || '').trim();
    if (!vin) {
      plan.errors.push('缺 vin 的行被跳过');
      continue;
    }
    const v = db.prepare('SELECT * FROM vehicle WHERE vin = ?').get(vin);
    if (!v) {
      plan.unknown.push(vin); // 不新建车架号
      continue;
    }
    const set = [];
    const args = [];
    if (row.org != null && String(row.org).trim() !== '') {
      const d = ensureDict('organization', String(row.org).trim(), plan.dict);
      set.push('org_id=?, org=?');
      args.push(d.id, String(row.org).trim());
    }
    if (row.supplier != null && String(row.supplier).trim() !== '') {
      const d = ensureDict('supplier', String(row.supplier).trim(), plan.dict);
      set.push('supplier_id=?, supplier=?');
      args.push(d.id, String(row.supplier).trim());
    }
    if (row.station != null && String(row.station).trim() !== '') {
      set.push('station=?');
      args.push(String(row.station).trim());
    }
    if (!set.length) continue;
    plan.veh.push({ vin, id: v.id, from: { org_id: v.org_id, supplier_id: v.supplier_id }, to: { org: row.org ?? null, supplier: row.supplier ?? null } });
    if (APPLY) db.prepare(`UPDATE vehicle SET ${set.join(', ')} WHERE id=?`).run(...args, v.id);
  }
  if (APPLY) db.exec('COMMIT');
  else db.exec('ROLLBACK');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('已回滚：', e.message);
  process.exit(1);
}

const after = {
  org: db.prepare('SELECT COUNT(*) c FROM organization').get().c,
  sup: db.prepare('SELECT COUNT(*) c FROM supplier').get().c,
};
console.log(`库: ${DB_FILE}  模式: ${APPLY ? 'APPLY' : 'DRY-RUN'}  输入 ${rows.length} 行`);
console.log(`字典补建: ${plan.dict.create.length ? plan.dict.create.join(' | ') : '（无）'}`);
if (plan.dict.reactivate.length) console.log(`⚠️ 命中停用字典项（未自动启用，需人工决定）: ${plan.dict.reactivate.join(' | ')}`);
console.log(`挂靠更新: ${plan.veh.length} 条${plan.veh.length ? '\n  ' + plan.veh.map((x) => `#${x.id} ${x.vin} → org=${x.to.org ?? '(不变)'} supplier=${x.to.supplier ?? '(不变)'}`).join('\n  ') : ''}`);
if (plan.unknown.length) console.log(`⚠️ 未知车架号（未新建，需先到后台/导入添加）: ${plan.unknown.join(', ')}`);
if (plan.errors.length) console.log(`⚠️ ${plan.errors.join('; ')}`);
console.log(`字典条数: organization ${before.org} → ${after.org} | supplier ${before.sup} → ${after.sup}`);
if (!APPLY) console.log('（未落库，加 --apply 生效）');
db.close();
