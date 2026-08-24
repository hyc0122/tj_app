export interface TransportFailureGuidance {
  readonly kind: "central-api" | "local-service" | "business-service";
  readonly title: string;
  readonly detail: string;
}

interface AxiosLikeError {
  readonly message?: string;
  readonly response?: {
    readonly data?: {
      readonly code?: unknown;
      readonly message?: unknown;
    };
  };
}

/**
 * renderer 只按可观察边界分类，中央 503 不能被通用 Network Error 覆盖。
 */
export function classifyTransportFailure(
  error: AxiosLikeError,
  desktop: boolean,
): TransportFailureGuidance | null {
  if (error.response?.data?.code === "CENTRAL_API_UNREACHABLE") {
    return {
      kind: "central-api",
      title: "中央 API 不可达",
      detail: "本地服务已启动，但暂时无法连接中央 API。请检查网络连接或稍后重试。",
    };
  }
  const networkError = error.message?.includes("Network Error")
    || error.response?.data?.message === "Network Error";
  if (!networkError) return null;
  if (desktop) {
    return {
      kind: "local-service",
      title: "本地服务连接中断",
      detail: "已自动尝试恢复本地服务连接；若仍失败，请重新启动应用并查看启动诊断日志。",
    };
  }
  return {
    kind: "business-service",
    title: "业务服务连接失败",
    detail: "请检查业务 API 地址、网络连接和服务状态后重试。",
  };
}
