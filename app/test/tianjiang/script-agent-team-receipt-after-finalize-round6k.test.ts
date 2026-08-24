/**
 * round6k RED：Team release receipt 必须是最后一个清除的持久化事实。
 * 中央 release 确认后先 finalize journal/sidecar，成功后才允许删 receipt。
 * 测试必须穿过 SyncCoordinator + TeamProjectSync + 文件 receipt/journal。
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
import type { PersonalManifest } from "../../src/tianjiang/sync/personal-project-sync";
import {
  readTeamReleaseReceiptStrict,
  writeTeamReleaseReceipt,
  type TeamReleaseReceipt,
} from "../../src/tianjiang/runtime/team-release-receipt";
import {
  hasPendingLegacyMutationIntent,
  recordPendingLegacyMutationIntent,
} from "../../src/tianjiang/runtime/pending-legacy-mutation-intent";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";
import { createShutdownPhaseState } from "../../src/tianjiang/runtime/sync-coordinator";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { centralSessionStore } from "../../src/tianjiang/auth/auth-runtime";
import {
  destroyAllDatabaseHandles,
  stopGenerationTaskRecovery,
  resetDatabaseRuntimeForServe,
  beginDatabaseShutdown,
} from "../../src/utils/db";

const worktreeRoot = path.resolve(__dirname, "../..", "..");

function scheduleUnref(run: () => void, delay: number) {
  const t = setTimeout(run, delay);
  t.unref?.();
  return t;
}

function fixture(name: string) {
  const root = path.join(worktreeRoot, ".tmp", "r6k", name, String(Date.now()));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

const segment = "c".repeat(32);
const teamUuid = "33333333-3333-4333-8333-333333333333";

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

function pendingCount(dbPath: string): number {
  if (!fs.existsSync(dbPath)) return -1;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM o_legacyMutationJournal WHERE status = 'pending'`)
      .get() as { c: number };
    return Number(row.c ?? 0);
  } finally {
    db.close();
  }
}

function fullReceipt(
  phase: TeamReleaseReceipt["phase"],
  overrides: Partial<TeamReleaseReceipt> = {},
): TeamReleaseReceipt {
  return {
    projectUuid: teamUuid,
    lockId: "LOCK-6K",
    fencingToken: 8,
    phase,
    publishedAt: new Date().toISOString(),
    baseVersion: 3,
    expectedVersion: 4,
    capturedMutationGeneration: 11,
    manifestFingerprint: "fp-6k",
    objects: [{ relativePath: "project.sqlite", md5: "m6k", size: 9 }],
    ...overrides,
  };
}

function makeLocal(events: string[]): TeamLocal {
  return {
    current: {
      version: 3,
      objects: [{ relativePath: "project.sqlite", md5: "m6k", size: 9 }],
    },
    async install() {
      events.push("install");
    },
    async setReadonly(r) {
      events.push(`readonly:${r}`);
    },
    async createRecovery(r) {
      events.push(`recovery:${r}`);
    },
    async createSnapshot() {
      events.push("snapshot");
      return {
        version: 3,
        objects: [{ relativePath: "project.sqlite", md5: "m6k", size: 9 }],
        capturedMutationGeneration: 11,
      } as PersonalManifest;
    },
  };
}

function makeRemote(events: string[], opts?: { releaseFails?: boolean }) {
  let publishCount = 0;
  let releaseCount = 0;
  let acquireCount = 0;
  const remote: TeamRemote = {
    async acquire() {
      acquireCount += 1;
      events.push("acquire");
      return { lockId: "LOCK-6K", fencingToken: 8 };
    },
    async download() {
      events.push("download");
    },
    async publish() {
      publishCount += 1;
      events.push("publish");
    },
    async release(lockId, fencingToken) {
      releaseCount += 1;
      events.push(`release:${lockId}:${fencingToken}`);
      if (opts?.releaseFails) throw new Error("release failed");
    },
    async heartbeat() {
      events.push("heartbeat");
    },
    async fetchProjectEvidence() {
      return {
        version: 4,
        objects: [{ relativePath: "project.sqlite", md5: "m6k", size: 9 }],
      };
    },
  };
  return {
    remote,
    counts: () => ({ publishCount, releaseCount, acquireCount }),
  };
}

// ---------- 1) release 成功后 Team 不得先删 receipt ----------
test("RED：release 成功后 receipt 必须仍为 released_cleanup_pending（Team 内禁止先删）", async () => {
  const dataRoot = fixture("team-no-early-clear");
  const events: string[] = [];
  writeTeamReleaseReceipt(dataRoot, segment, fullReceipt("published_release_pending"));
  const { remote } = makeRemote(events);
  const sync = new TeamProjectSync("editor", makeLocal(events), remote, () => ({}), scheduleUnref, 60_000);
  sync.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid: teamUuid });
  await sync.open();
  const close = await sync.close();
  // 修复后：返回等待 finalize 的状态；receipt 仍在且 phase=released_cleanup_pending
  assert.notEqual(
    readTeamReleaseReceiptStrict(dataRoot, segment, teamUuid).kind,
    "missing",
    "release 成功后、协调器 finalize 前禁止删除 receipt（过早删除是 P0 根因）",
  );
  const r = readTeamReleaseReceiptStrict(dataRoot, segment, teamUuid);
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") {
    assert.equal(r.receipt.phase, "released_cleanup_pending");
    assert.equal(r.receipt.capturedMutationGeneration, 11);
    assert.equal(r.receipt.lockId, "LOCK-6K");
    assert.equal(r.receipt.fencingToken, 8);
  }
  assert.ok(
    close.state === "released_cleanup_pending" || close.state === "published",
    "必须返回可被协调器消费的结果",
  );
  // 若错误返回 published 且已删 receipt，上面 kind!==missing 已失败
  assert.ok(events.some((e) => e.startsWith("release:")));
  assert.ok(!events.includes("publish"), "published_release_pending 不得 re-publish");
});

// ---------- 2) finalize 抛错：receipt 保留、close 失败 ----------
test("RED：coordinator finalize 抛错时 receipt 必须保留且 close 失败", async () => {
  const fixtureRoot = fixture("finalize-throws");
  const dataRoot = path.join(fixtureRoot, "data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const events: string[] = [];
  const originalCwd = process.cwd();
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = fixtureRoot;
  process.chdir(fixtureRoot);
  resetDatabaseRuntimeForServe();

  const session = centralSessionStore.create({
    serverUrl: "https://api.j11.com.cn",
    token: "r6k-token",
    expiresAt: Date.now() + 60_000,
    user: { id: 76001, username: "r6k-user", nickname: "" },
  });
  const internals = syncCoordinator as unknown as Record<string, any>;
  const userSegment = userStorageSegment({
    issuer: session.serverUrl,
    userId: session.user.id,
  });
  // 对齐测试 segment 与真实账号 segment：使用真实 segment 写 receipt/journal
  const realSegment = userSegment;
  const journalPath = path.join(
    projectDirectory(dataRoot, teamUuid, realSegment),
    "project.sqlite",
  );
  seedJournal(journalPath, 11);
  writeTeamReleaseReceipt(dataRoot, realSegment, fullReceipt("published_release_pending"));
  recordPendingLegacyMutationIntent({
    dataRoot,
    userSegment: realSegment,
    projectUuid: teamUuid,
    kind: "team",
    source: "scriptAgent",
  });

  const teamCatalog = {
    projectUuid: teamUuid,
    name: "t",
    kind: "team",
    ownerUserId: session.user.id,
    role: "editor",
    myRole: "editor",
    currentVersion: 3,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: new Date().toISOString(),
    lockStatus: "none",
    lockHolderName: "",
    openMode: "editable",
    businessType: "script",
  };
  const grant = {
    grantId: "d4d4d4d4-d4d4-4d4d-d4d4-d4d4d4d4d4d4",
    userId: session.user.id,
    deviceUuid: String(internals.deviceUuid),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revokedAt: null,
  };
  Object.assign(internals, {
    dataRoot,
    session,
    remote: { refreshOfflineGrant: async () => grant },
    catalog: new Map([[teamUuid, teamCatalog]]),
    localProjectIds: new Map([[teamUuid, 7601]]),
    offlineCache: {
      issuer: session.serverUrl,
      userId: session.user.id,
      grant,
      catalog: [teamCatalog],
    },
    online: true,
    deviceActive: true,
    shutdownState: createShutdownPhaseState(),
    shutdownRequested: false,
  });
  internals.projects.clear();

  const { remote } = makeRemote(events);
  const teamLocal: any = {
    dirty: true,
    markLegacyEdited() {
      this.dirty = true;
    },
    hasLegacyResource: () => true,
    close: () => undefined,
    async install() {},
    async setReadonly() {},
    async createRecovery() {},
    async createSnapshot() {
      return {
        version: 3,
        objects: [{ relativePath: "project.sqlite", md5: "m6k", size: 9 }],
        capturedMutationGeneration: 11,
      };
    },
  };
  const sync = new TeamProjectSync("editor", teamLocal, remote, () => ({}), scheduleUnref, 60_000);
  sync.configureReleaseReceiptStore({
    dataRoot,
    userSegment: realSegment,
    projectUuid: teamUuid,
  });
  await sync.open();
  internals.projects.set(teamUuid, { kind: "team", local: teamLocal, sync });

  const originalFinalize = internals.finalizeMutationClearedAfterCentralSuccess.bind(syncCoordinator);
  let finalizeCalled = false;
  internals.finalizeMutationClearedAfterCentralSuccess = (...args: unknown[]) => {
    finalizeCalled = true;
    // 证明：进入 finalize 时 receipt 必须仍存在（过早删除则此处已 missing）
    const before = readTeamReleaseReceiptStrict(dataRoot, realSegment, teamUuid);
    assert.equal(
      before.kind,
      "ok",
      "finalize 开始时 receipt 必须仍在——当前生产在 Team.close 内过早删除",
    );
    throw new Error("forced finalize failure");
  };

  try {
    await assert.rejects(
      () => syncCoordinator.closeProject(session, teamUuid),
      /清理|finalize|mutation|重试/i,
    );
    assert.equal(finalizeCalled, true, "必须进入 finalize");
    const after = readTeamReleaseReceiptStrict(dataRoot, realSegment, teamUuid);
    assert.equal(after.kind, "ok", "finalize 失败后 receipt 必须保留");
    assert.equal(pendingCount(journalPath), 1, "finalize 失败后 journal pending 必须保留");
    assert.equal(
      hasPendingLegacyMutationIntent(dataRoot, realSegment, teamUuid),
      true,
      "sidecar intent 必须保留",
    );
  } finally {
    internals.finalizeMutationClearedAfterCentralSuccess = originalFinalize;
    centralSessionStore.delete(session.id);
    beginDatabaseShutdown();
    await syncCoordinator.shutdown().catch(() => undefined);
    await stopGenerationTaskRecovery();
    await destroyAllDatabaseHandles().catch(() => undefined);
    internals.projects.clear();
    process.chdir(originalCwd);
  }
});

// ---------- 3) released_cleanup_pending 重启：0 acquire/publish/release ----------
test("RED：released_cleanup_pending 重启不得 acquire/publish/release，保留 capture", async () => {
  const dataRoot = fixture("cleanup-restart");
  const events: string[] = [];
  writeTeamReleaseReceipt(dataRoot, segment, fullReceipt("released_cleanup_pending"));
  const { remote, counts } = makeRemote(events);
  const sync = new TeamProjectSync("editor", makeLocal(events), remote, () => ({}), scheduleUnref, 60_000);
  sync.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid: teamUuid });
  await sync.open();
  assert.equal(sync.state().editable, false);
  assert.equal((sync.state() as any).cleanupOnly, true);
  const close = await sync.close();
  assert.equal(counts().acquireCount, 0);
  assert.equal(counts().publishCount, 0);
  assert.equal(counts().releaseCount, 0);
  // Team 内不得删 receipt；协调器 finalize 后才删
  const r = readTeamReleaseReceiptStrict(dataRoot, segment, teamUuid);
  assert.equal(r.kind, "ok", "Team.close 不得删除 released_cleanup_pending receipt");
  if (r.kind === "ok") {
    assert.equal(r.receipt.phase, "released_cleanup_pending");
    assert.equal(r.receipt.capturedMutationGeneration, 11);
  }
  assert.equal(close.capturedMutationGeneration, 11);
  assert.equal(close.centralEvidenceConfirmed, true);
});

// ---------- 4) published_release_pending：release 后转 cleanup，Team 内不删 ----------
test("RED：published_release_pending 只幂等 release，之后 phase=released_cleanup_pending 且不删文件", async () => {
  const dataRoot = fixture("pub-rel-pending");
  const events: string[] = [];
  writeTeamReleaseReceipt(dataRoot, segment, fullReceipt("published_release_pending"));
  const { remote, counts } = makeRemote(events);
  const sync = new TeamProjectSync("editor", makeLocal(events), remote, () => ({}), scheduleUnref, 60_000);
  sync.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid: teamUuid });
  await sync.open();
  await sync.close();
  assert.equal(counts().publishCount, 0);
  assert.equal(counts().releaseCount, 1);
  const r = readTeamReleaseReceiptStrict(dataRoot, segment, teamUuid);
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") {
    assert.equal(r.receipt.phase, "released_cleanup_pending");
  }
});

// ---------- 5) capture unknown：禁止清 journal/receipt ----------
test("RED：capture unknown 时 journal、sidecar、receipt 全部保留", async () => {
  const dataRoot = fixture("unknown-capture");
  const events: string[] = [];
  // 构造 released_cleanup_pending 但 capture=unknown
  writeTeamReleaseReceipt(
    dataRoot,
    segment,
    fullReceipt("released_cleanup_pending", { capturedMutationGeneration: "unknown" as any }),
  );
  const { remote } = makeRemote(events);
  const sync = new TeamProjectSync("editor", makeLocal(events), remote, () => ({}), scheduleUnref, 60_000);
  sync.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid: teamUuid });
  await sync.open();
  const close = await sync.close();
  // fail-closed：不得 published 成功清场
  assert.notEqual(close.state, "published");
  assert.equal(readTeamReleaseReceiptStrict(dataRoot, segment, teamUuid).kind, "ok");
});

// ---------- 6) 协调器完整路径：finalize 时 receipt 必须在 ----------
test("RED：SyncCoordinator closeProject 进入 finalize 时 receipt 不得已 missing", async () => {
  const fixtureRoot = fixture("coord-receipt-during-finalize");
  const dataRoot = path.join(fixtureRoot, "data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const events: string[] = [];
  const originalCwd = process.cwd();
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = fixtureRoot;
  process.chdir(fixtureRoot);
  resetDatabaseRuntimeForServe();

  const session = centralSessionStore.create({
    serverUrl: "https://api.j11.com.cn",
    token: "r6k-token2",
    expiresAt: Date.now() + 60_000,
    user: { id: 76002, username: "r6k-user2", nickname: "" },
  });
  const internals = syncCoordinator as unknown as Record<string, any>;
  const realSegment = userStorageSegment({
    issuer: session.serverUrl,
    userId: session.user.id,
  });
  const journalPath = path.join(
    projectDirectory(dataRoot, teamUuid, realSegment),
    "project.sqlite",
  );
  seedJournal(journalPath, 11);
  writeTeamReleaseReceipt(dataRoot, realSegment, fullReceipt("published_release_pending"));
  recordPendingLegacyMutationIntent({
    dataRoot,
    userSegment: realSegment,
    projectUuid: teamUuid,
    kind: "team",
    source: "scriptAgent",
  });

  const teamCatalog = {
    projectUuid: teamUuid,
    name: "t",
    kind: "team",
    ownerUserId: session.user.id,
    role: "editor",
    myRole: "editor",
    currentVersion: 3,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: new Date().toISOString(),
    lockStatus: "none",
    lockHolderName: "",
    openMode: "editable",
    businessType: "script",
  };
  const grant = {
    grantId: "e5e5e5e5-e5e5-4e5e-e5e5-e5e5e5e5e5e5",
    userId: session.user.id,
    deviceUuid: String(internals.deviceUuid),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revokedAt: null,
  };
  Object.assign(internals, {
    dataRoot,
    session,
    remote: { refreshOfflineGrant: async () => grant },
    catalog: new Map([[teamUuid, teamCatalog]]),
    localProjectIds: new Map([[teamUuid, 7602]]),
    offlineCache: {
      issuer: session.serverUrl,
      userId: session.user.id,
      grant,
      catalog: [teamCatalog],
    },
    online: true,
    deviceActive: true,
    shutdownState: createShutdownPhaseState(),
    shutdownRequested: false,
  });
  internals.projects.clear();

  const { remote } = makeRemote(events);
  const teamLocal: any = {
    dirty: true,
    markLegacyEdited() {
      this.dirty = true;
    },
    hasLegacyResource: () => true,
    close: () => undefined,
    async install() {},
    async setReadonly() {},
    async createRecovery() {},
    async createSnapshot() {
      return {
        version: 3,
        objects: [{ relativePath: "project.sqlite", md5: "m6k", size: 9 }],
        capturedMutationGeneration: 11,
      };
    },
  };
  const sync = new TeamProjectSync("editor", teamLocal, remote, () => ({}), scheduleUnref, 60_000);
  sync.configureReleaseReceiptStore({
    dataRoot,
    userSegment: realSegment,
    projectUuid: teamUuid,
  });
  await sync.open();
  internals.projects.set(teamUuid, { kind: "team", local: teamLocal, sync });

  let sawReceiptDuringFinalize = false;
  const originalFinalize = internals.finalizeMutationClearedAfterCentralSuccess.bind(syncCoordinator);
  internals.finalizeMutationClearedAfterCentralSuccess = (...args: unknown[]) => {
    const mid = readTeamReleaseReceiptStrict(dataRoot, realSegment, teamUuid);
    sawReceiptDuringFinalize = mid.kind === "ok";
    assert.equal(
      mid.kind,
      "ok",
      "P0：finalize 时 receipt 已被 Team 过早删除，崩溃将丢失 capture/中央证据",
    );
    return originalFinalize(...args);
  };

  try {
    const result = await syncCoordinator.closeProject(session, teamUuid);
    assert.equal(sawReceiptDuringFinalize, true);
    assert.equal((result as { state?: string }).state, "published");
    // 完整成功后才允许 missing
    assert.equal(readTeamReleaseReceiptStrict(dataRoot, realSegment, teamUuid).kind, "missing");
    assert.equal(pendingCount(journalPath), 0);
  } finally {
    internals.finalizeMutationClearedAfterCentralSuccess = originalFinalize;
    centralSessionStore.delete(session.id);
    beginDatabaseShutdown();
    await syncCoordinator.shutdown().catch(() => undefined);
    await stopGenerationTaskRecovery();
    await destroyAllDatabaseHandles().catch(() => undefined);
    internals.projects.clear();
    process.chdir(originalCwd);
  }
});

// ---------- 7) viewer 不消费 editor receipt ----------
test("RED：viewer 始终只读且不消费 release receipt", async () => {
  const dataRoot = fixture("viewer");
  const events: string[] = [];
  writeTeamReleaseReceipt(dataRoot, segment, fullReceipt("published_release_pending"));
  const { remote, counts } = makeRemote(events);
  const sync = new TeamProjectSync("viewer", makeLocal(events), remote, () => ({}), scheduleUnref, 60_000);
  sync.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid: teamUuid });
  await sync.open();
  const close = await sync.close();
  assert.equal(close.state, "skipped_viewer");
  assert.equal(counts().releaseCount, 0);
  assert.equal(counts().publishCount, 0);
  assert.equal(readTeamReleaseReceiptStrict(dataRoot, segment, teamUuid).kind, "ok");
});

// ---------- 8) 生产必须暴露 coordinator 确认接口（RED 合同）----------
test("RED：TeamProjectSync 必须暴露 confirmReleasedCleanupStrict 供协调器在 finalize 后调用", () => {
  const sync = new TeamProjectSync(
    "editor",
    makeLocal([]),
    makeRemote([]).remote,
    () => ({}),
  );
  assert.equal(
    typeof (sync as any).confirmReleasedCleanupStrict,
    "function",
    "协调器 finalize 成功后须调用明确的严格确认接口删除 receipt",
  );
});
