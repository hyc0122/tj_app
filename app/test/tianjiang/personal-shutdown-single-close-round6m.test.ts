/**
 * round6m：同一轮 closeAllForOrdinaryShutdown 内每个项目最多 sync.close 一次。
 * 穿过真实 SyncCoordinator + SyncQueue；测试调度器 unref，避免 120s 句柄挂起。
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
  TeamProjectSync,
  type TeamLocal,
  type TeamRemote,
} from "../../src/tianjiang/sync/team-project-sync";
import {
  hasPendingLegacyMutationIntent,
  recordPendingLegacyMutationIntent,
} from "../../src/tianjiang/runtime/pending-legacy-mutation-intent";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import {
  userStorageSegment,
  userStorageRoot,
} from "../../src/tianjiang/runtime/user-storage-context";
import { createShutdownPhaseState } from "../../src/tianjiang/runtime/sync-coordinator";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { centralSessionStore } from "../../src/tianjiang/auth/auth-runtime";
import {
  destroyAllDatabaseHandles,
  stopGenerationTaskRecovery,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { SyncQueue } from "../../src/tianjiang/sync/queue";
import { runPendingSyncConsumer } from "../../src/tianjiang/sync/pending-sync-consumer";

const worktreeRoot = path.resolve(__dirname, "../..", "..");
const personalUuid = "c3c3c3c3-c3c3-4c3c-83c3-c3c3c3c3c3c3";
const teamUuid = "d4d4d4d4-d4d4-4d4d-84d4-d4d4d4d4d4d4";

function scheduleUnref(run: () => void, delay: number) {
  const t = setTimeout(run, delay);
  t.unref?.();
  return t;
}

function fixture(name: string) {
  const root = path.join(worktreeRoot, ".tmp", "r6m", name, String(Date.now()));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function seedJournal(dbPath: string, generation: number): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS o_legacyMutationJournal (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
  const now = Date.now();
  db.prepare(
    `INSERT INTO o_legacyMutationJournal (source, status, generation, createdAt, updatedAt)
     VALUES (?, 'pending', ?, ?, ?)`,
  ).run("scriptAgent", generation, now, now);
  db.close();
}

function countUploads(queueDbPath: string, projectUuid: string): {
  count: number;
  statuses: string[];
  retryCounts: number[];
} {
  if (!fs.existsSync(queueDbPath)) return { count: 0, statuses: [], retryCounts: [] };
  const db = new Database(queueDbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT status, retry_count FROM sync_tasks
         WHERE project_uuid = ? AND task_type = 'upload'`,
      )
      .all(projectUuid) as Array<{ status: string; retry_count: number }>;
    return {
      count: rows.length,
      statuses: rows.map((r) => r.status),
      retryCounts: rows.map((r) => Number(r.retry_count ?? 0)),
    };
  } finally {
    db.close();
  }
}

type Ctx = {
  dataRoot: string;
  segment: string;
  queueDbPath: string;
  internals: Record<string, any>;
  session: { id: string };
  originalCwd: string;
  cleanup: () => Promise<void>;
};

async function bootCoordinator(opts: {
  name: string;
  withTeam?: boolean;
}): Promise<Ctx> {
  const fixtureRoot = fixture(opts.name);
  const dataRoot = path.join(fixtureRoot, "data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const originalCwd = process.cwd();
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = fixtureRoot;
  process.chdir(fixtureRoot);
  resetDatabaseRuntimeForServe();

  const session = centralSessionStore.create({
    serverUrl: "https://api.j11.com.cn",
    token: "r6m-token",
    expiresAt: Date.now() + 120_000,
    user: { id: 88001, username: "r6m-user", nickname: "" },
  });
  const internals = syncCoordinator as unknown as Record<string, any>;
  const identity = { issuer: session.serverUrl, userId: session.user.id };
  const segment = userStorageSegment(identity);
  const queueDbPath = path.join(userStorageRoot(dataRoot, identity), "sync-queue.sqlite");

  const personalCatalog = {
    projectUuid: personalUuid,
    name: "p",
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
    ...personalCatalog,
    projectUuid: teamUuid,
    name: "t",
    kind: "team",
    role: "editor",
    myRole: "editor",
  };
  const grant = {
    grantId: "a7a7a7a7-a7a7-4a7a-a7a7-a7a7a7a7a7a7",
    userId: session.user.id,
    deviceUuid: String(internals.deviceUuid ?? "018f3d6e-2d9e-7b6c-8a9b-r6mdevice0001"),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    revokedAt: null,
  };
  const catalog = new Map<string, unknown>([[personalUuid, personalCatalog]]);
  const localProjectIds = new Map([[personalUuid, 8801]]);
  if (opts.withTeam) {
    catalog.set(teamUuid, teamCatalog);
    localProjectIds.set(teamUuid, 8802);
  }

  Object.assign(internals, {
    dataRoot,
    session,
    remote: { refreshOfflineGrant: async () => grant },
    catalog,
    localProjectIds,
    offlineCache: {
      issuer: session.serverUrl,
      userId: session.user.id,
      grant,
      catalog: opts.withTeam ? [personalCatalog, teamCatalog] : [personalCatalog],
    },
    online: true,
    deviceActive: true,
    shutdownState: createShutdownPhaseState(),
    shutdownRequested: false,
    shutdownInFlight: undefined,
  });
  internals.projects.clear();

  return {
    dataRoot,
    segment,
    queueDbPath,
    internals,
    session,
    originalCwd,
    cleanup: async () => {
      for (const [, runtime] of [...internals.projects]) {
        try {
          runtime.local?.close?.();
        } catch {
          // ignore
        }
      }
      internals.projects.clear();
      internals.shutdownState = createShutdownPhaseState();
      internals.shutdownRequested = false;
      internals.shutdownInFlight = undefined;
      centralSessionStore.delete(session.id);
      await stopGenerationTaskRecovery();
      await destroyAllDatabaseHandles().catch(() => undefined);
      resetDatabaseRuntimeForServe();
      process.chdir(originalCwd);
    },
  };
}

function makePersonalRuntime(opts: {
  dataRoot: string;
  segment: string;
  failMode: "once" | "always" | "never";
  dirty: boolean;
}): {
  local: any;
  sync: PersonalProjectSync;
  counters: { closeCalls: number; localCloseCalls: number; publishCalls: number };
} {
  const counters = { closeCalls: 0, localCloseCalls: 0, publishCalls: 0 };
  let personalDirty = opts.dirty;
  let failNext = opts.failMode === "once" || opts.failMode === "always";
  const alwaysFail = opts.failMode === "always";

  seedJournal(path.join(projectDirectory(opts.dataRoot, personalUuid, opts.segment), "project.sqlite"), 5);
  recordPendingLegacyMutationIntent({
    dataRoot: opts.dataRoot,
    userSegment: opts.segment,
    projectUuid: personalUuid,
    kind: "personal",
    source: "scriptAgent",
  });

  const local: any = {
    get dirty() {
      return personalDirty;
    },
    set dirty(v: boolean) {
      personalDirty = v;
    },
    markLegacyEdited() {
      personalDirty = true;
    },
    hasLegacyResource: () => true,
    close: () => {
      counters.localCloseCalls += 1;
    },
    current: {
      version: 1,
      objects: [{ relativePath: "project.sqlite", md5: opts.dirty ? "dirty-v" : "base-v" }],
    },
    async install(remote?: PersonalManifest) {
      if (remote) this.current = structuredClone(remote);
    },
    async createSnapshot() {
      return {
        version: 1,
        objects: [{ relativePath: "project.sqlite", md5: opts.dirty ? "dirty-v" : "base-v" }],
        capturedMutationGeneration: 5,
      } as PersonalManifest;
    },
    async createRecovery() {},
  };

  const remote: PersonalRemote = {
    async latest() {
      return {
        version: 1,
        objects: [{ relativePath: "project.sqlite", md5: "base-v" }],
      };
    },
    async publish() {
      counters.publishCalls += 1;
      if (failNext) {
        if (!alwaysFail) failNext = false;
        const err = new Error("network personal publish failed");
        (err as { code?: string }).code = "NETWORK_OFFLINE";
        throw err;
      }
      return {
        version: 2,
        objects: [{ relativePath: "project.sqlite", md5: "dirty-v" }],
      };
    },
  };

  const sync = new PersonalProjectSync(local as PersonalLocal, remote, () => true, scheduleUnref);
  const realClose = sync.close.bind(sync);
  (sync as any).close = async () => {
    counters.closeCalls += 1;
    return realClose();
  };
  return { local, sync, counters };
}

// ---------- 1) 瞬态失败：不得二次 close ----------
test("1) Personal 第一次 close 失败后本轮 closeCalls=1、queue=1、禁止二次 publish", async () => {
  const ctx = await bootCoordinator({ name: "fail-once" });
  try {
    const { local, sync, counters } = makePersonalRuntime({
      dataRoot: ctx.dataRoot,
      segment: ctx.segment,
      failMode: "once",
      dirty: true,
    });
    sync.open();
    await sync.ensureLoaded();
    local.dirty = true;
    ctx.internals.projects.set(personalUuid, { kind: "personal", local, sync });

    await assert.rejects(
      () => ctx.internals.closeAllForOrdinaryShutdown(),
      /阻断|中央同步|取消|修复|PERSONAL_CLOSE/,
    );

    assert.equal(counters.closeCalls, 1, `closeCalls=${counters.closeCalls}`);
    assert.equal(counters.publishCalls, 1, "禁止同一 shutdown 二次中央 publish");
    assert.equal(ctx.internals.projects.has(personalUuid), true, "失败保留 runtime");
    const q = countUploads(ctx.queueDbPath, personalUuid);
    assert.equal(q.count, 0, "不得入队冒充中央成功");
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 2) 第一次 close 成功 ----------
test("2) Personal 第一次 close 成功：closeCalls=1、queue=0、runtime 删除", async () => {
  const ctx = await bootCoordinator({ name: "success" });
  try {
    const { local, sync, counters } = makePersonalRuntime({
      dataRoot: ctx.dataRoot,
      segment: ctx.segment,
      failMode: "never",
      dirty: true,
    });
    sync.open();
    await sync.ensureLoaded();
    local.dirty = true;
    ctx.internals.projects.set(personalUuid, { kind: "personal", local, sync });

    await ctx.internals.closeAllForOrdinaryShutdown();

    assert.equal(counters.closeCalls, 1);
    assert.equal(counters.localCloseCalls, 1);
    assert.equal(countUploads(ctx.queueDbPath, personalUuid).count, 0);
    assert.equal(ctx.internals.projects.has(personalUuid), false);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 3) 持续失败：retryCount 不在同一轮加两次 ----------
test("3) Personal 持续失败：closeCalls=1，queue 仅 1 条，retry 不双增", async () => {
  const ctx = await bootCoordinator({ name: "always-fail" });
  try {
    const { local, sync, counters } = makePersonalRuntime({
      dataRoot: ctx.dataRoot,
      segment: ctx.segment,
      failMode: "always",
      dirty: true,
    });
    sync.open();
    await sync.ensureLoaded();
    local.dirty = true;
    ctx.internals.projects.set(personalUuid, { kind: "personal", local, sync });

    await assert.rejects(
      () => ctx.internals.closeAllForOrdinaryShutdown(),
      /阻断|中央同步|取消|修复|PERSONAL_CLOSE/,
    );

    assert.equal(counters.closeCalls, 1);
    assert.equal(counters.publishCalls, 1);
    const q = countUploads(ctx.queueDbPath, personalUuid);
    assert.equal(q.count, 0, "Round9 不得入队冒充中央成功");
    assert.equal(ctx.internals.projects.has(personalUuid), true);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 4) finalize 失败：不重复 close，intent 保留 ----------
test("4) Personal finalize 失败：不重复 close，sidecar 保留可恢复", async () => {
  const ctx = await bootCoordinator({ name: "finalize-fail" });
  const original = ctx.internals.finalizeMutationClearedAfterCentralSuccess?.bind(syncCoordinator);
  try {
    ctx.internals.finalizeMutationClearedAfterCentralSuccess = () => {
      throw new Error("forced finalize failure");
    };
    const { local, sync, counters } = makePersonalRuntime({
      dataRoot: ctx.dataRoot,
      segment: ctx.segment,
      failMode: "never",
      dirty: true,
    });
    sync.open();
    await sync.ensureLoaded();
    local.dirty = true;
    ctx.internals.projects.set(personalUuid, { kind: "personal", local, sync });

    // finalize 失败 → close_blocked → 生产 shutdown 必须 reject，runtime 保留
    await assert.rejects(
      () => ctx.internals.closeAllForOrdinaryShutdown(),
      /finalize|阻断|修复|清理|PERSONAL_CLOSE|无法自动恢复/i,
    );

    assert.equal(counters.closeCalls, 1);
    assert.equal(
      ctx.internals.projects.has(personalUuid),
      true,
      "finalize 失败后 runtime 必须保留",
    );
    assert.equal(
      hasPendingLegacyMutationIntent(ctx.dataRoot, ctx.segment, personalUuid),
      true,
      "finalize 失败后 sidecar 必须保留",
    );
  } finally {
    if (original) ctx.internals.finalizeMutationClearedAfterCentralSuccess = original;
    await ctx.cleanup();
  }
});

// ---------- 5) 非 dirty Personal：其余路径 close 一次，不入队 ----------
test("5) 非 dirty Personal：其余关闭路径 close 一次，不入队", async () => {
  const ctx = await bootCoordinator({ name: "not-dirty" });
  try {
    const { local, sync, counters } = makePersonalRuntime({
      dataRoot: ctx.dataRoot,
      segment: ctx.segment,
      failMode: "never",
      dirty: false,
    });
    sync.open();
    await sync.ensureLoaded();
    local.dirty = false;
    // 清除 journal/intent 以免 isDirtyRuntime 为 true
    const journalPath = path.join(
      projectDirectory(ctx.dataRoot, personalUuid, ctx.segment),
      "project.sqlite",
    );
    if (fs.existsSync(journalPath)) {
      const db = new Database(journalPath);
      db.exec(`UPDATE o_legacyMutationJournal SET status='cleared'`);
      db.close();
    }
    ctx.internals.projects.set(personalUuid, { kind: "personal", local, sync });

    await ctx.internals.closeAllForOrdinaryShutdown();

    assert.equal(counters.closeCalls, 1, "非 dirty 走其余循环 close 一次");
    assert.equal(countUploads(ctx.queueDbPath, personalUuid).count, 0);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 6) Personal + Team ----------
test("6) Personal+Team：各 close 一次；Personal 入队 1；Team 入队 0", async () => {
  const ctx = await bootCoordinator({ name: "both", withTeam: true });
  try {
    const personal = makePersonalRuntime({
      dataRoot: ctx.dataRoot,
      segment: ctx.segment,
      failMode: "always",
      dirty: true,
    });
    personal.sync.open();
    await personal.sync.ensureLoaded();
    personal.local.dirty = true;
    ctx.internals.projects.set(personalUuid, {
      kind: "personal",
      local: personal.local,
      sync: personal.sync,
    });

    let teamCloseCalls = 0;
    seedJournal(
      path.join(projectDirectory(ctx.dataRoot, teamUuid, ctx.segment), "project.sqlite"),
      11,
    );
    recordPendingLegacyMutationIntent({
      dataRoot: ctx.dataRoot,
      userSegment: ctx.segment,
      projectUuid: teamUuid,
      kind: "team",
      source: "scriptAgent",
    });
    const teamLocal: any = {
      dirty: true,
      markLegacyEdited() {
        this.dirty = true;
      },
      hasLegacyResource: () => true,
      close: () => undefined,
      current: { version: 3, objects: [{ relativePath: "project.sqlite", md5: "t" }] },
      async install() {},
      async setReadonly() {},
      async createRecovery() {},
      async createSnapshot() {
        return {
          version: 3,
          objects: [{ relativePath: "project.sqlite", md5: "t" }],
          capturedMutationGeneration: 11,
        };
      },
    };
    const teamRemote: TeamRemote = {
      async acquire() {
        return { lockId: "L", fencingToken: 1 };
      },
      async download() {},
      async publish() {
        throw new Error("team publish network fail");
      },
      async release() {},
      async heartbeat() {},
    };
    const teamSync = new TeamProjectSync(
      "editor",
      teamLocal as TeamLocal,
      teamRemote,
      () => ({}),
      scheduleUnref,
      60_000,
    );
    teamSync.configureReleaseReceiptStore({
      dataRoot: ctx.dataRoot,
      userSegment: ctx.segment,
      projectUuid: teamUuid,
    });
    const realTeamClose = teamSync.close.bind(teamSync);
    (teamSync as any).close = async () => {
      teamCloseCalls += 1;
      return realTeamClose();
    };
    await teamSync.open();
    teamLocal.dirty = true;
    ctx.internals.projects.set(teamUuid, { kind: "team", local: teamLocal, sync: teamSync });

    await assert.rejects(
      () => ctx.internals.closeAllForOrdinaryShutdown(),
      /阻断|中央同步|取消|修复|PERSONAL_CLOSE/,
    );

    assert.equal(personal.counters.closeCalls, 1);
    // Team 可能在 Personal 失败前未关闭；关键是 Team 永不入队
    assert.equal(countUploads(ctx.queueDbPath, personalUuid).count, 0);
    assert.equal(countUploads(ctx.queueDbPath, teamUuid).count, 0);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 7) 下次启动 consumer 只消费 Personal 一次 ----------
test("7) 重启 consumer：仅 Personal UUID 一次，成功后 completed", async () => {
  const fixtureRoot = fixture("consumer");
  const dbPath = path.join(fixtureRoot, "sync-queue.sqlite");
  const queue = new SyncQueue(dbPath, () => Date.now());
  queue.ensureUploadQueued(personalUuid, Date.now() + 60_000);
  const uploaded: string[] = [];
  const result = await runPendingSyncConsumer({
    queue,
    isActive: () => true,
    maxTasksPerRun: 8,
    executor: {
      async uploadProject(uuid) {
        uploaded.push(uuid);
        assert.notEqual(uuid, teamUuid, "不得出现 Team UUID");
      },
    },
  });
  assert.deepEqual(uploaded, [personalUuid]);
  assert.equal(result.completed, 1);
  // 任务应 completed
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare(`SELECT status FROM sync_tasks WHERE project_uuid = ?`)
    .get(personalUuid) as { status: string };
  db.close();
  queue.close();
  assert.equal(row.status, "completed");
});

// ---------- 8) 一轮 shutdown 中任意项目 closeCalls 不得 > 1 ----------
test("8) 源码：ordinary shutdown 禁止对已 settle 的 Personal 二次 close", () => {
  const src = fs.readFileSync(
    path.join(worktreeRoot, "app/src/tianjiang/runtime/sync-coordinator.ts"),
    "utf8",
  );
  const start = src.indexOf("closeAllForOrdinaryShutdown");
  assert.ok(start > 0);
  const block = src.slice(start, start + 8000);
  assert.ok(
    /attemptedPersonal|settlePersonalProjectClose|settleProject/.test(block),
    "ordinary shutdown 必须经统一 settle，且跟踪已 attempt Personal",
  );
  assert.ok(
    /preparePendingSyncForShutdown 已消费|后续循环不得再次 close/.test(block),
    "须有中文注释说明后续循环不得再次 close 已消费 Personal",
  );
});
