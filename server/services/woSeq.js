// 工单号规则（冻结规格 §2）
// 格式 WO-YYYYMMDD-序号；序号 3 位补零，>999 自动扩位为 4 位，不截断。
// 序号按服务器自然日（Asia/Shanghai）重置；生成须在 BEGIN IMMEDIATE 事务内，与插入会话同事务。
import { compactDay } from '../lib/time.js';

/**
 * 在“当前事务上下文”内生成下一个工单号。
 * @param {import('better-sqlite3').Database} db
 * @param {string} [day] YYYYMMDD，默认取服务器当天
 * @returns {string} 如 WO-20260929-001
 */
export function nextWorkOrderNo(db, day = compactDay()) {
  db.prepare(
    `INSERT INTO wo_sequence(day,last_seq) VALUES(?,1)
     ON CONFLICT(day) DO UPDATE SET last_seq=last_seq+1`
  ).run(day);

  const row = db
    .prepare(
      `SELECT 'WO-'||?||'-'||printf('%0'||(CASE WHEN last_seq>999 THEN 4 ELSE 3 END)||'d', last_seq) AS wono
       FROM wo_sequence WHERE day=?`
    )
    .get(day, day);
  return row.wono;
}
