// CR-11 登录日志域：login_log 幂等建表/建索引（纯新增，不动既有表）。
// ---------------------------------------------------------------------------
// 口径（主人 15:51/15:55）：
//   - 只记「登录」：安全员 H5 登录 + 后台账号登录；成功/失败都记。
//   - 字段：账号/姓名/角色(admin|engineer|fleet_admin|operator)/类型(admin|h5)/时间/IP/UA/结果(+失败原因码)。
//   - 预留：后续可扩「操作日志」(改派/取消/账号变更等)，本期只建登录表、只铺登录点。
// 幂等：DDL 全 IF NOT EXISTS；可重复调用。
// 隐私：**绝不记录口令/派生值/盐/令牌**（CHK-SEND-03）。
export const LOGIN_LOG_DDL = `
CREATE TABLE IF NOT EXISTS login_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account    TEXT,                                          -- 登录账号名（安全员=工号；后台=用户名；单口令兜底=NULL）
  name       TEXT,                                          -- 姓名（成功时可取；失败可能为 NULL）
  role       TEXT,                                          -- admin|engineer|fleet_admin|operator(安全员)
  source     TEXT    NOT NULL CHECK(source IN ('admin','h5')), -- 类型：后台 / 安全员 H5
  result     TEXT    NOT NULL CHECK(result IN ('ok','fail')),  -- 结果：成功 / 失败
  reason     TEXT,                                          -- 失败原因码（VALIDATION/INVALID_CREDENTIALS/ACCOUNT_INACTIVE…）
  ip         TEXT,                                          -- 客户端 IP（经 trust proxy 解析 XFF）
  ua         TEXT,                                          -- User-Agent
  created_at TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS ix_login_log_created ON login_log(created_at);
CREATE INDEX IF NOT EXISTS ix_login_log_account ON login_log(account);
CREATE INDEX IF NOT EXISTS ix_login_log_source ON login_log(source, result);
`;

/**
 * 幂等建表/建索引。可重复调用。
 * @param {import('better-sqlite3').Database} db
 */
export function ensureLoginLogSchema(db) {
  db.exec(LOGIN_LOG_DDL);
  return db;
}
