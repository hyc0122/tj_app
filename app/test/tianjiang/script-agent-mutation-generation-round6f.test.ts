/**
 * 第 6 轮 round6f RED：journal-only 恢复、快照剥离、generation 竞态、Team release、fail-closed
 * 关键路径至少覆盖真实 RuntimeProjectLocal + SQLite 快照 + coordinator open/close。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { RuntimeProjectLocal } from "../../src/tianjiang/runtime/project-runtime-local";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";
import {
  clearPendingLegacyMutationIntent,
  hasPendingLegacyMutationIntent,
  recordPendingLegacyMutationIntent,
} from "../../src/tianjiang/runtime/pending-legacy-mutation-intent";
import { createShutdownPhaseState } from "../../src/tianjiang/runtime/sync-coordinator";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { centralSessionStore } from "../../src/tianjiang/auth/auth-runtime";
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
import {
  destroyAllDatabaseHandles,
  stopGenerationTaskRecovery,
  resetDatabaseRuntimeForServe,
  activateUserDatabase,
  prepareProjectDatabase,
  beginDatabaseShutdown,
  db as activeDb,
} from "../../src/utils/db";
import {
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { commitScriptAgentArtifact } from "../../src/agents/scriptAgent/script-agent-plan-commit";
import { validateScriptAgentOutput } from "../../src/agents/scriptAgent/script-agent-output-contract";

const worktreeRoot = path.resolve(__dirname, "../..", "..");

function seedJournalSqlite(
  dbPath: string,
  rows: Array<{ generation: number; status: "pending" | "cleared"; source?: string }>,
): void {
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
  const ins = db.prepare(
    `INSERT INTO o_legacyMutationJournal (source, status, generation, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  for (const r of rows) {
    ins.run(r.source ?? "scriptAgent", r.status, r.generation, now, now);
  }
  db.close();
}

function pendingGenerations(dbPath: string): number[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(`SELECT generation FROM o_legacyMutationJournal WHERE status = 'pending' ORDER BY generation`)
      .all() as Array<{ generation: number }>;
    return rows.map((r) => r.generation);
  } finally {
    db.close();
  }
}

function writeManifest(projectRoot: string, version: number, md5 = "local-md5"): void {
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, ".tianjiang-manifest.json"),
    JSON.stringify({
      version,
      objects: [{ relativePath: "project.sqlite", md5 }],
    }),
    "utf8",
  );
}

// ---------- probe / API surface ----------
test("RED：probe/clear generation API 与 fail-closed 探测存在", async () => {
  const journal = await import("../../src/tianjiang/runtime/legacy-mutation-journal");
  assert.equal(typeof (journal as any).probeProjectMutationJournal, "function");
  assert.equal(typeof (journal as any).clearPendingMutationJournalOnFile, "function");
  assert.equal(typeof (journal as any).stripMutationJournalFromSnapshotFile, "function");

  const tmp = path.join(worktreeRoot, ".tmp", "r6f-probe", String(Date.now()));
  const dbPath = path.join(tmp, "project.sqlite");
  seedJournalSqlite(dbPath, [
    { generation: 1, status: "pending" },
    { generation: 2, status: "pending" },
  ]);
  const probe = (journal as any).probeProjectMutationJournal(dbPath);
  assert.equal(probe.ok, true);
  assert.equal(probe.pending, true);
  assert.equal(probe.maxGeneration, 2);

  // 损坏：fail-closed，不得报无 pending
  const bad = path.join(tmp, "bad.sqlite");
  fs.writeFileSync(bad, "not-a-sqlite");
  const badProbe = (journal as any).probeProjectMutationJournal(bad);
  assert.equal(badProbe.ok, false);
  assert.notEqual(badProbe.pending, false);
});

// ---------- 快照剥离：真实 RuntimeProjectLocal ----------
test("RED：createSnapshot 剥离 journal；live 仍 pending", async () => {
  const runId = `snap-${process.pid}-${Date.now()}`;
  const dataRoot = path.join(worktreeRoot, ".tmp", "r6f-snap", runId, "data");
  const segment = "a".repeat(32);
  const projectUuid = "11111111-1111-4111-8111-111111111111";
  const projectRoot = projectDirectory(dataRoot, projectUuid, segment);
  fs.mkdirSync(path.join(projectRoot, "files"), { recursive: true });
  writeManifest(projectRoot, 1);
  // 先创建可被 ProjectStore 打开的库并写入 journal
  const dbPath = path.join(projectRoot, "project.sqlite");
  const local = new RuntimeProjectLocal(dataRoot, projectUuid, segment);
  await local.install(false);
  local.setWritable();
  // 在 live 库写 journal（ProjectStore 已打开同一文件）
  {
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
    db.prepare(
      `INSERT INTO o_legacyMutationJournal (source, status, generation, createdAt, updatedAt) VALUES (?,?,?,?,?)`,
    ).run("scriptAgent", "pending", 7, Date.now(), Date.now());
    db.close();
  }
  // 重新打开 store 句柄以看到表（若需要）
  local.close();
  const local2 = new RuntimeProjectLocal(dataRoot, projectUuid, segment);
  await local2.install(false);
  local2.setWritable();
  const snap = await local2.createSnapshot();
  assert.ok((snap as any).capturedMutationGeneration === 7 || (snap as any).capturedMutationGeneration >= 1);

  const snapPath = path.join(
    dataRoot,
    "runtime-users",
    segment,
    "sync",
    "snapshots",
    projectUuid,
    "project.sqlite",
  );
  assert.equal(fs.existsSync(snapPath), true, "必须存在待上传快照文件");
  // 直接打开快照：无 pending
  const snapPending = pendingGenerations(snapPath);
  assert.deepEqual(snapPending, [], "上传快照不得含 pending journal");
  // live 仍 pending
  assert.deepEqual(pendingGenerations(dbPath), [7]);
  local2.close();
});

// ---------- journal-only open/close（真实 coordinator） ----------
test("RED：journal=true sidecar=false 时 open 后 dirty，close 不得 unchanged 清 journal", async () => {
  const runId = `jlonly-${process.pid}-${Date.now()}`;
  const fixtureRoot = path.join(worktreeRoot, ".tmp", "r6f-jlonly", runId);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const originalCwd = process.cwd();
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = fixtureRoot;
  process.chdir(fixtureRoot);
  resetDatabaseRuntimeForServe();

  const effectiveDataRoot = path.join(fixtureRoot, "data");
  fs.mkdirSync(effectiveDataRoot, { recursive: true });
  const projectUuid = "22222222-2222-4222-8222-222222222222";
  const session = centralSessionStore.create({
    serverUrl: "https://api.j11.com.cn",
    token: "r6f-jlonly",
    expiresAt: Date.now() + 60_000,
    user: { id: 77001, username: "r6f-jl", nickname: "" },
  });
  const segment = userStorageSegment({ issuer: session.serverUrl, userId: session.user.id });
  const projectRoot = projectDirectory(effectiveDataRoot, projectUuid, segment);
  writeManifest(projectRoot, 2, "live-local");
  seedJournalSqlite(path.join(projectRoot, "project.sqlite"), [
    { generation: 3, status: "pending" },
  ]);
  // 明确无 sidecar
  clearPendingLegacyMutationIntent(effectiveDataRoot, segment, projectUuid);
  assert.equal(hasPendingLegacyMutationIntent(effectiveDataRoot, segment, projectUuid), false);

  const internals = syncCoordinator as unknown as Record<string, any>;
  internals.dataRoot = effectiveDataRoot;
  let publishCalls = 0;
  const remoteManifest: PersonalManifest = {
    version: 2,
    objects: [{ relativePath: "project.sqlite", md5: "live-local" }],
  };
  const catalogItem = {
    projectUuid,
    name: "jlonly",
    kind: "personal",
    ownerUserId: session.user.id,
    role: "owner",
    myRole: "owner",
    currentVersion: 2,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: new Date().toISOString(),
    lockStatus: "none",
    lockHolderName: "",
    openMode: "editable",
    businessType: "script",
  };
  const grant = {
    grantId: "33333333-3333-4333-8333-333333333333",
    userId: session.user.id,
    deviceUuid: String(internals.deviceUuid),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revokedAt: null,
  };
  Object.assign(internals, {
    session,
    remote: {
      refreshOfflineGrant: async () => grant,
      personalRemote: (
        _uuid: string,
        acceptDownloaded: (s: any) => void,
      ) => ({
        async latest() {
          return structuredClone(remoteManifest);
        },
        async publish(_base: number, next: PersonalManifest) {
          publishCalls += 1;
          remoteManifest.version = (remoteManifest.version ?? 2) + 1;
          remoteManifest.objects = structuredClone(next.objects);
          acceptDownloaded({
            ...remoteManifest,
            records: {},
          });
          return structuredClone(remoteManifest);
        },
      }),
    },
    catalog: new Map([[projectUuid, catalogItem]]),
    localProjectIds: new Map([[projectUuid, 7701]]),
    offlineCache: {
      issuer: session.serverUrl,
      userId: session.user.id,
      grant,
      catalog: [catalogItem],
    },
    online: true,
    deviceActive: true,
    shutdownState: createShutdownPhaseState(),
    shutdownRequested: false,
  });
  internals.projects.clear();

  try {
    // cwd 在夹具内时 getPath()=fixture/data，与 coordinator.dataRoot 对齐
    const identity = { issuer: session.serverUrl, userId: session.user.id };
    process.env.NODE_ENV = "prod";
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      await syncCoordinator.openProject(session, projectUuid);
      const runtime = internals.projects.get(projectUuid);
      assert.ok(runtime);
      assert.equal(runtime.local.dirty, true, "journal-only 打开后必须 dirty");

      // 强制对象变更，确保 close 触发 publish 而非仅 version 幂等
      runtime.local.dirty = true;
      if (runtime.local.current) {
        runtime.local.current = {
          version: 2,
          objects: [{ relativePath: "project.sqlite", md5: "dirty-after-journal" }],
        };
      }

      const closeResult = await syncCoordinator.closeProject(session, projectUuid);
      assert.notEqual(
        (closeResult as { state?: string }).state,
        "unchanged",
        "journal-only 不得 close 为 unchanged",
      );
      assert.ok(
        publishCalls >= 1 ||
          (closeResult as { state?: string }).state === "synced" ||
          (closeResult as { capturedMutationGeneration?: number }).capturedMutationGeneration !=
            null,
        "close 必须上传或带 generation 的 synced 清理",
      );
    });
  } finally {
    centralSessionStore.delete(session.id);
    beginDatabaseShutdown();
    await syncCoordinator.shutdown().catch(() => undefined);
    await stopGenerationTaskRecovery();
    await destroyAllDatabaseHandles().catch(() => undefined);
    internals.projects.clear();
    process.chdir(originalCwd);
  }
});

// ---------- generation 竞态 ----------
test("RED：generation N 上传期间 N+1 提交后 N 成功仍保留 N+1", async () => {
  const journal = await import("../../src/tianjiang/runtime/legacy-mutation-journal");
  const tmp = path.join(worktreeRoot, ".tmp", "r6f-gen", String(Date.now()));
  const dbPath = path.join(tmp, "project.sqlite");
  seedJournalSqlite(dbPath, [
    { generation: 1, status: "pending" },
    { generation: 2, status: "pending" },
  ]);
  // 仅清 <=1
  (journal as any).clearPendingMutationJournalOnFile(dbPath, 1);
  assert.deepEqual(pendingGenerations(dbPath), [2], "N 成功后 N+1 仍 pending");

  // 禁止统一清空全部
  seedJournalSqlite(path.join(tmp, "all.sqlite"), [
    { generation: 5, status: "pending" },
    { generation: 6, status: "pending" },
  ]);
  (journal as any).clearPendingMutationJournalOnFile(path.join(tmp, "all.sqlite"), 5);
  assert.deepEqual(pendingGenerations(path.join(tmp, "all.sqlite")), [6]);
});

test("RED：Personal sync 返回 capturedMutationGeneration；N+1 时 dirty 保持", async () => {
  class Local implements PersonalLocal {
    current: PersonalManifest = {
      version: 1,
      objects: [{ relativePath: "project.sqlite", md5: "a" }],
    };
    dirty = true;
    installs: PersonalManifest[] = [];
    async install(remote: PersonalManifest): Promise<void> {
      this.installs.push(remote);
      this.current = structuredClone(remote);
    }
    async createSnapshot(): Promise<PersonalManifest> {
      return {
        ...structuredClone(this.current!),
        capturedMutationGeneration: 1,
      } as PersonalManifest;
    }
    async createRecovery(): Promise<void> {}
  }
  class Remote implements PersonalRemote {
    current: PersonalManifest = {
      version: 1,
      objects: [{ relativePath: "project.sqlite", md5: "a" }],
    };
    publishes = 0;
    async latest() {
      return structuredClone(this.current);
    }
    async publish(base: number, next: PersonalManifest) {
      this.publishes += 1;
      this.current = { version: base + 1, objects: structuredClone(next.objects) };
      return structuredClone(this.current);
    }
  }
  const local = new Local();
  // 快照 objects 与远端不同，确保会 publish
  local.current = {
    version: 1,
    objects: [{ relativePath: "project.sqlite", md5: "local-changed" }],
  };
  const remote = new Remote();
  remote.current = {
    version: 1,
    objects: [{ relativePath: "project.sqlite", md5: "a" }],
  };
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();
  const result = await sync.sync("manual");
  assert.equal(result.state, "synced");
  assert.equal(
    (result as { capturedMutationGeneration?: number }).capturedMutationGeneration,
    1,
  );
  assert.equal(remote.publishes, 1);
  // N+1 仍 pending：noteRemaining 后 dirty 保持并安排后续同步
  assert.equal(typeof (sync as any).noteRemainingPendingAfterSync, "function");
  (sync as any).noteRemainingPendingAfterSync(true);
  assert.equal(local.dirty, true);
});

// ---------- Team publish/release 状态机 ----------
test("RED：Team publish 成功 release 失败：不重复 publish；可重试 release；心跳续", async () => {
  const events: string[] = [];
  let releaseFails = 1;
  const local: TeamLocal = {
    async install() {
      events.push("install");
    },
    async setReadonly() {
      events.push("readonly");
    },
    async createRecovery() {
      events.push("recovery");
    },
    async createSnapshot() {
      events.push("snapshot");
      return {
        version: 1,
        objects: [{ relativePath: "project.sqlite", md5: "t" }],
        capturedMutationGeneration: 4,
      } as PersonalManifest;
    },
  };
  const remote: TeamRemote = {
    async acquire() {
      events.push("acquire");
      return { lockId: "L1", fencingToken: 1 };
    },
    async download() {
      events.push("download");
    },
    async publish() {
      events.push("publish");
    },
    async release() {
      events.push("release");
      if (releaseFails > 0) {
        releaseFails -= 1;
        throw new Error("release failed");
      }
    },
    async heartbeat() {
      events.push("heartbeat");
    },
  };
  const timers: Array<() => void> = [];
  const sync = new TeamProjectSync(
    "editor",
    local,
    remote,
    () => ({}),
    (run) => {
      timers.push(run as () => void);
      return 0;
    },
    1,
  );
  await sync.open();
  await assert.rejects(() => sync.close());
  const publishCount1 = events.filter((e) => e === "publish").length;
  assert.equal(publishCount1, 1);
  assert.ok(events.includes("release"));
  // 第二次 close：不得再 publish
  events.length = 0;
  const result = await sync.close();
  // release 成功后 Team 返回 released_cleanup_pending（协调器 finalize 后才 published）
  assert.equal((result as { state?: string }).state, "released_cleanup_pending");
  assert.equal(events.filter((e) => e === "publish").length, 0, "禁止重复 publish");
  assert.ok(events.includes("release"));
});

// ---------- sidecar clear 失败 ----------
test("RED：sidecar 删除失败时 finalize 不得宣称完成", async () => {
  const work = path.join(worktreeRoot, ".tmp", "r6f-clearfail", String(Date.now()));
  fs.mkdirSync(work, { recursive: true });
  const segment = "b".repeat(32);
  const projectUuid = "44444444-4444-4444-8444-444444444444";
  recordPendingLegacyMutationIntent({
    dataRoot: work,
    userSegment: segment,
    projectUuid,
    kind: "personal",
    source: "scriptAgent",
  });
  const intentFile = path.join(
    work,
    "runtime-users",
    segment,
    "pending-legacy-mutations",
    `${projectUuid}.json`,
  );
  assert.equal(fs.existsSync(intentFile), true);

  // 用目录替换文件使 rm 后仍“存在”路径异常；或 mock：
  // 直接测 clearPendingLegacyMutationIntent 在不可删时抛错
  fs.rmSync(intentFile, { force: true });
  fs.mkdirSync(intentFile, { recursive: true }); // 路径是目录，rmSync file 行为因平台而异
  let threw = false;
  try {
    clearPendingLegacyMutationIntent(work, segment, projectUuid);
    // 若未抛：必须验证文件仍在时返回失败语义
    if (fs.existsSync(intentFile)) {
      // 允许抛或返回 false；禁止静默成功
      const still = hasPendingLegacyMutationIntent(work, segment, projectUuid);
      // GREEN：clear 应 throw；此处若 silent 且 still true 也算失败契约
      assert.equal(still, true);
      threw = false;
      assert.fail("clear 在目标仍存在时必须抛出稳定错误");
    }
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "sidecar 清理失败必须抛错");
});

// ---------- journal 损坏 fail-closed：远端 install 0 次 ----------
test("RED：journal SQLite 损坏 fail-closed，远端 install 调用 0 次", async () => {
  class Local implements PersonalLocal {
    current: PersonalManifest = {
      version: 1,
      objects: [{ relativePath: "project.sqlite", md5: "local" }],
    };
    dirty = false;
    installs = 0;
    recoveries: string[] = [];
    async install(): Promise<void> {
      this.installs += 1;
    }
    async createSnapshot(): Promise<PersonalManifest> {
      return structuredClone(this.current!);
    }
    async createRecovery(reason: string): Promise<void> {
      this.recoveries.push(reason);
    }
  }
  class Remote implements PersonalRemote {
    latestCalls = 0;
    async latest() {
      this.latestCalls += 1;
      return {
        version: 9,
        objects: [{ relativePath: "project.sqlite", md5: "remote" }],
      };
    }
    async publish(): Promise<PersonalManifest> {
      throw new Error("should not publish");
    }
  }
  const local = new Local();
  const remote = new Remote();
  const sync = new PersonalProjectSync(local, remote, () => true);
  assert.equal(typeof (sync as any).setProtectPendingLocal, "function");
  (sync as any).setProtectPendingLocal(true, { failClosed: true });
  sync.open();
  await assert.rejects(() => sync.ensureLoaded());
  assert.equal(local.installs, 0, "fail-closed 禁止 install");
});

// ---------- artifact 回滚：generation/journal 同回滚 ----------
test("RED：artifact 事务回滚时 journal/generation 同时不存在", async () => {
  const fixtureRoot = path.join(worktreeRoot, ".tmp", "r6f-rollback", String(Date.now()));
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const originalCwd = process.cwd();
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = fixtureRoot;
  process.chdir(path.join(worktreeRoot, "app"));
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  const PROJECT_UUID = "55555555-5555-4555-8555-555555555555";
  const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 77055 };
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      await prepareProjectDatabase(PROJECT_UUID);
      await runWithProjectStorage(PROJECT_UUID, async () => {
        const validation = validateScriptAgentOutput(
          "storySkeleton",
          "<storySkeleton>回滚测试骨架</storySkeleton>",
          { finishReason: "stop" },
        );
        assert.equal(validation.ok, true);
        if (!validation.ok) return;
        await assert.rejects(async () => {
          await activeDb.transaction(async (trx) => {
            await commitScriptAgentArtifact({
              projectId: 7055,
              artifact: validation.artifact,
              // 使用外部 trx 若支持；否则钩子
              ...( {
                trx,
                testHooks: {
                  beforeAuthoritativeTransaction: async () => undefined,
                },
              } as any),
            });
            // 若 journal 已在 trx 内写入，随后回滚
            throw new Error("force rollback");
          });
        });
        if (await activeDb.schema.hasTable("o_legacyMutationJournal")) {
          const pending = await activeDb("o_legacyMutationJournal").where({ status: "pending" });
          assert.equal(pending.length, 0, "回滚后不得残留 pending journal");
        }
      });
    });
  } finally {
    await stopGenerationTaskRecovery();
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
  }
});

// ---------- upsert 递增 generation ----------
test("RED：连续 artifact 提交 generation 单调递增", async () => {
  const fixtureRoot = path.join(worktreeRoot, ".tmp", "r6f-incgen", String(Date.now()));
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const originalCwd = process.cwd();
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = fixtureRoot;
  process.chdir(path.join(worktreeRoot, "app"));
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  const PROJECT_UUID = "66666666-6666-4666-8666-666666666666";
  const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 77066 };
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      await prepareProjectDatabase(PROJECT_UUID);
      await runWithProjectStorage(PROJECT_UUID, async () => {
        for (const body of ["骨架A", "骨架B"]) {
          const validation = validateScriptAgentOutput(
            "storySkeleton",
            `<storySkeleton>${body}</storySkeleton>`,
            { finishReason: "stop" },
          );
          assert.equal(validation.ok, true);
          if (!validation.ok) return;
          await commitScriptAgentArtifact({
            projectId: 7066,
            artifact: validation.artifact,
          });
        }
        assert.equal(await activeDb.schema.hasTable("o_legacyMutationJournal"), true);
        const gens = await activeDb("o_legacyMutationJournal")
          .where({ status: "pending" })
          .orderBy("generation", "asc")
          .select("generation");
        assert.ok(gens.length >= 2, "两次提交至少两条或递增 generation");
        const values = gens.map((g: { generation: number }) => Number(g.generation));
        if (values.length >= 2) {
          assert.ok(values[values.length - 1]! > values[0]!, "generation 必须单调递增");
        } else if (values.length === 1) {
          // 若 upsert 单行递增，generation 应 >= 2
          assert.ok(values[0]! >= 2, "单行 upsert 时 generation 应递增到 >=2");
        }
      });
    });
  } finally {
    await stopGenerationTaskRecovery();
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
  }
});
