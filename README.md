# 安全员工作计时系统

面向现场安全员的作业计时系统：安全员在手机 H5 上选择本人、选择车架号后开始计时，支持暂停 / 恢复 / 停止 / 备注，后端权威落库并自动生成工单号，管理端负责排班、字典、账号、审批、日志与工时导出。

> 本仓库仅包含源代码（前端 + 后端 + 测试），不含任何数据库、业务数据、日志、备份、部署口令或内部网络信息。

## 功能概览

**安全员端（H5，手机）**
- 账号登录 / 修改密码；选人 → 选车架号 → 开始计时
- 暂停、恢复、停止、备注；跨会话冲突提示（同一安全员同一时刻只能对一辆车计时）
- 今日记录查看；里程录入（出车 / 收车里程）

**管理端（后台）**
- 安全员、车辆、组织、供应商、发起人、班次等字典管理
- 排班与改派（含留痕）；工单会话查看与订正
- 后台用户与角色、菜单权限、操作日志、登录日志
- 任务延时等审批流；工时导出 Excel / CSV（时间轴、有效计费时长、行驶里程等列）

**自动化**
- 工单号按天自增（`WO-YYYYMMDD-序号`，事务内生成）
- 到班次结束时间后自动结束挂起工单（可选 dry-run 观察模式）
- 登录限流、幂等键、VIN 校验、CSV / Excel 导入

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3 + Vite + TypeScript + Vue Router + Pinia + Element Plus（后台）+ Vant 4（H5） |
| 后端 | Node.js 22 + Express + better-sqlite3（SQLite，WAL） |
| 测试 | Vitest + Supertest |
| 部署 | 单进程同源托管（后端同时提供 API 与前端静态文件） |

## 目录结构

```
.
├─ server/                 # 后端（Express + SQLite）
│  ├─ index.js             # 启动入口（端口、DB、自动结束清扫）
│  ├─ app.js               # 应用装配（路由、静态托管、错误处理）
│  ├─ db.js                # 建库 / 迁移 / 初始化
│  ├─ routes/              # HTTP 路由：admin、approvals、dicts、export、h5、h5auth …
│  ├─ services/            # 业务服务：timer、schedule、autoEnd、export、loginLog …
│  ├─ lib/                 # 通用能力：时间、CSV、幂等、范围权限、令牌、VIN …
│  ├─ middleware/          # 鉴权、限流
│  ├─ migrations/          # 增量迁移（登录日志、排班、审批）
│  ├─ scripts/             # 数据回填、E2E 冒烟脚本
│  ├─ test/                # Vitest 用例（接口、并发、审批、导出、角色 …）
│  └─ seed.js              # 演示数据（假数据，可直接重置本地库）
└─ web/                    # 前端（Vue 3 + Vite + TS）
   ├─ src/api/             # 接口封装（后台 / H5 各一套客户端）
   ├─ src/components/      # 计时、选人、选车、备注、里程等组件
   ├─ src/views/           # H5 页面 + admin/ 后台页面
   ├─ src/stores/          # Pinia 状态
   └─ vite.config.ts       # 开发代理 /api → 后端
```

## 快速开始

前置：Node.js 22+，npm。

**1. 后端**

```bash
cd server
npm install
npm run seed        # 可选：写入演示数据
npm start           # 默认 http://0.0.0.0:19300
```

**2. 前端**

```bash
cd web
npm install
npm run dev         # 开发服务器，/api 代理到 127.0.0.1:19300
npm run build       # 产物写入 web/dist
```

生产部署时把 `web/dist` 的内容放到 `server/public/`，由后端同源托管；也可直接使用仓库外的反向代理。

**3. 测试**

```bash
cd server
npm test            # vitest run
```

## 环境变量（server）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `19300` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_FILE` | `server/safety-timer.db` | SQLite 文件路径 |
| `ADMIN_USER` | `admin` | 初始管理员账号 |
| `ADMIN_INIT_PASSWORD` | 空 | 仅在账号表为空时用于创建初始管理员 |
| `ADMIN_PASSWORD` | `safety-timer` | 单口令后台通道（生产环境务必覆盖） |
| `AUTH_SECRET` | 自动生成 | 令牌签名密钥 |
| `SCHEDULE_ENFORCE` | 关 | 是否强制排班 |
| `AUTO_END_DRYRUN` / `AUTO_END_MODE` | observe | 自动结束模式：`live` 写入 / 仅观察 |
| `AUTO_END_BUFFER_MIN` | `30` | 班次结束后缓冲分钟数 |
| `AUTO_END_MAX_HOURS` | `0` | 计时硬顶小时数（0 为不限） |
| `AUTO_END_INTERVAL_MS` | `120000` | 自动结束扫描间隔 |
| `AUTO_END_DISABLED` | `0` | 置 1 关闭自动结束 |

## 关键业务规则

1. 一个安全员同一时间只能对一辆车计时（互斥，数据库唯一索引兜底）。
2. 工单号由系统生成、按天自增，事务内保证唯一。
3. 实际工时 = 净时长 = Σ 工作分段（自动扣除暂停）。
4. 导出列序固定，包含有效计费时长、行驶里程等对账字段。

## 数据与合规说明

- 仓库内只有源代码与测试，测试与演示数据均为虚构样例（如 `张伟 / 13800000001`）。
- 数据库文件、导出文件、日志、备份、部署脚本与运行环境配置（`*.env` 等）均通过 `.gitignore` 排除，不入库。
- 生产口令、密钥、内网地址不在仓库中维护；部署时通过环境变量注入。

## 许可

[MIT](LICENSE)。欢迎 Issue / PR；生产使用请自行替换默认口令并做好数据备份。
