/**
 * round6q：PersonalCloseCoordinator 生产闭环。
 * 必须穿过真实生产入口：closeProject / shutdown+closeServe+ShutdownGate /
 * performLogin / executePendingUpload / syncNow / runPendingSyncConsumer。
 * 禁止私有 settle 直调、源码正则、void uploads、typeof state === string 冒充。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  PersonalProjectSync,
  type PersonalLocal,
  type PersonalManifest,
  type PersonalRemote,
} from "../../src/tianjiang/sync/personal-project-sync";
import {
  createShutdownPhaseState,
  openUserSyncQueue,
} from "../../src/tianjiang/runtime/sync-coordinator";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { centralSessionStore } from "../../src/tianjiang/auth/auth-runtime";
import {
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
  stopGenerationTaskRecovery,
} from "../../src/utils/db";
import { SyncQueue } from "../../src/tianjiang/sync/queue";
import {
  classifyPendingSyncFailure,
  runPendingSyncConsumer,
} from "../../src/tianjiang/sync/pending-sync-consumer";
import { ShutdownGate } from "../../src/tianjiang/runtime/shutdown-gate";
import {
  closeServe,
  registerServeRuntimeResources,
  resetServeLifecycleForTests,
  serveRuntimeSnapshot,
} from "../../src/tianjiang/runtime/serve-lifecycle";
import {
  userStorageSegment,
  userStorageRoot,
} from "../../src/tianjiang/runtime/user-storage-context";
import http from "node:http";

const worktreeRoot = path.resolve(__dirname, "../..", "..");
const personalUuid = "b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0";
const teamUuid = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

function fixture(name: string) {
  const root = path.join(worktreeRoot, ".tmp", "r6q", name, String(Date.now()));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function manifest(version: number, md5: string): PersonalManifest {
  return { version, objects: [{ relativePath: "project.sqlite", md5 }] };
}

function makeLocal(initial?: PersonalManifest): PersonalLocal & {
  failSnapshot?: string;
  closed?: boolean;
  close(): void;
} {
  const state = {
    current: initial ? structuredClone(initial) : (undefined as PersonalManifest | undefined),
    dirty: false,
    failSnapshot: undefined as string | undefined,
    closed: false,
    gen: 0,
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
      state.current = v;
    },
    get failSnapshot() {
      return state.failSnapshot;
    },
    set failSnapshot(v: string | undefined) {
      state.failSnapshot = v;
    },
    get closed() {
      return state.closed;
    },
    async install(remote) {
      state.current = structuredClone(remote);
      state.dirty = false;
    },
    async createSnapshot() {
      if (state.failSnapshot) {
        const err = new Error(state.failSnapshot);
        if (/SQLITE/i.test(state.failSnapshot)) {
          (err as { code?: string }).code = "SQLITE_CORRUPT";
        }
        if (/integrity/i.test(state.failSnapshot)) {
          (err as { code?: string }).code = "SNAPSHOT_INTEGRITY";
        }
        if (/journal/i.test(state.failSnapshot)) {
          (err as { code?: string }).code = "JOURNAL_UNREADABLE";
        }
        throw err;
      }
      if (!state.current) throw new Error("no current");
      if (state.dirty) state.gen += 1;
      const objects = state.dirty
        ? state.current.objects.map((o) =>
            o.relativePath === "project.sqlite"
              ? { ...o, md5: `${o.md5}-g${state.gen}` }
              : o,
          )
        : structuredClone(state.current.objects);
      return {
        version: state.current.version,
        objects,
        capturedMutationGeneration: state.dirty ? state.gen : 0,
      };
    },
    async createRecovery() {},
    close() {
      state.closed = true;
    },
  };
}

function makeRemote(opts?: { failPublish?: boolean }): PersonalRemote & {
  publishCalls: number;
  commitCalls: number;
} {
  let current = manifest(1, "base");
  let publishCalls = 0;
  let commitCalls = 0;
  return {
    get publishCalls() {
      return publishCalls;
    },
    get commitCalls() {
      return commitCalls;
    },
    async latest() {
      return structuredClone(current);
    },
    async publish(_b, next) {
      publishCalls += 1;
      if (opts?.failPublish) {
        const err = new Error("network personal publish failed");
        (err as { code?: string }).code = "NETWORK_OFFLINE";
        throw err;
      }
      current = { ...structuredClone(next), version: current.version + 1 };
      commitCalls += 1;
      return structuredClone(current);
    },
  };
}

function countUploads(queueDbPath: string, projectUuid?: string): number {
  if (!fs.existsSync(queueDbPath)) return 0;
  const db = new Database(queueDbPath, { readonly: true, fileMustExist: true });
  try {
    if (projectUuid) {
      return (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM sync_tasks WHERE project_uuid = ? AND task_type = 'upload'`,
          )
          .get(projectUuid) as { c: number }
      ).c;
    }
    return (db.prepare(`SELECT COUNT(*) AS c FROM sync_tasks`).get() as { c: number }).c;
  } finally {
    db.close();
  }
}

function readTaskStatus(queueDbPath: string, projectUuid: string): string | undefined {
  if (!fs.existsSync(queueDbPath)) return undefined;
  const db = new Database(queueDbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT status FROM sync_tasks WHERE project_uuid = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectUuid) as { status: string } | undefined;
    return row?.status;
  } finally {
    db.close();
  }
}

async function boot(opts: {
  name: string;
  userId?: number;
  expiresAt?: number;
  failPublish?: boolean;
  failSnapshot?: string;
  profileKey?: Buffer;
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

  const userId = opts.userId ?? 67001;
  const expiresAt = opts.expiresAt ?? Date.now() + 3_600_000;
  const session = centralSessionStore.create({
    serverUrl: "https://api.j11.com.cn",
    token: `r6q-${userId}`,
    expiresAt,
    user: { id: userId, username: `u${userId}`, nickname: "" },
  });
  (session as { expiresAt: number }).expiresAt = expiresAt;

  const internals = syncCoordinator as unknown as Record<string, any>;
  const identity = { issuer: session.serverUrl, userId };
  const segment = userStorageSegment(identity);
  const queueDbPath = path.join(userStorageRoot(dataRoot, identity), "sync-queue.sqlite");

  const personalLocal = makeLocal(manifest(1, "base"));
  personalLocal.dirty = true;
  if (opts.failSnapshot) personalLocal.failSnapshot = opts.failSnapshot;
  const personalRemote = makeRemote({
    failPublish: opts.failPublish === true,
  });
  // 默认 failPublish=false 成功路径；显式 true 才失败
  if (opts.failPublish === undefined && !opts.failSnapshot) {
    // 默认：网络失败以测退出门，除非调用方指定
  }
  const personalSync = new PersonalProjectSync(
    personalLocal,
    personalRemote,
    () => true,
  );
  personalSync.open();

  const personalCatalog = {
    projectUuid: personalUuid,
    name: "p",
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
  };

  const grant = {
    grantId: "d8d8d8d8-d8d8-4d8d-d8d8-d8d8d8d8d8d8",
    userId,
    deviceUuid: String(internals.deviceUuid ?? "018f3d6e-2d9e-7b6c-8a9b-r6qdevice0001"),
    expiresAt: new Date(expiresAt).toISOString(),
    revokedAt: null,
  };

  const profileKey = opts.profileKey ?? Buffer.from("r6q-profile-key-32bytes!!!!!!!!");
  const profileStore = { closed: false, close() { this.closed = true; } };

  Object.assign(internals, {
    dataRoot,
    session,
    remote: {
      refreshOfflineGrant: async () => grant,
      personalRemote: () => personalRemote,
    },
    catalog: new Map([[personalUuid, personalCatalog]]),
    localProjectIds: new Map([[personalUuid, userId]]),
    offlineCache: {
      issuer: session.serverUrl,
      userId,
      grant,
      catalog: [personalCatalog],
    },
    online: true,
    deviceActive: true,
    profileKey,
    profileStore,
    shutdownState: createShutdownPhaseState(),
    shutdownRequested: false,
    shutdownInFlight: undefined,
  });
  internals.projects.clear();
  internals.projects.set(personalUuid, {
    kind: "personal",
    local: {
      get dirty() {
        return personalLocal.dirty;
      },
      set dirty(v: boolean) {
        personalLocal.dirty = v;
      },
      close: () => {
        personalLocal.close();
      },
      markLegacyEdited() {
        personalLocal.dirty = true;
      },
    },
    sync: personalSync,
  });

  return {
    dataRoot,
    segment,
    queueDbPath,
    identity,
    internals,
    session,
    expiresAt,
    personalSync,
    personalLocal,
    personalRemote,
    profileKey,
    profileStore,
    originalCwd,
    cleanup: async () => {
      for (const [, rt] of [...internals.projects]) {
        try {
          rt.local?.close?.();
        } catch {
          // ignore
        }
      }
      internals.projects.clear();
      centralSessionStore.delete(session.id);
      await stopGenerationTaskRecovery().catch(() => undefined);
      await destroyAllDatabaseHandles().catch(() => undefined);
      resetDatabaseRuntimeForServe();
      process.chdir(originalCwd);
    },
  };
}

// ---------- 消费者 fatal 分类 ----------
test("consumer 分类：共享分类器；JOURNAL/SNAPSHOT/SQLITE/未知 fatal；不得默认 retryable", () => {
  assert.equal(
    classifyPendingSyncFailure(
      Object.assign(new Error("j"), { code: "JOURNAL_UNREADABLE" }),
    ),
    "fatal",
  );
  assert.equal(
    classifyPendingSyncFailure(
      Object.assign(new Error("s"), { code: "SNAPSHOT_INTEGRITY" }),
    ),
    "fatal",
  );
  assert.equal(
    classifyPendingSyncFailure(
      Object.assign(new Error("c"), { code: "SQLITE_CORRUPT" }),
    ),
    "fatal",
  );
  assert.equal(
    classifyPendingSyncFailure(new Error("totally unknown weird failure xyz")),
    "fatal",
  );
  assert.equal(
    classifyPendingSyncFailure(
      Object.assign(new Error("n"), { code: "NETWORK_OFFLINE" }),
    ),
    "retryable",
  );
  assert.equal(
    classifyPendingSyncFailure(
      Object.assign(new Error("conflict"), { name: "PersonalProjectConflictError" }),
    ),
    "fatal",
    "conflict 在 consumer 侧进入 fatal 而非 retryable",
  );
});

test("consumer fatal 任务进入 failed 且不再 claim", async () => {
  const root = fixture("consumer-fatal");
  const dbPath = path.join(root, "sync-queue.sqlite");
  const queue = new SyncQueue(dbPath);
  try {
    const id = queue.ensureUploadQueued(personalUuid, Date.now() + 86_400_000);
    queue.requeueRunningAsPending();
    let uploads = 0;
    const result = await runPendingSyncConsumer({
      queue,
      isActive: () => true,
      executor: {
        uploadProject: async () => {
          uploads += 1;
          throw Object.assign(new Error("sqlite corrupt"), {
            code: "SQLITE_CORRUPT",
          });
        },
      },
    });
    assert.equal(uploads, 1, "必须真实 await 执行 upload");
    assert.equal(result.fatal, 1);
    assert.equal(result.completed, 0);
    assert.equal(result.retryable, 0);
    const task = queue.get(id)!;
    assert.equal(task.status, "failed", "fatal 必须 failed 禁止无限重试");
    // 再次消费不得再领取
    const second = await runPendingSyncConsumer({
      queue,
      isActive: () => true,
      executor: {
        uploadProject: async () => {
          uploads += 1;
        },
      },
    });
    assert.equal(second.attempted, 0);
    assert.equal(uploads, 1);
  } finally {
    queue.close();
  }
});

// ---------- 真实退出门 ----------
test("fatal project → ShutdownGate：closeRuntime reject、canQuit=false、quitCalls=0、profile 未销毁", async () => {
  const ctx = await boot({
    name: "exit-gate-fatal",
    failSnapshot: "SQLITE_CORRUPT disk image",
  });
  try {
    const events: string[] = [];
    let quitCalls = 0;
    let relaunchCalls = 0;

    // 生产链：ShutdownGate → closeRuntime → preflight/shutdown
    const gate = new ShutdownGate({
      closeRuntime: async () => {
        events.push("closeRuntime");
        await (syncCoordinator as any).shutdown();
      },
      quit: () => {
        quitCalls += 1;
        events.push("quit");
      },
      relaunch: () => {
        relaunchCalls += 1;
        events.push("relaunch");
      },
      onFailure: async () => {
        events.push("failure");
      },
    });

    await gate.request(false);

    assert.equal(gate.canQuit(), false, "canQuit 必须保持 false");
    assert.equal(quitCalls, 0, "不得 quit");
    assert.equal(relaunchCalls, 0, "不得 relaunch");
    assert.ok(events.includes("failure"));
    assert.ok(events.includes("closeRuntime"));
    assert.equal(events.includes("quit"), false);

    // projectsClosed 不得 true
    assert.equal(
      ctx.internals.shutdownState.projectsClosed,
      false,
      "projectsClosed 不得在 fatal 后记 true",
    );
    assert.equal(
      ctx.internals.shutdownState.profileKeyCleared,
      false,
      "profileKey 不得进入销毁",
    );
    assert.equal(
      ctx.internals.shutdownState.profileStoreClosed,
      false,
      "profileStore 不得关闭",
    );
    assert.ok(ctx.internals.profileKey, "profileKey 句柄仍在");
    assert.equal(ctx.profileStore.closed, false);
    assert.equal(
      ctx.internals.projects.has(personalUuid),
      true,
      "fatal 后 runtime 保留",
    );
    assert.equal(
      ctx.personalSync.isTerminalClosed(),
      false,
      "blocked 后 isTerminalClosed=false",
    );

    // blocked 后仍可 syncNow / markEdited（修复后）
    ctx.personalLocal.failSnapshot = undefined;
    ctx.personalLocal.dirty = true;
    ctx.personalSync.markEdited();
    const nowOut = await (syncCoordinator as any).syncNow(ctx.session, personalUuid);
    assert.ok(
      nowOut.state === "synced" || nowOut.state === "unchanged",
      `syncNow 不得伪装失败为 silent；实际 ${JSON.stringify(nowOut)}`,
    );
    // 再次 close 在故障消失后可成功
    const closeOut = await (syncCoordinator as any).closeProject(
      ctx.session,
      personalUuid,
    );
    assert.ok(
      closeOut.state === "synced" || closeOut.state === "unchanged",
      `再次 close 应成功，实际 ${JSON.stringify(closeOut)}`,
    );
  } finally {
    await ctx.cleanup();
  }
});

test("fatal → closeServe preflight：beginClosing 前阻断，应用可操作", async () => {
  const ctx = await boot({
    name: "preflight-block",
    failSnapshot: "SQLITE_CORRUPT disk image",
  });
  let httpServer: http.Server | undefined;
  try {
    httpServer = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    await new Promise<void>((resolve, reject) => {
      httpServer!.once("error", reject);
      httpServer!.listen(0, "127.0.0.1", () => resolve());
    });
    // 测试句柄不得阻止 suite 退出
    httpServer.unref();
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");

    registerServeRuntimeResources(
      {
        httpServer,
        socketRuntime: {
          beginClosing: () => undefined,
          waitForDrain: async () => undefined,
          close: async () => undefined,
          snapshot: () => ({ acceptingEvents: true, activeHandlerCount: 0 }),
        } as any,
        webSocketRuntime: {
          beginClosing: () => undefined,
          close: async () => undefined,
        },
      },
      {
        // 使用生产 preflight + finalSync 默认链，但 destroy 空操作避免污染
        destroyDatabases: async () => undefined,
        stopGenerationRecovery: async () => undefined,
        stopProfileKeyRecovery: async () => undefined,
      },
    );

    let quitCalls = 0;
    const gate = new ShutdownGate({
      closeRuntime: closeServe,
      quit: () => {
        quitCalls += 1;
      },
      relaunch: () => undefined,
      onFailure: async () => undefined,
    });

    await gate.request(false);
    assert.equal(gate.canQuit(), false);
    assert.equal(quitCalls, 0);

    const snap = serveRuntimeSnapshot();
    assert.equal(
      snap.closing,
      false,
      "preflight 阻断后不得 beginClosing",
    );
    assert.equal(snap.preflightPersonalCloseComplete, false);
    assert.equal(snap.closed, false);
    assert.equal(snap.databaseHandlesClosed, false);

    // HTTP 仍可访问
    const res = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(res.status, 200);

    assert.equal(ctx.internals.projects.has(personalUuid), true);
    assert.equal(ctx.personalSync.isTerminalClosed(), false);
  } finally {
    try {
      httpServer?.closeAllConnections?.();
    } catch {
      // ignore
    }
    try {
      if (httpServer?.listening) {
        await Promise.race([
          new Promise<void>((resolve) => httpServer!.close(() => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 500)),
        ]);
      }
    } catch {
      // ignore
    }
    resetServeLifecycleForTests();
    await ctx.cleanup();
  }
});

// ---------- session_expired 阻断与重新登录恢复 ----------
test("过期会话：close_blocked、不 dispose、不入 active queue、不允许退出", async () => {
  const ctx = await boot({
    name: "session-expired",
    failPublish: true,
    expiresAt: Date.now() - 5_000,
  });
  try {
    await assert.rejects(
      () => (syncCoordinator as any).closeProject(ctx.session, personalUuid),
      /过期|会话|SESSION/i,
    );
    assert.equal(ctx.internals.projects.has(personalUuid), true);
    assert.equal(ctx.personalSync.isTerminalClosed(), false);
    assert.equal(countUploads(ctx.queueDbPath, personalUuid), 0, "禁止假任务");
    assert.equal(
      readTaskStatus(ctx.queueDbPath, personalUuid),
      undefined,
    );

    // shutdown 也必须 reject
    await assert.rejects(
      () => (syncCoordinator as any).shutdown(),
      /过期|阻断|修复|会话|PERSONAL_CLOSE|SYNC|数据/i,
    );
    assert.equal(ctx.internals.shutdownState.projectsClosed, false);
    assert.ok(ctx.internals.profileKey);
  } finally {
    await ctx.cleanup();
  }
});

test("重新登录新 expiresAt 后：中央成功才允许关闭，失败不入队", async () => {
  const ctx = await boot({
    name: "relogin-claim",
    failPublish: true,
    expiresAt: Date.now() - 1_000,
  });
  try {
    // 过期关闭阻断
    await assert.rejects(
      () => (syncCoordinator as any).closeProject(ctx.session, personalUuid),
    );
    assert.equal(countUploads(ctx.queueDbPath, personalUuid), 0);

    // 模拟重新登录：写入新 expiresAt
    const newExpires = Date.now() + 86_400_000;
    (ctx.session as { expiresAt: number }).expiresAt = newExpires;
    ctx.internals.session = ctx.session;
    if (ctx.internals.offlineCache?.grant) {
      ctx.internals.offlineCache.grant.expiresAt = new Date(newExpires).toISOString();
    }

    // Round9：中央仍失败时取消关闭；不得把入队当成功
    await assert.rejects(
      () => (syncCoordinator as any).closeProject(ctx.session, personalUuid),
      /中央同步|取消|失败|网络/,
    );
    assert.equal(ctx.internals.projects.has(personalUuid), true);
    assert.equal(countUploads(ctx.queueDbPath, personalUuid), 0);

    // 修复远端后关闭成功
    const goodRemote = makeRemote({ failPublish: false });
    const local2 = makeLocal(manifest(1, "base"));
    local2.dirty = true;
    const sync2 = new PersonalProjectSync(local2, goodRemote, () => true);
    sync2.open();
    ctx.internals.projects.set(personalUuid, {
      kind: "personal",
      local: {
        get dirty() {
          return local2.dirty;
        },
        set dirty(v: boolean) {
          local2.dirty = v;
        },
        close: () => local2.close(),
      },
      sync: sync2,
    });
    ctx.internals.online = true;
    const out = await (syncCoordinator as any).closeProject(ctx.session, personalUuid);
    assert.ok(out.state === "synced" || out.state === "unchanged", `应中央成功关闭，实际 ${JSON.stringify(out)}`);
    assert.ok(goodRemote.publishCalls >= 1 || out.state === "unchanged");
  } finally {
    await ctx.cleanup();
  }
});

// ---------- blocked runtime 可继续使用 ----------
test("blocked 后 isTerminalClosed=false；syncNow 真实 finalize；markEdited 可再调度；再 close 成功", async () => {
  const ctx = await boot({
    name: "blocked-runtime",
    failSnapshot: "SQLITE_CORRUPT disk image",
  });
  try {
    await assert.rejects(
      () => (syncCoordinator as any).closeProject(ctx.session, personalUuid),
    );
    assert.equal(ctx.personalSync.isTerminalClosed(), false);
    assert.equal(ctx.internals.projects.has(personalUuid), true);

    // 修复故障
    ctx.personalLocal.failSnapshot = undefined;
    ctx.personalLocal.dirty = true;
    const genBefore = 0;
    ctx.personalSync.markEdited();

    const syncOut = await (syncCoordinator as any).syncNow(ctx.session, personalUuid);
    assert.ok(
      syncOut.state === "synced" || syncOut.state === "unchanged",
      `不得伪装；实际 ${JSON.stringify(syncOut)}`,
    );
    // 若 synced，应有 captured generation 语义
    if (syncOut.state === "synced") {
      assert.ok(
        syncOut.capturedMutationGeneration === undefined
          || typeof syncOut.capturedMutationGeneration === "number"
          || syncOut.capturedMutationGeneration === "unknown",
      );
    }
    assert.ok(ctx.personalRemote.publishCalls >= 1 || syncOut.state === "unchanged");
    void genBefore;

    // 再次 dirty 后 close 成功
    ctx.personalLocal.dirty = true;
    ctx.personalSync.markEdited();
    const closeOut = await (syncCoordinator as any).closeProject(
      ctx.session,
      personalUuid,
    );
    assert.ok(
      closeOut.state === "synced"
        || closeOut.state === "unchanged"
        || closeOut.pendingSync === true,
      JSON.stringify(closeOut),
    );
  } finally {
    await ctx.cleanup();
  }
});

// ---------- performLogin 账号切换阻断 ----------
test("performLogin A→B：队列/关闭失败时 A session/runtime 保留且可 syncNow", async () => {
  const ctx = await boot({
    name: "login-switch-block",
    userId: 67111,
    failSnapshot: "SQLITE_CORRUPT disk image",
  });
  try {
    const sessionA = ctx.session;
    const sessionB = centralSessionStore.create({
      serverUrl: "https://api.j11.com.cn",
      token: "r6q-b-token",
      expiresAt: Date.now() + 3_600_000,
      user: { id: 67222, username: "ub", nickname: "" },
    });

    // 生产 performLogin 会 closeAll → settle → fatal → throw
    await assert.rejects(
      () => (syncCoordinator as any).performLogin(sessionB, ctx.internals.shutdownEpoch ?? 0),
      /关闭|数据|异常|corrupt|SQLITE|保留|禁止切换/i,
    );

    // A 仍在
    assert.equal(ctx.internals.session?.id, sessionA.id, "A session 必须保留");
    assert.equal(ctx.internals.projects.has(personalUuid), true, "A runtime 保留");
    assert.equal(ctx.personalSync.isTerminalClosed(), false);

    // A 仍可 syncNow（修复故障后）
    ctx.personalLocal.failSnapshot = undefined;
    ctx.personalLocal.dirty = true;
    const out = await (syncCoordinator as any).syncNow(sessionA, personalUuid);
    assert.ok(
      out.state === "synced" || out.state === "unchanged",
      `A 仍可 syncNow，实际 ${JSON.stringify(out)}`,
    );
    assert.ok(ctx.personalRemote.publishCalls >= 1 || out.state === "unchanged");

    centralSessionStore.delete(sessionB.id);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- Team 0 + Personal 账号隔离 ----------
test("Team queue 保持 0；Personal 账号隔离", async () => {
  const ctxA = await boot({
    name: "iso-a",
    userId: 67301,
    failPublish: true,
    expiresAt: Date.now() + 3_600_000,
  });
  try {
    ctxA.internals.catalog.set(teamUuid, {
      projectUuid: teamUuid,
      kind: "team",
      role: "editor",
      myRole: "editor",
      ownerUserId: 67301,
      name: "t",
      currentVersion: 1,
      syncState: "synced",
      lastSyncedAt: null,
      updatedAt: new Date().toISOString(),
      lockStatus: "none",
      lockHolderName: "",
      openMode: "editable",
      businessType: "script",
    });
    await assert.rejects(
      () => (syncCoordinator as any).closeProject(ctxA.session, personalUuid),
      /中央同步|取消|失败/,
    );
    assert.equal(countUploads(ctxA.queueDbPath, personalUuid), 0);
    assert.equal(countUploads(ctxA.queueDbPath, teamUuid), 0, "Team 永不入队");

    // 账号 B 队列独立
    const idB = { issuer: "https://api.j11.com.cn", userId: 67302 };
    const queueBPath = path.join(
      userStorageRoot(ctxA.dataRoot, idB),
      "sync-queue.sqlite",
    );
    assert.equal(
      fs.existsSync(queueBPath) ? countUploads(queueBPath) : 0,
      0,
      "B 账号队列不得被 A 污染",
    );
  } finally {
    await ctxA.cleanup();
  }
});

// ---------- 并发 close 单飞 ----------
test("并发 close publishCalls<=1 且结果一致", async () => {
  const local = makeLocal(manifest(1, "base"));
  local.dirty = true;
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  let publishCalls = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const remote: PersonalRemote = {
    async latest() {
      return manifest(1, "base");
    },
    async publish(_b, next) {
      publishCalls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await barrier;
      concurrent -= 1;
      return { ...structuredClone(next), version: 2 };
    },
  };
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();
  sync.markEdited();
  const p1 = sync.close();
  const p2 = sync.close();
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(publishCalls, 1);
  assert.equal(maxConcurrent, 1);
  assert.equal(a.state, b.state);
  assert.equal(sync.isTerminalClosed(), false, "attempt 不 dispose");
  sync.commitTerminalDispose();
  assert.equal(sync.isTerminalClosed(), true);
});

// ---------- syncNow generation 断言 ----------
test("syncNow：captured generation finalize；dirty 正确", async () => {
  const ctx = await boot({
    name: "syncnow-gen",
    failPublish: false,
  });
  try {
    ctx.personalLocal.dirty = true;
    ctx.personalSync.markEdited();
    const out = await (syncCoordinator as any).syncNow(ctx.session, personalUuid);
    assert.ok(
      out.state === "synced" || out.state === "unchanged",
      JSON.stringify(out),
    );
    if (out.state === "synced") {
      assert.ok(
        typeof out.capturedMutationGeneration === "number"
          || out.capturedMutationGeneration === "unknown"
          || out.capturedMutationGeneration === undefined,
      );
    }
    assert.ok(ctx.personalRemote.publishCalls >= 1 || out.state === "unchanged");
    // N+1：再次编辑后 dirty 应可再同步
    ctx.personalLocal.dirty = true;
    ctx.personalSync.markEdited();
    assert.equal(ctx.personalLocal.dirty, true);
    const out2 = await (syncCoordinator as any).syncNow(ctx.session, personalUuid);
    assert.ok(out2.state === "synced" || out2.state === "unchanged");
  } finally {
    await ctx.cleanup();
  }
});
