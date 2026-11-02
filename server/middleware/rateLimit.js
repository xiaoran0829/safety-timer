// CR-12：登录限流（内存实现；单进程；重启清零，可接受）。
// 背景：昨日登录失败率 74%，出现单账号 69 次 / 单手机号 74 次 / 1 分钟 53 次的暴力重试。
// 设计：
//   主手段 = 按「账号」连续失败锁定：同账号在窗口内连续失败 N 次 → 锁定时长内直接 429。
//   辅手段 = 按「客户端 IP」失败上限（阈值宽松）：同 IP 在窗口内失败 > 上限 → 429，
//            仅统计**失败**尝试，避免同办公网关/NAT 下早高峰正常打卡被误伤。
// 触发限流时复用 writeLoginLog 落一行 result=fail, reason=RATE_LIMITED（写日志失败被吞，不影响主流程）。
// 说明：后台与 H5 各自实例化（各自独立计数/锁定），互不影响；env 单口令兜底通道账号为空，
//       不参与账号锁定（保留「防锁死」语义），仅 IP 上限对兜底通道生效。
import { ApiError } from '../lib/errors.js';
import { writeLoginLog, clientIp } from '../services/loginLog.js';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

// 阈值（环境变量可覆盖，均给安全默认值）
const ACCOUNT_MAX_FAILS = num(process.env.LOGIN_ACCOUNT_MAX_FAILS, 5); // 账号连续失败次数
const ACCOUNT_WINDOW_MS = num(process.env.LOGIN_ACCOUNT_WINDOW_MS, 15 * 60 * 1000); // 账号计数窗口
const ACCOUNT_LOCK_MS = num(process.env.LOGIN_ACCOUNT_LOCK_MS, 15 * 60 * 1000); // 账号锁定时长
const IP_MAX_FAILS = num(process.env.LOGIN_IP_MAX_FAILS, 30); // 同 IP 失败上限（宽松）
const IP_WINDOW_MS = num(process.env.LOGIN_IP_WINDOW_MS, 5 * 60 * 1000); // IP 计数窗口
const IP_LOCK_MS = num(process.env.LOGIN_IP_LOCK_MS, 5 * 60 * 1000); // IP 锁定时长

// 计数器内存清理（避免 Map 无界增长）：每 N 次调用顺带清理过期项，或条目过多时清理
const PRUNE_EVERY = 500;
const MAX_ENTRIES = 20000;

/** 账号归一化（与登录口径一致：trim + 小写），空 → null（不参与账号计数）。 */
const normAccount = (v) => {
  const s = v === undefined || v === null ? '' : String(v).trim().toLowerCase();
  return s || null;
};

/**
 * 生成登录限流中间件（挂在登录路由最前面、body 解析之后）。
 * @param {{db:any, source:'admin'|'h5'}} opts
 * @returns {import('express').RequestHandler}
 */
export function loginRateLimit({ db, source }) {
  const accounts = new Map(); // account -> {count, since, lockedUntil}
  const ips = new Map(); // ip -> {count, since, lockedUntil}
  let calls = 0;

  /** 返回 key 的锁定截止时间戳（0 = 未锁）；锁已过期则清零该 key。 */
  const lockedUntilOf = (map, key) => {
    if (!key) return 0;
    const e = map.get(key);
    if (!e) return 0;
    const t = Date.now();
    if (e.lockedUntil > t) return e.lockedUntil;
    if (e.lockedUntil) map.delete(key); // 锁定已过期 → 清零
    return 0;
  };

  /** 计一次失败；窗口内达到上限即置锁并清零计数。 */
  const bump = (map, key, windowMs, maxFails, lockMs) => {
    if (!key) return;
    const t = Date.now();
    let e = map.get(key);
    if (!e || t - e.since > windowMs) e = { count: 0, since: t, lockedUntil: 0 };
    e.count += 1;
    if (e.count >= maxFails) {
      e.lockedUntil = t + lockMs;
      e.count = 0;
    }
    map.set(key, e);
  };

  const prune = () => {
    const t = Date.now();
    for (const [k, e] of accounts) if (e.lockedUntil <= t && t - e.since > ACCOUNT_WINDOW_MS) accounts.delete(k);
    for (const [k, e] of ips) if (e.lockedUntil <= t && t - e.since > IP_WINDOW_MS) ips.delete(k);
  };

  return function rateLimitMw(req, res, next) {
    if (++calls % PRUNE_EVERY === 0 || accounts.size + ips.size > MAX_ENTRIES) prune();

    const account = normAccount(req.body && req.body.username);
    const ip = clientIp(req);

    // 命中锁定 → 直接 429，并留痕 RATE_LIMITED（写日志失败被吞）
    const until = Math.max(lockedUntilOf(accounts, account), lockedUntilOf(ips, ip));
    if (until > Date.now()) {
      const retryAfter = Math.max(1, Math.ceil((until - Date.now()) / 1000));
      writeLoginLog(db, { account, source, result: 'fail', reason: 'RATE_LIMITED', req });
      res.set('Retry-After', String(retryAfter));
      throw new ApiError('RATE_LIMITED', 429, `登录尝试过于频繁，请 ${Math.ceil(retryAfter / 60)} 分钟后再试`);
    }

    // 捕获最终结果：>=400 记为失败（含校验失败/凭据错误/停用等），<400 记为成功。
    const send = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 400) {
        bump(accounts, account, ACCOUNT_WINDOW_MS, ACCOUNT_MAX_FAILS, ACCOUNT_LOCK_MS);
        bump(ips, ip, IP_WINDOW_MS, IP_MAX_FAILS, IP_LOCK_MS);
      } else if (account) {
        accounts.delete(account); // 成功登录 → 重置该账号「连续失败」
      }
      return send(body);
    };
    next();
  };
}
