interface RuntimeRequestConfigLike {
  baseURL?: unknown;
  __tianjiangRuntimeRetried?: boolean;
}

interface RuntimeNetworkErrorLike {
  message?: unknown;
  code?: unknown;
  response?: unknown;
  config?: RuntimeRequestConfigLike;
}

function isExactLocalRuntimeBaseUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:"
      && parsed.hostname === "127.0.0.1"
      && /^\/api\/?$/.test(parsed.pathname)
      && Boolean(parsed.port)
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

/**
 * 只识别 Electron 本地环回服务的“未收到 HTTP 响应”错误。
 * 中央 API 的 4xx/5xx、业务异常与已重试请求均不得进入端口恢复流程。
 */
export function isRetryableLocalRuntimeFailure(
  error: RuntimeNetworkErrorLike,
  desktop: boolean,
): boolean {
  if (!desktop || error?.response || error?.config?.__tianjiangRuntimeRetried) return false;
  if (!isExactLocalRuntimeBaseUrl(error?.config?.baseURL)) return false;
  const message = typeof error?.message === "string" ? error.message : "";
  const code = typeof error?.code === "string" ? error.code : "";
  return /Network Error|ECONNREFUSED|ECONNRESET|socket hang up/i.test(message)
    || /ERR_NETWORK|ECONNREFUSED|ECONNRESET/i.test(code);
}
