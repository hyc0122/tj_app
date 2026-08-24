import fs from "node:fs";
import path from "node:path";

/**
 * 跨平台托盘：Windows 通知区 / macOS 菜单栏。
 * 单击恢复窗口；右键菜单提供显示与显式退出。
 */
export interface TrayLike {
  setToolTip(text: string): void;
  setContextMenu(menu: unknown): void;
  on(event: "click", listener: () => void): void;
  destroy(): void;
}

export interface MenuLike {
  buildFromTemplate(template: unknown[]): unknown;
}

export interface TrayControllerOptions {
  // 兼容 Electron.Tray 构造签名，避免 image 参数过窄。
  Tray: new (image: any, ...rest: any[]) => TrayLike;
  Menu: MenuLike;
  nativeImage: {
    createFromPath(p: string): { isEmpty(): boolean; setTemplateImage?(v: boolean): void };
  };
  appName: string;
  resourcesRoot: string;
  platform: NodeJS.Platform;
  getWindow: () => { show(): void; focus(): void; isMinimized(): boolean; restore(): void } | null;
  requestShutdown: () => void | Promise<void>;
}

export interface TrayController {
  dispose(): void;
}

export function resolveTrayIconPath(
  resourcesRoot: string,
  platform: NodeJS.Platform,
): string {
  if (platform === "darwin") {
    const template = path.join(resourcesRoot, "trayTemplate.png");
    if (fs.existsSync(template)) return template;
  }
  const ico = path.join(resourcesRoot, "tray.ico");
  if (fs.existsSync(ico)) return ico;
  // 开发回退：使用打包脚本旁 logo
  return path.join(process.cwd(), "scripts", "logo.ico");
}

export function createTrayController(options: TrayControllerOptions): TrayController {
  const iconPath = resolveTrayIconPath(options.resourcesRoot, options.platform);
  let image = options.nativeImage.createFromPath(iconPath);
  if (options.platform === "darwin" && image.setTemplateImage) {
    image.setTemplateImage(true);
  }
  const tray = new options.Tray(image);
  // 模块生命周期强引用，防止 GC 回收托盘。
  (globalThis as { __tjTray?: TrayLike }).__tjTray = tray;
  tray.setToolTip(options.appName);

  const showWindow = () => {
    const win = options.getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  tray.setContextMenu(
    options.Menu.buildFromTemplate([
      {
        label: `显示${options.appName}`,
        click: () => showWindow(),
      },
      {
        label: `退出${options.appName}`,
        // 中文注释：只有托盘“退出”才进入真正退出门。
        click: () => {
          void options.requestShutdown();
        },
      },
    ]),
  );

  tray.on("click", () => showWindow());

  return {
    dispose() {
      tray.destroy();
      delete (globalThis as { __tjTray?: TrayLike }).__tjTray;
    },
  };
}

/** 关闭意图：默认隐藏；显式退出/更新安装才销毁。 */
export class QuitIntent {
  private explicit = false;
  private installingUpdate = false;

  markExplicitQuit(): void {
    this.explicit = true;
  }

  markInstallUpdate(): void {
    this.installingUpdate = true;
    this.explicit = true;
  }

  isExplicit(): boolean {
    return this.explicit || this.installingUpdate;
  }

  isInstallingUpdate(): boolean {
    return this.installingUpdate;
  }

  reset(): void {
    this.explicit = false;
    this.installingUpdate = false;
  }
}

export function handleWindowClose(
  event: { preventDefault(): void },
  window: { hide(): void },
  quitIntent: QuitIntent,
  options: {
    canHideToTray: boolean;
    requestShutdown: () => void | Promise<void>;
  } = {
    canHideToTray: true,
    requestShutdown: () => undefined,
  },
): void {
  // 只有显式退出、系统退出或更新安装才能真正销毁窗口。
  if (!quitIntent.isExplicit()) {
    event.preventDefault();
    handleTitlebarClose(window, quitIntent, options);
  }
}

/** 标题栏协议与原生 close 事件共享同一托盘/退出决策。 */
export function handleTitlebarClose(
  window: { hide(): void },
  quitIntent: QuitIntent,
  options: {
    canHideToTray: boolean;
    requestShutdown: () => void | Promise<void>;
  },
): void {
  if (options.canHideToTray && !quitIntent.isExplicit()) {
    window.hide();
    return;
  }
  // 托盘不可用时必须进入退出门，不能留下无入口后台进程。
  void options.requestShutdown();
}
