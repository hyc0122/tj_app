// import "./logger";
import "./err";
import "./env";
import express, { Request, Response, NextFunction } from "express";
import { Server } from "socket.io";
import http from "node:http";
import type { Duplex } from "node:stream";
import expressWs from "express-ws";
import logger from "morgan";
import cors from "cors";
import buildRoute from "@/core";
import path from "path";
import fs from "fs";
import u from "@/utils";
import socketInit from "@/socket/index";
import { ENGINE_IO_PATH } from "@/tianjiang/socket-path";
import { isEletron } from "@/utils/getPath";
import { ensureThumbnail, ThumbnailSize } from "@/utils/image";
import { centralAuthGateway, centralSessionStore } from "@/tianjiang/auth/auth-runtime";
import {
  createCentralSessionMiddleware,
  TIANJIANG_PRE_AUTH_PUBLIC_PATHS,
} from "@/tianjiang/auth/session-middleware";
import { syncCoordinator } from "@/tianjiang/runtime/runtime";
import tianjiangRuntimeRouter from "@/routes/tianjiang/runtime";
import tianjiangControlPlaneRouter from "@/routes/tianjiang/control-plane";
import tianjiangStoryboardHttpRouter from "@/routes/tianjiang/storyboard-http";
import {
  describeLegacyProjectTarget,
  isGlobalLegacyDestructiveRoute,
  isLegacyProjectMutation,
  isLegacyProjectRoute,
  isTransientLegacyMediaUpload,
} from "@/tianjiang/runtime/legacy-project-guard";
import {
  migrateActiveDatabaseBeforeServe,
  prepareProjectDatabase,
  prepareUserDatabase,
} from "@/utils/db";
import { currentOssRoot } from "@/utils/oss";
import {
  runWithProjectStorage,
  runWithUserStorage,
} from "@/tianjiang/runtime/user-storage-context";
import { assertNoImageBase64 } from "@/tianjiang/media/media-safety";
import { listenHttpServer } from "@/tianjiang/runtime/http-listener";
import type { ManualUpdateActionBody } from "@/tianjiang/update/manual-update-contracts";
import { ensureCurrentAccountBuiltinSkills } from "@/tianjiang/skills/account-skills";
import {
  bindManualUpdater,
  type ManualUpdaterBindingState,
} from "@/routes/setting/about/checkUpdate";
import { bindManualDownloadUpdater } from "@/routes/setting/about/downloadApp";
import {
  closeServe,
  createWebSocketRuntime,
  registerServeRuntimeResources,
} from "@/tianjiang/runtime/serve-lifecycle";
import { serveReadinessGate } from "@/tianjiang/runtime/serve-readiness";

const app = express();
const server = http.createServer(app);
const EXPRESS_WS_PATH = "/api/express-ws";

/**
 * express-ws 5 内置的旧版 ws 会对非自身 path 的 upgrade 主动返回 400。
 * 因此保留真实共享 WSS，但只把明确的保留路径交给它，Socket.IO 路径继续由 Engine.IO 独占。
 */
function bindExpressWebSocketRuntime() {
  const existingUpgradeListeners = new Set(server.listeners("upgrade"));
  const runtime = expressWs(app, server);
  for (const listener of server.listeners("upgrade")) {
    if (!existingUpgradeListeners.has(listener)) server.removeListener("upgrade", listener);
  }

  const webSocketServer = runtime.getWss();
  const selectiveUpgrade = (
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== EXPRESS_WS_PATH) return;
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  };
  server.on("upgrade", selectiveUpgrade);
  return createWebSocketRuntime(
    webSocketServer,
    () => server.removeListener("upgrade", selectiveUpgrade),
  );
}

type ManualUpdateServiceLike = {
  getSnapshot: () => unknown;
  runAction: (body: ManualUpdateActionBody) => Promise<unknown>;
  startAction: (body: ManualUpdateActionBody) => Promise<unknown>;
};

/** 主进程把 updater 注入已打包的同一个 Express 路由实例，禁止回源加载 src。 */
export function bindManualUpdateService(
  service: ManualUpdateServiceLike | null,
  state?: ManualUpdaterBindingState,
): void {
  bindManualUpdater(service, state);
  bindManualDownloadUpdater(service);
}

/** 初始化失败也必须进入明确可重试的 fail-closed 状态。 */
export function failManualUpdateService(currentVersion: string, message?: string): void {
  bindManualUpdateService(null, {
    state: "failed",
    platform: process.platform,
    arch: process.arch,
    currentVersion,
    message,
  });
}

async function checkPermissions() {
  if (!isEletron()) return true;
  const userDataPath = u.getPath();
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    const testFile = path.join(userDataPath, ".access_test");
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
  } catch (e) {
    const { dialog, app } = require("electron");
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "权限不足",
      message: "应用无法访问数据目录",
      detail: `无法读写以下目录：\n${userDataPath}\n\n请确认当前 Windows 账号拥有该数据目录的读写权限，然后重新启动应用。`,
      buttons: ["确认退出"],
      defaultId: 0,
    });
    if (response === 0) {
      app.quit();
    }
    // app.quit() 只发起退出；必须同步终止启动链，禁止继续迁移或打开 SQLite。
    throw Object.assign(new Error("应用数据目录不可写"), {
      code: "APP_DATA_PERMISSION_DENIED",
      cause: e,
    });
  }
}

export default async function startServe(randomPort: Boolean = false) {
  await checkPermissions();

  // 数据库迁移失败必须阻止监听端口，路由、Socket 和任务恢复都不能提前运行。
  await migrateActiveDatabaseBeforeServe();
  await u.writeVersion();
  // Engine.IO path 必须在 /api 下，浏览器才会把 Path=/api 的 tj_session Cookie 发给握手。
  const io = new Server(server, { cors: { origin: "*" }, path: ENGINE_IO_PATH });
  const socketRuntime = socketInit(io);

  if (process.env.NODE_ENV == "dev") await buildRoute();

  const webSocketRuntime = bindExpressWebSocketRuntime();

  // 必须是所有业务/静态中间件之前的全局门；关闭时统一拒绝新 HTTP 并统计活动请求。
  serveReadinessGate.startAccepting();
  app.use(serveReadinessGate.middleware());
  app.use(logger("dev"));
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ extended: true, limit: "100mb" }));

  // assets 静态资源
  const assetsDir = u.getPath("assets");
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  app.use("/assets", express.static(assetsDir, { acceptRanges: false }));

  // 打包环境中的 web 是只读安装资源；用户 data/web 即使遗留也绝不再加载。
  const webDir = process.env.TJ_IMMUTABLE_WEB_ROOT
    ? path.resolve(process.env.TJ_IMMUTABLE_WEB_ROOT)
    : u.getPath("web");
  if (fs.existsSync(webDir)) {
    console.log("静态网站目录:", webDir);
    app.use(express.static(webDir, { acceptRanges: false }));
  } else {
    console.warn("静态网站目录不存在:", webDir);
  }

  app.use(createCentralSessionMiddleware({
    gateway: centralAuthGateway,
    sessionStore: centralSessionStore,
    publicPaths: TIANJIANG_PRE_AUTH_PUBLIC_PATHS,
    onSessionInvalid: (session) => syncCoordinator.onSessionInvalid(session),
    isOfflineRequest: (requestPath, method) =>
      syncCoordinator.isOfflineRequest(requestPath, method),
    runOffline: async (next) => {
      // 离线授权与在线会话一样必须先打开账号 db2，供应商配置不得回退项目库。
      const identity = syncCoordinator.offlineStorageIdentity();
      await prepareUserDatabase(identity);
      return runWithUserStorage(identity, async () => {
        void import("@/tianjiang/model-providers/dreamina-cli/dreamina-enablement").then(async ({
          endDreaminaEnablementProbe,
          reserveDreaminaProbeForCurrentSettings,
          runWithDreaminaProbeToken,
        }) => {
          const token = await reserveDreaminaProbeForCurrentSettings();
          if (!token) return;
          try {
            const { ensureDreaminaStartupStatusCheck } = await import(
              "@/tianjiang/model-providers/dreamina-cli/cli-truth"
            );
            await runWithDreaminaProbeToken(token, () => ensureDreaminaStartupStatusCheck());
          } finally {
            endDreaminaEnablementProbe(token);
          }
        }).catch(() => undefined);
        return next();
      });
    },
    runAuthenticated: async (session, next) => {
      const storageIdentity = { issuer: session.serverUrl, userId: session.user.id };
      await prepareUserDatabase(storageIdentity);
      // 从这里开始的所有 DB/OSS 异步调用都绑定当前中央用户，不依赖全局“当前账号”变量。
      return runWithUserStorage(storageIdentity, async () => {
        void import("@/tianjiang/model-providers/dreamina-cli/dreamina-enablement").then(async ({
          endDreaminaEnablementProbe,
          reserveDreaminaProbeForCurrentSettings,
          runWithDreaminaProbeToken,
        }) => {
          const token = await reserveDreaminaProbeForCurrentSettings();
          if (!token) return;
          try {
            const { ensureDreaminaStartupStatusCheck } = await import(
              "@/tianjiang/model-providers/dreamina-cli/cli-truth"
            );
            await runWithDreaminaProbeToken(token, () => ensureDreaminaStartupStatusCheck());
          } finally {
            endDreaminaEnablementProbe(token);
          }
        }).catch(() => undefined);
        return next();
      });
    },
  }));

  // 登录 Cookie 仅在 /api 下发送；封面路由必须同属该作用域，且继续由账号上下文隔离。
  app.use("/api/skills", async (req, res, next) => {
    if (!/\.(jpe?g|png|gif|webp|svg|ico|bmp)$/i.test(req.path)) return res.status(403).end();
    try {
      // 认证中间件已建立 AsyncLocalStorage；静态图片也只能读取当前账号目录。
      const { skillsRoot } = await ensureCurrentAccountBuiltinSkills(u.getPath());
      return express.static(skillsRoot, { acceptRanges: false })(req, res, next);
    } catch {
      return res.status(503).send({ code: 503, message: "当前账号 Skills 资源不可用" });
    }
  });

  // OSS 必须位于中央认证和用户存储上下文之后，静态请求也不能跨账号读取。
  app.use("/oss", (req, res, next) => {
    const ossDir = currentOssRoot();
    fs.mkdirSync(ossDir, { recursive: true });
    const staticFiles = express.static(ossDir, { acceptRanges: false });
    if (!req.query.size) return staticFiles(req, res, next);

    const size = String(req.query.size);
    const smallImageBaseDir = path.join(ossDir, "smallImage");
    const originalPath = path.join(ossDir, req.path);
    let sizeSubDir: string;
    let sizeOpts: ThumbnailSize | undefined;
    const dimensMatch = size.match(/^(\d+)x(\d+)$/i);
    const percentMatch = size.match(/^(\d+(?:\.\d+)?)\s*%?$/);
    if (dimensMatch) {
      const width = parseInt(dimensMatch[1], 10);
      const height = parseInt(dimensMatch[2], 10);
      sizeSubDir = `${width}x${height}`;
      sizeOpts = { type: "dimensions", width, height };
    } else if (percentMatch) {
      const percentage = parseFloat(percentMatch[1]);
      sizeSubDir = `${percentMatch[1]}p`;
      sizeOpts = { type: "percentage", value: percentage };
    } else {
      return staticFiles(req, res, next);
    }
    const ext = path.extname(req.path);
    const base = path.basename(req.path, ext);
    const dir = path.dirname(req.path);
    const smallImagePath = path.join(smallImageBaseDir, dir, `${base}_${sizeSubDir}${ext}`);
    void ensureThumbnail(originalPath, smallImagePath, sizeOpts).then((thumbnailPath) => {
      if (thumbnailPath) res.sendFile(thumbnailPath);
      else staticFiles(req, res, next);
    });
  });

  app.use(async (req, res, next) => {
    if (isGlobalLegacyDestructiveRoute(req.path)) {
      return res.status(403).send({
        code: 403,
        message: "全局数据库清理入口已禁用，请使用受控项目迁移或删除流程",
      });
    }
    if (!isLegacyProjectRoute(req.path)) return next();
    try {
      const session = (req as any).centralSession;
      const mutation = isLegacyProjectMutation(req.method, req.path);
      if (mutation && !isTransientLegacyMediaUpload(req.path)) {
        assertNoImageBase64(req.body, "旧业务写请求");
      }
      const target = describeLegacyProjectTarget(req.path, req.body ?? {});
      // 统一解析项目及所有子资源归属；未命中、跨项目或歧义均返回 404。
      const { projectUuid } = await syncCoordinator.authorizeLegacyRequest(
        session,
        target,
        mutation,
      );
      await prepareProjectDatabase(projectUuid);
      if (mutation) {
        res.once("finish", () => {
          if (res.statusCode < 400) {
            // 旧业务写成功后先落 durable intent，再更新运行时 dirty；进程重启仍可恢复首次同步。
            try {
              syncCoordinator.recordAndMarkLegacyMutation(projectUuid, "legacyRoute");
            } catch {
              // 响应已结束，不能再伪造成功/失败；保留安全诊断供本地日志定位磁盘异常。
              console.error("[sync] 旧业务写入后的同步登记失败");
            }
          }
        });
      }
      return runWithProjectStorage(projectUuid, next);
    } catch (error) {
      const status = typeof (error as { status?: unknown })?.status === "number"
        ? Number((error as { status: number }).status)
        : 403;
      return res.status(status).send({
        code: status,
        message: error instanceof Error ? error.message : "项目写入被拒绝",
      });
    }
  });

  // 运行时路由直接进入生产装配，不能依赖被 Git 忽略的自动生成 router.ts。
  app.use("/api/tianjiang/runtime", tianjiangRuntimeRouter);
  app.use("/api/tianjiang/storyboard", tianjiangStoryboardHttpRouter);
  // 中央控制面只暴露公共契约声明的版本化路径；/admin 不是 API 前缀。
  app.use("/api/tianjiang/v1", tianjiangControlPlaneRouter);

  const router = await import("@/router");
  await router.default(app);

  // 404 处理
  app.use((_, res, next: NextFunction) => {
    return res.status(404).send({ message: "API 404 Not Found" });
  });

  // 错误处理
  app.use((err: any, _: Request, res: Response, __: NextFunction) => {
    res.locals.message = err.message;
    res.locals.error = err;
    console.error(err);
    res.status(err.status || 500).send(err);
  });

  const port = randomPort ? 0 : 10588;
  const realPort = await listenHttpServer(server, port);
  registerServeRuntimeResources({
    httpServer: server,
    socketRuntime,
    webSocketRuntime,
  });
  console.log(`[服务启动成功]: http://127.0.0.1:${realPort}`);
  return realPort;
}

// Electron 主进程加载该命名导出，更新备份必须等待真实生命周期全部关闭。
export { closeServe };

const isElectron = typeof process.versions?.electron !== "undefined";
if (!isElectron) startServe();
