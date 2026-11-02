// 错误码表（冻结规格 §5.1）
export class ApiError extends Error {
  constructor(code, http, message, data) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.http = http;
    this.data = data;
  }
}

export const ERR = {
  VALIDATION: (m = '参数缺失或非法') => new ApiError('VALIDATION', 400, m),
  OPERATOR_INACTIVE: (m = '该安全员已停用') => new ApiError('OPERATOR_INACTIVE', 400, m),
  VEHICLE_INACTIVE: (m = '该车架号已停用') => new ApiError('VEHICLE_INACTIVE', 400, m),
  UNAUTHORIZED: (m = '未登录') => new ApiError('UNAUTHORIZED', 401, m),
  // CR-06：签名有效但与库内 pwd_ver 不一致（改密/重置/清号后旧 token 失效）
  TOKEN_STALE: (m = '登录状态已失效，请重新登录') => new ApiError('TOKEN_STALE', 401, m),
  INVALID_CREDENTIALS: (m = '用户名或密码错误') => new ApiError('INVALID_CREDENTIALS', 401, m),
  ACCOUNT_INACTIVE: (m = '账号已停用') => new ApiError('ACCOUNT_INACTIVE', 403, m),
  MUST_CHANGE_PASSWORD: (m = '请先修改密码') => new ApiError('MUST_CHANGE_PASSWORD', 403, m),
  INVALID_OLD_PASSWORD: (m = '原密码不正确') => new ApiError('INVALID_OLD_PASSWORD', 400, m),
  // CR-12：登录限流触发（账号连续失败锁定 / 同 IP 高频失败上限）→ 429
  RATE_LIMITED: (m = '登录尝试过于频繁，请稍后再试') => new ApiError('RATE_LIMITED', 429, m),
  FORBIDDEN: (m = '无权操作该会话') => new ApiError('FORBIDDEN', 403, m),
  // CR-10：后台模块级权限（角色不含该模块）→ 403
  NO_PERMISSION: (m = '无权访问该模块') => new ApiError('NO_PERMISSION', 403, m),
  NOT_FOUND: (m = '资源不存在') => new ApiError('NOT_FOUND', 404, m),
  OPERATOR_BUSY: (m = '您已有进行中的计时', data) => new ApiError('OPERATOR_BUSY', 409, m, data),
  NOT_SCHEDULED: (m = '该车未排给您，如需继续请确认', data) => new ApiError('NOT_SCHEDULED', 403, m, data),
  // CR-08 批2（需求②）：未到班次开始时间 → 拦（迟到/早退放行，不在此列）
  BEFORE_SHIFT_START: (m = '未到班次开始时间，请稍后再开始', data) => new ApiError('BEFORE_SHIFT_START', 403, m, data),
  // CR-08 批2（需求⑦）：同人同车当天已结束 → 不可再次开始
  DAY_CLOSED: (m = '该车今日任务已结束，不可再次开始', data) => new ApiError('DAY_CLOSED', 409, m, data),
  // CR-09（需求⑩）：暂停必须填写备注（前端拦截 + 后端校验）
  REMARK_REQUIRED: (m = '暂停前请填写备注', data) => new ApiError('REMARK_REQUIRED', 400, m, data),
  INVALID_STATE: (m = '当前状态不允许该操作') => new ApiError('INVALID_STATE', 409, m),
  CONFLICT: (m = '唯一性冲突') => new ApiError('CONFLICT', 409, m),
  // 2026-10-08 老板需求①：里程必填/合法/与前次收车核对
  ODOMETER_REQUIRED: (m = '请填写里程数', data) => new ApiError('ODOMETER_REQUIRED', 400, m, data),
  ODOMETER_INVALID: (m = '里程数不合法', data) => new ApiError('ODOMETER_INVALID', 400, m, data),
  ODOMETER_MISMATCH: (m = '里程数与上次收车里程偏差过大', data) => new ApiError('ODOMETER_MISMATCH', 409, m, data),
};
