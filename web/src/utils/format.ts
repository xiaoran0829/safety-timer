const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 幂等键：优先 crypto.randomUUID；非安全上下文（局域网 http）回退手写 UUID v4 */
export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 秒 → HH:MM:SS */
export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * 秒 → 有效计费时长（h），保留 2 位小数。
 * 主人令（2026-10-07 09:37）：计时记录页 / 详细工时页在「试验实际时长」右侧展示该列。
 */
export function billableHours(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  return (s / 3600).toFixed(2);
}

/** 'YYYY-MM-DD HH:mm:ss' → 'HH:mm:ss' */
export function hms(ts: string | null): string {
  return ts ? ts.slice(11, 19) : '';
}

/** 'YYYY-MM-DD HH:mm:ss' → 'YYYY-MM-DD HH:mm' */
export function toMinute(ts: string | null): string {
  return ts ? ts.slice(0, 16) : '';
}

/** 今天 YYYY-MM-DD（本地/上海一致，浏览器时区视为东八） */
export function todayStr(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function nowCompact(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** 当前「上海墙上时间」'YYYY-MM-DD HH:mm:ss'（需求⑫：点按瞬间取 at 用） */
export function nowDateTime(d = new Date(Date.now() + 8 * 60 * 60 * 1000)): string {
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}
