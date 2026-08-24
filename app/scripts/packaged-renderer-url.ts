/**
 * 打包生产窗口同源地址构造：必须来自已成功启动的 runtime 端口，
 * 且只能是 127.0.0.1 回环，禁止 localhost、0.0.0.0、外部主机或路径注入。
 */
export interface ReadyRuntimePort {
  readonly state: "ready";
  readonly port: number;
  readonly url?: string;
}

export function buildPackagedRendererURL(runtime: {
  readonly state: string;
  readonly port?: number;
  readonly url?: string;
}): string {
  if (runtime.state !== "ready") {
    throw new Error("本地服务尚未就绪，不能打开打包渲染页");
  }
  const port = runtime.port;
  if (!Number.isInteger(port) || port! < 1 || port! > 65_535) {
    throw new Error(`本地服务端口无效: ${String(port)}`);
  }
  // 若 runtime 已带 URL，必须是同一 127.0.0.1 端口，防止被污染。
  if (typeof runtime.url === "string" && runtime.url.length > 0) {
    assertLoopbackApiUrl(runtime.url, port!);
  }
  return `http://127.0.0.1:${port}/`;
}

export function assertLoopbackApiUrl(raw: string, expectedPort: number): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("本地服务地址无效");
  }
  if (parsed.protocol !== "http:") {
    throw new Error("本地服务地址必须使用 http");
  }
  if (parsed.hostname !== "127.0.0.1") {
    throw new Error("本地服务地址只能绑定 127.0.0.1");
  }
  const port = parsed.port ? Number(parsed.port) : 80;
  if (port !== expectedPort) {
    throw new Error("本地服务地址端口与 runtime 不一致");
  }
  // 握手 URL 固定为 /api；规范化后的路径注入（如 /api/../evil）一律拒绝。
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  if (pathname !== "/api") {
    throw new Error("本地服务地址路径不允许注入");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("本地服务地址不得包含凭据、查询或片段");
  }
}
