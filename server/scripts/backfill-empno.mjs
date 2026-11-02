/**
 * 工号回填（一次性数据治理）：给「启用中且工号为空」的安全员补 6 位数字工号。
 * 口径（主人 2026-09-29 18:08）：工号必填 + 登录账号默认=工号；现有 3 人工号为空 → 随机生成、互不重复、可在后台改。
 * 用法：
 *   node scripts/backfill-empno.mjs            # 干跑，只打印计划
 *   node scripts/backfill-empno.mjs --apply    # 落库
 * 环境变量 DB_FILE 指定库路径（默认 server/safety-timer.db）。
 * 只动 employee_no 一列；不建账号、不改其它字段、不写任何口令。
 */
import { openDb } from '../db.js';

const DB_FILE = process.env.DB_FILE || new URL('../safety-timer.db', import.meta.url).pathname;
const APPLY = process.argv.includes('--apply');
const db = openDb(DB_FILE);

const taken = new Set(
  db
    .prepare("SELECT employee_no FROM operator WHERE employee_no IS NOT NULL AND trim(employee_no) <> ''")
    .all()
    .map((r) => r.employee_no)
);

function gen() {
  for (let i = 0; i < 200; i += 1) {
    const n = String(Math.floor(100000 + Math.random() * 900000)); // 6 位、不以 0 开头
    if (!taken.has(n)) {
      taken.add(n);
      return n;
    }
  }
  throw new Error('工号池冲突过多，中止');
}

const rows = db
  .prepare("SELECT id, name, ifnull(label,'') AS label FROM operator WHERE active=1 AND (employee_no IS NULL OR trim(employee_no)='') ORDER BY id")
  .all();

console.log(`库: ${DB_FILE}  模式: ${APPLY ? 'APPLY' : 'DRY-RUN'}  待补工号: ${rows.length} 人`);
for (const r of rows) {
  const empno = gen();
  console.log(`  · #${r.id} ${r.name}${r.label ? ' / ' + r.label : ''} → 工号 ${empno}`);
  if (APPLY) db.prepare('UPDATE operator SET employee_no=? WHERE id=?').run(empno, r.id);
}
if (!APPLY) console.log('（未落库，加 --apply 生效）');
db.close();
