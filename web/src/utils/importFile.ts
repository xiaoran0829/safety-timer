/**
 * 导入文件前端闸门 + CSV 模板下载（与后端口径一致）
 * 用途：导入前校验扩展名/大小，避免把二进制/超大文件传到「CSV 口」；
 *      并提供「下载模板」，让主人直接拿到带表头样例的 CSV（Excel 可另存为 .xlsx 上传）。
 */

export const IMPORT_ACCEPT =
  '.csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

const OK_EXT = ['.csv', '.xlsx', '.xls'];

/** 返回错误提示；合法返回 null */
export function checkImportFile(f: File | null | undefined): string | null {
  if (!f) return '未选择文件';
  const name = String(f.name || '').toLowerCase();
  if (!OK_EXT.some((e) => name.endsWith(e))) return '只支持 .csv / .xlsx / .xls 文件';
  if (f.size === 0) return '文件内容为空，请检查后再上传';
  if (f.size > MAX_IMPORT_BYTES) return `文件过大（超过 ${MAX_IMPORT_BYTES / 1024 / 1024}MB），请拆分后再导入`;
  return null;
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** 下载 CSV 模板（UTF-8 BOM，Excel 双击不乱码） */
export function downloadCsvTemplate(filename: string, headers: string[], samples: string[][] = []) {
  const lines = [headers, ...samples].map((r) => r.map((c) => csvCell(String(c ?? ''))).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + lines + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
