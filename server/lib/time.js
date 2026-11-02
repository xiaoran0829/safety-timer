// 时间工具 · 统一 Asia/Shanghai（UTC+8）
// 口径（冻结规格 §0）：落库/API 一律 'YYYY-MM-DD HH:mm:ss'（秒精度）；
// 时长落库整数秒，展示 HH:MM:SS；导出「试验开始时间」用 'YYYY-MM-DD HH:mm'。

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 返回“上海墙上时间”对应的 Date（其 UTC getter 即上海本地值） */
export function nowDate() {
  return new Date(Date.now() + TZ_OFFSET_MS);
}

/** 'YYYY-MM-DD HH:mm:ss' */
export function fmtDateTime(d = nowDate()) {
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** 'YYYY-MM-DD HH:mm' */
export function fmtMinute(d = nowDate()) {
  return fmtDateTime(d).slice(0, 16);
}

/** 'YYYY-MM-DD' */
export function fmtDay(d = nowDate()) {
  return fmtDateTime(d).slice(0, 10);
}

/** 'YYYYMMDD'（工单号/文件名用） */
export function compactDay(d = nowDate()) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/**
 * 解析 'YYYY-MM-DD HH:mm:ss' → “墙上时间” epoch ms（即把字面值当 UTC 分量）。
 * 与 nowDate() 同基准，可直接相减求耗时。非法返回 NaN，空返回 null。
 */
export function parseTs(s) {
  if (s === null || s === undefined || s === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return NaN;
  const [, Y, Mo, D, H, Mi, S] = m.map(Number);
  return Date.UTC(Y, Mo - 1, D, H, Mi, S);
}

/** 从 fromStr 到 toDate（默认现在）的整秒差，≥0 */
export function diffSeconds(fromStr, toDate = nowDate()) {
  const from = parseTs(fromStr);
  if (from === null || Number.isNaN(from)) return 0;
  // toDate 为 nowDate() 基准（墙上时间 +8h），与 parseTs 同基准
  return Math.max(0, Math.floor((toDate.getTime() - from) / 1000));
}

/** 整数秒 → 'HH:MM:SS' */
export function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
