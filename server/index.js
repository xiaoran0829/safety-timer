// 启动入口：Express API + 静态托管 Vue dist（同源单进程）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ensureInitialAdmin } from './db.js';
import { createApp } from './app.js';
import { startAutoEndSweeper, resolveAutoEndMode } from './services/autoEnd.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 19300);
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'safety-timer.db');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'safety-timer';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_INIT_PASSWORD = process.env.ADMIN_INIT_PASSWORD;

const db = openDb(DB_FILE);
// CR-03 启动引导（幂等）：仅当账号表为空且提供 ADMIN_INIT_PASSWORD 时建初始管理员；口令不打印。
if (ensureInitialAdmin(db, { username: ADMIN_USER, password: ADMIN_INIT_PASSWORD })) {
  console.log(`[safety-timer] 已初始化管理员账号：${ADMIN_USER}`);
}
const app = createApp({ db, adminPassword: ADMIN_PASSWORD, adminUser: ADMIN_USER });

// CR-13：工单自动结束清扫（依「班次结束时间」口径；默认每 2min；缓冲默认 30min；AUTO_END_MAX_HOURS=0 关硬顶）
// 模式：AUTO_END_DRYRUN=1→只记日志不写库（dry-run）；=0→真写；未设→AUTO_END_MODE；均未设→observe（安全默认，CEO 裁定）
const { mode: AUTO_END_MODE, source: AUTO_END_MODE_SRC } = resolveAutoEndMode(process.env);
const AUTO_END_BUFFER_MIN = Number(process.env.AUTO_END_BUFFER_MIN ?? 30);
const AUTO_END_MAX_HOURS = Number(process.env.AUTO_END_MAX_HOURS ?? 0);
const AUTO_END_INTERVAL_MS = Number(process.env.AUTO_END_INTERVAL_MS ?? 120000);
if (Number(process.env.AUTO_END_DISABLED ?? 0) !== 1) {
  startAutoEndSweeper(db, {
    bufferMin: AUTO_END_BUFFER_MIN,
    maxHours: AUTO_END_MAX_HOURS,
    intervalMs: AUTO_END_INTERVAL_MS,
    mode: AUTO_END_MODE,
  });
  console.log(
    `[safety-timer] 自动结束已启用：【${AUTO_END_MODE === 'live' ? 'live 写入' : 'dry-run 观察（零写入）'}】` +
      `（source=${AUTO_END_MODE_SRC}）` +
      `；口径：过班次结束时间+${AUTO_END_BUFFER_MIN}min 缓冲` +
      (AUTO_END_MAX_HOURS > 0 ? `；硬顶 >${AUTO_END_MAX_HOURS}h` : '') +
      `（每 ${Math.round(AUTO_END_INTERVAL_MS / 1000)}s 扫描）`
  );
} else {
  console.warn('[safety-timer] 自动结束已关闭（AUTO_END_DISABLED=1）');
}

app.listen(PORT, HOST, () => {
  console.log(`[safety-timer] listening on http://${HOST}:${PORT}`);
  console.log(`[safety-timer] db=${DB_FILE}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('[safety-timer] ⚠️ 未设置 ADMIN_PASSWORD，使用默认口令，请在生产环境配置！');
  }
});
