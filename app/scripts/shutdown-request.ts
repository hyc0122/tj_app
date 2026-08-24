export interface ShutdownRequesterOptions {
  markExplicitQuit(): void;
  request(relaunch: boolean): Promise<void>;
}

export interface ProtocolShutdownHandlerOptions {
  requestShutdown(relaunch: boolean): Promise<void>;
  defer(callback: () => void): void;
}

/** 所有真正退出入口先标记显式退出，再进入同一个 ShutdownGate。 */
export function createShutdownRequester(options: ShutdownRequesterOptions) {
  return (relaunch = false): Promise<void> => {
    options.markExplicitQuit();
    return options.request(relaunch);
  };
}

/**
 * 桌面协议的“退出”与“重启”必须显式进入 ShutdownGate。
 * 延迟一拍执行，让自定义协议响应先返回 renderer，避免安全退出过程中截断请求。
 */
export function createProtocolShutdownHandlers(
  options: ProtocolShutdownHandlerOptions,
) {
  const schedule = (relaunch: boolean, message: string) => () => {
    options.defer(() => {
      void options.requestShutdown(relaunch);
    });
    return { ok: true, message };
  };

  return {
    appquit: schedule(false, "应用即将退出"),
    apprestart: schedule(true, "应用即将重启"),
  };
}
