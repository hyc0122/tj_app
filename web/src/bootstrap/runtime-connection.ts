export type RuntimeConnection =
  | {
      mode: "browser";
      state: "ready";
    }
  | {
      mode: "electron";
      state: "ready";
      url: string;
    }
  | {
      mode: "electron";
      state: "failed";
      code: string;
      message: string;
      logPath: string;
    };

interface DiscoverRuntimeConnectionOptions {
  pageProtocol?: string;
  desktopRuntime?: boolean;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

let runtimeConnectionDiscoveryInFlight: Promise<RuntimeConnection> | null = null;

function defaultFailure(
  message = "无法与桌面主进程建立启动握手，请重新启动应用。",
): RuntimeConnection {
  return {
    mode: "electron",
    state: "failed",
    code: "LOCAL_SERVICE_HANDSHAKE_FAILED",
    message,
    logPath: "",
  };
}

function isLocalApiUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  // 先校验原始串，禁止 URL 解析器把默认端口或前导零端口静默归一化。
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/api\/?$/.exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  if (!Number.isSafeInteger(port) || port > 65_535) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:"
      && parsed.hostname === "127.0.0.1"
      && /^\/api\/?$/.test(parsed.pathname)
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
    );
  } catch {
    return false;
  }
}

/**
 * 在 Vue Router 首次导航前取得 Electron 分配的随机端口。
 * 这一步禁止回退到固定端口，否则每次启动都可能先产生一次假 Network Error。
 */
export async function discoverRuntimeConnection(
  options: DiscoverRuntimeConnectionOptions = {},
): Promise<RuntimeConnection> {
  const pageProtocol = options.pageProtocol ?? window.location.protocol;
  const desktopRuntime = options.desktopRuntime
    ?? (pageProtocol === "file:" || navigator.userAgent.includes("TianjiangDesktop/"));
  if (!desktopRuntime) {
    return { mode: "browser", state: "ready" };
  }

  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher("tianjiang://getAppUrl", { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.ok && payload.ok !== false && isLocalApiUrl(payload.url)) {
      return {
        mode: "electron",
        state: "ready",
        url: payload.url,
      };
    }
    return {
      mode: "electron",
      state: "failed",
      code: typeof payload.code === "string"
        ? payload.code
        : "LOCAL_SERVICE_START_FAILED",
      message: typeof payload.message === "string" && payload.message.trim()
        ? payload.message
        : "应用内置本地服务未能启动。",
      logPath: typeof payload.logPath === "string" ? payload.logPath : "",
    };
  } catch {
    return defaultFailure();
  }
}

/**
 * 本地服务断线时复用同一次主进程握手，避免并发请求各自触发协议读取和通知风暴。
 * 每次握手完成后立即释放缓存；下一次真实断线仍可重新发现新端口。
 */
export function discoverRuntimeConnectionSingleFlight(
  options: DiscoverRuntimeConnectionOptions = {},
): Promise<RuntimeConnection> {
  if (runtimeConnectionDiscoveryInFlight) return runtimeConnectionDiscoveryInFlight;
  const pending = discoverRuntimeConnection(options);
  let tracked!: Promise<RuntimeConnection>;
  tracked = pending.finally(() => {
    if (runtimeConnectionDiscoveryInFlight === tracked) {
      runtimeConnectionDiscoveryInFlight = null;
    }
  });
  runtimeConnectionDiscoveryInFlight = tracked;
  return tracked;
}

/** 仅供单元测试隔离模块级单飞状态。 */
export function resetRuntimeConnectionDiscoveryForTests(): void {
  runtimeConnectionDiscoveryInFlight = null;
}
