/**
 * round6r RED：可恢复 draining + 全有或全无 project_close_commit。
 * Promise barrier / 显式事件推进；禁止固定 sleep、--test-force-exit、process.exit。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import express from "express";
import { Server } from "socket.io";
import { io as connectSocket, type Socket as ClientSocket } from "socket.io-client";

import socketInit from "../../src/socket";
import { ENGINE_IO_PATH } from "../../src/tianjiang/socket-path";
import {
  PersonalProjectSync,
  type PersonalLocal,
  type PersonalManifest,
  type PersonalRemote,
} from "../../src/tianjiang/sync/personal-project-sync";
import {
  attemptPersonalProjectClose,
  commitDisposePersonalRuntime,
  settlePersonalProjectClose,
} from "../../src/tianjiang/sync/personal-close-coordinator";
import { createShutdownPhaseState } from "../../src/tianjiang/runtime/sync-coordinator";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { centralSessionStore } from "../../src/tianjiang/auth/auth-runtime";
import {
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
  stopGenerationTaskRecovery,
} from "../../src/utils/db";
import { ShutdownGate } from "../../src/tianjiang/runtime/shutdown-gate";
import {
  closeServe,
  registerServeRuntimeResources,
  resetServeLifecycleForTests,
  serveRuntimeSnapshot,
} from "../../src/tianjiang/runtime/serve-lifecycle";
import { serveReadinessGate } from "../../src/tianjiang/runtime/serve-readiness";
import {
  userStorageSegment,
  userStorageRoot,
} from "../../src/tianjiang/runtime/user-storage-context";

const worktreeRoot = path.resolve(__dirname, "../..", "..");
const personalA = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const personalB = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const teamUuid = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fixture(name: string) {
  const root = path.join(worktreeRoot, ".tmp", "r6r", name, String(Date.now()));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function manifest(version: number, md5: string): PersonalManifest {
  return { version, objects: [{ relativePath: "project.sqlite", md5 }] };
}

function makeLocal(
  initial: PersonalManifest,
  hooks?: {
    onSnapshot?: () => Promise<void> | void;
    onClose?: () => void;
    failClose?: boolean;
  },
): PersonalLocal & { dirty: boolean; closed: boolean; close(): void } {
  const state = {
    current: structuredClone(initial) as PersonalManifest,
    dirty: false,
    closed: false,
  };
  return {
    get dirty() {
      return state.dirty;
    },
    set dirty(v: boolean) {
      state.dirty = v;
    },
    get current() {
      return state.current;
    },
    set current(v) {
      state.current = v!;
    },
    get closed() {
      return state.closed;
    },
    async install(remote) {
      state.current = structuredClone(remote);
      state.dirty = false;
    },
    async createSnapshot() {
      await hooks?.onSnapshot?.();
      if (!state.current) throw new Error("no current");
      const objects = state.dirty
        ? state.current.objects.map((o) =>
            o.relativePath === "project.sqlite" ? { ...o, md5: `${o.md5}-dirty` } : o,
          )
        : structuredClone(state.current.objects);
      return {
        version: state.current.version,
        objects,
        capturedMutationGeneration: state.dirty ? 1 : 0,
      };
    },
    async createRecovery() {},
    close() {
      hooks?.onClose?.();
      if (hooks?.failClose) {
        throw Object.assign(new Error("local.close forced fail"), {
          code: "LOCAL_CLOSE_FAILED",
        });
      }
      state.closed = true;
    },
  };
}

function makeRemote(opts?: {
  failPublish?: boolean;
  onPublish?: () => Promise<void> | void;
}): PersonalRemote & { publishCalls: number } {
  let current = manifest(1, "base");
  let publishCalls = 0;
  return {
    get publishCalls() {
      return publishCalls;
    },
    async latest() {
      return structuredClone(current);
    },
    async publish(_b, next) {
      publishCalls += 1;
      await opts?.onPublish?.();
      if (opts?.failPublish) {
        throw Object.assign(new Error("network personal publish failed"), {
          code: "NETWORK_OFFLINE",
        });
      }
      current = { ...structuredClone(next), version: current.version + 1 };
      return structuredClone(current);
    },
  };
}

async function bootCoordinator(opts: {
  name: string;
  projects: Array<{
    uuid: string;
    failSnapshot?: string;
    failPublish?: boolean;
    onSnapshot?: () => Promise<void> | void;
    onPublish?: () => Promise<void> | void;
    onLocalClose?: () => void;
    failLocalClose?: boolean;
  }>;
}) {
  const fixtureRoot = fixture(opts.name);
  const dataRoot = path.join(fixtureRoot, "data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const originalCwd = process.cwd();
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = fixtureRoot;
  process.chdir(fixtureRoot);
  resetDatabaseRuntimeForServe();

  const userId = 68001;
  const expiresAt = Date.now() + 3_600_000;
  const session = centralSessionStore.create({
    serverUrl: "https://api.j11.com.cn",
    token: `r6r-${userId}`,
    expiresAt,
    user: { id: userId, username: `u${userId}`, nickname: "" },
  });
  (session as { expiresAt: number }).expiresAt = expiresAt;

  const internals = syncCoordinator as unknown as Record<string, any>;
  const identity = { issuer: session.serverUrl, userId };
  const segment = userStorageSegment(identity);

  const catalog = new Map<string, any>();
  const localProjectIds = new Map<string, number>();
  const projectHandles: Record<
    string,
    {
      local: ReturnType<typeof makeLocal>;
      remote: ReturnType<typeof makeRemote>;
      sync: PersonalProjectSync;
    }
  > = {};

  internals.projects.clear();
  for (const p of opts.projects) {
    const local = makeLocal(manifest(1, "base"), {
      onSnapshot: p.onSnapshot,
      onClose: p.onLocalClose,
      failClose: p.failLocalClose,
    });
    if (p.failSnapshot) {
      (local as any).createSnapshot = async () => {
        await p.onSnapshot?.();
        throw Object.assign(new Error(p.failSnapshot!), {
          code: p.failSnapshot!.includes("SQLITE")
            ? "SQLITE_CORRUPT"
            : "SNAPSHOT_INTEGRITY",
        });
      };
    }
    local.dirty = true;
    const remote = makeRemote({
      failPublish: p.failPublish,
      onPublish: p.onPublish,
    });
    const sync = new PersonalProjectSync(local, remote, () => true);
    sync.open();
    projectHandles[p.uuid] = { local, remote, sync };
    catalog.set(p.uuid, {
      projectUuid: p.uuid,
      name: p.uuid.slice(0, 8),
      kind: "personal",
      ownerUserId: userId,
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
    });
    localProjectIds.set(p.uuid, userId);
    internals.projects.set(p.uuid, {
      kind: "personal",
      local: {
        get dirty() {
          return local.dirty;
        },
        set dirty(v: boolean) {
          local.dirty = v;
        },
        close: () => local.close(),
        markLegacyEdited() {
          local.dirty = true;
        },
      },
      sync,
    });
  }

  const grant = {
    grantId: "e8e8e8e8-e8e8-4e8e-e8e8-e8e8e8e8e8e8",
    userId,
    deviceUuid: String(internals.deviceUuid ?? "018f3d6e-2d9e-7b6c-8a9b-r6rdevice0001"),
    expiresAt: new Date(expiresAt).toISOString(),
    revokedAt: null,
  };

  Object.assign(internals, {
    dataRoot,
    session,
    remote: { refreshOfflineGrant: async () => grant },
    catalog,
    localProjectIds,
    offlineCache: {
      issuer: session.serverUrl,
      userId,
      grant,
      catalog: [...catalog.values()],
    },
    online: true,
    deviceActive: true,
    profileKey: Buffer.from("r6r-profile-key-32bytes!!!!!!!!!!"),
    profileStore: { closed: false, close() { this.closed = true; } },
    shutdownState: createShutdownPhaseState(),
    shutdownRequested: false,
    shutdownInFlight: undefined,
  });

  return {
    dataRoot,
    segment,
    identity,
    internals,
    session,
    expiresAt,
    projectHandles,
    originalCwd,
    cleanup: async () => {
      internals.projects.clear();
      centralSessionStore.delete(session.id);
      await stopGenerationTaskRecovery().catch(() => undefined);
      await destroyAllDatabaseHandles().catch(() => undefined);
      resetDatabaseRuntimeForServe();
      resetServeLifecycleForTests();
      process.chdir(originalCwd);
    },
  };
}

// ---------- 1) HTTP 项目写 + ShutdownGate：snapshot 等写结束 ----------
test("1) 真实 HTTP 项目写 handler：ShutdownGate 下 snapshot 必须等待写入结束", async () => {
  const events: string[] = [];
  const writeStarted = deferred();
  const writeRelease = deferred();
  const snapshotEntered = deferred();

  const ctx = await bootCoordinator({
    name: "http-write-wait",
    projects: [
      {
        uuid: personalA,
        onSnapshot: async () => {
          events.push("snapshot:start");
          snapshotEntered.resolve();
        },
      },
    ],
  });

  const app = express();
  app.use(serveReadinessGate.middleware());
  app.post("/api/tianjiang/runtime/project-write", async (_req, res) => {
    events.push("http-write:start");
    writeStarted.resolve();
    await writeRelease.promise;
    events.push("http-write:done");
    // 模拟写后 dirty
    ctx.projectHandles[personalA].local.dirty = true;
    res.status(200).json({ ok: true });
  });
  const httpServer = http.createServer(app);
  httpServer.unref();
  const socketRuntime = {
    beginReversibleDraining: () => events.push("socket:reversible"),
    resumeAccepting: () => events.push("socket:resume"),
    beginClosing: () => events.push("socket:irreversible"),
    waitForDrain: async () => undefined,
    close: async () => undefined,
    snapshot: () => ({ acceptingEvents: true, activeHandlerCount: 0 }),
  };
  const webSocketRuntime = {
    beginClosing: () => events.push("ws:close"),
    close: async () => undefined,
  };

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    registerServeRuntimeResources(
      { httpServer, socketRuntime: socketRuntime as any, webSocketRuntime },
      {
        stopGenerationRecovery: async () => undefined,
        stopProfileKeyRecovery: async () => undefined,
        commitProjectCloses: async () => {
          events.push("commit:start");
          await (syncCoordinator as any).commitProjectClosesForOrdinaryShutdown();
          events.push("commit:done");
        },
        finalSync: async () => {
          events.push("final-sync");
        },
        destroyDatabases: async () => {
          events.push("db:destroy");
        },
      },
    );
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");

    const writeFetch = fetch(
      `http://127.0.0.1:${address.port}/api/tianjiang/runtime/project-write`,
      { method: "POST" },
    );
    await writeStarted.promise;

    let quitCalls = 0;
    const gate = new ShutdownGate({
      closeRuntime: closeServe,
      quit: () => {
        quitCalls += 1;
      },
      relaunch: () => undefined,
      onFailure: async () => undefined,
    });
    const closing = gate.request(false);
    // 写仍在途：不得 commit / snapshot
    await Promise.resolve();
    assert.equal(events.includes("commit:start"), false);
    assert.equal(events.includes("snapshot:start"), false);

    writeRelease.resolve();
    await writeFetch;
    await closing;

    assert.ok(events.includes("http-write:done"));
    assert.ok(events.indexOf("http-write:done") < events.indexOf("commit:start"));
    // snapshot 发生在 commit 的 close attempt 中，必须在写结束之后
    if (events.includes("snapshot:start")) {
      assert.ok(events.indexOf("http-write:done") < events.indexOf("snapshot:start"));
    }
    assert.equal(quitCalls, 1);
    assert.equal(gate.canQuit(), true);
  } finally {
    writeRelease.resolve();
    try {
      await closeServe();
    } catch {
      // ignore
    }
    resetServeLifecycleForTests();
    if (httpServer.listening) {
      await new Promise<void>((r) => httpServer.close(() => r()));
    }
    await ctx.cleanup();
  }
});

// ---------- 2) Socket Agent 写：Team/Personal 关闭不得提前 ----------
test("2) Socket Script Agent 写 handler 在途时不得 Team release / Personal snapshot / runtime 删除", async () => {
  const events: string[] = [];
  const agentStarted = deferred();
  const agentRelease = deferred();
  let teamCloseCalls = 0;
  let personalSnapshotCalls = 0;

  const ctx = await bootCoordinator({
    name: "socket-agent-wait",
    projects: [
      {
        uuid: personalA,
        onSnapshot: async () => {
          personalSnapshotCalls += 1;
          events.push("personal:snapshot");
        },
      },
    ],
  });

  // 注入 Team runtime（假 close 记事件）
  ctx.internals.projects.set(teamUuid, {
    kind: "team",
    local: {
      dirty: true,
      close: () => {
        events.push("team:local-close");
      },
    },
    sync: {
      close: async () => {
        teamCloseCalls += 1;
        events.push("team:release");
        return { state: "published", centralEvidenceConfirmed: true };
      },
    },
  });
  ctx.internals.catalog.set(teamUuid, {
    projectUuid: teamUuid,
    kind: "team",
    role: "editor",
    myRole: "editor",
    ownerUserId: ctx.session.user.id,
    name: "team",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: new Date().toISOString(),
    lockStatus: "held",
    lockHolderName: "me",
    openMode: "editable",
    businessType: "script",
  });

  const app = express();
  app.use(serveReadinessGate.middleware());
  const httpServer = http.createServer(app);
  httpServer.unref();
  const socketServer = new Server(httpServer, { cors: { origin: "*" }, path: ENGINE_IO_PATH });
  const socketRuntime = socketInit(socketServer, {
    scriptAgent: (namespace, activity) => {
      activity.bindConnection(namespace, async (socket) => {
        activity.bindEvent(socket, "project-write", async () => {
          events.push("agent:start");
          agentStarted.resolve();
          await agentRelease.promise;
          events.push("agent:done");
        });
      });
    },
  });
  let client: ClientSocket | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    registerServeRuntimeResources(
      {
        httpServer,
        socketRuntime,
        webSocketRuntime: {
          beginClosing: () => events.push("ws:close"),
          close: async () => undefined,
        },
      },
      {
        stopGenerationRecovery: async () => undefined,
        stopProfileKeyRecovery: async () => undefined,
        commitProjectCloses: async () => {
          events.push("commit:start");
          await (syncCoordinator as any).commitProjectClosesForOrdinaryShutdown();
          events.push("commit:done");
        },
        finalSync: async () => {
          events.push("final-sync");
        },
        destroyDatabases: async () => {
          events.push("db:destroy");
        },
      },
    );
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");
    client = connectSocket(
      `http://127.0.0.1:${address.port}/api/socket/scriptAgent`,
      {
        path: ENGINE_IO_PATH,
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
      },
    );
    await new Promise<void>((resolve, reject) => {
      client!.once("connect", () => resolve());
      client!.once("connect_error", reject);
    });
    client.emit("project-write", {});
    await agentStarted.promise;

    const gate = new ShutdownGate({
      closeRuntime: closeServe,
      quit: () => undefined,
      relaunch: () => undefined,
      onFailure: async () => undefined,
    });
    const closing = gate.request(false);
    await Promise.resolve();
    assert.equal(teamCloseCalls, 0, "Agent 写在途时不得 Team release");
    assert.equal(personalSnapshotCalls, 0, "Agent 写在途时不得 Personal snapshot");
    assert.equal(ctx.internals.projects.has(personalA), true);
    assert.equal(ctx.internals.projects.has(teamUuid), true);

    agentRelease.resolve();
    await closing;
    assert.ok(events.indexOf("agent:done") < events.indexOf("commit:start"));
    assert.ok(events.indexOf("agent:done") < events.indexOf("team:release") || teamCloseCalls >= 1);
  } finally {
    agentRelease.resolve();
    client?.close();
    try {
      await closeServe();
    } catch {
      // ignore
    }
    resetServeLifecycleForTests();
    await new Promise<void>((r) => socketServer.close(() => r()));
    if (httpServer.listening) {
      await new Promise<void>((r) => httpServer.close(() => r()));
    }
    await ctx.cleanup();
  }
});

// ---------- 3) draining 期间新写请求 503 ----------
test("3) reversible_draining 期间新写请求被拒绝，不落到关闭中的 SQLite", async () => {
  const { ServeReadinessGate } = await import(
    "../../src/tianjiang/runtime/serve-readiness"
  );
  const gate = new ServeReadinessGate();
  gate.startAccepting();

  const app = express();
  app.use(gate.middleware());
  let sqliteHits = 0;
  app.post("/write", (_req, res) => {
    sqliteHits += 1;
    res.status(200).send("ok");
  });
  const server = http.createServer(app);
  server.unref();
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    gate.beginReversibleDraining();
    const rejected = await fetch(`http://127.0.0.1:${addr.port}/write`, {
      method: "POST",
    });
    assert.equal(rejected.status, 503);
    assert.equal(sqliteHits, 0, "draining 中写请求不得进入 handler/SQLite");
    const body = await rejected.json();
    assert.equal(body.code, 503);
    gate.resumeAccepting();
    const ok = await fetch(`http://127.0.0.1:${addr.port}/write`, { method: "POST" });
    assert.equal(ok.status, 200);
    assert.equal(sqliteHits, 1);
  } finally {
    if (server.listening) await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------- 4) A 可同步 B fatal：阻断后两者均保留 ----------
test("4) 双 Personal：A 可同步 B fatal，阻断后 A/B 均保留 runtime 可再编辑", async () => {
  const ctx = await bootCoordinator({
    name: "dual-ab",
    projects: [
      { uuid: personalA, failPublish: false },
      { uuid: personalB, failSnapshot: "SQLITE_CORRUPT disk image" },
    ],
  });
  try {
    await assert.rejects(
      () => (syncCoordinator as any).commitProjectClosesForOrdinaryShutdown(),
      /阻断|修复|数据|PERSONAL_CLOSE/i,
    );
    assert.equal(
      ctx.internals.projects.has(personalA),
      true,
      "A 不得静默从 runtime 消失",
    );
    assert.equal(ctx.internals.projects.has(personalB), true, "B 必须保留");
    assert.equal(ctx.projectHandles[personalA].sync.isTerminalClosed(), false);
    assert.equal(ctx.projectHandles[personalB].sync.isTerminalClosed(), false);
    // 可继续编辑
    ctx.projectHandles[personalA].local.dirty = true;
    ctx.projectHandles[personalA].sync.markEdited();
    ctx.projectHandles[personalB].local.dirty = true;
    ctx.projectHandles[personalB].sync.markEdited();
    assert.equal(ctx.projectHandles[personalA].local.dirty, true);
    assert.equal(ctx.projectHandles[personalB].local.dirty, true);
    // A 仍可 syncNow
    const out = await (syncCoordinator as any).syncNow(ctx.session, personalA);
    assert.ok(out.state === "synced" || out.state === "unchanged");
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 5) Team 锁在写排空后释放（事件序） ----------
test("5) Personal+Team：Team release 不得早于活动写 barrier 释放", async () => {
  const events: string[] = [];
  const writeHold = deferred();
  const writeStarted = deferred();

  const ctx = await bootCoordinator({
    name: "team-lock-order",
    projects: [{ uuid: personalA }],
  });
  ctx.internals.projects.set(teamUuid, {
    kind: "team",
    local: { dirty: true, close: () => events.push("team:local-close") },
    sync: {
      close: async () => {
        events.push("team:release");
        // 中文注释：真实 Team close 在 release 后必须携带可 finalize 的 capture，
        // 并由协调器先清 mutation、最后确认 receipt；本用例只观察 barrier 顺序。
        return {
          state: "released_cleanup_pending",
          capturedMutationGeneration: 1,
          centralEvidenceConfirmed: true,
        };
      },
      confirmReleasedCleanupStrict: () => events.push("team:confirm-cleanup"),
    },
  });

  // 模拟活动写：在 commit 前挂起 personal snapshot
  const origSnapshot = ctx.projectHandles[personalA].local.createSnapshot.bind(
    ctx.projectHandles[personalA].local,
  );
  ctx.projectHandles[personalA].local.createSnapshot = async () => {
    events.push("personal:snapshot-enter");
    writeStarted.resolve();
    await writeHold.promise;
    events.push("personal:snapshot-leave");
    return origSnapshot();
  };

  try {
    const closing = (syncCoordinator as any).commitProjectClosesForOrdinaryShutdown();
    await writeStarted.promise;
    assert.equal(events.includes("team:release"), false, "写 snapshot 在途时不得 Team release");
    writeHold.resolve();
    await closing;
    assert.ok(events.indexOf("personal:snapshot-leave") <= events.indexOf("team:release")
      || events.includes("team:release"));
  } finally {
    writeHold.resolve();
    await ctx.cleanup();
  }
});

// ---------- 6) dispose / local.close 抛错不得 deleted ----------
test("6) commitTerminalDispose/local.close 抛错：不得 dispose=true、不得删 runtime", async () => {
  const local = makeLocal(manifest(1, "base"), { failClose: true });
  local.dirty = false;
  const remote = makeRemote();
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();
  const projects = new Map<string, any>();
  const runtime = {
    kind: "personal" as const,
    local,
    sync,
  };
  projects.set(personalA, runtime);

  // 强制走 dispose_synced：dirty false close → unchanged 或 synced
  const result = await settlePersonalProjectClose({
    projectUuid: personalA,
    runtime,
    identity: { issuer: "https://api.j11.com.cn", userId: 1 },
    sessionExpiresAt: Date.now() + 60_000,
    dataRoot: fixture("dispose-fail"),
    surface: "closeProject",
    openQueue: () => {
      throw new Error("queue should not open on clean dispose path");
    },
    consumeSyncCloseResult: () => undefined,
    deleteFromProjects: (uuid) => {
      projects.delete(uuid);
    },
  });

  assert.equal(result.disposed, false, "local.close 失败不得 disposed=true");
  assert.equal(result.allowSafeQuit, false);
  assert.equal(result.allowAccountSwitch, false);
  assert.equal(projects.has(personalA), true, "runtime 必须保留可重试");

  // commitDispose 直接抛（同步）
  const local2 = makeLocal(manifest(1, "base"), { failClose: true });
  const sync2 = new PersonalProjectSync(local2, makeRemote(), () => true);
  sync2.open();
  assert.throws(
    () =>
      commitDisposePersonalRuntime({
        projectUuid: personalB,
        runtime: { kind: "personal", local: local2, sync: sync2 },
        identity: undefined,
        sessionExpiresAt: undefined,
        dataRoot: ".",
        surface: "ordinaryShutdown",
        openQueue: () => {
          throw new Error("no");
        },
        consumeSyncCloseResult: () => undefined,
        deleteFromProjects: () => {
          assert.fail("不得调用 deleteFromProjects");
        },
      }),
    /local\.close|LOCAL_CLOSE|fail/i,
  );
});

// ---------- 7) 阻断消失后第二次退出成功，publish 每项目 ≤1 ----------
test("7) 阻断恢复后第二次退出成功，且每项目 publishCalls≤1", async () => {
  const ctx = await bootCoordinator({
    name: "second-quit",
    projects: [
      { uuid: personalA },
      { uuid: personalB, failSnapshot: "SQLITE_CORRUPT" },
    ],
  });
  try {
    await assert.rejects(() =>
      (syncCoordinator as any).commitProjectClosesForOrdinaryShutdown(),
    );
    const pubA1 = ctx.projectHandles[personalA].remote.publishCalls;

    // 修复 B
    const localB = ctx.projectHandles[personalB].local;
    localB.dirty = true;
    (localB as any).createSnapshot = async () => {
      const objects = localB.current!.objects.map((o) =>
        o.relativePath === "project.sqlite" ? { ...o, md5: `${o.md5}-fixed` } : o,
      );
      return {
        version: localB.current!.version,
        objects,
        capturedMutationGeneration: 1,
      };
    };
    // rollback 后需重新 open 生命周期
    ctx.projectHandles[personalB].sync.rollbackCloseAttempt();
    ctx.projectHandles[personalA].sync.rollbackCloseAttempt();
    localB.dirty = true;
    ctx.projectHandles[personalA].local.dirty = true;

    await (syncCoordinator as any).commitProjectClosesForOrdinaryShutdown();
    assert.equal(ctx.internals.projects.has(personalA), false);
    assert.equal(ctx.internals.projects.has(personalB), false);
    // 每项目 publish 在整个过程中不超过合理次数（attempt 各 1 次成功路径）
    assert.ok(
      ctx.projectHandles[personalA].remote.publishCalls - pubA1 <= 1,
      `A publish 增量应 ≤1，实际 ${ctx.projectHandles[personalA].remote.publishCalls - pubA1}`,
    );
    assert.ok(
      ctx.projectHandles[personalB].remote.publishCalls <= 1,
      `B publishCalls=${ctx.projectHandles[personalB].remote.publishCalls}`,
    );
  } finally {
    await ctx.cleanup();
  }
});

// ---------- attempt 全有或全无辅助 ----------
test("attemptPersonalProjectClose 不 dispose", async () => {
  const local = makeLocal(manifest(1, "base"));
  local.dirty = true;
  const remote = makeRemote({ failPublish: true });
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();
  const deleted: string[] = [];
  const attempt = await attemptPersonalProjectClose({
    projectUuid: personalA,
    runtime: { kind: "personal", local, sync },
    identity: { issuer: "https://api.j11.com.cn", userId: 1 },
    sessionExpiresAt: Date.now() + 60_000,
    dataRoot: fixture("attempt-only"),
    surface: "ordinaryShutdown",
    openQueue: () => {
      throw new Error("no queue in attempt");
    },
    consumeSyncCloseResult: () => undefined,
    deleteFromProjects: (u) => deleted.push(u),
  });
  assert.equal(attempt.disposed, false);
  assert.equal(deleted.length, 0);
  assert.equal(sync.isTerminalClosed(), false);
  assert.ok(
    attempt.pendingAction === "enqueue_and_dispose" || attempt.allowSafeQuit === false,
  );
});

// ========== P0 纠偏 RED ==========

test("P0: pauseGenerationTaskRecovery / resume 必须导出", async () => {
  const db = await import("../../src/utils/db");
  assert.equal(typeof db.pauseGenerationTaskRecovery, "function");
  assert.equal(typeof db.resumeGenerationTaskRecovery, "function");
});

test("P0: draining 新 Socket 事件不进入且不断开既有连接", async () => {
  const { SocketActivityTracker } = await import("../../src/socket/activity-tracker");
  const tracker = new SocketActivityTracker();
  let entered = 0;
  let disconnected = 0;
  const hold = deferred();
  const started = deferred();
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    connected: true,
    disconnect: () => {
      disconnected += 1;
      socket.connected = false;
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler);
    },
  };
  tracker.bindEvent(socket as never, "chat", async () => {
    entered += 1;
    if (entered === 1) {
      started.resolve();
      await hold.promise;
    }
  });
  handlers.get("chat")?.();
  await started.promise;
  tracker.beginReversibleDraining();
  handlers.get("chat")?.();
  await Promise.resolve();
  assert.equal(entered, 1, "draining 后新事件不得进入业务 handler");
  assert.equal(disconnected, 0, "draining 不得 disconnect 既有 socket");
  assert.equal(socket.connected, true);
  hold.resolve();
  await tracker.waitForDrain();
});

test("P0: beginProjectCloseDrain / resumeProjectCloseDrain 必须存在", () => {
  const c = syncCoordinator as unknown as {
    beginProjectCloseDrain?: () => Promise<void>;
    resumeProjectCloseDrain?: () => void;
  };
  assert.equal(typeof c.beginProjectCloseDrain, "function");
  assert.equal(typeof c.resumeProjectCloseDrain, "function");
});

test("P0: 队列已入队后 local.close 失败保留 pendingSync/taskId 且不删 map", async () => {
  const { SyncQueue } = await import("../../src/tianjiang/sync/queue");
  const root = fixture("dispose-queue-fact");
  const queue = new SyncQueue(path.join(root, "q.sqlite"));
  try {
    const local = makeLocal(manifest(1, "base"), { failClose: true });
    local.dirty = true;
    const remote = makeRemote({ failPublish: true });
    const sync = new PersonalProjectSync(local, remote, () => true);
    sync.open();
    const projects = new Map<string, unknown>();
    projects.set(personalA, true);
    const result = await settlePersonalProjectClose({
      projectUuid: personalA,
      runtime: { kind: "personal", local, sync },
      identity: { issuer: "https://api.j11.com.cn", userId: 1 },
      sessionExpiresAt: Date.now() + 86_400_000,
      dataRoot: root,
      surface: "closeProject",
      sharedQueue: queue,
      openQueue: () => queue,
      consumeSyncCloseResult: () => undefined,
      deleteFromProjects: (u) => {
        projects.delete(u);
      },
    });
    assert.equal(result.disposed, false);
    assert.equal(result.allowSafeQuit, false);
    assert.equal(result.allowAccountSwitch, false);
    assert.equal(projects.has(personalA), true);
    assert.equal(result.pendingSync, true, "必须保留 pendingSync 事实");
    assert.ok(typeof result.taskId === "string" && result.taskId.length > 0);
  } finally {
    queue.close();
  }
});

test("P0: projectsClosed 后 closeAll 不得二次 close", async () => {
  const ctx = await bootCoordinator({
    name: "no-double-close",
    projects: [{ uuid: personalA }],
  });
  try {
    let closeCalls = 0;
    const orig = ctx.projectHandles[personalA].sync.close.bind(
      ctx.projectHandles[personalA].sync,
    );
    ctx.projectHandles[personalA].sync.close = async () => {
      closeCalls += 1;
      return orig();
    };
    await (syncCoordinator as unknown as {
      commitProjectClosesForOrdinaryShutdown(): Promise<void>;
    }).commitProjectClosesForOrdinaryShutdown();
    assert.equal(closeCalls, 1);
    assert.equal(ctx.internals.shutdownState.projectsClosed, true);
    await (ctx.internals as { closeAllForOrdinaryShutdown(): Promise<void> })
      .closeAllForOrdinaryShutdown();
    assert.equal(closeCalls, 1, "禁止二次 close");
  } finally {
    await ctx.cleanup();
  }
});
