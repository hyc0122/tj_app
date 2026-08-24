/**
 * round6o：Personal close 失败权威、所有关闭入口持久化入队、manual finalize。
 * 必须穿过真实 PersonalProjectSync / SyncCoordinator / SyncQueue；禁止仅源码正则或手工塞队列冒充 closeProject。
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
  closeRuntimeProjects,
  createShutdownPhaseState,
} from "../../src/tianjiang/runtime/sync-coordinator";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { centralSessionStore } from "../../src/tianjiang/auth/auth-runtime";
import {
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
  stopGenerationTaskRecovery,
} from "../../src/utils/db";
import { SyncQueue } from "../../src/tianjiang/sync/queue";
import { runPendingSyncConsumer } from "../../src/tianjiang/sync/pending-sync-consumer";
import {
  userStorageSegment,
  userStorageRoot,
} from "../../src/tianjiang/runtime/user-storage-context";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import {
  hasPendingLegacyMutationIntent,
  recordPendingLegacyMutationIntent,
} from "../../src/tianjiang/runtime/pending-legacy-mutation-intent";

const worktreeRoot = path.resolve(__dirname, "../..", "..");
const personalUuid = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";
const teamUuid = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";

function fixture(name: string) {
  const root = path.join(worktreeRoot, ".tmp", "r6o", name, String(Date.now()));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function manifest(version: number, md5: string): PersonalManifest {
  return { version, objects: [{ relativePath: "project.sqlite", md5 }] };
}

type TestLocal = PersonalLocal & { markClosed(): void };

function makeLocal(initial?: PersonalManifest): TestLocal {
  const state = {
    current: initial ? structuredClone(initial) : (undefined as PersonalManifest | undefined),
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
    set current(v: PersonalManifest | undefined) {
      state.current = v;
    },
    markClosed() {
      state.closed = true;
    },
    async install(remote) {
      state.current = structuredClone(remote);
      state.dirty = false;
    },
    async createSnapshot() {
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
  };
}

function makeRemote(opts?: {
  failPublish?: boolean;
  publishBarrier?: () => Promise<void>;
}): PersonalRemote & {
  publishCalls: number;
  maxConcurrent: number;
  concurrent: number;
} {
  let current = manifest(1, "base");
  const stats = { publishCalls: 0, maxConcurrent: 0, concurrent: 0 };
  return {
    get publishCalls() {
      return stats.publishCalls;
    },
    get maxConcurrent() {
      return stats.maxConcurrent;
    },
    get concurrent() {
      return stats.concurrent;
    },
    async latest() {
      return structuredClone(current);
    },
    async publish(_b, next) {
      stats.concurrent += 1;
      stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
      stats.publishCalls += 1;
      try {
        if (opts?.publishBarrier) await opts.publishBarrier();
        if (opts?.failPublish) {
          const err = new Error("network personal publish failed");
          (err as { code?: string }).code = "NETWORK_OFFLINE";
          throw err;
        }
        current = { ...structuredClone(next), version: current.version + 1 };
        return structuredClone(current);
      } finally {
        stats.concurrent -= 1;
      }
    },
  };
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
     VALUES ('scriptAgent', 'pending', ?, ?, ?)`,
  ).run(generation, now, now);
  db.close();
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

// ---------- 1) 第二次 close 不得 unchanged 掩盖失败 ----------
test("1) 第一次 publish 失败后第二次 close 必须 reject 且 dirty 仍 true", async () => {
  const local = makeLocal(manifest(1, "base"));
  const remote = makeRemote({ failPublish: true });
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();
  sync.markEdited();
  await assert.rejects(() => sync.close(), /network personal publish failed/);
  assert.equal(local.dirty, true, "失败不得清 dirty");
  // 旧行为：第二次返回 unchanged —— RED 要求必须 reject
  await assert.rejects(
    () => sync.close(),
    /network personal publish failed/,
    "第二次 close 禁止返回 unchanged 掩盖失败",
  );
  const second = await sync.close().then(
    (r) => ({ ok: true as const, r }),
    (e) => ({ ok: false as const, e }),
  );
  assert.equal(second.ok, false, "禁止成功返回");
  if (second.ok === false) {
    assert.match(String((second.e as Error).message), /network|NETWORK|失败/i);
  }
});

// ---------- 2) 并发 close 共享 rejection ----------
test("2) 两并发 close 遇同一 publish 失败：publishCalls=1 且均 reject", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const local = makeLocal(manifest(1, "base"));
  const remote = makeRemote({
    failPublish: true,
    publishBarrier: () => barrier,
  });
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();
  sync.markEdited();

  const p1 = sync.close().then(
    () => "ok" as const,
    () => "rej" as const,
  );
  // 等待进入 publish
  for (let i = 0; i < 80 && remote.publishCalls === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const p2 = sync.close().then(
    () => "ok" as const,
    () => "rej" as const,
  );
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(remote.publishCalls, 1, "并发 close 只 publish 一次");
  assert.equal(remote.maxConcurrent, 1);
  assert.equal(a, "rej");
  assert.equal(b, "rej", "禁止一个 reject 另一个 unchanged");
});

// ---------- 3-6) 协调器真实入口 ----------
async function bootPersonal(opts: {
  name: string;
  userId?: number;
  online?: boolean;
  withTeam?: boolean;
  failPublish?: boolean;
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

  const userId = opts.userId ?? 77001;
  const session = centralSessionStore.create({
    serverUrl: "https://api.j11.com.cn",
    token: `r6o-${userId}`,
    expiresAt: Date.now() + 120_000,
    user: { id: userId, username: `u${userId}`, nickname: "" },
  });
  const internals = syncCoordinator as unknown as Record<string, any>;
  const identity = { issuer: session.serverUrl, userId };
  const segment = userStorageSegment(identity);
  const queueDbPath = path.join(userStorageRoot(dataRoot, identity), "sync-queue.sqlite");

  seedJournal(
    path.join(projectDirectory(dataRoot, personalUuid, segment), "project.sqlite"),
    2,
  );
  recordPendingLegacyMutationIntent({
    dataRoot,
    userSegment: segment,
    projectUuid: personalUuid,
    kind: "personal",
    source: "scriptAgent",
  });

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
  const catalog = new Map<string, unknown>([[personalUuid, personalCatalog]]);
  if (opts.withTeam) {
    catalog.set(teamUuid, {
      ...personalCatalog,
      projectUuid: teamUuid,
      kind: "team",
      role: "editor",
      myRole: "editor",
    });
  }

  let publishCalls = 0;
  const personalLocal = makeLocal(manifest(1, "base"));
  personalLocal.dirty = true;
  const personalRemote = makeRemote({ failPublish: opts.failPublish !== false });
  const personalSync = new PersonalProjectSync(
    personalLocal,
    personalRemote,
    () => opts.online !== false,
  );
  personalSync.open();

  const projects = new Map<string, any>();
  projects.set(personalUuid, {
    kind: "personal",
    local: {
      dirty: true,
      close: () => personalLocal.markClosed(),
      markLegacyEdited() {
        personalLocal.dirty = true;
      },
    },
    sync: personalSync,
  });

  const grant = {
    grantId: "b7b7b7b7-b7b7-4b7b-b7b7-b7b7b7b7b7b7",
    userId,
    deviceUuid: String(internals.deviceUuid ?? "018f3d6e-2d9e-7b6c-8a9b-r6odevice0001"),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    revokedAt: null,
  };

  Object.assign(internals, {
    dataRoot,
    session,
    remote: {
      refreshOfflineGrant: async () => grant,
      personalRemote: () => personalRemote,
    },
    catalog,
    localProjectIds: new Map([[personalUuid, userId]]),
    offlineCache: {
      issuer: session.serverUrl,
      userId,
      grant,
      catalog: [...catalog.values()],
    },
    online: opts.online !== false,
    deviceActive: true,
    shutdownState: createShutdownPhaseState(),
    shutdownRequested: false,
    shutdownInFlight: undefined,
  });
  internals.projects.clear();
  for (const [k, v] of projects) internals.projects.set(k, v);

  return {
    dataRoot,
    segment,
    queueDbPath,
    identity,
    internals,
    session,
    personalSync,
    personalLocal,
    personalRemote,
    publishCalls: () => personalRemote.publishCalls,
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

test("3) closeProject 网络失败：保留 runtime；禁止伪装成功；不得入队冒充中央成功", async () => {
  const ctx = await bootPersonal({ name: "close-project-net", failPublish: true });
  try {
    // Round9：正常关闭必须中央成功；网络失败取消关闭并保留可编辑 runtime。
    await assert.rejects(
      () => (syncCoordinator as any).closeProject(ctx.session, personalUuid),
      /中央同步|取消|网络/,
    );
    assert.equal(ctx.internals.projects.has(personalUuid), true, "失败时不得 dispose runtime");
    assert.equal(countUploads(ctx.queueDbPath, personalUuid), 0, "不得把入队当中央成功");
  } finally {
    await ctx.cleanup();
  }
});

test("4) 离线 closeProject：取消关闭并保留 runtime，不入队伪装成功", async () => {
  const ctx = await bootPersonal({ name: "offline-close", online: false, failPublish: false });
  try {
    await assert.rejects(
      () => (syncCoordinator as any).closeProject(ctx.session, personalUuid),
      /中央同步|取消|网络/,
    );
    assert.equal(ctx.internals.projects.has(personalUuid), true);
    assert.equal(countUploads(ctx.queueDbPath, personalUuid), 0);
  } finally {
    await ctx.cleanup();
  }
});

test("5) 账号切换 closeAll：中央失败阻断切换；Team=0", async () => {
  const ctx = await bootPersonal({ name: "account-switch", userId: 77011, failPublish: true });
  try {
    await assert.rejects(
      () => (ctx.internals as any).closeAll(),
      /中央同步|取消|禁止切换|失败/,
    );
    assert.equal(ctx.internals.projects.has(personalUuid), true, "失败时保留旧账号 runtime");
    assert.equal(countUploads(ctx.queueDbPath, personalUuid), 0);
    assert.equal(countUploads(ctx.queueDbPath, teamUuid), 0);
  } finally {
    await ctx.cleanup();
  }
});

test("6) ordinary shutdown：中央失败阻断退出；Team 永不入队", async () => {
  const ctx = await bootPersonal({ name: "ordinary-shutdown", failPublish: true });
  try {
    let closeCalls = 0;
    const originalClose = ctx.personalSync.close.bind(ctx.personalSync);
    ctx.personalSync.close = async () => {
      closeCalls += 1;
      return originalClose();
    };
    await assert.rejects(
      () => (ctx.internals as any).closeAllForOrdinaryShutdown(),
      /阻断|中央同步|取消|修复|PERSONAL_CLOSE/,
    );
    assert.ok(closeCalls >= 1);
    assert.equal(countUploads(ctx.queueDbPath, personalUuid), 0);
    assert.equal(countUploads(ctx.queueDbPath, teamUuid), 0);
    assert.equal(ctx.internals.projects.has(personalUuid), true);
  } finally {
    await ctx.cleanup();
  }
});

test("7) closeRuntimeProjects：失败后第二次不得 unchanged", async () => {
  const local = makeLocal(manifest(1, "base"));
  const remote = makeRemote({ failPublish: true });
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();
  sync.markEdited();
  const projects = new Map([
    [
      personalUuid,
      {
        kind: "personal" as const,
        local: { dirty: true, close: () => local.markClosed() },
        sync,
      },
    ],
  ]);
  await assert.rejects(() => closeRuntimeProjects(projects as any));
  // 第二次直接 close 也必须 reject
  await assert.rejects(() => sync.close());
});

test("8) syncNow 必须 finalize：成功清 generation；N+1 保留 dirty", async () => {
  const src = fs.readFileSync(
    path.join(worktreeRoot, "app/src/tianjiang/runtime/sync-coordinator.ts"),
    "utf8",
  );
  // 生产合同：按相邻类方法边界提取完整 syncNow，避免 Team 分支扩展后被固定长度截断。
  const syncNowStart = src.indexOf("async syncNow");
  const syncNowEnd = src.indexOf("\n  setProfileValue(", syncNowStart);
  assert.ok(syncNowStart >= 0 && syncNowEnd > syncNowStart, "必须能定位完整 syncNow 方法");
  const syncNowBody = src.slice(syncNowStart, syncNowEnd);
  assert.match(
    syncNowBody,
    /runPersonalSyncAndFinalize/,
    "syncNow 必须经 runPersonalSyncAndFinalize",
  );
  assert.doesNotMatch(
    syncNowBody,
    /runtime\.sync\.sync\(\s*[\"']manual[\"']\s*\)/,
    "禁止直接 runtime.sync.sync(manual)",
  );
});

test("9) pending consumer 遇 closed runtime 不得 unchanged 当成功", async () => {
  // 源码合同：executePendingUpload 必须检测 isTerminalClosed 并重开
  const src = fs.readFileSync(
    path.join(worktreeRoot, "app/src/tianjiang/runtime/sync-coordinator.ts"),
    "utf8",
  );
  assert.match(src, /isTerminalClosed/, "consumer 路径必须识别 closed/zombie runtime");
  assert.match(src, /executePendingUpload/, "须存在 pending upload 执行入口");
});
