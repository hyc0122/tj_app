import type { Server } from "node:http";

/**
 * 将底层 listen 错误转换为 Promise reject，确保 Electron 主进程能展示结构化诊断页。
 */
export function listenHttpServer(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      const realPort = typeof address === "string" ? undefined : address?.port;
      if (!Number.isInteger(realPort) || !realPort) {
        reject(new Error("HTTP 服务未返回有效监听端口"));
        return;
      }
      resolve(realPort);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    try {
      // 桌面本地服务只允许 IPv4 环回访问，禁止默认绑定到所有 IPv4/IPv6 网卡。
      server.listen(port, "127.0.0.1");
    } catch (error) {
      server.off("error", onError);
      server.off("listening", onListening);
      reject(error);
    }
  });
}
