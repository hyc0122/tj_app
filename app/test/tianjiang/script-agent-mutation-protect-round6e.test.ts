/**
 * 第 6 轮最终阻断：intent 早于远端覆盖 + journal 权威 + 统一 sync clear（RED）
 * 不改写 round6d；禁止测试伪造生产不存在的 close 返回结构。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  PersonalProjectConflictError,
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
  clearPendingLegacyMutationIntent,
  hasPendingLegacyMutationIntent,
  recordPendingLegacyMutationIntent,
} from "../../src/tianjiang/runtime/pending-legacy-mutation-intent";
import { createShutdownPhaseState } from "../../src/tianjiang/runtime/sync-coordinator";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { centralSessionStore } from "../../src/tianjiang/auth/auth-runtime";
import { userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";
import {
  destroyAllDatabaseHandles,
  stopGenerationTaskRecovery,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { commitScriptAgentArtifact } from "../../src/agents/scriptAgent/script-agent-plan-commit";
import { validateScriptAgentOutput } from "../../src/agents/scriptAgent/script-agent-output-contract";
import {
  activateUserDatabase,
  prepareProjectDatabase,
  db as activeDb,
} from "../../src/utils/db";
import {
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";

function manifest(version: number, entries: Array<[string, string]>): PersonalManifest {
  return { version, objects: entries.map(([relativePath, md5]) => ({ relativePath, md5 })) };
}

class FakePersonalLocal implements PersonalLocal {
  current?: PersonalManifest;
  dirty = false;
  installs: PersonalManifest[] = [];
  recoveries: string[] = [];
  async install(remote: PersonalManifest): Promise<void> {
    this.installs.push(structuredClone(remote));
    this.current = structuredClone(remote);
  }
  async createSnapshot(): Promise<PersonalManifest> {
    if (!this.current) throw new Error("no current");
    return structuredClone(this.current);
  }
  async createRecovery(reason: string): Promise<void> {
    this.recoveries.push(reason);
  }
}

class FakePersonalRemote implements PersonalRemote {
  current: PersonalManifest;
  latestCalls = 0;
  constructor(current: PersonalManifest) {
    this.current = structuredClone(current);
  }
  async latest(): Promise<PersonalManifest> {
    this.latestCalls += 1;
    return structuredClone(this.current);
  }
  async publish(
    base: number,
    next: PersonalManifest,
  ): Promise<PersonalManifest> {
    this.current = { ...structuredClone(next), version: base + 1 };
    return structuredClone(this.current);
  }
}

class FakeTeamLocal implements TeamLocal {
  events: string[] = [];
  async install(readonly: boolean): Promise<void> {
    this.events.push(`install:${readonly}`);
  }
  async setReadonly(reason: string): Promise<void> {
    this.events.push(`readonly:${reason}`);
  }
  async createRecovery(reason: string): Promise<void> {
    this.events.push(`recovery:${reason}`);
  }
  async createSnapshot(): Promise<PersonalManifest> {
    this.events.push("snapshot");
    return { version: 3, objects: [{ relativePath: "project.sqlite", md5: "local-db" }] };
  }
}

class FakeTeamRemote implements TeamRemote {
  events: string[] = [];
  lockAvailable = true;
  publishFails = false;
  async acquire(): Promise<{ lockId: string; fencingToken: number } | undefined> {
    this.events.push("acquire");
    return this.lockAvailable ? { lockId: "lock-1", fencingToken: 9 } : undefined;
  }
  async download(): Promise<void> {
    this.events.push("download");
  }
  async publish(): Promise<void> {
    this.events.push("publish");
    if (this.publishFails) throw new Error("publish failed");
  }
  async release(): Promise<void> {
    this.events.push("release");
  }
  async heartbeat(): Promise<void> {
    this.events.push("heartbeat");
  }
}

// ---------- 1) Personal：pending 时远端前进不得 install 覆盖 ----------
test("RED personal：protectPendingLocal 时远端已前进禁止 install，保留本地版本", async () => {
  const local = new FakePersonalLocal();
  local.current = manifest(1, [["project.sqlite", "local-v1"]]);
  const remote = new FakePersonalRemote(manifest(3, [["project.sqlite", "remote-v3"]]));
  const sync = new PersonalProjectSync(local, remote, () => true);
  assert.equal(typeof (sync as any).setProtectPendingLocal, "function", "必须暴露 setProtectPendingLocal");
  (sync as any).setProtectPendingLocal(true);
  sync.open();
  await assert.rejects(() => sync.ensureLoaded(), PersonalProjectConflictError);
  assert.equal(local.installs.length, 0, "禁止远端 install 覆盖本地");
  assert.equal(local.current?.objects[0]?.md5, "local-v1");
  assert.ok(local.recoveries.some((r) => /pending_mutation|remote/i.test(r)));
});

test("RED personal：protectPendingLocal 且远端未前进时不 install，保留本地", async () => {
  const local = new FakePersonalLocal();
  local.current = manifest(2, [["project.sqlite", "local-v2"]]);
  const remote = new FakePersonalRemote(manifest(2, [["project.sqlite", "remote-same"]]));
  const sync = new PersonalProjectSync(local, remote, () => true);
  (sync as any).setProtectPendingLocal(true);
  sync.open();
  await sync.ensureLoaded();
  assert.equal(local.installs.length, 0);
  assert.equal(local.current?.objects[0]?.md5, "local-v2");
});

test("RED personal：journal pending 但 manifest 缺失时先恢复并禁止读取远端", async () => {
  const local = new FakePersonalLocal();
  const remote = new FakePersonalRemote(manifest(3, [["project.sqlite", "remote-v3"]]));
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.setProtectPendingLocal(true);
  sync.open();

  await assert.rejects(() => sync.ensureLoaded(), PersonalProjectConflictError);
  assert.equal(remote.latestCalls, 0, "manifest 缺失时不得先读取或下载远端");
  assert.equal(local.installs.length, 0, "不得用远端数据覆盖 journal 对应的本地 SQLite");
  assert.ok(local.recoveries.includes("pending_mutation_local_manifest_missing"));
});

test("RED personal：journal 不可读必须在任何远端读取前失败关闭", async () => {
  const local = new FakePersonalLocal();
  local.current = manifest(2, [["project.sqlite", "local-v2"]]);
  const remote = new FakePersonalRemote(manifest(3, [["project.sqlite", "remote-v3"]]));
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.setProtectPendingLocal(true, { failClosed: true });
  sync.open();

  await assert.rejects(() => sync.ensureLoaded(), PersonalProjectConflictError);
  assert.equal(remote.latestCalls, 0, "journal 不可读时不得请求远端 manifest");
  assert.equal(local.installs.length, 0);
  assert.ok(local.recoveries.includes("mutation_journal_unreadable"));
});

// ---------- 2) Team：pending 时禁止 download 覆盖 ----------
test("RED team：protectPendingLocal 时持锁也不 download 覆盖本地", async () => {
  const local = new FakeTeamLocal();
  const remote = new FakeTeamRemote();
  const sync = new TeamProjectSync("editor", local, remote, () => ({}));
  assert.equal(typeof (sync as any).setProtectPendingLocal, "function");
  (sync as any).setProtectPendingLocal(true);
  await sync.open();
  assert.ok(!remote.events.includes("download"), "禁止 download 覆盖 pending 本地");
  assert.equal(sync.state().editable, true);
});

test("RED team：protectPendingLocal 且无锁 → recovery，不 download", async () => {
  const local = new FakeTeamLocal();
  const remote = new FakeTeamRemote();
  remote.lockAvailable = false;
  const sync = new TeamProjectSync("editor", local, remote, () => ({}));
  (sync as any).setProtectPendingLocal(true);
  await sync.open();
  assert.ok(!remote.events.includes("download"));
  assert.equal(sync.state().editable, false);
  assert.equal(sync.state().recoveryRequired, true);
});

// ---------- 3) 真实 TeamProjectSync.close 契约 ----------
test("RED team close：publish 成功返回 published；失败保留锁且抛错", async () => {
  const remote = new FakeTeamRemote();
  const local = new FakeTeamLocal();
  const sync = new TeamProjectSync("editor", local, remote, () => ({ m: "1" }));
  await sync.open();
  const ok = await sync.close();
  // Team.close 在 release 成功后返回 released_cleanup_pending（协调器 finalize 后才 published）
  assert.equal((ok as { state?: string } | void)?.state, "released_cleanup_pending");
  assert.ok(remote.events.includes("publish"));
  assert.ok(remote.events.includes("release"));

  const remote2 = new FakeTeamRemote();
  remote2.publishFails = true;
  const local2 = new FakeTeamLocal();
  const sync2 = new TeamProjectSync("editor", local2, remote2, () => ({}));
  await sync2.open();
  await assert.rejects(() => sync2.close());
  assert.ok(remote2.events.includes("publish"));
  assert.ok(!remote2.events.includes("release"), "发布失败不得 release");
});

// ---------- 4) journal 与 artifact 同事务；未提交无 journal ----------
test("RED journal：commitScriptAgentArtifact 成功后 project.sqlite 存在 pending journal", async () => {
  const worktreeRoot = path.resolve(__dirname, "../..", "..");
  const fixtureRoot = path.join(worktreeRoot, ".tmp", "round6e-journal", String(Date.now()));
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const originalCwd = process.cwd();
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = fixtureRoot;
  process.chdir(path.join(worktreeRoot, "app"));
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  const PROJECT_UUID = "e6e6e6e6-e6e6-4e6e-ae6e-e6e6e6e6e6e6";
  const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 66106 };
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      await prepareProjectDatabase(PROJECT_UUID);
      await runWithProjectStorage(PROJECT_UUID, async () => {
        const validation = validateScriptAgentOutput(
          "storySkeleton",
          "<storySkeleton>round6e 权威 journal 骨架</storySkeleton>",
          { finishReason: "stop" },
        );
        assert.equal(validation.ok, true);
        if (!validation.ok) return;
        await commitScriptAgentArtifact({
          projectId: 606,
          artifact: validation.artifact,
        });
        // 权威：表 o_legacyMutationJournal 必须有 pending（禁止仅 dirty/sidecar）
        const hasTable = await activeDb.schema.hasTable("o_legacyMutationJournal");
        assert.equal(hasTable, true, "必须存在 o_legacyMutationJournal");
        const row = await activeDb("o_legacyMutationJournal").where({ status: "pending" }).first();
        assert.ok(row, "产物事务提交后必须有 pending journal");
      });
    });
  } finally {
    await stopGenerationTaskRecovery();
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
  }
});

test("RED journal：未提交/校验失败不得产生 journal", async () => {
  const worktreeRoot = path.resolve(__dirname, "../..", "..");
  const fixtureRoot = path.join(worktreeRoot, ".tmp", "round6e-nojournal", String(Date.now()));
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const originalCwd = process.cwd();
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = fixtureRoot;
  process.chdir(path.join(worktreeRoot, "app"));
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  const PROJECT_UUID = "f6f6f6f6-f6f6-4f6f-af6f-f6f6f6f6f6f6";
  const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 66107 };
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      await prepareProjectDatabase(PROJECT_UUID);
      await runWithProjectStorage(PROJECT_UUID, async () => {
        const bad = validateScriptAgentOutput("storySkeleton", "无标签过渡文本", {
          finishReason: "stop",
        });
        assert.equal(bad.ok, false);
        if (await activeDb.schema.hasTable("o_legacyMutationJournal")) {
          const row = await activeDb("o_legacyMutationJournal").where({ status: "pending" }).first();
          assert.equal(row, undefined, "未提交不得写 journal");
        }
      });
    });
  } finally {
    await stopGenerationTaskRecovery();
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
  }
});

// ---------- 5) coordinator：catalog fail-closed；统一 finalize clear ----------
test("RED coordinator：catalog 缺失 fail-closed；Team close published 清 intent；失败保留", async () => {
  const worktreeRoot = path.resolve(__dirname, "../..", "..");
  const fixtureRoot = path.join(worktreeRoot, ".tmp", "round6e-coord", String(Date.now()));
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

  const personalUuid = "a1a1a1a1-a1a1-4a1a-a1a1-a1a1a1a1a1a1";
  const teamUuid = "b2b2b2b2-b2b2-4b2b-b2b2-b2b2b2b2b2b2";
  const session = centralSessionStore.create({
    serverUrl: "https://api.j11.com.cn",
    token: "round6e-token",
    expiresAt: Date.now() + 60_000,
    user: { id: 66108, username: "round6e-user", nickname: "" },
  });
  const internals = syncCoordinator as unknown as Record<string, any>;
  internals.dataRoot = effectiveDataRoot;
  const userSegment = userStorageSegment({
    issuer: session.serverUrl,
    userId: session.user.id,
  });

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
    grantId: "c3c3c3c3-c3c3-4c3c-c3c3-c3c3c3c3c3c3",
    userId: session.user.id,
    deviceUuid: String(internals.deviceUuid),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revokedAt: null,
  };

  Object.assign(internals, {
    session,
    remote: { refreshOfflineGrant: async () => grant },
    catalog: new Map([
      [personalUuid, personalCatalog],
      [teamUuid, teamCatalog],
    ]),
    localProjectIds: new Map([
      [personalUuid, 6101],
      [teamUuid, 6102],
    ]),
    offlineCache: {
      issuer: session.serverUrl,
      userId: session.user.id,
      grant,
      catalog: [personalCatalog, teamCatalog],
    },
    online: true,
    deviceActive: true,
    shutdownState: createShutdownPhaseState(),
    shutdownRequested: false,
  });
  internals.projects.clear();

  try {
    // catalog 缺失不得默认 personal
    const orphan = "d4d4d4d4-d4d4-4d4d-d4d4-d4d4d4d4d4d4";
    assert.throws(
      () => syncCoordinator.recordPendingLegacyMutationOnly(orphan, "scriptAgent"),
      /目录|不存在|拒绝/,
    );
    assert.equal(hasPendingLegacyMutationIntent(effectiveDataRoot, userSegment, orphan), false);

    // 必须存在统一 finalize
    assert.equal(
      typeof internals.finalizeMutationClearedAfterCentralSuccess,
      "function",
      "必须有 finalizeMutationClearedAfterCentralSuccess",
    );

    // 团队：真实 TeamProjectSync.close 成功 → published 清 intent
    const teamRemote = new FakeTeamRemote();
    const teamLocal: any = {
      events: [] as string[],
      dirty: true,
      markLegacyEdited() {
        this.dirty = true;
      },
      hasLegacyResource: () => true,
      close: () => undefined,
      async install(readonly: boolean) {
        this.events.push(`install:${readonly}`);
      },
      async setReadonly(reason: string) {
        this.events.push(`readonly:${reason}`);
      },
      async createRecovery(reason: string) {
        this.events.push(`recovery:${reason}`);
      },
      async createSnapshot() {
        return {
          version: 1,
          objects: [{ relativePath: "project.sqlite", md5: "t" }],
          capturedMutationGeneration: 0,
        };
      },
    };
    const realTeamSync = new TeamProjectSync("editor", teamLocal, teamRemote, () => ({}));
    await realTeamSync.open();
    recordPendingLegacyMutationIntent({
      dataRoot: effectiveDataRoot,
      userSegment,
      projectUuid: teamUuid,
      kind: "team",
      source: "scriptAgent",
    });
    internals.projects.set(teamUuid, { kind: "team", local: teamLocal, sync: realTeamSync });
    assert.equal(hasPendingLegacyMutationIntent(effectiveDataRoot, userSegment, teamUuid), true);
    const closeResult = await syncCoordinator.closeProject(session, teamUuid);
    assert.equal((closeResult as { state?: string }).state, "published");
    assert.equal(
      hasPendingLegacyMutationIntent(effectiveDataRoot, userSegment, teamUuid),
      false,
      "published 后必须清 intent",
    );

    // 团队发布失败保留 intent
    const teamRemoteFail = new FakeTeamRemote();
    teamRemoteFail.publishFails = true;
    const teamLocal2: any = {
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
          version: 1,
          objects: [{ relativePath: "project.sqlite", md5: "t2" }],
          capturedMutationGeneration: 0,
        };
      },
    };
    const realTeamFail = new TeamProjectSync("editor", teamLocal2, teamRemoteFail, () => ({}));
    await realTeamFail.open();
    recordPendingLegacyMutationIntent({
      dataRoot: effectiveDataRoot,
      userSegment,
      projectUuid: teamUuid,
      kind: "team",
      source: "scriptAgent",
    });
    internals.projects.set(teamUuid, { kind: "team", local: teamLocal2, sync: realTeamFail });
    await assert.rejects(() => syncCoordinator.closeProject(session, teamUuid));
    assert.equal(
      hasPendingLegacyMutationIntent(effectiveDataRoot, userSegment, teamUuid),
      true,
      "发布失败必须保留 intent",
    );

    // personal close synced 清 intent；offline_pending 保留
    recordPendingLegacyMutationIntent({
      dataRoot: effectiveDataRoot,
      userSegment,
      projectUuid: personalUuid,
      kind: "personal",
      source: "scriptAgent",
    });
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
      current: manifest(1, [["project.sqlite", "p1"]]),
      async install() {},
      async createSnapshot() {
        return manifest(1, [["project.sqlite", "p1"]]);
      },
      async createRecovery() {},
    };
    const personalRemote = new FakePersonalRemote(manifest(1, [["project.sqlite", "p1"]]));
    const personalSync = new PersonalProjectSync(personalLocal, personalRemote, () => true);
    personalSync.open();
    await personalSync.ensureLoaded();
    personalDirty = true;
    internals.projects.set(personalUuid, {
      kind: "personal",
      local: personalLocal,
      sync: personalSync,
    });
    const pClose = await syncCoordinator.closeProject(session, personalUuid);
    assert.ok(
      (pClose as { state?: string }).state === "synced" ||
        (pClose as { state?: string }).state === "unchanged",
    );
    assert.equal(hasPendingLegacyMutationIntent(effectiveDataRoot, userSegment, personalUuid), false);

    // offline_pending 保留
    recordPendingLegacyMutationIntent({
      dataRoot: effectiveDataRoot,
      userSegment,
      projectUuid: personalUuid,
      kind: "personal",
      source: "scriptAgent",
    });
    personalDirty = true;
    const offlineSync = new PersonalProjectSync(personalLocal, personalRemote, () => false);
    offlineSync.open();
    internals.projects.set(personalUuid, {
      kind: "personal",
      local: personalLocal,
      sync: offlineSync,
    });
    await assert.rejects(
      () => syncCoordinator.closeProject(session, personalUuid),
      /中央同步|取消|网络/,
    );
    assert.equal(hasPendingLegacyMutationIntent(effectiveDataRoot, userSegment, personalUuid), true);
    assert.equal(internals.projects.has(personalUuid), true);

    // executePendingUpload：synced 清 intent
    recordPendingLegacyMutationIntent({
      dataRoot: effectiveDataRoot,
      userSegment,
      projectUuid: personalUuid,
      kind: "personal",
      source: "scriptAgent",
    });
    personalDirty = true;
    const uploadSync = new PersonalProjectSync(personalLocal, personalRemote, () => true);
    uploadSync.open();
    await uploadSync.ensureLoaded();
    personalDirty = true;
    internals.projects.set(personalUuid, {
      kind: "personal",
      local: personalLocal,
      sync: uploadSync,
    });
    assert.equal(typeof internals.executePendingUpload, "function");
    await internals.executePendingUpload(personalUuid);
    assert.equal(
      hasPendingLegacyMutationIntent(effectiveDataRoot, userSegment, personalUuid),
      false,
      "executePendingUpload synced/unchanged 必须清 intent",
    );
  } finally {
    centralSessionStore.delete(session.id);
    await syncCoordinator.shutdown().catch(() => undefined);
    await stopGenerationTaskRecovery();
    await destroyAllDatabaseHandles().catch(() => undefined);
    internals.projects.clear();
    process.chdir(originalCwd);
  }
});

// ---------- 6) open 前可读 journal（文件探测 API）----------
test("RED：projectFileHasPendingMutationJournal 可在远端 install 前只读探测", async () => {
  const { projectFileHasPendingMutationJournal } = await import(
    "../../src/tianjiang/runtime/legacy-mutation-journal"
  );
  assert.equal(typeof projectFileHasPendingMutationJournal, "function");
  const tmp = path.join(
    path.resolve(__dirname, "../..", ".."),
    ".tmp",
    "round6e-probe",
    String(Date.now()),
  );
  fs.mkdirSync(tmp, { recursive: true });
  const dbPath = path.join(tmp, "project.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE o_legacyMutationJournal (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    INSERT INTO o_legacyMutationJournal (source, status, createdAt, updatedAt)
    VALUES ('scriptAgent', 'pending', 1, 1);
  `);
  db.close();
  assert.equal(projectFileHasPendingMutationJournal(dbPath), true);
  assert.equal(projectFileHasPendingMutationJournal(path.join(tmp, "missing.sqlite")), false);
});

// ---------- 7) 双失败不得正常 complete（契约：isSatisfied 为 false 时 route 不得吞掉）----------
test("RED：intent 与 runtime mark 均失败时 isSatisfied=false，禁止当成功结束", () => {
  const { createIdempotentPlanCommitMarker } = require(
    "../../src/agents/scriptAgent/script-agent-decision-result",
  );
  const marker = createIdempotentPlanCommitMarker({
    recordIntent: () => {
      throw new Error("intent disk fail");
    },
    markRuntime: () => {
      throw new Error("mark fail");
    },
  });
  assert.throws(() => marker.markOnce());
  assert.equal(marker.isSatisfied(), false);
  assert.equal(marker.intentRecorded, false);
  assert.equal(marker.marked, false);
});
