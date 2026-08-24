/**
 * 与 App 端 `app/src/tianjiang/socket-path.ts` 必须保持同一 Engine.IO path。
 * Cookie Path=/api；握手必须落在 /api 下，浏览器才会携带 tj_session。
 */
export const ENGINE_IO_PATH = "/api/socket.io" as const;

/** 业务命名空间（由 io(url) 的 url 路径表达，勿与 Engine path 混淆） */
export const SOCKET_NAMESPACE_SUFFIX = {
  scriptAgent: "/socket/scriptAgent",
  productionAgent: "/socket/productionAgent",
} as const;
