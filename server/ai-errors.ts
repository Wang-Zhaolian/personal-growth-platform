export type Stage = '授权' | '权限检查' | '模型列表' | '推理请求' | '结果解析' | '业务校验' | '数据保存' | '界面刷新' | '附件校验' | '附件读取' | '附件删除';
export type Diagnostic = { stage: Stage; code: string; httpStatus?: number; requestId?: string; message: string; advice: string; at: string };
const safeCode = (value: unknown) => typeof value === 'string' && /^[\w.-]{1,100}$/.test(value) ? value : 'unknown_error';
export class AIError extends Error {
  diagnostic: Diagnostic;
  constructor(stage: Stage, code: string, message: string, advice = '保留输入，检查原因后重试。', httpStatus?: number, requestId?: string) {
    super(message); this.name = 'AIError';
    this.diagnostic = { stage, code: safeCode(code), message, advice, httpStatus, requestId: requestId && /^[\w-]{1,160}$/.test(requestId) ? requestId : undefined, at: new Date().toISOString() };
  }
}
export function remoteError(stage: Stage, status: number, code: unknown, requestId?: string) {
  const value = safeCode(code);
  let message = 'OpenAI 请求失败。', advice = '按错误阶段、状态码及请求 ID 排查；不要重复提交业务数据。';
  if (value === 'access_denied') { message = '你取消或拒绝了授权。'; advice = '需要时重新发起登录，并在官方页面选择授权。'; }
  else if (/unsupported_country/.test(value)) { message = 'OpenAI 拒绝当前请求地区。'; advice = '确认所在地在官方支持范围内；若受支持，请联系 OpenAI 支持。这不是登录成功。'; }
  else if (/invalid_grant|invalid_token|token_expired|invalid_refresh_token|refresh_token_(expired|invalidated|reused)/.test(value)) { message = '登录已过期或被撤销。'; advice = '重新授权当前账号；已保留应用注册信息和本地数据。'; }
  else if (/scope|permission/.test(value)) { message = '未获得订阅额度调用权限。'; advice = '检查实际授予的权限，在 ChatGPT 中启用本应用的订阅用量后重新授权。'; }
  else if (/quota|usage_limit|budget|credits/.test(value)) { message = '订阅额度或应用用量限制已达到。'; advice = '查看 ChatGPT 设置 → 用量，等待额度恢复或调整本应用限制。'; }
  else if (/model|unsupported|invalid_parameter/.test(value)) { message = '模型或请求能力不受支持。'; advice = '刷新账号模型列表；本平台目前仅发送文本，不提供附件功能。'; }
  else if (status === 403 || /client|eligible/.test(value)) { message = '应用、账号或工作区未获准执行此请求。'; advice = '检查私有客户端接入资格、Plus/Pro 账号及工作区政策；登录本身不等于可调用。'; }
  else if (status === 401) { message = '服务端未接受当前身份或订阅授权上下文。'; advice = '检查当前注册、授予权限及请求 ID；仅在确认凭据失效时重新授权。'; }
  else if (status === 429) { message = '请求频率或用量受到限制。'; advice = '查看 ChatGPT 用量并稍后重试。'; }
  else if (status >= 500) { message = 'OpenAI 服务暂时不可用。'; advice = '稍后重试；本平台不会自动重发推理请求。'; }
  return new AIError(stage, value, message, advice, status, requestId);
}
export function normalizeError(error: unknown, stage: Stage): AIError {
  if (error instanceof AIError) return error;
  let codes = '';
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 6; depth++) {
    const item = current as { name?: string; code?: string; cause?: unknown };
    codes += ` ${item.name ?? ''} ${item.code ?? ''}`; current = item.cause;
  }
  if (/CERT|TLS|SSL/i.test(codes)) return new AIError(stage, 'certificate_error', 'TLS 证书验证失败。', '检查系统时钟、证书信任链及代理证书；不要关闭 TLS 验证。');
  if (/Timeout|ETIMEDOUT/i.test(codes)) return new AIError(stage, 'timeout', '请求超时。', '检查网络和代理后重试；未自动重发请求。');
  if (/Abort/i.test(codes)) return new AIError(stage, 'cancelled', '请求已取消。');
  if (/ECONN|ENOTFOUND|EHOST|ENET|UND_ERR|TypeError/i.test(codes)) return new AIError(stage, 'network_error', '网络或代理连接失败。', '检查设置页的网络来源、代理进程、DNS 和证书后重试。');
  return new AIError(stage, stage === '数据保存' ? 'storage_error' : 'operation_failed', stage === '数据保存' ? '本机保存失败，数据未提交。' : '此阶段处理失败。', '保留输入及建议，检查本机存储权限或诊断信息后重试。');
}
export async function checkedFetch(stage: Stage, url: string, options: RequestInit = {}, fetcher: typeof fetch = fetch) {
  try {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(90_000), ...(options.signal ? [options.signal] : [])]) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: { code?: string } | string };
      throw remoteError(stage, response.status, typeof body.error === 'string' ? body.error : body.error?.code, response.headers.get('x-request-id') ?? undefined);
    }
    return response;
  } catch (error) { throw normalizeError(error, stage); }
}
