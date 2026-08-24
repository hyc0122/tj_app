/**
 * round6s RED：resume 重试 re-drain、批量 commit 中途失败 reopen、Socket 已启动异常断连。
 * Promise barrier；禁止固定 sleep / force-exit / process.exit。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import express from "express";

import {
  PersonalProjectSync,
  type PersonalLocal,
  type PersonalManifest,
  type PersonalRemote,
} from "../../src/tianjiang/sync/personal-project-sync";
import { createShutdownPhaseState } from "../../src/tianjiang/runtime/sync-coordinator";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { centralSessionStore } from "../../src/tianjiang/auth/auth-runtime";
import {
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
  stopGenerationTaskRecovery,
} from "../../src/utils/db";
import {
  closeServe,
  registerServeRuntimeResources,
  resetServeLifecycleForTests,
  serveRuntimeSnapshot,
} from "../../src/tianjiang/runtime/serve-lifecycle";
import { serveReadinessGate } from "../../src/tianjiang/runtime/serve-readiness";
import { SocketActivityTracker } from "../../src/socket/activity-tracker";
import { userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";

const worktreeRoot = path.resolve(__dirname, "../..", "..");
const personalA = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";
const personalB = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";

function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fixture(name: string) {
  const root = path.join(worktreeRoot, ".tmp", "round6s", name, String(Date.now()));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function manifest(version: number, md5: string): PersonalManifest {
  return { version, objects: [{ relativePath: "project.sqlite", md5 }] };
}

function makeLocal(
  initial: PersonalManifest,
  hooks?: { failClose?: boolean; onClose?: () => void },
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
      if (!state.current) throw new Error("no current");
      const objects = state.dirty
        ? state.current.objects.map((o) =>
            o.relativePath === "project.sqlite" ? { ...o, md5: `${o.md5}-d` } : o,
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

function makeRemote(opts?: { failPublish?: boolean }): PersonalRemote & {
  publishCalls: number;
} {
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
      if (opts?.failPublish) {
        throw Object.assign(new Error("network fail"), { code: "NETWORK_OFFLINE" });
      }
      current = { ...structuredClone(next), version: current.version + 1 };
      return structuredClone(current);
    },
  };
}

async function boot(opts: {
  name: string;
  projects: Array<{
    uuid: string;
    failLocalClose?: boolean;
    failPublish?: boolean;
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

  const userId = 69001;
  const expiresAt = Date.now() + 3_600_000;
  const session = centralSessionStore.create({
    serverUrl: "https://api.j11.com.cn",
    token: `r6s-${userId}`,
    expiresAt,
    user: { id: userId, username: `u${userId}`, nickname: "" },
  });
  (session as { expiresAt: number }).expiresAt = expiresAt;

  const internals = syncCoordinator as unknown as Record<string, any>;
  const identity = { issuer: session.serverUrl, userId };
  const segment = userStorageSegment(identity);
  const catalog = new Map<string, any>();
  const handles: Record<
    string,
    { local: ReturnType<typeof makeLocal>; remote: ReturnType<typeof makeRemote>; sync: PersonalProjectSync }
  > = {};

  internals.projects.clear();
  for (const p of opts.projects) {
    const local = makeLocal(manifest(1, "base"), { failClose: p.failLocalClose });
    local.dirty = true;
    const remote = makeRemote({ failPublish: p.failPublish === true });
    const sync = new PersonalProjectSync(local, remote, () => true);
    sync.open();
    handles[p.uuid] = { local, remote, sync };
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
    internals.projects.set(p.uuid, {
      kind: "personal",
      local: {
        get dirty() {
          return local.dirty;
        },
        set dirty(v: boolean) {
          local.dirty = v;
        },
        get closed() {
          return local.closed;
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
    grantId: "f8f8f8f8-f8f8-4f8f-f8f8-f8f8f8f8f8f8",
    userId,
    deviceUuid: String(internals.deviceUuid ?? "018f3d6e-2d9e-7b6c-8a9b-r6sdevice0001"),
    expiresAt: new Date(expiresAt).toISOString(),
    revokedAt: null,
  };

  Object.assign(internals, {
    dataRoot,
    session,
    remote: {
      refreshOfflineGrant: async () => grant,
      personalRemote: () => makeRemote(),
      projectCatalog: async () => [...catalog.values()],
    },
    catalog,
    localProjectIds: new Map([...catalog.keys()].map((u) => [u, userId])),
    offlineCache: {
      issuer: session.serverUrl,
      userId,
      grant,
      catalog: [...catalog.values()],
    },
    online: true,
    deviceActive: true,
    profileKey: Buffer.from("r6s-profile-key-32bytes!!!!!!!!!!"),
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
    handles,
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

async function assertDrainStageFailureRestores(
  failingStage: "generation" | "project-consumer",
): Promise<void> {
  const httpServer = http.createServer();
  httpServer.unref();
  let socketResumeCalls = 0;
  let generationResumeCalls = 0;
  let projectResumeCalls = 0;
  let commitCalls = 0;
  try {
    registerServeRuntimeResources(
      {
        httpServer,
        socketRuntime: {
          beginReversibleDraining: () => undefined,
          resumeAccepting: () => {
            socketResumeCalls += 1;
          },
          beginClosing: () => undefined,
          waitForDrain: async () => undefined,
          close: async () => undefined,
          snapshot: () => ({ acceptingEvents: true, activeHandlerCount: 0 }),
        } as never,
        webSocketRuntime: {
          beginClosing: () => undefined,
          close: async () => undefined,
        },
      },
      {
        pauseGenerationRecovery: async () => {
          if (failingStage === "generation") {
            throw Object.assign(new Error("generation pause failed"), {
              code: "GENERATION_PAUSE_FAILED",
            });
          }
        },
        resumeGenerationRecovery: () => {
          generationResumeCalls += 1;
        },
        beginProjectCloseDrain: async () => {
          if (failingStage === "project-consumer") {
            throw Object.assign(new Error("project drain failed"), {
              code: "PROJECT_DRAIN_FAILED",
            });
          }
        },
        resumeProjectCloseDrain: () => {
          projectResumeCalls += 1;
        },
        stopGenerationRecovery: async () => undefined,
        stopProfileKeyRecovery: async () => undefined,
        commitProjectCloses: async () => {
          commitCalls += 1;
        },
        finalSync: async () => undefined,
        destroyDatabases: async () => undefined,
      },
    );

    await assert.rejects(
      closeServe(),
      (error: unknown) =>
        error instanceof Error
        && (error as Error & { code?: string }).code
          === (failingStage === "generation"
            ? "GENERATION_PAUSE_FAILED"
            : "PROJECT_DRAIN_FAILED"),
    );
    assert.equal(commitCalls, 0, "drain 未完整完成时禁止进入项目关闭提交");
    assert.equal(socketResumeCalls, 1);
    assert.equal(generationResumeCalls, 1, "pause 调用可能部分生效，异常时必须恢复");
    assert.equal(
      projectResumeCalls,
      failingStage === "project-consumer" ? 1 : 0,
      "仅已开始的 project consumer drain 需要恢复",
    );
    assert.equal(serveReadinessGate.snapshot().accepting, true);
  } finally {
    resetServeLifecycleForTests();
    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }
}

test("P0-0: generation pause 抛错时倒序恢复 HTTP/Socket/后台接入", async () => {
  await assertDrainStageFailureRestores("generation");
});

test("P0-0: project consumer drain 抛错时倒序恢复全部可逆阶段", async () => {
  await assertDrainStageFailureRestores("project-consumer");
});

async function assertResumeFailureKeepsExternalDrained(
  failingResume: "project-consumer" | "socket",
): Promise<void> {
  const httpServer = http.createServer();
  httpServer.unref();
  let socketAccepting = true;
  let socketDrainCalls = 0;
  let socketResumeCalls = 0;
  let generationResumeCalls = 0;
  let projectResumeCalls = 0;
  try {
    registerServeRuntimeResources(
      {
        httpServer,
        socketRuntime: {
          beginReversibleDraining: () => {
            socketDrainCalls += 1;
            socketAccepting = false;
          },
          resumeAccepting: () => {
            socketResumeCalls += 1;
            socketAccepting = true;
            if (failingResume === "socket") {
              throw Object.assign(new Error("socket resume failed"), {
                code: "SOCKET_RESUME_FAILED",
              });
            }
          },
          beginClosing: () => undefined,
          waitForDrain: async () => undefined,
          close: async () => undefined,
          snapshot: () => ({
            acceptingEvents: socketAccepting,
            activeHandlerCount: 0,
          }),
        } as never,
        webSocketRuntime: {
          beginClosing: () => undefined,
          close: async () => undefined,
        },
      },
      {
        pauseGenerationRecovery: async () => undefined,
        resumeGenerationRecovery: () => {
          generationResumeCalls += 1;
        },
        beginProjectCloseDrain: async () => {
          throw Object.assign(new Error("project drain failed"), {
            code: "PROJECT_DRAIN_FAILED",
          });
        },
        resumeProjectCloseDrain: () => {
          projectResumeCalls += 1;
          if (failingResume === "project-consumer") {
            throw Object.assign(new Error("project resume failed"), {
              code: "PROJECT_RESUME_FAILED",
            });
          }
        },
        stopGenerationRecovery: async () => undefined,
        stopProfileKeyRecovery: async () => undefined,
        commitProjectCloses: async () => undefined,
        finalSync: async () => undefined,
        destroyDatabases: async () => undefined,
      },
    );

    await assert.rejects(
      closeServe(),
      (error: unknown) =>
        error instanceof Error
        && (error as Error & { code?: string }).code === "DRAIN_RESUME_FAILED",
    );
    const snapshot = serveRuntimeSnapshot();
    assert.equal(snapshot.phase, "reversible_draining");
    assert.equal(snapshot.reversibleDraining, true);
    assert.equal(snapshot.acceptingHttpRequests, false, "恢复失败后 HTTP 必须保持 503");
    assert.equal(snapshot.acceptingSocketEvents, false, "恢复失败后 Socket 必须继续拒绝新事件");
    assert.equal(projectResumeCalls, 1);
    assert.equal(generationResumeCalls, 1, "独立后台阶段仍应尽量倒序恢复");
    assert.equal(
      socketResumeCalls,
      failingResume === "socket" ? 1 : 0,
      "内部后台恢复失败时禁止提前开放 Socket",
    );
    assert.ok(socketDrainCalls >= 1);
  } finally {
    resetServeLifecycleForTests();
    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }
}

test("P0-0: project consumer 恢复失败时 HTTP/Socket 必须保持排空", async () => {
  await assertResumeFailureKeepsExternalDrained("project-consumer");
});

test("P0-0: Socket 恢复自身抛错时必须重新排空并禁止开放 HTTP", async () => {
  await assertResumeFailureKeepsExternalDrained("socket");
});

test("P0-0: project_close_commit 阻断后 Socket 部分开放再抛错仍须重新排空", async () => {
  const httpServer = http.createServer();
  httpServer.unref();
  let socketAccepting = true;
  let socketDrainCalls = 0;
  try {
    registerServeRuntimeResources(
      {
        httpServer,
        socketRuntime: {
          beginReversibleDraining: () => {
            socketDrainCalls += 1;
            socketAccepting = false;
          },
          resumeAccepting: () => {
            // 中文注释：模拟生产组件先改变状态、随后抛错的最坏部分恢复窗口。
            socketAccepting = true;
            throw Object.assign(new Error("socket resume failed after open"), {
              code: "SOCKET_RESUME_FAILED",
            });
          },
          beginClosing: () => undefined,
          waitForDrain: async () => undefined,
          close: async () => undefined,
          snapshot: () => ({
            acceptingEvents: socketAccepting,
            activeHandlerCount: 0,
          }),
        } as never,
        webSocketRuntime: {
          beginClosing: () => undefined,
          close: async () => undefined,
        },
      },
      {
        pauseGenerationRecovery: async () => undefined,
        resumeGenerationRecovery: () => undefined,
        beginProjectCloseDrain: async () => undefined,
        resumeProjectCloseDrain: () => undefined,
        stopGenerationRecovery: async () => undefined,
        stopProfileKeyRecovery: async () => undefined,
        commitProjectCloses: async () => {
          throw Object.assign(new Error("personal close blocked"), {
            code: "PERSONAL_CLOSE_BLOCKED",
          });
        },
        finalSync: async () => undefined,
        destroyDatabases: async () => undefined,
      },
    );

    await assert.rejects(
      closeServe(),
      (error: unknown) =>
        error instanceof Error
        && (error as Error & { code?: string }).code === "DRAIN_RESUME_FAILED",
    );
    const snapshot = serveRuntimeSnapshot();
    assert.equal(snapshot.phase, "reversible_draining");
    assert.equal(snapshot.reversibleDraining, true);
    assert.equal(snapshot.acceptingHttpRequests, false);
    assert.equal(snapshot.acceptingSocketEvents, false);
    assert.ok(socketDrainCalls >= 2, "初始 drain + resume 失败重新压回 drain");
  } finally {
    resetServeLifecycleForTests();
    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }
});

// ---------- P0-1: resume 中途失败后第二次关闭必须完整 re-drain ----------
test("P0-1: resume 中途失败后第二次 closeServe 必须完整重新 drain", async () => {
  const events: string[] = [];
  let commitRound = 0;
  let genResumeRound = 0;

  const app = express();
  app.use(serveReadinessGate.middleware());
  const httpServer = http.createServer(app);
  httpServer.unref();

  const socketRuntime = {
    beginReversibleDraining: () => {
      // 事件在 waitForDrain 完成点记录，保证与文档事件序对齐
    },
    resumeAccepting: () => {
      events.push("socket:resume");
    },
    beginClosing: () => {
      events.push("socket:irreversible");
    },
    waitForDrain: async () => {
      events.push("socket:drain");
    },
    close: async () => undefined,
    snapshot: () => ({ acceptingEvents: true, activeHandlerCount: 0 }),
  };

  try {
    await new Promise<void>((r, j) => {
      httpServer.once("error", j);
      httpServer.listen(0, "127.0.0.1", () => r());
    });
    if (!serveReadinessGate.snapshot().accepting) {
      try {
        serveReadinessGate.startAccepting();
      } catch {
        //
      }
    }
    registerServeRuntimeResources(
      {
        httpServer,
        socketRuntime: socketRuntime as never,
        webSocketRuntime: {
          beginClosing: () => undefined,
          close: async () => undefined,
        },
      },
      {
        pauseGenerationRecovery: async () => {
          events.push("generation:pause");
        },
        resumeGenerationRecovery: () => {
          genResumeRound += 1;
          events.push("generation:resume");
          if (genResumeRound === 1) {
            throw Object.assign(new Error("generation resume failed"), {
              code: "GEN_RESUME_FAIL",
            });
          }
        },
        beginProjectCloseDrain: async () => {
          events.push("project-consumer:drain");
        },
        resumeProjectCloseDrain: () => {
          events.push("project-consumer:resume");
        },
        stopGenerationRecovery: async () => undefined,
        stopProfileKeyRecovery: async () => undefined,
        commitProjectCloses: async () => {
          commitRound += 1;
          events.push("project:commit");
          if (commitRound === 1) {
            throw Object.assign(new Error("personal close blocked"), {
              code: "PERSONAL_CLOSE_BLOCKED",
            });
          }
        },
        finalSync: async () => {
          events.push("final-sync");
        },
        destroyDatabases: async () => {
          events.push("db:destroy");
        },
      },
    );

    // 包装 waitForDrain 事件：HTTP gate 完成时记 http:drain
    const origWait = serveReadinessGate.waitForDrain.bind(serveReadinessGate);
    serveReadinessGate.waitForDrain = async () => {
      events.push("http:drain");
      await origWait();
    };

    const first = closeServe();
    await assert.rejects(
      first,
      (error: unknown) =>
        error instanceof Error
        && (error as Error & { code?: string }).code === "DRAIN_RESUME_FAILED",
    );

    const afterFirst = events.slice();
    events.length = 0;

    await closeServe();
    const secondAttemptEvents = events.slice();
    assert.deepEqual(secondAttemptEvents.slice(0, 5), [
      "http:drain",
      "socket:drain",
      "generation:pause",
      "project-consumer:drain",
      "project:commit",
    ]);
    assert.ok(afterFirst.includes("project:commit"));
    assert.ok(afterFirst.includes("generation:resume"));
  } finally {
    try {
      await closeServe();
    } catch {
      //
    }
    resetServeLifecycleForTests();
    if (httpServer.listening) {
      await new Promise<void>((r) => httpServer.close(() => r()));
    }
  }
});

// ---------- P0-2：真实补偿闭环见 personal-close-compensation-round6t.test.ts ----------
test("P0-2: 补偿测试文件存在且禁止假 runtime fallback 字样", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "personal-close-compensation-round6t.test.ts"),
    "utf8",
  );
  assert.match(src, /openProjectCalls \+= 1/);
  assert.match(src, /仅委托生产路径/);
  assert.equal(
    /catch\s*\{[\s\S]*projects\.set/.test(src),
    false,
    "禁止 catch openProject 后 projects.set 假 runtime",
  );
});

// ---------- P1: 已启动 handler 异常断连；draining 拒新不断连 ----------
test("P1: 已启动 handler 异常断开当前连接；draining 拒绝不断连", async () => {
  const tracker = new SocketActivityTracker();
  let disconnectCalls = 0;
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    connected: true,
    disconnect: () => {
      disconnectCalls += 1;
      socket.connected = false;
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler);
    },
  };

  const settled = deferred();
  tracker.bindEvent(socket as never, "chat", async () => {
    try {
      throw new Error("unexpected handler failure");
    } finally {
      queueMicrotask(() => settled.resolve());
    }
  });
  handlers.get("chat")?.();
  await settled.promise;
  for (let i = 0; i < 10 && disconnectCalls === 0; i += 1) {
    await new Promise<void>((r) => setImmediate(r));
  }
  assert.equal(disconnectCalls, 1, "已启动 handler 异常必须 disconnect 当前连接");

  // draining 拒绝：不断连
  disconnectCalls = 0;
  socket.connected = true;
  const hold = deferred();
  const started = deferred();
  let entered = 0;
  const socket2 = {
    connected: true,
    disconnect: () => {
      disconnectCalls += 1;
      socket2.connected = false;
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(`2:${event}`, handler);
    },
  };
  tracker.bindEvent(socket2 as never, "chat", async () => {
    entered += 1;
    if (entered === 1) {
      started.resolve();
      await hold.promise;
    }
  });
  handlers.get("2:chat")?.();
  await started.promise;
  tracker.beginReversibleDraining();
  handlers.get("2:chat")?.();
  await Promise.resolve();
  assert.equal(entered, 1);
  assert.equal(disconnectCalls, 0, "draining 拒绝新事件不得 disconnect");
  hold.resolve();
  await tracker.waitForDrain();
});
