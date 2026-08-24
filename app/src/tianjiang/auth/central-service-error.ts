export const CENTRAL_API_UNREACHABLE = "CENTRAL_API_UNREACHABLE" as const;
export const CENTRAL_AUTH_NOT_READY = "CENTRAL_AUTH_NOT_READY" as const;
export const CENTRAL_AUTH_UNAVAILABLE = "CENTRAL_AUTH_UNAVAILABLE" as const;

export interface CentralErrorMapping {
  readonly status: 503;
  readonly code:
    | typeof CENTRAL_API_UNREACHABLE
    | typeof CENTRAL_AUTH_NOT_READY
    | typeof CENTRAL_AUTH_UNAVAILABLE;
  readonly message: string;
}

/**
 * 中央认证接口尚未部署与中央服务暂时不可用必须和账号输入错误分开。
 */
export function mapCentralError(
  response: { readonly status: number },
): CentralErrorMapping | null {
  if (response.status === 404) {
    return {
      status: 503,
      code: CENTRAL_AUTH_NOT_READY,
      message: "中央认证服务尚未就绪，请稍后重试。",
    };
  }
  if (response.status >= 500 && response.status <= 599) {
    return {
      status: 503,
      code: CENTRAL_AUTH_UNAVAILABLE,
      message: "中央认证服务暂时不可用，请稍后重试。",
    };
  }
  return null;
}

export class CentralServiceUnavailableError extends Error {
  readonly code:
    | typeof CENTRAL_API_UNREACHABLE
    | typeof CENTRAL_AUTH_NOT_READY
    | typeof CENTRAL_AUTH_UNAVAILABLE;
  readonly publicMessage: string;

  constructor(cause: unknown, upstreamStatus?: number) {
    const mapping = upstreamStatus === undefined
      ? {
          status: 503 as const,
          code: CENTRAL_API_UNREACHABLE,
          message: "中央 API 不可达，请检查网络连接或稍后重试。",
        }
      : mapCentralError({ status: upstreamStatus });
    const resolved = mapping ?? {
      status: 503 as const,
      code: CENTRAL_API_UNREACHABLE,
      message: "中央 API 不可达，请检查网络连接或稍后重试。",
    };
    super(
      resolved.code === CENTRAL_AUTH_NOT_READY
        ? "中央认证服务尚未就绪"
        : resolved.code === CENTRAL_AUTH_UNAVAILABLE
          ? "中央认证服务暂时不可用"
          : "中央 API 不可达",
      { cause },
    );
    this.name = "CentralServiceUnavailableError";
    this.code = resolved.code;
    this.publicMessage = resolved.message;
  }
}

export interface CentralServiceUnavailableResponse {
  readonly status: 503;
  readonly body: {
    readonly code:
      | typeof CENTRAL_API_UNREACHABLE
      | typeof CENTRAL_AUTH_NOT_READY
      | typeof CENTRAL_AUTH_UNAVAILABLE;
    readonly message: string;
  };
}

/**
 * 只有中央网络失败、认证接口未就绪或 5xx 才能转换为 503，业务 400/401 保持原状态。
 */
export function centralServiceUnavailableResponse(
  error: unknown,
): CentralServiceUnavailableResponse | null {
  if (!(error instanceof CentralServiceUnavailableError)) return null;
  return {
    status: 503,
    body: {
      code: error.code,
      message: error.publicMessage,
    },
  };
}
