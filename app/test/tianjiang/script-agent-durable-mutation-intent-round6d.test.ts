/**
 * 第 6 轮最终 P0：持久化 mutation intent + 生产 scriptAgent Socket 立即登记
 */
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
import { centralSessionStore } from "../../src/tianjiang/auth/auth-runtime";
import { createShutdownPhaseState } from "../../src/tianjiang/runtime/sync-coordinator";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  clearPendingLegacyMutationIntent,
  hasPendingLegacyMutationIntent,
  listPendingLegacyMutationIntents,
  recordPendingLegacyMutationIntent,
} from "../../src/tianjiang/runtime/pending-legacy-mutation-intent";
import { userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";
import {
  destroyAllDatabaseHandles,
  stopGenerationTaskRecovery,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";

function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(cond: () => boolean, label: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(label);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("持久化 intent 纯文件：幂等、无密钥、账号隔离", () => {
  const worktreeRoot = path.resolve(__dirname, "../..", "..");
  const dataRoot = path.join(worktreeRoot, ".tmp", "intent-file-unit", String(Date.now()));
  fs.mkdirSync(dataRoot, { recursive: true });
  const segA = "a".repeat(32);
  const segB = "b".repeat(32);
  const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  recordPendingLegacyMutationIntent({
    dataRoot,
    userSegment: segA,
    projectUuid: uuid,
    kind: "personal",
    source: "scriptAgent",
  });
  recordPendingLegacyMutationIntent({
    dataRoot,
    userSegment: segA,
    projectUuid: uuid,
    kind: "personal",
    source: "scriptAgent",
  });
  assert.equal(hasPendingLegacyMutationIntent(dataRoot, segA, uuid), true);
  assert.equal(hasPendingLegacyMutationIntent(dataRoot, segB, uuid), false);
  const raw = fs.readFileSync(
    path.join(dataRoot, "runtime-users", segA, "pending-legacy-mutations", `${uuid}.json`),
    "utf8",
  );
  assert.doesNotMatch(raw, /token|password|secret|api[_-]?key/i);
  clearPendingLegacyMutationIntent(dataRoot, segA, uuid);
  assert.equal(hasPendingLegacyMutationIntent(dataRoot, segA, uuid), false);
});

test("coordinator：双失败 intent 持久化；reapply 恢复 dirty；团队 kind=team；未提交不 dirty", async () => {
  const originalCwd = process.cwd();
  const worktreeRoot = path.resolve(__dirname, "../..", "..");
  const runId = `dur-coord-${process.pid}-${Date.now()}`;
  const fixtureRoot = path.join(worktreeRoot, ".tmp", "script-agent-durable-mutation", runId);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = fixtureRoot;
  process.chdir(fixtureRoot);
  resetDatabaseRuntimeForServe();

  const effectiveDataRoot = path.join(fixtureRoot, "data");
  fs.mkdirSync(effectiveDataRoot, { recursive: true });

  const projectUuid = "66666666-6666-4666-a666-666666666666";
  const teamUuid = "88888888-8888-4888-a888-888888888888";
  const session = centralSessionStore.create({
    serverUrl: "https://api.j11.com.cn",
    token: "durable-coord-token",
    expiresAt: Date.now() + 60_000,
    user: { id: 9601, username: "durable-coord-user", nickname: "" },
  });
  const coordinatorInternals = syncCoordinator as unknown as Record<string, any>;
  coordinatorInternals.dataRoot = effectiveDataRoot;

  let markFailRemaining = 0;
  let dirty = false;
  const local: any = {
    hasLegacyResource: () => true,
    markLegacyEdited: () => {
      if (markFailRemaining > 0) {
        markFailRemaining -= 1;
        throw new Error("markLegacyEdited forced failure");
      }
      dirty = true;
    },
    close: () => undefined,
  };
  Object.defineProperty(local, "dirty", {
    get: () => dirty,
    set: (v: boolean) => {
      dirty = v;
    },
    configurable: true,
  });
  const projectRuntime = {
    kind: "personal" as const,
    local,
    sync: {
      markEdited: () => {
        dirty = true;
      },
      close: async () => ({ state: "synced" as const }),
    },
  };
  const catalogItem = {
    projectUuid,
    name: "Durable 个人",
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
  const teamCatalog = {
    ...catalogItem,
    projectUuid: teamUuid,
    name: "Durable 团队",
    kind: "team",
    role: "editor",
    myRole: "editor",
  };
  const deviceUuid = String(coordinatorInternals.deviceUuid);
  const grant = {
    grantId: "77777777-7777-4777-a777-777777777777",
    userId: session.user.id,
    deviceUuid,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revokedAt: null,
  };
  Object.assign(coordinatorInternals, {
    session,
    remote: { refreshOfflineGrant: async () => grant },
    catalog: new Map([
      [projectUuid, catalogItem],
      [teamUuid, teamCatalog],
    ]),
    localProjectIds: new Map([
      [projectUuid, 6601],
      [teamUuid, 8801],
    ]),
    offlineCache: {
      issuer: session.serverUrl,
      userId: session.user.id,
      grant,
      catalog: [catalogItem, teamCatalog],
    },
    online: true,
    deviceActive: true,
    shutdownState: createShutdownPhaseState(),
    shutdownRequested: false,
  });
  coordinatorInternals.projects.clear();
  coordinatorInternals.projects.set(projectUuid, projectRuntime);

  const userSegment = userStorageSegment({
    issuer: session.serverUrl,
    userId: session.user.id,
  });

  try {
    markFailRemaining = 2;
    dirty = false;
    clearPendingLegacyMutationIntent(effectiveDataRoot, userSegment, projectUuid);
    assert.throws(() => syncCoordinator.recordAndMarkLegacyMutation(projectUuid, "scriptAgent"));
    assert.equal(dirty, false);
    assert.ok(hasPendingLegacyMutationIntent(effectiveDataRoot, userSegment, projectUuid));
    assert.throws(() => syncCoordinator.markLegacyMutation(projectUuid));
    assert.equal(dirty, false);
    assert.ok(hasPendingLegacyMutationIntent(effectiveDataRoot, userSegment, projectUuid));

    coordinatorInternals.projects.delete(projectUuid);
    dirty = false;
    coordinatorInternals.projects.set(projectUuid, projectRuntime);
    markFailRemaining = 0;
    assert.equal(syncCoordinator.reapplyPendingLegacyMutation(projectUuid), true);
    assert.equal(dirty, true);

    // 未提交不得制造 intent
    clearPendingLegacyMutationIntent(effectiveDataRoot, userSegment, projectUuid);
    dirty = false;
    assert.equal(hasPendingLegacyMutationIntent(effectiveDataRoot, userSegment, projectUuid), false);

    const teamLocal: any = {
      _dirty: false,
      markLegacyEdited: () => {
        teamLocal._dirty = true;
      },
      hasLegacyResource: () => true,
      close: () => undefined,
    };
    Object.defineProperty(teamLocal, "dirty", {
      get: () => teamLocal._dirty,
      set: (v: boolean) => {
        teamLocal._dirty = v;
      },
    });
    coordinatorInternals.projects.set(teamUuid, {
      kind: "team",
      local: teamLocal,
      sync: { state: () => ({ editable: true }), close: async () => ({ state: "synced" }) },
    });
    syncCoordinator.recordPendingLegacyMutationOnly(teamUuid, "scriptAgent");
    const teamIntent = listPendingLegacyMutationIntents(effectiveDataRoot, userSegment).find(
      (i) => i.projectUuid === teamUuid,
    );
    assert.ok(teamIntent);
    assert.equal(teamIntent!.kind, "team");
  } finally {
    centralSessionStore.delete(session.id);
    await syncCoordinator.shutdown().catch(() => undefined);
    await stopGenerationTaskRecovery();
    await destroyAllDatabaseHandles().catch(() => undefined);
    coordinatorInternals.projects.clear();
    process.chdir(originalCwd);
  }
});

test("生产 scriptAgent Socket route：onPlanCommitted 时 decision 未结束已 dirty/intent", async () => {
  const originalCwd = process.cwd();
  const worktreeRoot = path.resolve(__dirname, "../..", "..");
  const runId = `run-${process.pid}-${Date.now()}`;
  const dataRoot = path.join(worktreeRoot, ".tmp", "script-agent-durable-socket", runId);
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
    token: "socket-durable-token",
    expiresAt: Date.now() + 60_000,
    user: { id: 9401, username: "socket-durable-user", nickname: "" },
  });
  session.validatedAt = Date.now();
  centralSessionStore.update(session);

  const coordinatorInternals = syncCoordinator as unknown as Record<string, any>;
  const deviceUuid = String(coordinatorInternals.deviceUuid);
  // 强制 dataRoot 到 getPath() 一致位置
  const effectiveDataRoot = path.join(dataRoot, "data");
  fs.mkdirSync(effectiveDataRoot, { recursive: true });
  coordinatorInternals.dataRoot = effectiveDataRoot;

  let dirty = false;
  let markCalls = 0;
  const local: any = {
    hasLegacyResource: () => true,
    markLegacyEdited: () => {
      markCalls += 1;
      dirty = true;
    },
    close: () => undefined,
  };
  Object.defineProperty(local, "dirty", {
    get: () => dirty,
    set: (v: boolean) => {
      dirty = v;
    },
  });
  const projectRuntime = {
    kind: "personal" as const,
    local,
    sync: {
      markEdited: () => {
        dirty = true;
      },
      close: async () => ({ state: "synced" as const }),
    },
  };
  const catalogItem = {
    projectUuid,
    name: "Socket Durable",
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
    remote: { refreshOfflineGrant: async () => grant },
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

  const userSegment = userStorageSegment({
    issuer: session.serverUrl,
    userId: session.user.id,
  });
  clearPendingLegacyMutationIntent(effectiveDataRoot, userSegment, projectUuid);

  const hold = deferred<void>();
  let registeredWhilePending = false;

  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: "*" }, path: ENGINE_IO_PATH });
  const runtime = socketInit(io, undefined, {
    productionAgent: {
      runDecisionAI: async (_c: ProductionAgentContext) => undefined,
    },
    scriptAgent: {
      runDecisionAI: async (ctx: ScriptAgentContext) => {
        assert.ok(ctx.abortSignal);
        ctx.planCommitted = true;
        ctx.onPlanCommitted?.();
        registeredWhilePending =
          dirty || hasPendingLegacyMutationIntent(effectiveDataRoot, userSegment, projectUuid);
        await hold.promise;
        return { planCommitted: true };
      },
    },
  });
  const clients: ClientSocket[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const cookie = `tj_session=${encodeURIComponent(session.id)}`;

    const client = connectSocket(`${baseUrl}/api/socket/scriptAgent`, {
      path: ENGINE_IO_PATH,
      auth: { isolationKey: "script-isolation", projectId: legacyProjectId },
      extraHeaders: { cookie },
      forceNew: true,
      reconnection: false,
      transports: ["websocket"],
    });
    clients.push(client);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        client.once("connect", resolve);
        client.once("connect_error", reject);
      }),
      "scriptAgent 连接失败",
    );
    await waitFor(() => {
      const socket =
        io.of("/api/socket/scriptAgent").sockets.get(client.id ?? "") ??
        [...io.of("/api/socket/scriptAgent").sockets.values()][0];
      return Boolean(socket && socket.listenerCount("chat") > 0);
    }, "scriptAgent 生产 chat handler 未注册");

    client.emit("chat", { content: "hold script" });
    await waitFor(() => registeredWhilePending, "onPlanCommitted 未在 pending 前完成登记");
    assert.ok(dirty || hasPendingLegacyMutationIntent(effectiveDataRoot, userSegment, projectUuid));
    assert.ok(markCalls >= 1 || hasPendingLegacyMutationIntent(effectiveDataRoot, userSegment, projectUuid));

    hold.resolve();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(dirty, true);
  } finally {
    hold.resolve();
    for (const c of clients) c.close();
    await runtime.close().catch(() => undefined);
    await new Promise<void>((resolve) => io.close(() => resolve()));
    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    centralSessionStore.delete(session.id);
    await syncCoordinator.shutdown().catch(() => undefined);
    await stopGenerationTaskRecovery();
    await destroyAllDatabaseHandles().catch(() => undefined);
    coordinatorInternals.projects.clear();
    Object.assign(coordinatorInternals, {
      session: undefined,
      remote: undefined,
      catalog: new Map(),
      localProjectIds: new Map(),
      offlineCache: undefined,
      online: false,
      deviceActive: false,
      shutdownState: createShutdownPhaseState(),
      shutdownRequested: false,
    });
    resetDatabaseRuntimeForServe();
    process.chdir(originalCwd);
    try {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
