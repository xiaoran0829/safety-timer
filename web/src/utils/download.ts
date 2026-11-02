/** 解析 Content-Disposition 中的文件名（兼容 filename*=UTF-8''… 与 filename="…"） */
function parseFilename(cd: string): string {
  if (!cd) return '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* ignore */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1].trim() : '';
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * 带鉴权下载（后台导出需登录）。
 * 优先用 Authorization 头；同时依赖登录时下发的同源 Cookie。
 */
export async function downloadWithAuth(url: string, fallbackName: string, token?: string | null) {
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (res.status === 401) {
    // 导出走原生 fetch，不经 axios 拦截器；复用统一的登录失效处理
    const { handleAuthExpired } = await import('@/api/client');
    void handleAuthExpired();
  }
  if (!res.ok) {
    let msg = `导出失败（HTTP ${res.status}）`;
    try {
      const body = await res.json();
      msg = body?.message || msg;
    } catch {
      /* 非 JSON 响应 */
    }
    const err: any = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const blob = await res.blob();
  const name = parseFilename(res.headers.get('Content-Disposition') || '') || fallbackName;
  saveBlob(blob, name);
}
