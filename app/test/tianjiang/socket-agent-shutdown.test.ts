import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { Server, type Socket as ServerSocket } from "socket.io";
import { io as connectSocket, type Socket as ClientSocket } from "socket.io-client";
import { ENGINE_IO_PATH } from "../../src/tianjiang/socket-path";

import type { AgentContext as ProductionAgentContext } from "../../src/agents/productionAgent";
import type { AgentContext as ScriptAgentContext } from "../../src/agents/scriptAgent";
import socketInit from "../../src/socket";
import {
  centralAuthGateway,
  centralSessionStore,
} from "../../src/tianjiang/auth/auth-runtime";
import { disconnectSocketsExceptSession } from "../../src/tianjiang/auth/socket-session";
import { createShutdownPhaseState } from "../../src/tianjiang/runtime/sync-coordinator";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";

test("真实 production/script Agent 断连会取消在途工作，鉴权后不再启动 provider 且排空失败关闭", async () => {
  const originalCwd = process.cwd();
  // 中文注释：测试数据必须落在当前工作树 .tmp，禁止污染系统 TEMP / app/data
  const worktreeRoot = path.resolve(originalCwd, "..");
  const runId = `run-${process.pid}-${Date.now()}`;
  const dataRoot = path.join(worktreeRoot, ".tmp", "socket-agent-shutdown", runId);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = dataRoot;
  process.chdir(dataRoot);
  resetDatabaseRuntimeForServe();

  const projectUuid = "44444444-4444-4444-a444-444444444444";
  const legacyProjectId = 4401;
  const session = centralSessionStore.create({
    serverUrl: "https://api.j11.com.cn",
    token: "socket-agent-test-token",
    expiresAt: Date.now() + 60_000,
    user: { id: 9401, username: "socket-agent-user", nickname: "" },
  });
  const coordinatorInternals = syncCoordinator as unknown as Record<string, any>;
  const deviceUuid = String(coordinatorInternals.deviceUuid);
  const blockedAuthorizationStarted = deferred<void>();
  const blockedAuthorizationBarrier = deferred<void>();
  const initialVerificationStarted = deferred<void>();
  const initialVerificationBarrier = deferred<void>();
  let blockAuthorization = false;
  let blockedAuthorizationCount = 0;
  let initialVerificationCount = 0;
  let mutationCount = 0;
  const projectRuntime = {
    kind: "personal",
    local: {
      hasLegacyResource: () => true,
      markLegacyEdited: () => { mutationCount += 1; },
      close: () => undefined,
    },
    sync: {
      markEdited: () => undefined,
      close: async () => undefined,
    },
  };
  const catalogItem = {
    projectUuid,
    name: "Socket Agent 测试项目",
    kind: "personal",
    ownerUserId: session.user.id,
    role: "owner",
    myRole: "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: new Date().toISOString(),
    lockStatus: "none",
    lockHolderName: "",
    openMode: "editable",
    businessType: "script",
  };
  const grant = {
    grantId: "55555555-5555-4555-a555-555555555555",
    userId: session.user.id,
    deviceUuid,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revokedAt: null,
  };
  Object.assign(coordinatorInternals, {
    session,
    remote: {
      refreshOfflineGrant: async () => {
        if (blockAuthorization) {
          blockedAuthorizationCount += 1;
          if (blockedAuthorizationCount === 2) blockedAuthorizationStarted.resolve();
          // 控制面边界故意悬挂，覆盖 chat 鉴权期间发生真实 disconnect 的窗口。
          await blockedAuthorizationBarrier.promise;
        }
        return grant;
      },
    },
    profileStore: undefined,
    profileSync: undefined,
    profileFailure: undefined,
    catalog: new Map([[projectUuid, catalogItem]]),
    localProjectIds: new Map([[projectUuid, legacyProjectId]]),
    offlineCache: {
      issuer: session.serverUrl,
      userId: session.user.id,
      grant,
      catalog: [catalogItem],
    },
    online: true,
    deviceActive: true,
    profileKey: undefined,
    keyRetryTimer: undefined,
    keyRetryCount: 0,
    keyRetryUserUuid: undefined,
    keyRecoveryInFlight: undefined,
    acceptingKeyRecovery: true,
    shutdownState: createShutdownPhaseState(),
    shutdownRequested: false,
    loginInFlight: undefined,
    shutdownInFlight: undefined,
  });
  coordinatorInternals.projects.clear();
  coordinatorInternals.projects.set(projectUuid, projectRuntime);

  const productionStarted = deferred<AbortSignal>();
  const scriptStarted = deferred<AbortSignal>();
  const productionBarrier = deferred<void>();
  const scriptBarrier = deferred<void>();
  let unexpectedProductionRuns = 0;
  let unexpectedScriptRuns = 0;
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: "*" }, path: ENGINE_IO_PATH });
  const runtime = socketInit(io, undefined, {
    productionAgent: {
      runDecisionAI: async (context: ProductionAgentContext) => {
        assert.ok(context.abortSignal);
        if (context.text === "blocked production") {
          unexpectedProductionRuns += 1;
          return;
        }
        productionStarted.resolve(context.abortSignal);
        // 故意忽略 abort，证明 tracker 不会把“已发取消”误当成“已经排空”。
        await productionBarrier.promise;
        // 模拟导演规划已通过后端契约并完成事务提交；未提交时 route 不得无条件标脏。
        context.artifactCommitted = true;
        context.onArtifactCommitted?.();
      },
    },
    scriptAgent: {
      runDecisionAI: async (context: ScriptAgentContext) => {
        assert.ok(context.abortSignal);
        if (context.text === "blocked script") {
          unexpectedScriptRuns += 1;
          // 未提交 plan 事务：route 不得 markLegacyMutation
          return { planCommitted: false };
        }
        scriptStarted.resolve(context.abortSignal);
        await scriptBarrier.promise;
        // 模拟决策完整成功且已事务提交，route 才允许 markLegacyMutation
        return { planCommitted: true };
      },
    },
  });
  const clients: ClientSocket[] = [];
  const initialVerificationSockets: ServerSocket[] = [];
  let closing: Promise<void> | undefined;
  const gatewayInternals = centralAuthGateway as unknown as { fetcher: typeof fetch };
  const originalCentralFetcher = gatewayInternals.fetcher;

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const cookie = `tj_session=${encodeURIComponent(session.id)}`;
    const productionClient = await connectAgent(
      `${baseUrl}/api/socket/productionAgent`,
      cookie,
      { isolationKey: "production-isolation", projectId: legacyProjectId, scriptId: 77 },
      io,
      "/api/socket/productionAgent",
    );
    clients.push(productionClient);
    const scriptClient = await connectAgent(
      `${baseUrl}/api/socket/scriptAgent`,
      cookie,
      { isolationKey: "script-isolation", projectId: legacyProjectId },
      io,
      "/api/socket/scriptAgent",
    );
    clients.push(scriptClient);

    productionClient.emit("chat", { content: "hold production" });
    scriptClient.emit("chat", { content: "hold script" });
    const productionSignal = await withTimeout(productionStarted.promise, "production Agent 未进入");
    const scriptSignal = await withTimeout(scriptStarted.promise, "script Agent 未进入");

    const blockedProductionClient = await connectAgent(
      `${baseUrl}/api/socket/productionAgent`,
      cookie,
      { isolationKey: "blocked-production", projectId: legacyProjectId, scriptId: 77 },
      io,
      "/api/socket/productionAgent",
    );
    clients.push(blockedProductionClient);
    const blockedScriptClient = await connectAgent(
      `${baseUrl}/api/socket/scriptAgent`,
      cookie,
      { isolationKey: "blocked-script", projectId: legacyProjectId },
      io,
      "/api/socket/scriptAgent",
    );
    clients.push(blockedScriptClient);
    blockAuthorization = true;
    blockedProductionClient.emit("chat", { content: "blocked production" });
    blockedScriptClient.emit("chat", { content: "blocked script" });
    await withTimeout(blockedAuthorizationStarted.promise, "两个 Agent 未同时进入在途鉴权");

    // 让两个新连接同时停在首次中央会话验证，覆盖 prepareUserDatabase/map 登记前的 disconnect。
    session.validatedAt = 0;
    centralSessionStore.update(session);
    gatewayInternals.fetcher = async () => {
      initialVerificationCount += 1;
      if (initialVerificationCount === 2) initialVerificationStarted.resolve();
      await initialVerificationBarrier.promise;
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "socket-initial-verify" },
      });
    };
    const verifyingProductionClient = await connectAgentTransport(
      `${baseUrl}/api/socket/productionAgent`,
      cookie,
      { isolationKey: "verify-production", projectId: legacyProjectId, scriptId: 77 },
    );
    clients.push(verifyingProductionClient);
    const verifyingScriptClient = await connectAgentTransport(
      `${baseUrl}/api/socket/scriptAgent`,
      cookie,
      { isolationKey: "verify-script", projectId: legacyProjectId },
    );
    clients.push(verifyingScriptClient);
    await withTimeout(initialVerificationStarted.promise, "两个 Agent 未同时进入首次会话验证");
    initialVerificationSockets.push(
      requireServerSocket(io, "/api/socket/productionAgent", verifyingProductionClient),
      requireServerSocket(io, "/api/socket/scriptAgent", verifyingScriptClient),
    );

    const disconnected = clients.map((client) => new Promise<void>((resolve) => {
      if (!client.connected) resolve();
      else client.once("disconnect", () => resolve());
    }));

    let closeSettled = false;
    closing = runtime.close().then(() => { closeSettled = true; });
    await withTimeout(Promise.all(disconnected), "runtime closing 未真实断开 Agent Socket");
    assert.equal(productionSignal.aborted, true);
    assert.equal(scriptSignal.aborted, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closeSettled, false, "provider 未落定时不得假装 Socket handler 已排空");
    assert.equal(runtime.snapshot().activeHandlerCount, 6);

    blockedAuthorizationBarrier.resolve();
    await waitFor(
      () => runtime.snapshot().activeHandlerCount === 4,
      "断连后的两个在途鉴权 handler 未退出",
    );
    assert.equal(unexpectedProductionRuns, 0, "production 断连后不得从鉴权继续启动 provider");
    assert.equal(unexpectedScriptRuns, 0, "script 断连后不得从鉴权继续启动 provider");

    initialVerificationBarrier.resolve();
    await waitFor(
      () => runtime.snapshot().activeHandlerCount === 2,
      "断连后的两个首次会话验证 handler 未退出",
    );
    for (const socket of initialVerificationSockets) {
      assert.notEqual(
        socket.data.tianjiangDisconnectTracked,
        true,
        "首次验证期间已断连的 Socket 不得迟到登记认证清理监听",
      );
    }
    // 若死 Socket 被迟到写入 authenticatedSockets，这里会再次调用其 disconnect。
    const disconnectCalls = initialVerificationSockets.map((socket) => instrumentDisconnect(socket));
    disconnectSocketsExceptSession("different-active-session");
    assert.deepEqual(disconnectCalls.map((readCount) => readCount()), [0, 0]);

    productionBarrier.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closeSettled, false, "仍有一个 Agent provider 在途时不得继续最终关闭");
    scriptBarrier.resolve();
    await closing;

    assert.deepEqual(runtime.snapshot(), {
      acceptingEvents: false,
      activeHandlerCount: 0,
    });
    assert.equal(io.of("/api/socket/productionAgent").sockets.size, 0);
    assert.equal(io.of("/api/socket/scriptAgent").sockets.size, 0);
    assert.equal(mutationCount, 2);
  } finally {
    gatewayInternals.fetcher = originalCentralFetcher;
    initialVerificationBarrier.resolve();
    blockedAuthorizationBarrier.resolve();
    productionBarrier.resolve();
    scriptBarrier.resolve();
    for (const client of clients) client.close();
    await Promise.allSettled([closing].filter((item): item is Promise<void> => Boolean(item)));
    await new Promise<void>((resolve) => io.close(() => resolve()));
    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    centralSessionStore.delete(session.id);
    await syncCoordinator.shutdown().catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    coordinatorInternals.projects.clear();
    Object.assign(coordinatorInternals, {
      session: undefined,
      remote: undefined,
      profileStore: undefined,
      profileSync: undefined,
      profileFailure: undefined,
      catalog: new Map(),
      localProjectIds: new Map(),
      offlineCache: undefined,
      online: false,
      deviceActive: false,
      profileKey: undefined,
      keyRetryTimer: undefined,
      keyRetryCount: 0,
      keyRetryUserUuid: undefined,
      keyRecoveryInFlight: undefined,
      acceptingKeyRecovery: true,
      shutdownState: createShutdownPhaseState(),
      shutdownRequested: false,
      loginInFlight: undefined,
      shutdownInFlight: undefined,
    });
    resetDatabaseRuntimeForServe();
    process.chdir(originalCwd);
    try {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    } catch {
      // Windows 偶发目录锁，不掩盖主断言。
    }
  }
});

async function connectAgent(
  url: string,
  cookie: string,
  auth: Record<string, unknown>,
  server: Server,
  namespace: string,
): Promise<ClientSocket> {
  const client = connectSocket(url, {
    path: ENGINE_IO_PATH,
    auth,
    extraHeaders: { cookie },
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
  });
  await withTimeout(new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
  }), `${namespace} 连接失败`);
  await waitFor(() => {
    const socket = [...server.of(namespace).sockets.values()][0];
    const connectedSocket = server.of(namespace).sockets.get(client.id ?? "") ?? socket;
    return Boolean(connectedSocket && connectedSocket.listenerCount("chat") > 0);
  }, `${namespace} 生产 chat handler 未注册`);
  return client;
}

async function connectAgentTransport(
  url: string,
  cookie: string,
  auth: Record<string, unknown>,
): Promise<ClientSocket> {
  const client = connectSocket(url, {
    path: ENGINE_IO_PATH,
    auth,
    extraHeaders: { cookie },
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
  });
  await withTimeout(new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
  }), "首次会话验证测试连接未建立");
  return client;
}

function requireServerSocket(
  server: Server,
  namespace: string,
  client: ClientSocket,
): ServerSocket {
  const socket = server.of(namespace).sockets.get(client.id ?? "");
  assert.ok(socket, `${namespace} 服务端 Socket 不存在`);
  return socket;
}

function instrumentDisconnect(socket: ServerSocket): () => number {
  let calls = 0;
  const originalDisconnect = socket.disconnect.bind(socket);
  socket.disconnect = ((close?: boolean) => {
    calls += 1;
    return originalDisconnect(close);
  }) as ServerSocket["disconnect"];
  return () => calls;
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return {
    promise,
    resolve: (value?: T) => resolve(value as T),
  };
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
