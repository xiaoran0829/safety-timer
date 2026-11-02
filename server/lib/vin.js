// 车架号（VIN）格式校验
// 口径（主人/CEO 定）：17 位字母数字，仅大写；字母排除 I / O / Q（避免与 1 / 0 混淆）
// 用途：导入口“不合法则跳过并计入 errors，禁止落库脏数据”（2026-09-29 乱码事故治本）

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/** 归一化：去空白 + 转大写（容忍小写粘贴） */
export function normalizeVin(v) {
  return String(v ?? '').trim().toUpperCase();
}

/** 是否合法车架号 */
export function isValidVin(v) {
  return VIN_RE.test(normalizeVin(v));
}

/** 给用户看的口径提示（与 FE 模板/提示一致） */
export const VIN_HINT = '车架号需为 17 位字母数字（不含 I/O/Q）';
