/**
 * 单实例守卫：第二实例只恢复已有窗口，不启动第二套本地服务。
 */
export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  on(event: "second-instance", listener: () => void): void;
  quit(): void;
}

export interface SingleInstanceGuardOptions {
  app: SingleInstanceApp;
  restore: () => void;
}

export function installSingleInstanceGuard(
  options: SingleInstanceGuardOptions,
): boolean {
  // 验收桩/非完整 Electron 宿主可能未注入单实例 API；此时跳过守卫允许继续启动诊断。
  if (typeof options.app.requestSingleInstanceLock !== "function") {
    return true;
  }
  const gotLock = options.app.requestSingleInstanceLock();
  if (!gotLock) {
    // 未拿到锁：立即退出，由已有实例处理恢复。
    options.app.quit();
    return false;
  }
  options.app.on("second-instance", () => {
    options.restore();
  });
  return true;
}

/** 恢复主窗口：显示、取消最小化并聚焦。 */
export function restoreMainWindow(window: {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
} | null): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
