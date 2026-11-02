// C6 幂等：客户端 Idempotency-Key 重放返回首次结果，不重复建/结算。
// 说明：内部基础设施表（非冻结模型的一部分，不改冻结字段/接口）。
import { fmtDateTime } from './time.js';

export function withIdempotency(db, key, scope, producer) {
  if (!key) return { replayed: false, result: producer() };
  const k = `${scope}:${String(key)}`;
  const row = db.prepare('SELECT response FROM idempotency WHERE key=?').get(k);
  if (row) {
    try {
      return { replayed: true, result: JSON.parse(row.response) };
    } catch {
      /* 损坏则重算 */
    }
  }
  const result = producer();
  db.prepare('INSERT OR IGNORE INTO idempotency(key,response,created_at) VALUES(?,?,?)').run(
    k,
    JSON.stringify(result),
    fmtDateTime()
  );
  return { replayed: false, result };
}
