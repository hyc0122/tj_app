/**
 * round6l RED：普通 shutdown 禁止把 Team 写入 Personal 专用 sync_tasks 上传队列。
 * 必须穿过真实 SyncCoordinator.closeAllForOrdinaryShutdown + SyncQueue + TeamProjectSync。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  TeamProjectSync,
  type TeamLocal,
  type TeamRemote,
} from "../../src/tianjiang/sync/team-project-sync";
import {
  PersonalProjectSync,
  type PersonalLocal,
  type PersonalManifest,
  type PersonalRemote,
} from "../../src/tianjiang/sync/personal-project-sync";
import {
  readTeamReleaseReceiptStrict,
  writeTeamReleaseReceipt,
} from "../../src/tianjiang/runtime/team-release-receipt";
import {
  hasPendingLegacyMutationIntent,
  recordPendingLegacyMutationIntent,
} from "../../src/tianjiang/runtime/pending-legacy-mutation-intent";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import {
  userStorageSegment,
  userStorageRoot,
} from "../../src/tianjiang/runtime/user-storage-context";
import {
  createShutdownPhaseState,
  openUserSyncQueue,
} from "../../src/tianjiang/runtime/sync-coordinator";
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

const personalUuid = "a1a1a1a1-a1a1-4a1a-81a1-a1a1a1a1a1a1";
const teamUuid = "b2b2b2b2-b2b2-4b2b-82b2-b2b2b2b2b2b2";
const teamSecondUuid = "b3b3b3b3-b3b3-4b3b-83b3-b3b3b3b3b3b3";

function fixture(name: string) {
  const root = path.join(worktreeRoot, ".tmp", "r6l", name, String(Date.now()));
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

function countUploadTasks(queueDbPath: string, projectUuid: string): number {
  if (!fs.existsSync(queueDbPath)) return 0;
  const db = new Database(queueDbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(1) AS c FROM sync_tasks
         WHERE project_uuid = ? AND task_type = 'upload'`,
      )
      .get(projectUuid) as { c: number };
    return Number(row?.c ?? 0);
  } finally {
    db.close();
  }
}

function listUploadProjectUuids(queueDbPath: string): string[] {
  if (!fs.existsSync(queueDbPath)) return [];
  const db = new Database(queueDbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT project_uuid FROM sync_tasks WHERE task_type = 'upload' ORDER BY created_at`,
      )
      .all() as Array<{ project_uuid: string }>;
    return rows.map((r) => r.project_uuid);
  } finally {
    db.close();
  }
}

type SetupOpts = {
  name: string;
  teamPublishFails?: boolean;
  teamReleaseFails?: boolean;
  teamFinalizeFails?: boolean;
  teamReceiptClearFails?: boolean;
  teamLocalCloseFails?: boolean;
  teamRecoveryRequired?: boolean;
  personalPublishFails?: boolean;
  withPersonal?: boolean;
  teamPhase?: "none" | "publishing" | "published_release_pending" | "released_cleanup_pending";
};

async function setupCoordinator(opts: SetupOpts) {
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
    token: "r6l-token",
    expiresAt: Date.now() + 120_000,
    user: { id: 77011, username: "r6l-user", nickname: "" },
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
    grantId: "f6f6f6f6-f6f6-4f6f-f6f6-f6f6f6f6f6f6",
    userId: session.user.id,
    deviceUuid: String(internals.deviceUuid ?? "018f3d6e-2d9e-7b6c-8a9b-r6ldevice0001"),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    revokedAt: null,
  };

  const catalog = new Map<string, unknown>([[teamUuid, teamCatalog]]);
  const localProjectIds = new Map([[teamUuid, 7702]]);
  if (opts.withPersonal) {
    catalog.set(personalUuid, personalCatalog);
    localProjectIds.set(personalUuid, 7701);
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
      catalog: opts.withPersonal ? [personalCatalog, teamCatalog] : [teamCatalog],
    },
    online: true,
    deviceActive: true,
    shutdownState: createShutdownPhaseState(),
    shutdownRequested: false,
    shutdownInFlight: undefined,
  });
  internals.projects.clear();
  // 中文注释：syncCoordinator 是进程级单例；补偿事实属于单个测试场景，禁止泄漏到下一夹具。
  internals.pendingPersonalCloseCompensations.clear();
  internals.pendingTeamCloseCompensations.clear();

  // Team journal + optional receipt
  const teamJournal = path.join(projectDirectory(dataRoot, teamUuid, segment), "project.sqlite");
  seedJournal(teamJournal, 11);
  recordPendingLegacyMutationIntent({
    dataRoot,
    userSegment: segment,
    projectUuid: teamUuid,
    kind: "team",
    source: "scriptAgent",
  });

  const teamEvents: string[] = [];
  const teamLocal: any = {
    dirty: true,
    markLegacyEdited() {
      this.dirty = true;
    },
    hasLegacyResource: () => true,
    close: () => {
      teamEvents.push("team:local-close");
      if (opts.teamLocalCloseFails) {
        throw new Error("forced team local close failure");
      }
    },
    current: {
      version: 3,
      objects: [{ relativePath: "project.sqlite", md5: "t", size: 1 }],
    },
    async install() {},
    async setReadonly() {},
    async createRecovery() {},
    async createSnapshot() {
      return {
        version: 3,
        objects: [{ relativePath: "project.sqlite", md5: "t", size: 1 }],
        capturedMutationGeneration: 11,
      };
    },
  };

  const teamRemote: TeamRemote = {
    async acquire() {
      teamEvents.push("acquire");
      return { lockId: "LOCK-T", fencingToken: 5 };
    },
    async download() {
      teamEvents.push("download");
    },
    async publish() {
      teamEvents.push("publish");
      if (opts.teamPublishFails) throw new Error("network publish failed");
    },
    async release() {
      teamEvents.push("release");
      if (opts.teamReleaseFails) throw new Error("network release failed");
    },
    async heartbeat() {
      teamEvents.push("heartbeat");
    },
    async fetchProjectEvidence() {
      return {
        version: 4,
        objects: [{ relativePath: "project.sqlite", md5: "t", size: 1 }],
      };
    },
  };

  const teamSync = new TeamProjectSync(
    "editor",
    teamLocal as TeamLocal,
    teamRemote,
    () => ({}),
    (run) => {
      const t = setTimeout(run, 60_000);
      t.unref?.();
      return t;
    },
    60_000,
  );
  teamSync.configureReleaseReceiptStore({
    dataRoot,
    userSegment: segment,
    projectUuid: teamUuid,
  });
  if (opts.teamReceiptClearFails) {
    teamSync.setReceiptClearHook(() => {
      throw new Error("EPERM delete receipt");
    });
  }

  const phase = opts.teamPhase ?? "none";
  if (phase !== "none") {
    writeTeamReleaseReceipt(dataRoot, segment, {
      projectUuid: teamUuid,
      lockId: "LOCK-T",
      fencingToken: 5,
      phase,
      publishedAt: new Date().toISOString(),
      baseVersion: 3,
      expectedVersion: 4,
      capturedMutationGeneration: 11,
      manifestFingerprint: "fp-r6l",
      objects: [{ relativePath: "project.sqlite", md5: "t", size: 1 }],
    });
    await teamSync.open(); // restore receipt path
  } else {
    await teamSync.open(); // acquire lock, editable
  }
  teamLocal.dirty = true;
  if (opts.teamRecoveryRequired) {
    teamSync.close = async () => ({ state: "recovery_required" });
  }
  internals.projects.set(teamUuid, { kind: "team", local: teamLocal, sync: teamSync });

  // optional personal dirty
  const personalEvents: string[] = [];
  if (opts.withPersonal) {
    recordPendingLegacyMutationIntent({
      dataRoot,
      userSegment: segment,
      projectUuid: personalUuid,
      kind: "personal",
      source: "scriptAgent",
    });
    const personalJournal = path.join(
      projectDirectory(dataRoot, personalUuid, segment),
      "project.sqlite",
    );
    seedJournal(personalJournal, 3);

    let personalDirty = true;
    const personalLocal: any = {
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
      close: () => undefined,
      // 本地有未上传变更（md5 与远端不同）以强制走 publish
      current: {
        version: 1,
        objects: [{ relativePath: "project.sqlite", md5: "p-dirty" }],
      },
      async install(remote?: PersonalManifest) {
        if (remote) this.current = structuredClone(remote);
      },
      async createSnapshot() {
        return {
          version: 1,
          objects: [{ relativePath: "project.sqlite", md5: "p-dirty" }],
          capturedMutationGeneration: 3,
        } as PersonalManifest;
      },
      async createRecovery() {},
    };
    const personalRemote: PersonalRemote = {
      async latest() {
        return {
          version: 1,
          objects: [{ relativePath: "project.sqlite", md5: "p-base" }],
        };
      },
      async publish() {
        personalEvents.push("publish");
        if (opts.personalPublishFails) {
          const err = new Error("network personal publish failed");
          (err as { code?: string }).code = "NETWORK_OFFLINE";
          throw err;
        }
        return {
          version: 2,
          objects: [{ relativePath: "project.sqlite", md5: "p-dirty" }],
        };
      },
    };
    const personalSync = new PersonalProjectSync(
      personalLocal as PersonalLocal,
      personalRemote,
      () => true,
      (run, delay) => {
        const t = setTimeout(run, delay);
        t.unref?.();
        return t;
      },
    );
    personalSync.open();
    await personalSync.ensureLoaded();
    personalDirty = true;
    internals.projects.set(personalUuid, {
      kind: "personal",
      local: personalLocal,
      sync: personalSync,
    });
  }

  // optional finalize throw
  const originalFinalize = internals.finalizeMutationClearedAfterCentralSuccess?.bind(syncCoordinator);
  if (opts.teamFinalizeFails && originalFinalize) {
    internals.finalizeMutationClearedAfterCentralSuccess = (...args: unknown[]) => {
      throw new Error("forced finalize failure");
    };
  }

  return {
    dataRoot,
    segment,
    session,
    internals,
    identity,
    queueDbPath,
    teamEvents,
    personalEvents,
    teamJournal,
    originalFinalize,
    originalCwd,
    async shutdownClose() {
      // 直接生产路径
      await internals.closeAllForOrdinaryShutdown();
    },
    async strictCloseAll() {
      await internals.closeAll({ requireCentralSuccess: true });
    },
    cleanup: async () => {
      if (originalFinalize) {
        internals.finalizeMutationClearedAfterCentralSuccess = originalFinalize;
      }
      // 中文注释：避免完整 shutdown 二次遍历与未 unref 定时器拖住进程（~120s 退出）
      for (const [, runtime] of [...internals.projects]) {
        try {
          runtime.local?.close?.();
        } catch {
          // ignore
        }
      }
      internals.projects.clear();
      internals.pendingPersonalCloseCompensations.clear();
      internals.pendingTeamCloseCompensations.clear();
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

// ---------- 1) Team publish 失败：不得入 Personal queue ----------
test("RED：Team dirty + publish 失败 → sync_tasks 中 Team 数量必须为 0", async () => {
  const ctx = await setupCoordinator({
    name: "team-publish-fail",
    teamPublishFails: true,
    teamPhase: "none",
  });
  try {
    await assert.rejects(() => ctx.shutdownClose());
    const teamTasks = countUploadTasks(ctx.queueDbPath, teamUuid);
    // 当前生产错误地把 Team 写入 Personal upload 队列 → teamTasks >= 1
    assert.equal(
      teamTasks,
      0,
      `Team 禁止进入 Personal upload 队列，实际 teamTasks=${teamTasks} uuids=${listUploadProjectUuids(ctx.queueDbPath).join(",")}`,
    );
    assert.equal(
      hasPendingLegacyMutationIntent(ctx.dataRoot, ctx.segment, teamUuid),
      true,
      "Team sidecar 必须保留",
    );
    // journal 仍有 pending
    const db = new Database(ctx.teamJournal, { readonly: true });
    const pending = (
      db.prepare(`SELECT COUNT(1) AS c FROM o_legacyMutationJournal WHERE status='pending'`).get() as {
        c: number;
      }
    ).c;
    db.close();
    assert.ok(pending >= 1, "Team journal pending 必须保留");
    assert.equal(ctx.internals.projects.has(teamUuid), true, "Team 发布失败必须保留运行时");
    assert.equal(ctx.teamEvents.includes("team:local-close"), false, "失败时禁止关闭本地项目");
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 2) Team release 失败：receipt 保留，queue=0 ----------
test("RED：Team release 失败 → published_release_pending 保留且 queue 无 Team", async () => {
  const ctx = await setupCoordinator({
    name: "team-release-fail",
    teamReleaseFails: true,
    teamPhase: "published_release_pending",
  });
  try {
    await assert.rejects(() => ctx.shutdownClose());
    assert.equal(countUploadTasks(ctx.queueDbPath, teamUuid), 0);
    const r = readTeamReleaseReceiptStrict(ctx.dataRoot, ctx.segment, teamUuid);
    assert.equal(r.kind, "ok", "release 失败必须保留 receipt");
    if (r.kind === "ok") {
      assert.ok(
        r.receipt.phase === "published_release_pending" || r.receipt.phase === "publishing",
        `phase=${r.kind === "ok" ? r.receipt.phase : "?"}`,
      );
    }
    assert.equal(ctx.internals.projects.has(teamUuid), true, "Team release 失败必须保留运行时");
    assert.equal(ctx.teamEvents.includes("team:local-close"), false, "失败时禁止关闭本地项目");
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 3) finalize 失败：receipt/journal 保留，queue=0 ----------
test("RED：released_cleanup_pending + finalize 失败 → queue 无 Team", async () => {
  const ctx = await setupCoordinator({
    name: "team-finalize-fail",
    teamFinalizeFails: true,
    teamPhase: "released_cleanup_pending",
  });
  try {
    await assert.rejects(() => ctx.shutdownClose());
    assert.equal(countUploadTasks(ctx.queueDbPath, teamUuid), 0);
    assert.equal(readTeamReleaseReceiptStrict(ctx.dataRoot, ctx.segment, teamUuid).kind, "ok");
    assert.equal(ctx.internals.projects.has(teamUuid), true, "Team finalize 失败必须保留运行时");
    assert.equal(ctx.teamEvents.includes("team:local-close"), false, "失败时禁止关闭本地项目");
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 4) receipt 删除失败：queue 无 Team ----------
test("RED：Team receipt 删除失败 → queue 无 Team，receipt 保留", async () => {
  const ctx = await setupCoordinator({
    name: "team-receipt-clear-fail",
    teamReceiptClearFails: true,
    teamPhase: "released_cleanup_pending",
  });
  try {
    await assert.rejects(() => ctx.shutdownClose());
    assert.equal(countUploadTasks(ctx.queueDbPath, teamUuid), 0);
    assert.equal(readTeamReleaseReceiptStrict(ctx.dataRoot, ctx.segment, teamUuid).kind, "ok");
    assert.equal(ctx.internals.projects.has(teamUuid), true, "Team receipt 清理失败必须保留运行时");
    assert.equal(ctx.teamEvents.includes("team:local-close"), false, "失败时禁止关闭本地项目");
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 5) Personal dirty + 网络失败：Round9 取消退出，不入队 ----------
test("RED：Personal dirty + 网络失败 → 取消退出且不入队", async () => {
  const ctx = await setupCoordinator({
    name: "personal-enqueue",
    withPersonal: true,
    personalPublishFails: true,
    teamPublishFails: false,
    teamPhase: "released_cleanup_pending",
  });
  try {
    ctx.internals.projects.delete(teamUuid);
    await assert.rejects(
      () => ctx.shutdownClose(),
      /阻断|中央同步|取消|修复|PERSONAL_CLOSE/,
    );
    assert.equal(countUploadTasks(ctx.queueDbPath, personalUuid), 0);
    assert.equal(countUploadTasks(ctx.queueDbPath, teamUuid), 0);
    assert.equal(ctx.internals.projects.has(personalUuid), true);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 6) Personal + Team 同时 dirty ----------
test("RED：Personal 与 Team 同时 dirty → 取消退出；Team 永不入队", async () => {
  const ctx = await setupCoordinator({
    name: "both-dirty",
    withPersonal: true,
    personalPublishFails: true,
    teamPublishFails: true,
    teamPhase: "none",
  });
  try {
    await assert.rejects(
      () => ctx.shutdownClose(),
      /阻断|中央同步|取消|修复|PERSONAL_CLOSE/,
    );
    assert.equal(countUploadTasks(ctx.queueDbPath, personalUuid), 0);
    assert.equal(countUploadTasks(ctx.queueDbPath, teamUuid), 0);
  } finally {
    await ctx.cleanup();
  }
});

test("RED：账号切换 Team recovery_required → 必须阻断且保留运行时", async () => {
  const ctx = await setupCoordinator({
    name: "team-strict-recovery",
    teamRecoveryRequired: true,
  });
  try {
    await assert.rejects(() => ctx.strictCloseAll());
    assert.equal(ctx.internals.projects.has(teamUuid), true);
    assert.equal(ctx.teamEvents.includes("team:local-close"), false);
  } finally {
    await ctx.cleanup();
  }
});

test("RED：账号切换 Team local.close 失败 → 必须阻断且保留 map 条目", async () => {
  const ctx = await setupCoordinator({
    name: "team-strict-local-close",
    teamLocalCloseFails: true,
  });
  try {
    await assert.rejects(() => ctx.strictCloseAll());
    assert.equal(ctx.internals.projects.has(teamUuid), true);
  } finally {
    await ctx.cleanup();
  }
});

test("RED：Personal 已同步后 Team 发布失败 → 仍须取消退出并登记 Personal 补偿", async () => {
  const ctx = await setupCoordinator({
    name: "personal-success-team-fail",
    withPersonal: true,
    personalPublishFails: false,
    teamPublishFails: true,
    teamPhase: "none",
  });
  try {
    await assert.rejects(() => ctx.shutdownClose());
    // 中文注释：本队列隔离 fixture 未配置生产 openProject；这里只验证补偿事实被登记。
    // 真实生产 reopen 由 personal-close-compensation-round6t 覆盖。
    assert.equal(ctx.internals.pendingPersonalCloseCompensations.has(personalUuid), true);
    assert.equal(
      ctx.internals.projects.has(teamUuid),
      true,
      "Team 中央失败必须保留运行时",
    );
    assert.equal(countUploadTasks(ctx.queueDbPath, personalUuid), 0);
    assert.equal(countUploadTasks(ctx.queueDbPath, teamUuid), 0);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 7) shutdown 后 Team queue 保持 0 ----------
test("RED：中央失败取消退出时 Team queue 仍为 0", async () => {
  const ctx = await setupCoordinator({
    name: "consumer-after-shutdown",
    withPersonal: true,
    personalPublishFails: true,
    teamPublishFails: true,
    teamPhase: "none",
  });
  try {
    await assert.rejects(
      () => ctx.shutdownClose(),
      /阻断|中央同步|取消|修复|PERSONAL_CLOSE/,
    );
    assert.equal(
      countUploadTasks(ctx.queueDbPath, teamUuid),
      0,
      `Team 不得在 queue 中，uuids=${listUploadProjectUuids(ctx.queueDbPath).join(",")}`,
    );
  } finally {
    await ctx.cleanup();
  }
});

test("Round10c RED：普通退出中 Team A 已完成中央关闭、Team B 失败时必须重新打开 A", async () => {
  const ctx = await setupCoordinator({ name: "team-central-compensation" });
  const originalPrepare = ctx.internals.prepareTeamCloseForCentralSuccess.bind(syncCoordinator);
  const originalOpenProject = ctx.internals.openProject.bind(syncCoordinator);
  const reopened: string[] = [];
  const originalA = ctx.internals.projects.get(teamUuid);
  try {
    const teamB = {
      kind: "team",
      local: { dirty: true, close() {} },
      sync: { async close() { return { state: "recovery_required" }; } },
    };
    ctx.internals.projects.set(teamSecondUuid, teamB);
    ctx.internals.catalog.set(teamSecondUuid, {
      ...ctx.internals.catalog.get(teamUuid),
      projectUuid: teamSecondUuid,
      name: "team-b",
    });
    ctx.internals.prepareTeamCloseForCentralSuccess = async (projectUuid: string) => {
      if (projectUuid === teamSecondUuid) throw new Error("Team B publish failed");
    };
    ctx.internals.openProject = async (_session: unknown, projectUuid: string) => {
      reopened.push(projectUuid);
      const replacement = {
        kind: "team",
        local: { dirty: false, close() {} },
        sync: { async close() { return { state: "skipped_not_editable" }; } },
      };
      ctx.internals.projects.set(projectUuid, replacement);
      return { projectUuid };
    };

    await assert.rejects(() => ctx.shutdownClose(), /Team|团队|同步|关闭/i);
    assert.deepEqual(reopened, [teamUuid], "已完成中央关闭的 Team A 必须走 openProject 补偿");
    assert.notEqual(ctx.internals.projects.get(teamUuid), originalA, "A 不得保留已 closed 的旧 runtime");
    assert.equal(ctx.internals.projects.has(teamSecondUuid), true, "失败的 Team B 必须保留");
  } finally {
    ctx.internals.prepareTeamCloseForCentralSuccess = originalPrepare;
    ctx.internals.openProject = originalOpenProject;
    await ctx.cleanup();
  }
});

test("Round10c RED：账号切换中 Team 本地关闭半途失败时必须补偿全部已完成中央关闭的 Team", async () => {
  const ctx = await setupCoordinator({ name: "team-local-compensation" });
  const originalPrepare = ctx.internals.prepareTeamCloseForCentralSuccess.bind(syncCoordinator);
  const originalOpenProject = ctx.internals.openProject.bind(syncCoordinator);
  const reopened: string[] = [];
  let secondCloseAttempts = 0;
  try {
    const teamA = ctx.internals.projects.get(teamUuid);
    teamA.local.close = () => undefined;
    const teamB = {
      kind: "team",
      local: {
        dirty: false,
        close() {
          secondCloseAttempts += 1;
          if (secondCloseAttempts === 1) throw new Error("Team B local close failed once");
        },
      },
      sync: { async close() { return { state: "skipped_not_editable" }; } },
    };
    ctx.internals.projects.set(teamSecondUuid, teamB);
    ctx.internals.catalog.set(teamSecondUuid, {
      ...ctx.internals.catalog.get(teamUuid),
      projectUuid: teamSecondUuid,
      name: "team-b",
    });
    ctx.internals.prepareTeamCloseForCentralSuccess = async () => undefined;
    ctx.internals.openProject = async (_session: unknown, projectUuid: string) => {
      reopened.push(projectUuid);
      ctx.internals.projects.set(projectUuid, {
        kind: "team",
        local: { dirty: false, close() {} },
        sync: { async close() { return { state: "skipped_not_editable" }; } },
      });
      return { projectUuid };
    };

    await assert.rejects(() => ctx.strictCloseAll(), /Team|团队|同步|关闭/i);
    assert.deepEqual(
      [...reopened].sort(),
      [teamUuid, teamSecondUuid].sort(),
      "中央阶段已完成的 Team A/B 都必须替换为重新打开的新 runtime",
    );
    assert.ok(secondCloseAttempts >= 2, "补偿前必须重试关闭 B 的旧本地句柄");
    assert.equal(ctx.internals.projects.has(teamUuid), true);
    assert.equal(ctx.internals.projects.has(teamSecondUuid), true);
  } finally {
    ctx.internals.prepareTeamCloseForCentralSuccess = originalPrepare;
    ctx.internals.openProject = originalOpenProject;
    await ctx.cleanup();
  }
});

// ---------- 8) 合同：dirty UUID 传给 preparePendingSync 前必须 personal 过滤 ----------
test("RED：preparePendingSyncForShutdown 的 dirty 列表必须来自 personal 过滤变量", async () => {
  const src = fs.readFileSync(
    path.join(worktreeRoot, "app/src/tianjiang/runtime/sync-coordinator.ts"),
    "utf8",
  );
  // 中文注释：必须锚定真实方法声明；前方调用点会随着协调器扩展导致固定长度扫描误截断。
  const closeStart = src.indexOf("private async closeAllForOrdinaryShutdown");
  assert.ok(closeStart > 0);
  const closeEnd = src.indexOf("\n  private buildPersonalCloseDeps", closeStart);
  assert.ok(closeEnd > closeStart, "必须找到 closeAllForOrdinaryShutdown 的方法边界");
  const closeBlock = src.slice(closeStart, closeEnd);
  // GREEN 后应显式 personalDirty* 再传入 preparePendingSyncForShutdown
  assert.ok(
    /personalDirtyProjectUuids|personalDirty/.test(closeBlock),
    "必须使用 personalDirtyProjectUuids（或等价命名）过滤后再 preparePendingSyncForShutdown",
  );
  assert.ok(
    /preparePendingSyncForShutdown\([\s\S]*?dirtyProjectUUIDs:\s*personalDirty/m.test(closeBlock)
      || /dirtyProjectUUIDs:\s*personalDirtyProjectUuids/.test(closeBlock),
    "preparePendingSyncForShutdown 的 dirtyProjectUUIDs 必须是 personal 过滤结果",
  );
});
