// 演示/联调种子数据（可选）：node seed.js
// 幂等：按名称/车架号判存，重复执行不产生重复数据；
// CR-01 补充：对**已存在**的车架号按 VIN 映射回填 org_id/supplier_id/default_initiator_id（UPDATE，幂等）。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'safety-timer.db');

const ops = [
  ['张伟', '安全员A', '13800000001', 10],
  ['李强', '安全员B', '13800000002', 20],
  ['王芳', '安全员C', '13800000003', 30],
];

// CR-01（§11）：字典 + 车架号挂靠
const orgs = [
  ['某组织A', 'ORG-A', 10],
  ['某组织B', 'ORG-B', 20],
];
const sups = [
  ['某供应商A', 'SUP-A', 10],
  ['某供应商B', 'SUP-B', 20],
];
const inits = [
  ['张三', '技术部', 10],
  ['李四', '生产部', 20],
];
// 车架号挂靠映射：车1→org1/sup1/init1；车2→org1/sup2/init2；车3→org2/sup1/init1；车4→org2/sup2/init2
const vehs = [
  ['LSVAB1234K5678901', '工位A', '某组织A', '某供应商A', '张三', 1],
  ['LSVAB1234K5678902', '工位B', '某组织A', '某供应商B', '李四', 2],
  ['LSVAB1234K5678903', '工位C', '某组织B', '某供应商A', '张三', 3],
  ['LSVAB1234K5678905', '工位D', '某组织B', '某供应商B', '李四', 4],
];

/**
 * 幂等播种：可重复调用（导入/测试复用）。
 * @param {import('better-sqlite3').Database} db
 */
export function seed(db) {
  const insOp = db.prepare('INSERT OR IGNORE INTO operator(name,label,phone,active,sort) VALUES(?,?,?,1,?)');
  const insOrg = db.prepare('INSERT OR IGNORE INTO organization(name,code,active,sort) VALUES(?,?,1,?)');
  const insSup = db.prepare('INSERT OR IGNORE INTO supplier(name,code,active,sort) VALUES(?,?,1,?)');
  const insInit = db.prepare('INSERT INTO initiator(name,department,active,sort) VALUES(?,?,1,?)');
  const initExists = db.prepare('SELECT 1 FROM initiator WHERE name=?');
  const insVeh = db.prepare(
    'INSERT OR IGNORE INTO vehicle(vin,station,org_id,supplier_id,default_initiator_id,active,sort) VALUES(?,?,?,?,?,1,?)'
  );
  // CR-01：已存在（历史遗留）车架号的挂靠回填——按 VIN 幂等 UPDATE，重复运行结果一致。
  const backfillVeh = db.prepare(
    'UPDATE vehicle SET org_id=?, supplier_id=?, default_initiator_id=? WHERE vin=?'
  );
  const orgByName = db.prepare('SELECT id FROM organization WHERE name=?');
  const supByName = db.prepare('SELECT id FROM supplier WHERE name=?');
  const initByName = db.prepare('SELECT id FROM initiator WHERE name=?');

  const tx = db.transaction(() => {
    for (const o of ops) insOp.run(...o);
    for (const o of orgs) insOrg.run(...o);
    for (const s of sups) insSup.run(...s);
    for (const i of inits) if (!initExists.get(i[0])) insInit.run(...i);
    for (const [vin, station, orgName, supName, initName, sort] of vehs) {
      const orgId = orgByName.get(orgName)?.id ?? null;
      const supId = supByName.get(supName)?.id ?? null;
      const initId = initByName.get(initName)?.id ?? null;
      insVeh.run(vin, station, orgId, supId, initId, sort); // 新建（不存在时）
      backfillVeh.run(orgId, supId, initId, vin); // 已存在时回填挂靠（幂等）
    }
  });
  tx();
  return db;
}

const n = (db, t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

function main() {
  const db = openDb(DB_FILE);
  seed(db);
  console.log(
    `[seed] operators=${n(db, 'operator')} vehicles=${n(db, 'vehicle')} organizations=${n(db, 'organization')} suppliers=${n(db, 'supplier')} initiators=${n(db, 'initiator')} (${DB_FILE})`
  );
  db.close();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
