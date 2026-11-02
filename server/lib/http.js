// 统一响应包装（冻结规格 §0）：成功 {ok:true,data}; 失败 {ok:false,code,message,data?}
export function sendOk(res, data, status = 200) {
  res.status(status).json({ ok: true, data });
}

export function errorHandler(err, req, res, _next) {
  const http = err && err.http ? err.http : 500;
  const body = {
    ok: false,
    code: (err && err.code) || 'INTERNAL',
    message: (err && err.message) || '服务器内部错误',
  };
  if (err && err.data !== undefined) body.data = err.data;
  if (http >= 500) {
    // 留痕：服务端错误打日志（审计口径）
    console.error(`[ERROR] ${req.method} ${req.originalUrl}`, err);
  }
  res.status(http).json(body);
}
