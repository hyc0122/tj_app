import { CentralBusinessError } from "./central-session";

/**
 * 个人密钥服务暂不可用：中央登录已成功，不得因此把整次登录判失败。
 * 客户端禁止本地生成或伪造服务器平台包装密钥。
 */
export class KeyServiceUnavailableError extends Error {
  readonly code = "KEY_SERVICE_UNAVAILABLE" as const;
  readonly retryable = true;

  constructor(message = "个人密钥服务暂不可用") {
    super(message);
    this.name = "KeyServiceUnavailableError";
  }
}

export function isKeyServiceUnavailableError(error: unknown): boolean {
  if (error instanceof KeyServiceUnavailableError) return true;
  if (error instanceof CentralBusinessError && error.code === "KEY_SERVICE_UNAVAILABLE") {
    return true;
  }
  if (
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "KEY_SERVICE_UNAVAILABLE"
  ) {
    return true;
  }
  return false;
}
