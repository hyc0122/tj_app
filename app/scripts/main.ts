import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  protocol,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import path from "path";
import fs from "fs";
import Module from "module";
import { BRAND } from "../src/brand.generated";
import { LEGACY_PROTOCOL_SCHEME } from "../src/tianjiang/identity/product-identity";
import { ShutdownGate } from "../src/tianjiang/runtime/shutdown-gate";
import {
  classifyStartupError,
  publicStartupPayload,
  sanitizeDiagnosticText,
  type RuntimeStartupState,
  writeStartupFailureLog,
} from "./runtime-startup";
import {
  resolvePackagedRuntimeResources,
  type PackagedRuntimeResources,
} from "./runtime-resources";
import { buildPackagedRendererURL } from "./packaged-renderer-url";
import {
  applyAcceptanceUserDataPath,
  isAcceptanceMode,
  resolveAcceptanceProfileRoot,
} from "../src/tianjiang/acceptance/isolation";
import { buildAcceptanceRuntimeSnapshot } from "./acceptance-runtime";
import {
  createTrayController,
  handleTitlebarClose,
  handleWindowClose,
  QuitIntent,
  type TrayController,
} from "./tray-controller";
import {
  installSingleInstanceGuard,
  restoreMainWindow,
} from "./single-instance";
import {
  createDesktopManualUpdater,
  createUnsupportedManualUpdater,
  isWindowsX64UpdatePlatform,
  launchVerifiedInstallerWithShell,
} from "./desktop-updater";
import { protectUserDataBeforeUpdate } from "../src/tianjiang/update/update-data-protection";
import { detachCurrentServeRequest } from "../src/tianjiang/runtime/serve-readiness";
import { installSystemSessionEndHandlers } from "./system-session-end";
import {
  DREAMINA_EXTERNAL_PROTOCOL_HOST,
  normalizeDesktopProtocolHost,
  openDreaminaDesktopExternal,
  settleDesktopProtocolAction,
} from "../src/tianjiang/model-providers/dreamina-cli/desktop-external-opener";
import {
  createProtocolShutdownHandlers,
  createShutdownRequester,
} from "./shutdown-request";

// 加速 Electron 启动：跳过 GPU 信息收集，减少初始化耗时
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.setName(BRAND.displayName);
const acceptanceProfileRoot = isAcceptanceMode()
  ? resolveAcceptanceProfileRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    cwd: process.cwd(),
  })
  : path.resolve(process.cwd(), "..", ".local", "profile");
// 必须早于 app.whenReady 和任何 app.getPath，保证验收不会先触碰真实 AppData。
applyAcceptanceUserDataPath(app, acceptanceProfileRoot);

const quitIntent = new QuitIntent();
let trayController: TrayController | null = null;

// 第二实例只恢复窗口，不启动第二套本地服务。
const singleInstanceOk = installSingleInstanceGuard({
  app,
  restore: () => restoreMainWindow(mainWindow),
});
if (!singleInstanceOk) {
  // 未获锁时已 quit，后续 whenReady 不再初始化。
}

//获取全部依赖路径，优先从 unpacked 加载原生模块，其他模块从 asar 加载
function getNodeModulesPaths(): string[] {
  const paths: string[] = [];
  if (app.isPackaged) {
    // external 依赖（原生模块）在 unpacked 目录
    const unpackedNodeModules = path.join(process.resourcesPath, "app.asar.unpacked", "node_modules");
    if (fs.existsSync(unpackedNodeModules)) {
      paths.push(unpackedNodeModules);
    }
    // 普通依赖在 asar 内
    const asarNodeModules = path.join(process.resourcesPath, "app.asar", "node_modules");
    paths.push(asarNodeModules);
  } else {
    paths.push(path.join(process.cwd(), "node_modules"));
  }
  return paths;
}

//动态加载
function requireWithCustomPaths(modulePath: string): any {
  const appNodeModulesPaths = getNodeModulesPaths();
  // 保存原始方法
  const originalNodeModulePaths = (Module as any)._nodeModulePaths;
  // 临时修改模块路径解析
  (Module as any)._nodeModulePaths = function (from: string): string[] {
    const paths = originalNodeModulePaths.call(this, from);
    // 将主程序的 node_modules 添加到前面
    for (let i = appNodeModulesPaths.length - 1; i >= 0; i--) {
      const p = appNodeModulesPaths[i];
      if (!paths.includes(p)) {
        paths.unshift(p);
      }
    }
    return paths;
  };
  try {
    // 清除缓存确保加载最新
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
  } finally {
    // 恢复原始方法
    (Module as any)._nodeModulePaths = originalNodeModulePaths;
  }
}

let mainWindow: BrowserWindow | null = null;
let packagedRuntimeResources: PackagedRuntimeResources | null = null;
let runtimeState: RuntimeStartupState = {
  ok: false,
  state: "starting",
  code: "STARTING",
  message: "本地服务正在启动",
  logPath: "",
};

function createMainWindow(): Promise<void> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 1000,
      height: 700,
      minWidth: 800,
      minHeight: 500,
      frame: false,
      show: false,
      autoHideMenuBar: true,
      resizable: true,
      thickFrame: true,
      title: BRAND.displayName,
    });
    mainWindow = win;
    // 明确标识桌面运行时；Vite HTTP 开发模式不能依赖 file: 协议判断 Electron。
    win.webContents.setUserAgent(
      `${win.webContents.getUserAgent()} TianjiangDesktop/${app.getVersion()}`,
    );
    win.setMenuBarVisibility(false);
    win.removeMenu();

    win.on("closed", () => {
      mainWindow = null;
    });
    // 点击 × / Alt+F4 默认隐藏到托盘，不退出进程。
    win.on("close", (event) => {
      handleWindowClose(event, win, quitIntent, {
        canHideToTray: trayController !== null,
        requestShutdown: () => requestShutdown(false),
      });
    });
    installSystemSessionEndHandlers({
      platform: process.platform,
      window: win,
      requestShutdown: () => requestShutdown(false),
    });

    win.once("ready-to-show", () => {
      // 中文注释：新进程首次显示前 maximize，避免先显示小窗口再最大化闪烁。
      // 托盘恢复走 restoreMainWindow，不得再次强制 maximize。
      win.maximize();
      win.show();
      resolve();
    });

    const isDev = process.env.NODE_ENV === "dev" || !app.isPackaged;
    if (process.env.VITE_DEV) {
      void win.loadURL("http://127.0.0.1:50188");
    } else if (isDev) {
      // 开发态可直接 loadFile 本地构建产物；生产禁止 file://（会破坏 SameSite Cookie）。
      void win.loadFile(path.join(process.cwd(), "data", "web", "index.html"));
    } else if (
      packagedRuntimeResources
      && runtimeState.state === "ready"
    ) {
      // 打包生产必须同源加载 http://127.0.0.1:${port}/：
      // 1) Web 仍由 Express 从 TJ_IMMUTABLE_WEB_ROOT（安装包 webRoot）提供，不读用户 data/web；
      // 2) 会话 Cookie Path=/api + SameSite=Strict 才能与 renderer 同站生效。
      try {
        const rendererURL = buildPackagedRendererURL(runtimeState);
        void win.loadURL(rendererURL);
      } catch (error) {
        console.error("[打包渲染地址无效]:", error);
        void loadStartupFailurePage(win, "STARTUP_RESOURCE_INVALID", "本地服务地址校验失败。");
      }
    } else {
      // web 自身损坏或服务未就绪：主进程内置最小诊断页。
      const code = runtimeState.state === "failed"
        ? runtimeState.code
        : "STARTUP_RESOURCE_INVALID";
      const message = runtimeState.state === "failed"
        ? runtimeState.message
        : "客户端安装资源校验失败。";
      void loadStartupFailurePage(win, code, message);
    }
  });
}

/** 启动失败诊断页：不依赖可能已损坏的安装包 HTML。 */
function loadStartupFailurePage(
  win: BrowserWindow,
  code: string,
  message: string,
): void {
  const html = [
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">",
    `<title>${BRAND.displayName}</title>`,
    "<style>body{font-family:'Microsoft YaHei',sans-serif;background:#10131a;color:#eef2ff;padding:48px}",
    ".card{max-width:720px;margin:auto;padding:32px;border:1px solid #34405c;border-radius:12px;background:#171c27}",
    "code{color:#9bc6ff}</style></head><body><main class=\"card\">",
    "<h1>客户端启动资源失败</h1>",
    `<p>${message}</p><p>诊断代码：<code>${code}</code></p>`,
    "</main></body></html>",
  ].join("");
  void win.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
}

let closeServeFn: (() => Promise<void>) | undefined;
const shutdownGate = new ShutdownGate({
  closeRuntime: async () => {
    if (closeServeFn) await closeServeFn();
  },
  relaunch: () => app.relaunch(),
  quit: () => app.quit(),
  onFailure: async (error) => {
    console.error("[安全退出失败]:", error);
    // 托盘退出同步失败：恢复窗口并只报一次错误，禁止无窗口后台进程。
    quitIntent.reset();
    restoreMainWindow(mainWindow);
    await dialog.showMessageBox({
      type: "error",
      title: "同步未完成",
      // 普通退出路径：可恢复故障已持久化 pending；仅致命关闭失败才走到这里。
      message: "本地内容已保存，将在下次启动后继续同步",
      detail: error instanceof Error ? error.message : String(error),
      buttons: ["返回应用"],
    });
  },
  onInstallerPreparationFailure: async (error) => {
    console.error("[更新前备份失败]:", error);
    // 此时本地服务与数据库句柄已经关闭，禁止恢复窗口；确认后由退出门受控重启。
    await dialog.showMessageBox({
      type: "error",
      title: "更新准备失败",
      message: "用户数据备份未通过校验，已取消安装。应用将安全重启。",
      detail: error instanceof Error ? error.message : String(error),
      buttons: ["重新启动应用"],
    });
  },
});

const requestShutdown = createShutdownRequester({
  markExplicitQuit: () => quitIntent.markExplicitQuit(),
  request: (relaunch) => shutdownGate.request(relaunch),
});
const protocolShutdownHandlers = createProtocolShutdownHandlers({
  requestShutdown,
  defer: (callback) => { setTimeout(callback, 500); },
});

async function handleDesktopProtocol(request: { url: string }): Promise<Response> {
    const url = new URL(request.url);
    const pathname = normalizeDesktopProtocolHost(url.hostname);
    let status = 200;

    if (pathname === "getappurl" || pathname === "getstartupstatus") {
      if (runtimeState.state === "failed") status = 503;
      if (runtimeState.state === "starting") status = 425;
      return new Response(JSON.stringify(publicStartupPayload(runtimeState)), {
        status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    if (pathname === "getacceptancestate") {
      if (!isAcceptanceMode()) {
        return new Response(JSON.stringify({ error: "验收模式未启用" }), {
          status: 404,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      return new Response(JSON.stringify(buildAcceptanceRuntimeSnapshot({
        acceptanceMode: true,
        userData: app.getPath("userData"),
        trayReady: trayController !== null,
      })), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    const handlers: Partial<Record<string, () => object | Promise<object>>> = {
      windowminimize: () => {
        mainWindow?.minimize();
        return { ok: true };
      },
      windowmaximize: () => {
        if (mainWindow?.isMaximized()) {
          mainWindow.unmaximize();
        } else {
          mainWindow?.maximize();
        }
        return { ok: true };
      },
      windowclose: () => {
        if (mainWindow) {
          handleTitlebarClose(mainWindow, quitIntent, {
            canHideToTray: trayController !== null,
            requestShutdown: () => requestShutdown(false),
          });
        } else {
          void requestShutdown(false);
        }
        return { ok: true };
      },
      ...protocolShutdownHandlers,
      openstartuplog: () => {
        if (!runtimeState.logPath) return { ok: false, error: "启动日志路径不可用" };
        if (fs.existsSync(runtimeState.logPath)) {
          shell.showItemInFolder(runtimeState.logPath);
        } else {
          void shell.openPath(path.dirname(runtimeState.logPath));
        }
        return { ok: true };
      },
      windowismaximized: () => ({
        maximized: mainWindow?.isMaximized() ?? false,
      }),
      opendevtool: () => {
        mainWindow?.webContents.openDevTools();
        return { ok: true };
      },
      openurlwithbrowser: () => {
        const targetUrl = url.searchParams.get("url");
        if (!targetUrl) return { ok: false, error: "缺少url参数" };
        void shell.openExternal(targetUrl);
        return { ok: true };
      },
      [DREAMINA_EXTERNAL_PROTOCOL_HOST]: async () => {
        const kind = url.searchParams.get("kind");
        const target = kind === "official_docs"
          ? { kind: "official_docs" as const }
          : {
              kind: "authorization" as const,
              url: String(url.searchParams.get("url") ?? ""),
            };
        return openDreaminaDesktopExternal(target, (targetUrl) => shell.openExternal(targetUrl));
      },
      getlocallanguage: () => {
        if (process.platform === "darwin") {
          const systemLocale = systemPreferences.getUserDefault("AppleLocale", "string");
          return { ok: true, local: systemLocale };
        }
        return { ok: true, local: app.getLocale() };
      },
    };

    const handler = handlers[pathname];
    const settled = handler
      ? await settleDesktopProtocolAction(handler)
      : { status: 404 as const, body: { error: "未知接口" } };
    return new Response(JSON.stringify(settled.body), {
      status: settled.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
}

function registerTianjiangProtocol(): void {
  protocol.handle(BRAND.protocolScheme, handleDesktopProtocol);
}

const legacyProtocolMigration: {
  scheme: string;
  privileges: {
    secure: boolean;
    supportFetchAPI: boolean;
    corsEnabled: boolean;
  };
  register: () => void;
} = {
  scheme: LEGACY_PROTOCOL_SCHEME,
  privileges: {
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
  // 仅用于已有旧版页面的单次协议迁移；新代码必须使用主协议。
  register: () =>
    protocol.handle(legacyProtocolMigration.scheme, handleDesktopProtocol),
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: BRAND.protocolScheme,
    privileges: {
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: legacyProtocolMigration.scheme,
    privileges: legacyProtocolMigration.privileges,
  },
]);

app.whenReady().then(async () => {
  if (!singleInstanceOk) return;
  const startupLogPath = path.join(app.getPath("userData"), "logs", "startup.log");
  runtimeState = {
    ok: false,
    state: "starting",
    code: "STARTING",
    message: "本地服务正在启动",
    logPath: startupLogPath,
  };
  // 协议先于本地服务注册，启动失败时 renderer 仍能取得真实诊断。
  registerTianjiangProtocol();
  legacyProtocolMigration.register();
  try {
    let servePath: string;
    if (app.isPackaged) {
      // 生产环境：让出主线程一次，再校验并只读加载安装包资源。
      await new Promise((r) => setTimeout(r, 0));
      packagedRuntimeResources = resolvePackagedRuntimeResources(process.resourcesPath);
      process.env.TJ_IMMUTABLE_WEB_ROOT = packagedRuntimeResources.webRoot;
      servePath = packagedRuntimeResources.serveEntry;
    } else {
      // 开发环境：直接加载源码（tsx 通过 -r tsx 注册了 require 钩子）
      servePath = path.join(process.cwd(), "src", "app.ts");
    }
    // 使用自定义路径加载模块
    const mod = requireWithCustomPaths(servePath);
    const port = Number(await mod.default(true));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`本地服务返回无效端口: ${port}`);
    }
    // 只有服务完整启动后才登记安全关闭函数；失败态可直接退出或重启诊断页。
    closeServeFn = mod.closeServe;
    process.env.PORT = String(port);
    runtimeState = {
      ok: true,
      state: "ready",
      url: `http://127.0.0.1:${port}/api`,
      port,
      logPath: startupLogPath,
    };

    // 中文注释：先绑定 updater 状态，再开放 Renderer；Windows x64 登录门不得抢跑为空绑定。
    if (isWindowsX64UpdatePlatform()) {
      mod.bindManualUpdateService?.(null, {
        state: "initializing",
        platform: process.platform,
        arch: process.arch,
        currentVersion: app.getVersion(),
      });
      try {
        // 动态加载 electron-updater，避免非支持平台和非 Electron 测试触碰 Windows feed。
        const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
        const service = createDesktopManualUpdater({
          autoUpdater,
          currentVersion: app.getVersion(),
          dataRoot: path.join(app.getPath("userData"), "data"),
          prepareInstall: async () => {
            // 中文注释：备份和校验仍可失败，必须在关闭 HTTP/DB 前完成并让当前请求看到错误。
            await protectUserDataBeforeUpdate({
              userDataRoot: app.getPath("userData"),
            });
          },
          launchVerifiedInstaller: async (filePath) => {
            await launchVerifiedInstallerWithShell(filePath, (verifiedPath) => shell.openPath(verifiedPath));
          },
          finalizeInstallShutdown: async () => {
            // 安装动作由本地 HTTP 发起；OS 受理安装器后再摘除自身，避免关闭时等待当前响应。
            detachCurrentServeRequest();
            quitIntent.markInstallUpdate();
            await shutdownGate.finalizeAcceptedInstaller();
          },
          scheduleApplicationQuit: () => {
            // 中文注释：仅在 shell.openPath 已成功受理安装器后，才把应用退出排入下一轮事件循环。
            setImmediate(() => app.quit());
          },
          showDownloadedFile: (filePath) => {
            if (fs.existsSync(filePath)) shell.showItemInFolder(filePath);
          },
        });
        mod.bindManualUpdateService?.(service);
        // 启动、登录和设置页复用同一服务；单飞会合并随后到达的登录检查。
        void service.runAction({ action: "check" }).catch((error) => {
          console.info("[桌面更新初始检查失败]:", error instanceof Error ? error.message : "检查失败");
        });
      } catch (updaterError) {
        mod.failManualUpdateService?.(
          app.getVersion(),
          updaterError instanceof Error ? updaterError.message : "更新服务初始化失败",
        );
        console.error("[手动更新服务初始化失败]:", updaterError);
      }
    } else {
      mod.bindManualUpdateService?.(
        createUnsupportedManualUpdater(app.getVersion(), process.platform, process.arch),
      );
    }

    // 服务与更新登录门均已绑定后才创建主窗口。
    await createMainWindow();
    const trayResources = app.isPackaged
      ? path.join(process.resourcesPath, "build")
      : path.join(process.cwd(), "build");
    try {
      trayController = createTrayController({
        Tray,
        Menu,
        nativeImage,
        appName: BRAND.displayName,
        resourcesRoot: trayResources,
        platform: process.platform,
        getWindow: () => mainWindow,
        requestShutdown: () => requestShutdown(false),
      });
    } catch (trayError) {
      console.error("[托盘初始化失败]:", trayError);
    }
  } catch (err) {
    const classified = classifyStartupError(err);
    runtimeState = {
      ok: false,
      state: "failed",
      ...classified,
      logPath: startupLogPath,
    };
    try {
      writeStartupFailureLog(startupLogPath, runtimeState, err);
    } catch (logError) {
      console.error("[启动日志写入失败]:", logError);
    }
    console.error(
      "[服务启动失败]:",
      sanitizeDiagnosticText(err instanceof Error ? err.stack ?? err.message : err),
    );
    await createMainWindow();
  }
});

app.on("window-all-closed", () => {
  // 托盘有效期间不得因隐藏窗口而退出应用。
  if (trayController && !quitIntent.isExplicit()) return;
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow();
  } else {
    restoreMainWindow(mainWindow);
  }
});

app.on("before-quit", (event) => {
  if (shutdownGate.canQuit()) return;
  event.preventDefault();
  void requestShutdown(false);
});
