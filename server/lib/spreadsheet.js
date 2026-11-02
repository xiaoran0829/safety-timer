// 批量导入统一解析：CSV + Excel(.xlsx/.xls)。
// 新增文件，不改动既有 lib/csv.js；供 车架号 / 安全员 / 排班 三处导入复用。
//
// 设计要点：
//  - 返回「二维数组行」（string[][]），与 parseCsv 输出**同形** → 各业务解析逻辑零改动。
//  - 自动识别：按文件扩展名(.xlsx/.xls) 或 ZIP 魔数(PK\x03\x04，xlsx=zip) 判定 Excel；否则回落 CSV。
//  - CSV 路径完全沿用 lib/csv.js（行为不变，兼容 BOM/引号/CRLF）。
import XLSX from 'xlsx';
import { parseCsv } from './csv.js';
import { ERR } from './errors.js';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"  (.xlsx/.xlsm = zip)
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]); // .xls (OLE2 复合文档)

/** 文件名是否 Excel（.xlsx/.xls，大小写不敏感）。 */
export function isExcelName(name = '') {
  return /\.(xlsx|xlsm|xls)$/i.test(String(name || '').trim());
}

export { looksBinary };

function looksLikeZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC);
}

/** .xls（OLE2）魔数识别：老版 Excel 即使文件名丢了扩展名也能认出来。 */
function looksLikeOle(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).equals(OLE_MAGIC);
}

/**
 * 二进制嗅探：返回原因（'nul' | 'utf8' | 'ctrl'），非二进制返回 null。
 *  - 'nul'  ：含 NUL 字节 —— 文本文件绝不该有，硬信号
 *  - 'utf8' ：不是合法 UTF-8（出现 U+FFFD）—— 可能是二进制，**也可能是 GBK/ANSI 中文文本**
 *  - 'ctrl' ：非法控制符占比过高
 */
function binaryReason(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  const sample = buf.subarray(0, 4096);
  if (sample.includes(0x00)) return 'nul';
  const text = sample.toString('utf8');
  if (text.includes('\ufffd')) return 'utf8';
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) bad++;
  }
  return bad / Math.max(1, text.length) > 0.05 ? 'ctrl' : null;
}

function looksBinary(buf) {
  return binaryReason(buf) !== null;
}

/**
 * GBK/ANSI 兼容：Windows 版 Excel「另存为 CSV(逗号分隔)」默认就是 GBK 编码。
 * 严格解码（fatal）+ 无控制符 + 至少含 1 个中文字符 → 认定为 GBK 文本；否则返回 null（当二进制拒掉）。
 */
function decodeGbk(buf) {
  let text;
  try {
    text = new TextDecoder('gbk', { fatal: true }).decode(buf.subarray(0, 1 << 20));
  } catch {
    return null;
  }
  if (text.includes('\ufffd') || text.includes('\u0000')) return null;
  let ctrl = 0;
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) ctrl++;
    if (c >= 0x4e00 && c <= 0x9fff) cjk++;
  }
  if (ctrl > 0 || cjk === 0) return null;
  return text;
}

function binaryErr() {
  return ERR.VALIDATION(
    '文件内容不是有效的 CSV：疑似二进制文件。请上传 .csv（UTF-8，或 Excel 另存为的 GBK/ANSI 也可），或直接用 .xlsx/.xls（支持 Excel 2003 .xls）'
  );
}

/** 解析 Excel → 二维数组行（首个工作表；全空行丢弃；单元格统一转字符串）。 */
export function parseExcel(buffer, { sheet } = {}) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    throw ERR.VALIDATION('Excel 解析失败：' + (e && e.message ? e.message : '文件损坏或格式不支持'));
  }
  const name = sheet || (wb.SheetNames && wb.SheetNames[0]);
  if (!name || !wb.Sheets[name]) throw ERR.VALIDATION('Excel 无可用工作表');
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], {
    header: 1, // 二维数组
    raw: false, // 取格式化文本 → 与 CSV 一样是字符串（避免 1234 变数字、长数字丢精度）
    defval: '',
    blankrows: false,
  });
  return aoa
    .map((row) => (Array.isArray(row) ? row.map((c) => (c == null ? '' : c)) : []))
    .filter((row) => row.some((c) => String(c).trim() !== '')); // 丢弃全空行
}

/**
 * 统一解析入口：CSV / Excel 自适应。
 * @param {Buffer|string} content 文件内容（Buffer 或已读取的文本）
 * @param {string} [filename] 原始文件名（用于按扩展名判定）
 * @returns {string[][]} 二维数组行
 */
export function parseSpreadsheet(content, filename = '') {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  const excel = isExcelName(filename) || looksLikeZip(buf) || looksLikeOle(buf);
  if (!excel) {
    // 防脏数据闸门（2026-09-29 生产事故根因）：非 Excel 且内容含 NUL / 替换字符 / 非法控制符
    // → 判定为二进制误传（如把 .xlsx/.pdf/图片 当 CSV 传），直接 400，绝不落库。
    const reason = binaryReason(buf);
    if (reason === 'utf8') {
      // 非合法 UTF-8：优先尝试 GBK/ANSI（Excel 中文用户最常见的导出编码），成功即按文本解析
      const gbk = decodeGbk(buf);
      if (gbk !== null) return parseCsv(gbk);
      throw binaryErr();
    }
    if (reason !== null) throw binaryErr(); // 'nul' / 'ctrl'：硬二进制信号
    return parseCsv(buf.toString('utf8'));
  }
  return parseExcel(buf);
}

/**
 * 从请求读取并解析导入文件：兼容 multipart(`file`) 与 `body.csv` 文本。
 * @param {import('express').Request} req
 * @returns {string[][]} 二维数组行
 */
export function readUploadRows(req) {
  if (req.file && req.file.buffer) return parseSpreadsheet(req.file.buffer, req.file.originalname || '');
  if (typeof req.body?.csv === 'string') return parseCsv(req.body.csv);
  throw ERR.VALIDATION('缺少文件（multipart 字段名 file；支持 CSV / Excel）');
}
