import { CentralBusinessError, CentralRequestError } from "./central-session";
import { CentralServiceUnavailableError } from "./central-service-error";

/**
 * 是否为「明确认证失败」：仅此类错误允许删除内存会话并调用 onSessionInvalid。
 * 网络不可达、超时、5xx、本机 DB 准备失败等均返回 false（fail-closed 拒绝当前请求，但保留运行时）。
 */
export function isDefinitiveSessionAuthFailure(error: unknown): boolean {
  if (error instanceof CentralServiceUnavailableError) {
    return false;
  }
  if (error instanceof CentralBusinessError || error instanceof CentralRequestError) {
    const status = error.status;
    if (status === 401 || status === 403) return true;
    // 中央业务码明确表示令牌/会话失效
    const code = String(error.code);
    if (
      code === "AUTH_REQUIRED"
      || code === "UNAUTHORIZED"
      || code === "TOKEN_INVALID"
      || code === "SESSION_INVALID"
    ) {
      return true;
    }
    // 5xx 类业务错误不得当退出登录
    if (status >= 500 && status <= 599) return false;
    return false;
  }
  if (error && typeof error === "object") {
    const anyErr = error as { status?: number; code?: string | number; message?: string; name?: string };
    if (typeof anyErr.status === "number") {
      if (anyErr.status === 401 || anyErr.status === 403) return true;
      if (anyErr.status >= 500) return false;
    }
    const code = anyErr.code != null ? String(anyErr.code) : "";
    if (code === "AUTH_REQUIRED" || code === "UNAUTHORIZED") return true;
  }
  // 超时 / 网络 / ECONNREFUSED 等
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (/timeout|ECONNREFUSED|ENOTFOUND|network|fetch failed|socket hang up|503|502|504/i.test(msg)) {
    return false;
  }
  // 未知错误默认不当作认证失效，避免误杀会话
  return false;
}
