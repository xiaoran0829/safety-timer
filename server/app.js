import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorHandler } from './lib/http.js';
import { operatorsRouter } from './routes/operators.js';
import { initiatorsRouter } from './routes/initiators.js';
import { vehiclesRouter } from './routes/vehicles.js';
import { sessionsRouter } from './routes/sessions.js';
import { exportRouter } from './routes/export.js';
import { adminRouter } from './routes/admin.js';
import { h5Router } from './routes/h5auth.js'; // CR-06：H5 安全员账号登录
import { h5Router as h5ScheduleRouter } from './routes/h5.js'; // CR-07：H5 排班（草案）

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ db, adminPassword, adminUser } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // CR-11：后台/接口在 frp/反代之后 → 设信任代理，使 req.ip 能取到 XFF 真实客户端 IP（登录日志用）。
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  // CR-06：把 db 挂到 req 上，供鉴权层按 role 比对 pwd_ver（不依赖模块级全局状态）
  app.use((req, _res, next) => {
    req.db = db;
    next();
  });

  const api = express.Router();
  api.use('/operators', operatorsRouter(db));
  api.use('/initiators', initiatorsRouter(db));
  api.use('/vehicles', vehiclesRouter(db));
  api.use('/sessions', sessionsRouter(db));
  api.use('/export', exportRouter(db));
  api.use('/h5', h5ScheduleRouter(db)); // CR-07：H5 排班（需 operator token；先挂，避免被 CR-06 路由级闸门拦截）
  api.use('/h5', h5Router(db)); // CR-06：H5 登录/改密
  api.use('/admin', adminRouter(db, { adminPassword, adminUser }));
  api.get('/health', (_req, res) => res.json({ ok: true, data: { status: 'up' } }));
  app.use('/api', api);

  // SPA 静态托管（同源单进程部署）
  const publicDir = path.resolve(__dirname, 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  app.use((req, res) => {
    res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '接口不存在' });
  });
  app.use(errorHandler);
  return app;
}
