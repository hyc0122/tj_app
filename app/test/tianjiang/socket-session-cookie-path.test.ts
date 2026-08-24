/**
 * Socket Cookie Path 与 Engine.IO path 契约 + 空会话不得清空同步运行时。
 * 测试数据必须落在工作树 .tmp，禁止污染 app/data。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { Server } from "socket.io";
import { io as connectSocket, type Socket as ClientSocket } from "socket.io-client";

// —— 必须在 require 会捕获数据根的运行时之前设置隔离环境 ——
const worktreeRoot = path.resolve(__dirname, "../..", "..");
const testDataRoot = path.join(worktreeRoot, ".tmp", "socket-session-cookie-path");
fs.rmSync(testDataRoot, { recursive: true, force: true });
fs.mkdirSync(testDataRoot, { recursive: true });
process.env.NODE_TEST_CONTEXT = "1";
process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
process.env.TIANJIANG_TEST_DATA_ROOT = testDataRoot;

function listAppDataRelative(): string[] {
  const appData = path.join(worktreeRoot, "app", "data");
  if (!fs.existsSync(appData)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out.push(path.relative(appData, p).replace(/\\/g, "/"));
    }
  };
  walk(appData);
  return out.sort();
}

const appDataBefore = listAppDataRelative();
const require = createRequire(__filename);

// 环境变量已就绪后再加载运行时
const {
  buildSessionCookie,
  CENTRAL_SESSION_COOKIE,
  CentralBusinessError,
} = require("../../src/tianjiang/auth/central-session") as typeof import("../../src/tianjiang/auth/central-session");
const { ENGINE_IO_PATH, SOCKET_NAMESPACES } = require("../../src/tianjiang/socket-path") as typeof import("../../src/tianjiang/socket-path");
const { verifySocketCentralSession } = require("../../src/tianjiang/auth/socket-session") as typeof import("../../src/tianjiang/auth/socket-session");
const { isDefinitiveSessionAuthFailure } = require("../../src/tianjiang/auth/session-auth-failure") as typeof import("../../src/tianjiang/auth/session-auth-failure");
const { CentralServiceUnavailableError } = require("../../src/tianjiang/auth/central-service-error") as typeof import("../../src/tianjiang/auth/central-service-error");
const { syncCoordinator } = require("../../src/tianjiang/runtime/runtime") as typeof import("../../src/tianjiang/runtime/runtime");
const { createShutdownPhaseState } = require("../../src/tianjiang/runtime/sync-coordinator") as typeof import("../../src/tianjiang/runtime/sync-coordinator");
const { centralSessionStore } = require("../../src/tianjiang/auth/auth-runtime") as typeof import("../../src/tianjiang/auth/auth-runtime");
const { destroyAllDatabaseHandles } = require("../../src/utils/db") as typeof import("../../src/utils/db");
const { requireStrictPositiveSafeInteger } = require("../../src/tianjiang/runtime/positive-safe-integer") as typeof import("../../src/tianjiang/runtime/positive-safe-integer");

test("Cookie Path 固定为 /api，不得扩大为 /", () => {
  const cookie = buildSessionCookie("opaque-session-id", false, 3600);
  assert.match(cookie, /Path=\/api/i);
  assert.doesNotMatch(cookie, /Path=\/;|Path=\/$/i);
  assert.match(cookie, new RegExp(`${CENTRAL_SESSION_COOKIE}=`));
});

test("Engine.IO path 常量必须为 /api/socket.io", () => {
  assert.equal(ENGINE_IO_PATH, "/api/socket.io");
  assert.equal(SOCKET_NAMESPACES.scriptAgent, "/api/socket/scriptAgent");
  assert.equal(SOCKET_NAMESPACES.productionAgent, "/api/socket/productionAgent");
});

test("app.ts 创建 Server 时必须显式 path=/api/socket.io", () => {
  const appTs = fs.readFileSync(path.join(worktreeRoot, "app", "src", "app.ts"), "utf8");
  assert.match(appTs, /path\s*:\s*ENGINE_IO_PATH|path\s*:\s*[\"']\/api\/socket\.io[\"']/);
});

test("会话错误分类：503/网络非认证失败，401 为明确失败", () => {
  assert.equal(isDefinitiveSessionAuthFailure(new CentralServiceUnavailableError(new Error("down"), 503)), false);
  assert.equal(
    isDefinitiveSessionAuthFailure(new CentralBusinessError(401, "AUTH_REQUIRED", "失效", "rid")),
    true,
  );
  assert.equal(isDefinitiveSessionAuthFailure(new Error("prepareUserDatabase failed")), false);
});

function installFakeCoordinatorSession(session: { id: string; serverUrl: string; user: { id: number } }) {
  const internals = syncCoordinator as unknown as Record<string, unknown>;
  Object.assign(internals, {
    session,
    remote: { marker: true },
    online: true,
    deviceActive: true,
    catalog: new Map(),
    projects: new Map(),
    shutdownState: createShutdownPhaseState(),
    shutdownRequested: false,
  });
  return internals;
}

test("空 sessionId 调用 onSessionInvalid 不得清空当前 coordinator 会话", async () => {
  const fake = {
    id: "active-session-id",
    serverUrl: "https://api.j11.com.cn",
    user: { id: 42 },
  };
  installFakeCoordinatorSession(fake);
  await syncCoordinator.onSessionInvalid("");
  await syncCoordinator.onSessionInvalid("   ");
  const internals = syncCoordinator as unknown as { session?: { id: string }; remote?: unknown };
  assert.equal(internals.session?.id, "active-session-id");
  assert.ok(internals.remote);
});

test("未知 sessionId 不得影响当前有效会话", async () => {
  const fake = {
    id: "active-session-id",
    serverUrl: "https://api.j11.com.cn",
    user: { id: 42 },
  };
  installFakeCoordinatorSession(fake);
  await syncCoordinator.onSessionInvalid("totally-unknown-id");
  const internals = syncCoordinator as unknown as { session?: { id: string } };
  assert.equal(internals.session?.id, "active-session-id");
});

test("匹配的 sessionId 才允许清空当前运行时", async () => {
  const fake = {
    id: "active-session-id",
    serverUrl: "https://api.j11.com.cn",
    user: { id: 42 },
  };
  installFakeCoordinatorSession(fake);
  await syncCoordinator.onSessionInvalid("active-session-id");
  const internals = syncCoordinator as unknown as { session?: unknown; remote?: unknown };
  assert.equal(internals.session, undefined);
  assert.equal(internals.remote, undefined);
});

test("Socket 字符串 projectId 被严格拒绝", () => {
  assert.throws(() => requireStrictPositiveSafeInteger("101"));
  assert.throws(() => requireStrictPositiveSafeInteger(0));
  assert.equal(requireStrictPositiveSafeInteger(101), 101);
});

test("缺 Cookie 的 Socket 握手只拒绝连接，不清理 coordinator；且不污染 app/data", async (t) => {
  const session = centralSessionStore.create({
    serverUrl: "https://api.j11.com.cn",
    token: "jwt-not-for-web",
    expiresAt: Date.now() + 60_000,
    user: { id: 7701, username: "socket-user", nickname: "SU" },
  });
  installFakeCoordinatorSession(session);

  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: "*" }, path: ENGINE_IO_PATH });
  io.of(SOCKET_NAMESPACES.scriptAgent).on("connection", async (socket) => {
    const ok = await verifySocketCentralSession(socket);
    if (!ok && socket.connected) socket.disconnect(true);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as { port: number }).port;
  t.after(async () => {
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await destroyAllDatabaseHandles().catch(() => undefined);
    fs.rmSync(testDataRoot, { recursive: true, force: true });
  });

  const bare = await new Promise<ClientSocket | null>((resolve) => {
    const s = connectSocket(`http://127.0.0.1:${port}${SOCKET_NAMESPACES.scriptAgent}`, {
      path: ENGINE_IO_PATH,
      transports: ["websocket"],
      reconnection: false,
      timeout: 5000,
      auth: { projectId: 101 },
    });
    s.on("connect", () => resolve(s));
    s.on("connect_error", () => resolve(null));
    setTimeout(() => resolve(null), 3000);
  });

  await new Promise((r) => setTimeout(r, 200));
  const internals = syncCoordinator as unknown as { session?: { id: string }; remote?: unknown };
  assert.equal(internals.session?.id, session.id, "缺 Cookie 不得清空会话");
  assert.ok(internals.remote);
  bare?.disconnect();

  const authed = await new Promise<ClientSocket>((resolve, reject) => {
    const s = connectSocket(`http://127.0.0.1:${port}${SOCKET_NAMESPACES.scriptAgent}`, {
      path: ENGINE_IO_PATH,
      transports: ["websocket"],
      reconnection: false,
      timeout: 5000,
      extraHeaders: {
        cookie: buildSessionCookie(session.id, false, 3600),
      },
      auth: { projectId: 101 },
    });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
    setTimeout(() => reject(new Error("timeout connect authed")), 8000);
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(authed.connected, true);
  assert.equal(
    (syncCoordinator as unknown as { session?: { id: string } }).session?.id,
    session.id,
  );
  authed.disconnect();
  io.close();
  await destroyAllDatabaseHandles().catch(() => undefined);

  const appDataAfter = listAppDataRelative();
  assert.deepEqual(appDataAfter, appDataBefore, "测试不得向 app/data 新增文件");
});

test("使用默认 /socket.io path 时浏览器侧 Cookie Path=/api 不会被发送（契约说明）", () => {
  const cookiePath = "/api";
  const badEnginePath = "/socket.io" as string;
  const goodEnginePath = ENGINE_IO_PATH as string;
  assert.ok(!badEnginePath.startsWith(`${cookiePath}/`) && badEnginePath !== cookiePath);
  assert.ok(goodEnginePath === `${cookiePath}/socket.io` || goodEnginePath.startsWith(`${cookiePath}/`));
});
