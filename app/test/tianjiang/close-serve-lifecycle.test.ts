import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import express from "express";
import expressWs from "express-ws";
import { Server } from "socket.io";
import { io as connectSocket, type Socket as ClientSocket } from "socket.io-client";

import socketInit from "../../src/socket";
import { ENGINE_IO_PATH } from "../../src/tianjiang/socket-path";
import { CentralAuthGateway, type CentralSession } from "../../src/tianjiang/auth/central-session";
import { KeyServiceUnavailableError } from "../../src/tianjiang/auth/key-service-error";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";
import {
  activateUserDatabase,
  databaseRuntimeSnapshot,
  destroyAllDatabaseHandles,
  prepareProjectDatabase,
  stopGenerationTaskRecovery,
  trackGenerationTaskRecovery,
} from "../../src/utils/db";
import { ShutdownGate } from "../../src/tianjiang/runtime/shutdown-gate";
import {
  closeServe,
  createWebSocketRuntime,
  registerServeRuntimeResources,
  serveRuntimeSnapshot,
} from "../../src/tianjiang/runtime/serve-lifecycle";
import { serveReadinessGate } from "../../src/tianjiang/runtime/serve-readiness";
import { SyncCoordinator } from "../../src/tianjiang/runtime/sync-coordinator";
import { runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";

// 夹具放在测试 runner 注入的短 TEMP（.tmp/r）下，避免长 worktree 名导致 Windows 清理 EPERM。
const fixtureRoot = path.resolve(
  process.env.TEMP || path.join(process.cwd(), "..", ".tmp"),
  "csl",
);

test("真实 closeServe 在更新备份前清零恢复 timer、传输层与全部数据库句柄", async () => {
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });

  const expressApp = express();
  expressApp.use(serveReadinessGate.middleware());
  let releaseRequest!: () => void;
  const requestReleased = new Promise<void>((resolve) => { releaseRequest = resolve; });
  let requestEntered!: () => void;
  const entered = new Promise<void>((resolve) => { requestEntered = resolve; });
  expressApp.get("/hold", async (_request, response) => {
    requestEntered();
    await requestReleased;
    response.status(200).send("done");
  });
  const httpServer = http.createServer(expressApp);
  const wsRuntime = expressWs(expressApp, httpServer);
  const socketServer = new Server(httpServer, { cors: { origin: "*" }, path: ENGINE_IO_PATH });
  const socketRuntime = socketInit(socketServer);

  try {
    process.chdir(fixtureRoot);
    process.env.NODE_ENV = "prod";
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    registerServeRuntimeResources({
      httpServer,
      socketRuntime,
      webSocketRuntime: createWebSocketRuntime(wsRuntime.getWss()),
    });
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");

    const identity = { issuer: "https://api.j11.com.cn", userId: 9001 };
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, () =>
      prepareProjectDatabase("11111111-1111-4111-a111-111111111111"));

    assert.deepEqual(databaseRuntimeSnapshot(), {
      userHandleCount: 1,
      projectHandleCount: 1,
      generationRecoveryTimerActive: true,
    });
    assert.equal(serveRuntimeSnapshot().httpListening, true);

    let backupCalls = 0;
    let finishRecovery!: () => void;
    const recovery = trackGenerationTaskRecovery(() => new Promise<void>((resolve) => {
      finishRecovery = resolve;
    }));
    const activeRequest = fetch(`http://127.0.0.1:${address.port}/hold`);
    await entered;
    const gate = new ShutdownGate({
      closeRuntime: closeServe,
      quit: () => undefined,
      relaunch: () => undefined,
      onFailure: async (error) => { throw error; },
    });

    const closing = gate.prepareForInstaller(async () => {
      backupCalls += 1;
      // 更新备份只能观察到完全静止的数据层与传输层。
      assert.deepEqual(databaseRuntimeSnapshot(), {
        userHandleCount: 0,
        projectHandleCount: 0,
        generationRecoveryTimerActive: false,
      });
      const snap = serveRuntimeSnapshot();
      assert.equal(snap.closing, true);
      assert.equal(snap.phase, "closed");
      assert.equal(snap.projectCloseCommitComplete, true);
      assert.equal(snap.preflightPersonalCloseComplete, true);
      assert.equal(snap.acceptingHttpRequests, false);
      assert.equal(snap.activeRequestCount, 0);
      assert.equal(snap.activeRequestsDrained, true);
      assert.equal(snap.acceptingSocketEvents, false);
      assert.equal(snap.activeSocketHandlerCount, 0);
      assert.equal(snap.socketHandlersDrained, true);
      assert.equal(snap.acceptingWebSocketConnections, false);
      assert.equal(snap.generationRecoveryStopped, true);
      assert.equal(snap.profileKeyRecoveryStopped, true);
      assert.equal(snap.socketIOActive, false);
      assert.equal(snap.webSocketActive, false);
      assert.equal(snap.finalSyncComplete, true);
      assert.equal(snap.databaseHandlesClosed, true);
      assert.equal(snap.httpListening, false);
      assert.equal(snap.closed, true);
    });

    await Promise.resolve();
    assert.equal(backupCalls, 0, "活动 HTTP 未结束时不得备份");
    releaseRequest();
    assert.equal((await activeRequest).status, 200);
    await Promise.resolve();
    assert.equal(backupCalls, 0, "恢复任务未结束时不得备份");
    finishRecovery();
    await Promise.all([recovery, closing]);

    assert.equal(backupCalls, 1);
    await closeServe();
    assert.equal(serveRuntimeSnapshot().closed, true, "重复关闭必须幂等成功");
  } finally {
    releaseRequest?.();
    // 先停恢复任务并销毁句柄，再关 HTTP，最后清理目录，降低 Windows 文件锁干扰。
    try { await stopGenerationTaskRecovery(); } catch { /* 清理路径不掩盖主断言 */ }
    try { await destroyAllDatabaseHandles(); } catch { /* 清理路径不掩盖主断言 */ }
    try { await closeServe(); } catch { /* 清理路径不掩盖主断言 */ }
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    try {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    } catch {
      // Windows 偶发目录锁：主断言已完成时不因清理失败翻红。
    }
  }
});

test("阻塞 HTTP、Socket Agent 与 profile key recovery 全部结束后才能最终同步、销毁 DB 和备份", async () => {
  const integrationRoot = path.join(fixtureRoot, "three-way-inflight");
  fs.rmSync(integrationRoot, { recursive: true, force: true });
  fs.mkdirSync(integrationRoot, { recursive: true });
  const events: string[] = [];
  const httpBarrier = deferred();
  const socketBarrier = deferred();
  const keyBarrier = deferred();
  const httpStarted = deferred();
  const socketStarted = deferred();
  const keyStarted = deferred();
  let client: ClientSocket | undefined;
  let closing: Promise<void> | undefined;
  let recovery: Promise<unknown> | undefined;

  const expressApp = express();
  expressApp.use(serveReadinessGate.middleware());
  expressApp.get("/hold-all", async (_request, response) => {
    events.push("http:start");
    httpStarted.resolve();
    await httpBarrier.promise;
    events.push("http:done");
    response.status(200).send("done");
  });
  const httpServer = http.createServer(expressApp);
  const socketServer = new Server(httpServer, { cors: { origin: "*" }, path: ENGINE_IO_PATH });
  const socketRuntime = socketInit(socketServer, {
    productionAgent: (namespace, activity) => {
      activity.bindConnection(namespace, async (socket) => {
        activity.bindEvent(socket, "chat", async () => {
          events.push("socket:start");
          socketStarted.resolve();
          await socketBarrier.promise;
          events.push("socket:done");
        });
      });
    },
  });
  const session: CentralSession = {
    id: "shutdown-session",
    serverUrl: "https://api.j11.com.cn",
    token: "test-only-token",
    expiresAt: Date.now() + 60_000,
    validatedAt: Date.now(),
    user: { id: 9001, username: "shutdown-user", nickname: "" },
  };
  const coordinator = new SyncCoordinator(
    integrationRoot,
    new CentralAuthGateway(),
    new MemoryCredentialStore(),
    {
      createKeyRecoveryClient: () => ({
        deviceIdentity: () => ({ publicKey: "unused", publicFingerprint: "unused" }),
        loadOrRecover: async () => {
          events.push("key:start");
          keyStarted.resolve();
          await keyBarrier.promise;
          events.push("key:done");
          throw new KeyServiceUnavailableError();
        },
      }),
    },
  );
  // 直接布置“登录已成功但密钥服务降级”的真实协调器状态，避免访问任何中央服务。
  Object.assign(coordinator as unknown as Record<string, unknown>, {
    session,
    remote: {},
    online: true,
    deviceActive: true,
    profileFailure: {
      code: "KEY_SERVICE_UNAVAILABLE",
      message: "个人密钥服务暂不可用，恢复后将自动重试",
      retryable: true,
    },
    keyRetryUserUuid: "11111111-1111-4111-a111-111111111111",
  });

  const webSocketRuntime = {
    beginClosing: () => { events.push("ws:entry-closed"); },
    close: async () => { events.push("ws:closed"); },
  };

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    registerServeRuntimeResources({ httpServer, socketRuntime, webSocketRuntime }, {
      stopGenerationRecovery: async () => { events.push("generation:stopped"); },
      stopProfileKeyRecovery: () => coordinator.stopBackgroundWork(),
      // 本测无打开项目；commit 为空操作，保证写 handler 排空后才 finalSync
      commitProjectCloses: async () => {
        events.push("project-close-commit");
      },
      finalSync: async () => {
        events.push("final-sync:start");
        await coordinator.shutdown();
        events.push("final-sync:done");
      },
      destroyDatabases: async () => { events.push("db:destroyed"); },
    });
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");
    client = connectSocket(`http://127.0.0.1:${address.port}/api/socket/productionAgent`, {
      path: ENGINE_IO_PATH,
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    await withTimeout(new Promise<void>((resolve, reject) => {
      client?.once("connect", resolve);
      client?.once("connect_error", reject);
    }), "Socket 测试连接未建立");

    const activeHttp = fetch(`http://127.0.0.1:${address.port}/hold-all`);
    await httpStarted.promise;
    client.emit("chat", { content: "block" });
    await withTimeout(socketStarted.promise, "共享 Agent handler 未进入");
    recovery = coordinator.retryProfileSync(session);
    await keyStarted.promise;

    const gate = new ShutdownGate({
      closeRuntime: closeServe,
      quit: () => undefined,
      relaunch: () => undefined,
      onFailure: async (error) => { throw error; },
    });
    closing = gate.prepareForInstaller(async () => { events.push("backup"); });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // reversible_draining：立即拒绝新 Socket 事件；不可逆 WS 关闭在排空+commit 之后
    assert.equal(socketRuntime.snapshot().acceptingEvents, false);
    assert.equal(events.includes("ws:entry-closed"), false, "不可逆 WS 关闭不得早于写 handler 排空");
    assert.equal(events.includes("final-sync:start"), false);
    assert.equal(events.includes("project-close-commit"), false, "写 handler 在途时不得 project_close_commit");

    httpBarrier.resolve();
    assert.equal((await activeHttp).status, 200);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(events.includes("final-sync:start"), false, "Socket handler 仍在途时不得最终同步");

    socketBarrier.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(events.includes("final-sync:start"), false, "key recovery 仍在途时不得最终同步");

    keyBarrier.resolve();
    await Promise.all([recovery, closing]);
    assertBefore(events, "http:done", "project-close-commit");
    assertBefore(events, "socket:done", "project-close-commit");
    assertBefore(events, "project-close-commit", "ws:entry-closed");
    assertBefore(events, "http:done", "final-sync:start");
    assertBefore(events, "socket:done", "final-sync:start");
    assertBefore(events, "key:done", "final-sync:start");
    assertBefore(events, "final-sync:done", "db:destroyed");
    assertBefore(events, "db:destroyed", "backup");
    assert.deepEqual(coordinator.backgroundWorkSnapshot(), {
      acceptingKeyRecovery: false,
      keyRecoveryInFlight: false,
      keyRetryTimerActive: false,
    });
  } finally {
    httpBarrier.resolve();
    socketBarrier.resolve();
    keyBarrier.resolve();
    client?.close();
    await Promise.allSettled([recovery, closing].filter((item): item is Promise<unknown> => Boolean(item)));
    try { await closeServe(); } catch { /* 清理 */ }
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    try {
      fs.rmSync(integrationRoot, { recursive: true, force: true });
    } catch {
      // Windows 偶发目录锁。
    }
  }
});

test("productionAgent 与 scriptAgent 的连接及事件必须全部经过共享活动门", () => {
  for (const routeName of ["productionAgent", "scriptAgent"]) {
    const source = fs.readFileSync(
      path.resolve("src", "socket", "routes", `${routeName}.ts`),
      "utf8",
    );
    assert.match(source, /activity\.bindConnection\(/);
    assert.match(source, /activity\.bindEvent\(socket, "chat"/);
    assert.doesNotMatch(source, /socket\.on\(/);
  }
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

function assertBefore(events: string[], earlier: string, later: string): void {
  const earlierIndex = events.indexOf(earlier);
  const laterIndex = events.indexOf(later);
  assert.ok(earlierIndex >= 0, `缺少事件：${earlier}`);
  assert.ok(laterIndex >= 0, `缺少事件：${later}`);
  assert.ok(earlierIndex < laterIndex, `${earlier} 必须早于 ${later}`);
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
