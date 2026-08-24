/**
 * round6h 生产链 RED：Team release_only、中央版本权威、Personal 全入口 finalize、
 * snapshot 物理剥离 fail-closed。禁止仅用 Fake 证明关键路径。
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
  PersonalProjectSync,
  type PersonalLocal,
  type PersonalRemote,
} from "../../src/tianjiang/sync/personal-project-sync";
import { RuntimeProjectLocal } from "../../src/tianjiang/runtime/project-runtime-local";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import {
  readTeamReleaseReceipt,
  writeTeamReleaseReceipt,
} from "../../src/tianjiang/runtime/team-release-receipt";
import { CentralRuntimeAdapter } from "../../src/tianjiang/runtime/central-runtime-adapter";
import { createShutdownPhaseState } from "../../src/tianjiang/runtime/sync-coordinator";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { centralSessionStore } from "../../src/tianjiang/auth/auth-runtime";
import { userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";
import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  stopGenerationTaskRecovery,
  resetDatabaseRuntimeForServe,
  beginDatabaseShutdown,
} from "../../src/utils/db";
import {
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import type { CommitVersionRequest } from "../../src/tianjiang/contracts";

const worktreeRoot = path.resolve(__dirname, "../..", "..");

// ---------- 合同审计：中央幂等键 ----------
test("RED 合同：CommitVersionRequest 无 operationId/clientToken 字段时必须文档化 getProject 回读策略", () => {
  // 编译期/运行期字段探测：生产不得假装有不存在的幂等键
  const sample: CommitVersionRequest = {
    deviceUuid: "d",
    manifest: {
      schema_version: 1,
      project_uuid: "00000000-0000-4000-8000-000000000001",
      version: 2,
      base_version: 1,
      created_at: new Date().toISOString(),
      database: { relative_path: "project.sqlite", size: 1, md5: "0".repeat(32) },
      files: [],
    } as any,
  };
  assert.equal(
    "operationId" in sample || "clientToken" in sample || "idempotencyKey" in sample,
    false,
    "当前合同无 operationId；GREEN 必须用 getProject 版本回读而非伪造幂等键",
  );
});

// ---------- P0-A：receipt → release_only，不可写 ----------
test("RED P0-A：receipt 恢复为 release_only 只读，禁止 setWritable/业务写/再 publish", async () => {
  const dataRoot = path.join(worktreeRoot, ".tmp", "r6h-relonly", String(Date.now()));
  const segment = "e".repeat(32);
  const projectUuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  fs.mkdirSync(dataRoot, { recursive: true });
  writeTeamReleaseReceipt(dataRoot, segment, {
    projectUuid,
    lockId: "lock-ro",
    fencingToken: 3,
    capturedMutationGeneration: 1,
    publishedAt: new Date().toISOString(),
    phase: "published_release_pending",
  });

  const events: string[] = [];
  const local: TeamLocal = {
    current: { version: 1, objects: [{ relativePath: "project.sqlite", md5: "x" }] },
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
      return { version: 1, objects: [{ relativePath: "project.sqlite", md5: "x" }] };
    },
  };
  const remote: TeamRemote = {
    async acquire() {
      events.push("acquire");
      return { lockId: "new", fencingToken: 9 };
    },
    async download() {
      events.push("download");
    },
    async publish() {
      events.push("publish");
    },
    async release() {
      events.push("release");
    },
    async heartbeat() {
      events.push("heartbeat");
    },
  };
  const sync = new TeamProjectSync("editor", local, remote, () => ({}));
  sync.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid });
  await sync.open();
  const st = sync.state();
  assert.equal((st as any).releaseOnly === true || st.editable === false, true, "必须 release_only 或不可编辑");
  assert.equal(st.editable, false, "release_only 不得 editable");
  assert.throws(() => sync.writeGuard(), /锁|只读|release/i);
  const close = await sync.close();
  // release 成功后等待协调器 finalize：Team 层为 released_cleanup_pending
  assert.equal(close.state, "released_cleanup_pending");
  assert.ok(!events.includes("publish"), "release_only 禁止 publish");
  assert.ok(events.includes("release"));
});

test("RED P0-A：viewer 不得因 receipt 获得写权限", async () => {
  const dataRoot = path.join(worktreeRoot, ".tmp", "r6h-viewer", String(Date.now()));
  const segment = "f".repeat(32);
  const projectUuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  writeTeamReleaseReceipt(dataRoot, segment, {
    projectUuid,
    lockId: "L",
    fencingToken: 1,
    publishedAt: new Date().toISOString(),
    phase: "published_release_pending",
  });
  const local: TeamLocal = {
    async install() {},
    async setReadonly() {},
    async createRecovery() {},
    async createSnapshot() {
      return { version: 1, objects: [] };
    },
  };
  const remote: TeamRemote = {
    async acquire() {
      return { lockId: "x", fencingToken: 1 };
    },
    async download() {},
    async publish() {
      throw new Error("viewer 不得 publish");
    },
    async release() {},
    async heartbeat() {},
  };
  const sync = new TeamProjectSync("viewer", local, remote, () => ({}));
  sync.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid });
  await sync.open();
  assert.equal(sync.state().editable, false);
  const r = await sync.close();
  assert.equal(r.state, "skipped_viewer");
});

test("RED P0-A：SyncCoordinator open 有 receipt 时不得 setWritable", async () => {
  const fixtureRoot = path.join(worktreeRoot, ".tmp", "r6h-coord-ro", String(Date.now()));
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const originalCwd = process.cwd();
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = fixtureRoot;
  process.chdir(fixtureRoot);
  resetDatabaseRuntimeForServe();
  const dataRoot = path.join(fixtureRoot, "data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const projectUuid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const session = centralSessionStore.create({
    serverUrl: "https://api.j11.com.cn",
    token: "r6h",
    expiresAt: Date.now() + 60_000,
    user: { id: 88001, username: "r6h", nickname: "" },
  });
  const segment = userStorageSegment({ issuer: session.serverUrl, userId: session.user.id });
  writeTeamReleaseReceipt(dataRoot, segment, {
    projectUuid,
    lockId: "coord-lock",
    fencingToken: 2,
    capturedMutationGeneration: 0,
    publishedAt: new Date().toISOString(),
    phase: "published_release_pending",
  });
  // 本地 manifest
  const root = projectDirectory(dataRoot, projectUuid, segment);
  fs.mkdirSync(path.join(root, "files"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".tianjiang-manifest.json"),
    JSON.stringify({ version: 1, objects: [{ relativePath: "project.sqlite", md5: "a" }] }),
  );
  const internals = syncCoordinator as unknown as Record<string, any>;
  internals.dataRoot = dataRoot;
  let setWritableCalls = 0;
  const origOpen = RuntimeProjectLocal.prototype.setWritable;
  RuntimeProjectLocal.prototype.setWritable = function (this: RuntimeProjectLocal) {
    setWritableCalls += 1;
    return origOpen.call(this);
  };
  const catalogItem = {
    projectUuid,
    name: "t",
    kind: "team",
    ownerUserId: session.user.id,
    role: "editor",
    myRole: "editor",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: new Date().toISOString(),
    lockStatus: "held",
    lockHolderName: "me",
    openMode: "editable",
    businessType: "script",
  };
  const grant = {
    grantId: "11111111-1111-4111-8111-111111111111",
    userId: session.user.id,
    deviceUuid: String(internals.deviceUuid),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revokedAt: null,
  };
  Object.assign(internals, {
    session,
    remote: {
      refreshOfflineGrant: async () => grant,
      teamRemote: () => ({
        async acquire() {
          return { lockId: "x", fencingToken: 1 };
        },
        async download() {},
        async publish() {
          throw new Error("不得 publish");
        },
        async release() {},
        async heartbeat() {},
        async latestVersion() {
          return 1;
        },
      }),
    },
    catalog: new Map([[projectUuid, catalogItem]]),
    localProjectIds: new Map([[projectUuid, 9001]]),
    offlineCache: { issuer: session.serverUrl, userId: session.user.id, grant, catalog: [catalogItem] },
    online: true,
    deviceActive: true,
    shutdownState: createShutdownPhaseState(),
    shutdownRequested: false,
  });
  internals.projects.clear();
  try {
    process.env.NODE_ENV = "prod";
    const identity = { issuer: session.serverUrl, userId: session.user.id };
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      await syncCoordinator.openProject(session, projectUuid);
      const runtime = internals.projects.get(projectUuid);
      assert.ok(runtime);
      assert.equal(runtime.sync.state().editable, false, "receipt 打开必须不可编辑");
      assert.equal(
        (runtime.sync.state() as { releaseOnly?: boolean }).releaseOnly,
        true,
      );
      assert.equal(setWritableCalls, 0, "协调器不得 setWritable");
    });
  } finally {
    RuntimeProjectLocal.prototype.setWritable = origOpen;
    centralSessionStore.delete(session.id);
    beginDatabaseShutdown();
    await syncCoordinator.shutdown().catch(() => undefined);
    await stopGenerationTaskRecovery();
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
  }
});

// ---------- P0-B：receipt fail-closed / 原子写 ----------
test("RED P0-B：receipt 损坏/非法字段 fail-closed；仅 ENOENT 为不存在", async () => {
  const {
    readTeamReleaseReceiptStrict,
  } = await import("../../src/tianjiang/runtime/team-release-receipt");
  assert.equal(typeof readTeamReleaseReceiptStrict, "function");
  const dataRoot = path.join(worktreeRoot, ".tmp", "r6h-receipt", String(Date.now()));
  const segment = "a".repeat(32);
  const projectUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  // missing
  const missing = readTeamReleaseReceiptStrict(dataRoot, segment, projectUuid);
  assert.equal(missing.kind, "missing");
  // corrupt
  const dir = path.join(dataRoot, "runtime-users", segment, "team-release-receipts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${projectUuid}.json`), "{not-json", "utf8");
  assert.throws(
    () => readTeamReleaseReceiptStrict(dataRoot, segment, projectUuid),
    /损坏|非法|fail/i,
  );
});

test("RED P0-B：writeTeamReleaseReceipt 必须 fsync 原子替换", async () => {
  const mod = await import("../../src/tianjiang/runtime/team-release-receipt");
  const src = fs.readFileSync(
    path.join(worktreeRoot, "app/src/tianjiang/runtime/team-release-receipt.ts"),
    "utf8",
  );
  assert.match(src, /fsync|fdatasync/, "receipt 写入必须 fsync");
  assert.match(src, /renameSync|rename/, "必须原子替换");
  void mod;
});

// ---------- P0-C：CentralRuntimeAdapter latestVersion 走 getProject 非缓存 ----------
test("RED P0-C：CentralRuntimeAdapter.latestVersion 必须请求 getProject 非缓存", async () => {
  const hits: Array<{ pathname: string; method: string }> = [];
  const gateway = {
    forwardBusinessRequest: async (
      _session: unknown,
      pathname: string,
      method: string,
    ) => {
      hits.push({ pathname, method });
      return {
        version: 7,
        currentVersion: 7,
        objects: [],
        records: {},
      };
    },
  } as unknown as import("../../src/tianjiang/auth/central-session").CentralAuthGateway;
  const session = {
    id: "s1",
    serverUrl: "https://api.example.invalid",
    token: "t",
    expiresAt: Date.now() + 60_000,
    validatedAt: Date.now(),
    user: { id: 1, username: "u", nickname: "" },
  } as import("../../src/tianjiang/auth/central-session").CentralSession;
  const adapter = new CentralRuntimeAdapter(gateway, session, "device-1");
  const team = adapter.teamRemote(
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    () => undefined,
    {
      currentVersion: 1, // 缓存为 1
      readObject: async () => Buffer.from(""),
    },
  );
  assert.equal(typeof team.latestVersion, "function");
  const v = await team.latestVersion!();
  assert.equal(v, 7, "必须返回中央 getProject 版本 7 而非缓存 1");
  assert.ok(
    hits.some((h) => /project/i.test(h.pathname) && h.method === "GET"),
    `必须发起中央 GET 项目请求，实际 hits=${JSON.stringify(hits)}`,
  );
});

// ---------- P1-D：Personal 定时器不得直调 sync 绕过 finalize ----------
test("RED P1-D：Personal idle/checkpoint 必须经协调器包装 finalize", async () => {
  const src = fs.readFileSync(
    path.join(worktreeRoot, "app/src/tianjiang/sync/personal-project-sync.ts"),
    "utf8",
  );
  // 定时器不得直接 this.sync(
  assert.equal(
    /scheduleFollowUpSync[\s\S]*void this\.sync\(/.test(src),
    false,
    "scheduleFollowUpSync 不得直接 this.sync",
  );
  assert.match(src, /runScheduled|syncExecutor/, "必须经 executor/runScheduled");
  const coordSrc = fs.readFileSync(
    path.join(worktreeRoot, "app/src/tianjiang/runtime/sync-coordinator.ts"),
    "utf8",
  );
  assert.match(
    coordSrc,
    /runPersonalSyncAndFinalize/,
    "协调器必须提供 Personal 同步包装入口",
  );
});

// ---------- P1-E：snapshot 剥离失败不得继续上传 ----------
test("RED P1-E：strip VACUUM/替换失败必须抛错中止，禁止 catch 后继续", async () => {
  const src = fs.readFileSync(
    path.join(worktreeRoot, "app/src/tianjiang/runtime/legacy-mutation-journal.ts"),
    "utf8",
  );
  // 禁止静默退回原快照继续上传
  assert.doesNotMatch(src, /VACUUM INTO 失败时退回原文件/);
  const { stripMutationJournalFromSnapshotFile } = await import(
    "../../src/tianjiang/runtime/legacy-mutation-journal"
  );
  // 损坏路径必须抛错
  const bad = path.join(worktreeRoot, ".tmp", "r6h-strip-bad", String(Date.now()), "x.sqlite");
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, "not-a-db");
  await assert.rejects(async () => {
    await stripMutationJournalFromSnapshotFile(bad);
  });
});

test("RED P1-E：真实 RuntimeProjectLocal 快照 strip 后 integrity 与 sentinel 清除", async () => {
  const runId = `strip-${Date.now()}`;
  const dataRoot = path.join(worktreeRoot, ".tmp", "r6h-strip", runId, "data");
  const segment = "b".repeat(32);
  const projectUuid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const projectRoot = projectDirectory(dataRoot, projectUuid, segment);
  fs.mkdirSync(path.join(projectRoot, "files"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, ".tianjiang-manifest.json"),
    JSON.stringify({ version: 1, objects: [{ relativePath: "project.sqlite", md5: "m" }] }),
  );
  const local = new RuntimeProjectLocal(dataRoot, projectUuid, segment);
  await local.install(false);
  local.setWritable();
  const live = path.join(projectRoot, "project.sqlite");
  const SENTINEL = `SENTINEL_JOURNAL_${Date.now()}_XYZ`;
  {
    const db = new Database(live);
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
    db.prepare(
      `INSERT INTO o_legacyMutationJournal (source, status, generation, createdAt, updatedAt)
       VALUES (?, 'pending', 1, ?, ?)`,
    ).run(SENTINEL, Date.now(), Date.now());
    db.close();
  }
  local.close();
  const local2 = new RuntimeProjectLocal(dataRoot, projectUuid, segment);
  await local2.install(false);
  local2.setWritable();
  const snap = await local2.createSnapshot();
  assert.equal(snap.capturedMutationGeneration, 1);
  const snapPath = path.join(
    dataRoot,
    "runtime-users",
    segment,
    "sync",
    "snapshots",
    projectUuid,
    "project.sqlite",
  );
  const bytes = fs.readFileSync(snapPath);
  assert.equal(bytes.includes(Buffer.from(SENTINEL)), false, "快照二进制不得残留 sentinel");
  const db = new Database(snapPath, { readonly: true });
  try {
    const integ = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    assert.equal(integ[0]?.integrity_check, "ok");
    const cnt = db.prepare("SELECT COUNT(*) AS c FROM o_legacyMutationJournal").get() as {
      c: number;
    };
    assert.equal(cnt.c, 0);
  } finally {
    db.close();
  }
  // live 仍有 sentinel 行
  assert.ok(fs.readFileSync(live).includes(Buffer.from(SENTINEL)));
  local2.close();
});
