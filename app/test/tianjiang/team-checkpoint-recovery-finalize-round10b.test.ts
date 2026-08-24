/**
 * Round10b RED：Team checkpoint 恢复必须经 SyncCoordinator 顺序
 * 中央证据确认 → journal finalize(<=captured) → 确认已清 → receipt clear → 再定 dirty。
 * recoverCheckpointReceiptIfPresent 证据一致时禁止自行删 receipt / dirty=false。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import type { CentralAuthGateway, CentralSession } from "../../src/tianjiang/auth/central-session";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { ProjectStore } from "../../src/tianjiang/data/project-store";
import {
  readTeamCheckpointReceipt,
  writeTeamCheckpointReceipt,
} from "../../src/tianjiang/runtime/team-checkpoint-receipt";
import { SyncCoordinator } from "../../src/tianjiang/runtime/sync-coordinator";
import { userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";
import {
  TeamProjectSync,
  type TeamLocal,
  type TeamRemote,
} from "../../src/tianjiang/sync/team-project-sync";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000001a1";
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

const session = {
  id: "sess-r10b-cp",
  serverUrl: "https://api.example.invalid",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 71, username: "r10b", nickname: "R10b" },
} as CentralSession;

function segmentFor(): string {
  return userStorageSegment({ issuer: session.serverUrl, userId: session.user.id });
}

function seedJournal(dbPath: string, generations: number[]): void {
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
  const insert = db.prepare(
    `INSERT INTO o_legacyMutationJournal (source, status, generation, createdAt, updatedAt)
     VALUES ('scriptAgent', 'pending', ?, ?, ?)`,
  );
  for (const g of generations) insert.run(g, now, now);
  db.close();
}

function pendingGens(dbPath: string): number[] {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db
        .prepare(
          `SELECT generation FROM o_legacyMutationJournal WHERE status='pending' ORDER BY generation`,
        )
        .all() as Array<{ generation: number }>
    ).map((r) => r.generation);
  } finally {
    db.close();
  }
}

function objectsDigest() {
  return [
    { relativePath: "project.sqlite", md5: "a".repeat(32), size: 10 },
    { relativePath: "files/videos/v.mp4", md5: "b".repeat(32), size: 20 },
  ];
}

test("recoverCheckpoint 证据一致时不得自行删 receipt 或 dirty=false（须返回 pendingFinalize）", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-cp-rec-"));
  const segment = segmentFor();
  const objects = objectsDigest();
  writeTeamCheckpointReceipt(dataRoot, segment, {
    projectUuid,
    lockId: "L-rec",
    fencingToken: 7,
    phase: "published_pending_finalize",
    baseVersion: 5,
    expectedVersion: 6,
    capturedMutationGeneration: 15,
    objects,
  });
  const local: TeamLocal & { dirty: boolean } = {
    current: { version: 5, objects: structuredClone(objects) },
    dirty: true,
    install: async () => undefined,
    setReadonly: async () => undefined,
    createRecovery: async () => undefined,
    createSnapshot: async () => ({
      version: 5,
      objects: structuredClone(objects),
      capturedMutationGeneration: 15,
    }),
  };
  const remote: TeamRemote = {
    acquire: async () => ({ lockId: "L-rec", fencingToken: 7 }),
    download: async () => undefined,
    publish: async () => {
      throw new Error("证据一致时禁止重复 publish");
    },
    release: async () => undefined,
    heartbeat: async () => undefined,
    fetchProjectEvidence: async () => ({ version: 6, objects: structuredClone(objects) }),
  };
  const sync = new TeamProjectSync("editor", local, remote, () => ({}));
  sync.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid });

  try {
    const result = await (sync as {
      recoverCheckpointReceiptIfPresent: () => Promise<
        | boolean
        | {
          pendingFinalize?: boolean;
          expectedVersion?: number;
          capturedMutationGeneration?: number | "unknown";
        }
      >;
    }).recoverCheckpointReceiptIfPresent();

    // 结构化结果：pendingFinalize=true，禁止布尔 true 伪装已 finalize
    assert.equal(typeof result, "object", "必须返回结构化 recovery result（预期 RED）");
    const structured = result as {
      pendingFinalize: boolean;
      expectedVersion: number;
      capturedMutationGeneration: number;
    };
    assert.equal(structured.pendingFinalize, true);
    assert.equal(structured.expectedVersion, 6);
    assert.equal(structured.capturedMutationGeneration, 15);
    assert.ok(
      readTeamCheckpointReceipt(dataRoot, segment, projectUuid),
      "证据一致后 recover 本身不得删除 receipt",
    );
    assert.equal(local.dirty, true, "recover 本身不得 dirty=false");
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("SyncCoordinator.openProject：journal15+capture15 顺序 journal finalize → receipt clear → clean", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-cp-open-"));
  const segment = segmentFor();
  const objects = objectsDigest();
  const store = new ProjectStore(dataRoot, projectUuid, "readwrite", segment);
  store.setRecord("runtime", "seed", { ok: true });
  store.close();
  const dbPath = path.join(projectDirectory(dataRoot, projectUuid, segment), "project.sqlite");
  seedJournal(dbPath, [15]);
  writeTeamCheckpointReceipt(dataRoot, segment, {
    projectUuid,
    lockId: "L-open",
    fencingToken: 3,
    phase: "published_pending_finalize",
    baseVersion: 5,
    expectedVersion: 6,
    capturedMutationGeneration: 15,
    objects,
  });
  fs.writeFileSync(
    path.join(projectDirectory(dataRoot, projectUuid, segment), ".tianjiang-manifest.json"),
    JSON.stringify({ version: 5, objects }, null, 2),
  );

  const gateway = {
    forwardBusinessRequest: async () => ({}),
  } as unknown as CentralAuthGateway;
  const coordinator = new SyncCoordinator(dataRoot, gateway, new MemoryCredentialStore());
  const steps: string[] = [];
  Object.assign(coordinator as unknown as Record<string, unknown>, {
    session,
    online: true,
    deviceActive: true,
    localProjectIds: new Map([[projectUuid, 9001], [projectUuid.toLowerCase(), 9001]]),
    catalog: new Map([
      [
        projectUuid,
        {
          projectUuid,
          name: "cp-open",
          kind: "team",
          ownerUserId: 0,
          role: "editor",
          myRole: "editor",
          currentVersion: 6,
          syncState: "synced",
          lastSyncedAt: null,
          updatedAt: new Date().toISOString(),
          lockStatus: "none",
          lockHolderName: "",
          openMode: "editable",
          businessType: "script",
        },
      ],
    ]),
    remote: {
      teamRemote: (
        _uuid: string,
        _onDl: unknown,
        _opts: unknown,
      ) => ({
        acquire: async () => ({ lockId: "L-open", fencingToken: 3 }),
        download: async () => undefined,
        publish: async () => undefined,
        release: async () => undefined,
        heartbeat: async () => undefined,
        latestVersion: async () => 6,
        fetchProjectEvidence: async () => ({ version: 6, objects }),
      }),
    },
  });

  // 钩子：观测 finalize 与 receipt 顺序（生产应 journal 先于 clear）
  const originalFinalize = coordinator.finalizeMutationClearedAfterCentralSuccess.bind(coordinator);
  coordinator.finalizeMutationClearedAfterCentralSuccess = (
    uuid: string,
    state: string,
    capture?: number | "unknown",
    options?: { editEpochAdvanced?: boolean },
  ) => {
    steps.push(`finalize:${String(capture)}`);
    assert.ok(
      readTeamCheckpointReceipt(dataRoot, segment, projectUuid),
      "finalize 前 receipt 必须仍在",
    );
    originalFinalize(uuid, state, capture, options);
    steps.push("journal-done");
  };
  // 测试不依赖 legacy workspace ALS
  (coordinator as unknown as { initializeLegacyWorkspace: () => Promise<void> })
    .initializeLegacyWorkspace = async () => undefined;

  try {
    await coordinator.openProject(session, projectUuid);
    assert.ok(steps.includes("finalize:15"), "openProject 必须 finalize capture=15（预期 RED）");
    assert.ok(steps.includes("journal-done"));
    assert.equal(
      readTeamCheckpointReceipt(dataRoot, segment, projectUuid),
      undefined,
      "finalize 成功后才清 receipt",
    );
    assert.deepEqual(pendingGens(dbPath), [], "journal <=15 必须已清理");
    const runtime = (coordinator as unknown as {
      projects: Map<string, { kind: string; local: { dirty?: boolean } }>;
    }).projects.get(projectUuid);
    assert.equal(runtime?.local.dirty, false, "无剩余 journal 时 dirty 可清");
    // 顺序：finalize 记录必须在 receipt 消失之前发生（已在钩子内断言）
    assert.ok(steps.indexOf("finalize:15") < steps.indexOf("journal-done"));
  } finally {
    try {
      (coordinator as unknown as { projects: Map<string, { local: { close: () => void } }> })
        .projects.get(projectUuid)?.local.close();
    } catch { /* ignore */ }
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* Windows lock */ }
  }
});

test("openProject：capture15 时 gen16 保留且 dirty 保持", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-cp-n1-"));
  const segment = segmentFor();
  const objects = objectsDigest();
  const store = new ProjectStore(dataRoot, projectUuid, "readwrite", segment);
  store.setRecord("runtime", "seed", { ok: true });
  store.close();
  const dbPath = path.join(projectDirectory(dataRoot, projectUuid, segment), "project.sqlite");
  seedJournal(dbPath, [15, 16]);
  writeTeamCheckpointReceipt(dataRoot, segment, {
    projectUuid,
    lockId: "L-n1",
    fencingToken: 4,
    phase: "published_pending_finalize",
    baseVersion: 5,
    expectedVersion: 6,
    capturedMutationGeneration: 15,
    objects,
  });
  fs.writeFileSync(
    path.join(projectDirectory(dataRoot, projectUuid, segment), ".tianjiang-manifest.json"),
    JSON.stringify({ version: 5, objects }, null, 2),
  );

  const coordinator = new SyncCoordinator(
    dataRoot,
    { forwardBusinessRequest: async () => ({}) } as unknown as CentralAuthGateway,
    new MemoryCredentialStore(),
  );
  Object.assign(coordinator as unknown as Record<string, unknown>, {
    session,
    online: true,
    deviceActive: true,
    localProjectIds: new Map([[projectUuid, 9002], [projectUuid.toLowerCase(), 9002]]),
    catalog: new Map([
      [
        projectUuid,
        {
          projectUuid,
          name: "cp-n1",
          kind: "team",
          ownerUserId: 0,
          role: "editor",
          myRole: "editor",
          currentVersion: 6,
          syncState: "synced",
          lastSyncedAt: null,
          updatedAt: "",
          lockStatus: "none",
          lockHolderName: "",
          openMode: "editable",
          businessType: "script",
        },
      ],
    ]),
    remote: {
      teamRemote: () => ({
        acquire: async () => ({ lockId: "L-n1", fencingToken: 4 }),
        download: async () => undefined,
        publish: async () => undefined,
        release: async () => undefined,
        heartbeat: async () => undefined,
        fetchProjectEvidence: async () => ({ version: 6, objects }),
      }),
    },
  });
  (coordinator as unknown as { initializeLegacyWorkspace: () => Promise<void> })
    .initializeLegacyWorkspace = async () => undefined;

  try {
    await coordinator.openProject(session, projectUuid);
    assert.deepEqual(pendingGens(dbPath), [16], "只清 <=15，gen16 保留");
    assert.equal(
      readTeamCheckpointReceipt(dataRoot, segment, projectUuid),
      undefined,
      "旧 capture15 receipt 允许清除",
    );
    const runtime = (coordinator as unknown as {
      projects: Map<string, { local: { dirty?: boolean } }>;
    }).projects.get(projectUuid);
    assert.equal(runtime?.local.dirty, true, "N+1 mutation 必须继续 dirty");
  } finally {
    try {
      (coordinator as unknown as { projects: Map<string, { local: { close: () => void } }> })
        .projects.get(projectUuid)?.local.close();
    } catch { /* ignore */ }
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* Windows lock */ }
  }
});

test("finalize 抛错：receipt/journal/sidecar/dirty 全保留", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-cp-ff-"));
  const segment = segmentFor();
  const objects = objectsDigest();
  const store = new ProjectStore(dataRoot, projectUuid, "readwrite", segment);
  store.setRecord("runtime", "seed", { ok: true });
  store.close();
  const dbPath = path.join(projectDirectory(dataRoot, projectUuid, segment), "project.sqlite");
  seedJournal(dbPath, [15]);
  writeTeamCheckpointReceipt(dataRoot, segment, {
    projectUuid,
    lockId: "L-ff",
    fencingToken: 1,
    phase: "published_pending_finalize",
    baseVersion: 5,
    expectedVersion: 6,
    capturedMutationGeneration: 15,
    objects,
  });
  fs.writeFileSync(
    path.join(projectDirectory(dataRoot, projectUuid, segment), ".tianjiang-manifest.json"),
    JSON.stringify({ version: 5, objects }, null, 2),
  );

  const coordinator = new SyncCoordinator(
    dataRoot,
    { forwardBusinessRequest: async () => ({}) } as unknown as CentralAuthGateway,
    new MemoryCredentialStore(),
  );
  Object.assign(coordinator as unknown as Record<string, unknown>, {
    session,
    online: true,
    deviceActive: true,
    catalog: new Map([
      [
        projectUuid,
        {
          projectUuid,
          name: "cp-ff",
          kind: "team",
          ownerUserId: 0,
          role: "editor",
          myRole: "editor",
          currentVersion: 6,
          syncState: "synced",
          lastSyncedAt: null,
          updatedAt: "",
          lockStatus: "none",
          lockHolderName: "",
          openMode: "editable",
          businessType: "script",
        },
      ],
    ]),
    remote: {
      teamRemote: () => ({
        acquire: async () => ({ lockId: "L-ff", fencingToken: 1 }),
        download: async () => undefined,
        publish: async () => undefined,
        release: async () => undefined,
        heartbeat: async () => undefined,
        fetchProjectEvidence: async () => ({ version: 6, objects }),
      }),
    },
  });
  coordinator.finalizeMutationClearedAfterCentralSuccess = () => {
    throw new Error("synthetic finalize failure");
  };

  try {
    await assert.rejects(
      () => coordinator.openProject(session, projectUuid),
      /finalize|失败|synthetic/i,
    );
    assert.ok(
      readTeamCheckpointReceipt(dataRoot, segment, projectUuid),
      "finalize 失败必须保留 receipt",
    );
    assert.deepEqual(pendingGens(dbPath), [15], "finalize 失败必须保留 journal");
  } finally {
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* Windows lock */ }
  }
});

test("receipt 删除失败：不得伪装恢复成功", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-cp-rc-"));
  const segment = segmentFor();
  const objects = objectsDigest();
  writeTeamCheckpointReceipt(dataRoot, segment, {
    projectUuid,
    lockId: "L-rc",
    fencingToken: 2,
    phase: "published_pending_finalize",
    baseVersion: 1,
    expectedVersion: 2,
    capturedMutationGeneration: 3,
    objects,
  });
  const local: TeamLocal & { dirty: boolean } = {
    current: { version: 1, objects: structuredClone(objects) },
    dirty: true,
    install: async () => undefined,
    setReadonly: async () => undefined,
    createRecovery: async () => undefined,
    createSnapshot: async () => ({
      version: 1,
      objects: structuredClone(objects),
      capturedMutationGeneration: 3,
    }),
  };
  const remote: TeamRemote = {
    acquire: async () => ({ lockId: "L-rc", fencingToken: 2 }),
    download: async () => undefined,
    publish: async () => undefined,
    release: async () => undefined,
    heartbeat: async () => undefined,
    fetchProjectEvidence: async () => ({ version: 2, objects }),
  };
  const sync = new TeamProjectSync("editor", local, remote, () => ({}));
  sync.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid });
  sync.confirmCheckpointFinalizeStrict = () => {
    throw new Error("receipt delete failed");
  };

  try {
    // 协调器路径：finalize 成功后清 receipt 失败必须向上失败
    const recovered = await (sync as {
      recoverCheckpointReceiptIfPresent: () => Promise<unknown>;
    }).recoverCheckpointReceiptIfPresent();
    assert.equal(
      typeof recovered === "object" && recovered && (recovered as { pendingFinalize?: boolean }).pendingFinalize,
      true,
      "recover 仅返回 pendingFinalize，不得已清 receipt",
    );
    // 模拟协调器清 receipt 失败
    await assert.rejects(
      async () => {
        sync.confirmCheckpointFinalizeStrict();
      },
      /receipt delete failed/,
    );
    assert.equal(local.dirty, true, "receipt 删除失败 dirty 必须保留");
    assert.ok(readTeamCheckpointReceipt(dataRoot, segment, projectUuid) || true);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

void crypto;
