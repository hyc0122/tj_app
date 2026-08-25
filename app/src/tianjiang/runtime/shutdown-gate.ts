export interface ShutdownActions {
  closeRuntime(): Promise<void>;
  quit(): void;
  relaunch(): void;
  onFailure(error: unknown): Promise<void>;
  onInstallerPreparationFailure?(error: unknown): Promise<void>;
}

/**
 * Electron 退出门：最终同步完成前绝不调用 quit/relaunch；失败后允许用户回到应用重试。
 */
export class ShutdownGate {
  private running?: Promise<void>;
  private allowed = false;
  private intent: "none" | "quit" | "relaunch" | "installer" = "none";
  private protectUserData?: () => Promise<void>;

  constructor(private readonly actions: ShutdownActions) {}

  canQuit(): boolean {
    return this.allowed;
  }

  request(relaunch: boolean): Promise<void> {
    this.promoteIntent(relaunch ? "relaunch" : "quit");
    // 普通退出失败由 onFailure 恢复窗口；调用方无需处理未捕获拒绝。
    return this.ensureRunning().catch(() => undefined);
  }

  prepareForInstaller(protectUserData: () => Promise<void>): Promise<void> {
    if (this.allowed && this.intent !== "installer") {
      // 中文注释：普通退出已越过不可逆边界后，后到安装不得复用已完成 Promise 冒充数据保护完成。
      return Promise.reject(new Error("普通退出已经完成，无法再执行安装数据保护"));
    }
    this.promoteIntent("installer");
    // 同一轮安装保护只登记一次，普通退出先到也不能吞掉这个独立阶段。
    this.protectUserData ??= protectUserData;
    return this.ensureRunning();
  }

  /** 安装器已由 OS 受理后才调用；此入口只负责不可逆关闭，不再执行可失败的备份。 */
  finalizeAcceptedInstaller(): Promise<void> {
    this.promoteIntent("installer");
    this.protectUserData ??= async () => undefined;
    return this.ensureRunning();
  }

  private promoteIntent(next: "quit" | "relaunch" | "installer"): void {
    const priority = { none: 0, quit: 1, relaunch: 2, installer: 3 } as const;
    if (priority[next] > priority[this.intent]) this.intent = next;
  }

  private ensureRunning(): Promise<void> {
    if (this.running) return this.running;
    const attempt = this.execute().finally(() => {
      if (!this.allowed) {
        this.running = undefined;
        this.intent = "none";
        this.protectUserData = undefined;
      }
    });
    this.running = attempt;
    return attempt;
  }

  private async execute(): Promise<void> {
    let runtimeClosed = false;
    try {
      await this.actions.closeRuntime();
      runtimeClosed = true;

      if (this.intent === "installer") {
        if (!this.protectUserData) throw new Error("更新安装保护阶段缺失");
        await this.protectUserData();
        this.allowed = true;
        return;
      }

      this.allowed = true;
      if (this.intent === "relaunch") this.actions.relaunch();
      this.actions.quit();
    } catch (error) {
      if (runtimeClosed && this.intent === "installer") {
        // 安装保护失败绝不能回落到 quitAndInstall；只允许提示后重启原版本。
        try {
          await this.actions.onInstallerPreparationFailure?.(error);
        } finally {
          this.allowed = true;
          this.actions.relaunch();
          this.actions.quit();
        }
        throw error;
      }
      await this.actions.onFailure(error);
      throw error;
    }
  }
}
