export interface SystemSessionEndWindow {
  on(event: "query-session-end" | "session-end", listener: (...args: any[]) => void): void;
}

export interface SystemSessionEndOptions {
  platform: NodeJS.Platform;
  window: SystemSessionEndWindow;
  requestShutdown: () => Promise<void>;
}

/**
 * Windows 注销/关机必须进入正常退出门。query 阶段先阻止窗口被系统直接销毁，
 * session-end 作为系统已确认结束时的兜底，仍尝试完成同一个幂等退出请求。
 */
export function installSystemSessionEndHandlers(options: SystemSessionEndOptions): void {
  if (options.platform !== "win32") return;
  const request = () => {
    void options.requestShutdown();
  };
  options.window.on("query-session-end", (event: { preventDefault(): void }) => {
    event.preventDefault();
    request();
  });
  options.window.on("session-end", () => {
    request();
  });
}
