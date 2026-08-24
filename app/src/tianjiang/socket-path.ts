/**
 * Engine.IO 握手路径（Cookie Path=/api 必须能覆盖）。
 * 与 namespace `/api/socket/*` 分离：namespace 是业务通道，path 是引擎握手。
 */
export const ENGINE_IO_PATH = "/api/socket.io" as const;

/** 业务 Socket 命名空间（相对 Engine path 独立） */
export const SOCKET_NAMESPACES = {
  scriptAgent: "/api/socket/scriptAgent",
  productionAgent: "/api/socket/productionAgent",
} as const;

export type SocketNamespaceName = keyof typeof SOCKET_NAMESPACES;
