/**
 * 第 6 轮 round6g RED：
 * - generation 从 snapshot 副本捕获（backup 后 N+1 不影响 captured）
 * - captured=0 / unknown 语义
 * - edit epoch 与二次上传
 * - 全同步入口 finalize
 * - Team release receipt 持久化与重启
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { RuntimeProjectLocal } from "../../src/tianjiang/runtime/project-runtime-local";
import { projectDirectory } from "../../src/tianjiang/data/paths";
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

const worktreeRoot = path.resolve(__dirname, "../..", "..");

function seedJournal(
  dbPath: string,
  gens: number[],
  status: "pending" | "cleared" = "pending",
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
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO o_legacyMutationJournal (source, status, generation, createdAt, updatedAt)
     VALUES ('scriptAgent', ?, ?, ?, ?)`,
  );
  for (const g of gens) ins.run(status, g, now, now);
  db.close();
}

function pendingGens(dbPath: string): number[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
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

function insertPendingGen(dbPath: string, generation: number): void {
  const db = new Database(dbPath);
  const now = Date.now();
  db.prepare(
    `INSERT INTO o_legacyMutationJournal (source, status, generation, createdAt, updatedAt)
     VALUES ('scriptAgent', 'pending', ?, ?, ?)`,
  ).run(generation, now, now);
  db.close();
}

// ---------- 1) backup 后 N+1：captured 仍为 N ----------
test("RED：backup 完成后插入 N+1，captured 仍为快照中的 N", async () => {
  const runId = `cap-${process.pid}-${Date.now()}`;
  const dataRoot = path.join(worktreeRoot, ".tmp", "r6g-cap", runId, "data");
  const segment = "c".repeat(32);
  const projectUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const projectRoot = projectDirectory(dataRoot, projectUuid, segment);
  fs.mkdirSync(path.join(projectRoot, "files"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, ".tianjiang-manifest.json"),
    JSON.stringify({
      version: 1,
      objects: [{ relativePath: "project.sqlite", md5: "m1" }],
    }),
  );
  const local = new RuntimeProjectLocal(dataRoot, projectUuid, segment);
  await local.install(false);
  local.setWritable();
  const livePath = path.join(projectRoot, "project.sqlite");
  local.close();
  // 关闭 store 后再写 journal，避免 Windows 下并发句柄 SQLITE_CANTOPEN
  seedJournal(livePath, [5]);

  const local2 = new RuntimeProjectLocal(dataRoot, projectUuid, segment);
  await local2.install(false);
  local2.setWritable();
  assert.equal(typeof (local2.createSnapshot as any), "function");
  let snap: PersonalManifest;
  try {
    snap = await local2.createSnapshot({
      afterBackup: () => {
        // 模拟上传期间/backup 后 live 再提交 N+1
        try {
          insertPendingGen(livePath, 6);
        } catch (err) {
          throw new Error(
            `afterBackup insert failed: ${err instanceof Error ? err.message : String(err)} live=${livePath}`,
          );
        }
      },
    } as any);
  } catch (err) {
    throw new Error(
      `createSnapshot failed: ${err instanceof Error ? `${err.message} ${(err as any).code ?? ""}` : String(err)}`,
    );
  }
  assert.equal(
    (snap as any).capturedMutationGeneration,
    5,
    "captured 必须来自 snapshot 副本中的 N=5，不是 live 的 6",
  );
  assert.deepEqual(pendingGens(livePath), [5, 6], "live 仍含 N 与 N+1");
  local2.close();
});

// ---------- 2) N 成功后 N+1 pending + 二次上传 ----------
test("RED：N 上传成功后 N+1 仍 pending dirty，并完成第二次上传", async () => {
  const journal = await import("../../src/tianjiang/runtime/legacy-mutation-journal");
  const tmp = path.join(worktreeRoot, ".tmp", "r6g-n1", String(Date.now()));
  const dbPath = path.join(tmp, "project.sqlite");
  seedJournal(dbPath, [1, 2]);

  // clear 仅 N=1
  const r1 = (journal as any).clearPendingMutationJournalOnFile(dbPath, {
    captured: 1,
  });
  assert.ok(r1);
  assert.deepEqual(pendingGens(dbPath), [2]);

  class Local implements PersonalLocal {
    current: PersonalManifest = {
      version: 1,
      objects: [{ relativePath: "project.sqlite", md5: "v1" }],
    };
    dirty = true;
    snapshots = 0;
    async install(remote: PersonalManifest): Promise<void> {
      this.current = structuredClone(remote);
    }
    async createSnapshot(): Promise<PersonalManifest> {
      this.snapshots += 1;
      const gen = this.snapshots === 1 ? 1 : 2;
      return {
        version: 1,
        objects: [{ relativePath: "project.sqlite", md5: `snap-${gen}` }],
        capturedMutationGeneration: gen,
      } as PersonalManifest;
    }
    async createRecovery(): Promise<void> {}
  }
  class Remote implements PersonalRemote {
    current: PersonalManifest = {
      version: 1,
      objects: [{ relativePath: "project.sqlite", md5: "base" }],
    };
    publishes: string[] = [];
    async latest() {
      return structuredClone(this.current);
    }
    async publish(base: number, next: PersonalManifest) {
      this.publishes.push(next.objects[0]!.md5);
      this.current = { version: base + 1, objects: structuredClone(next.objects) };
      return structuredClone(this.current);
    }
  }
  const local = new Local();
  const remote = new Remote();
  const scheduled: Array<() => void> = [];
  const sync = new PersonalProjectSync(local, remote, () => true, (run) => {
    scheduled.push(run as () => void);
    return 0;
  });
  sync.open();
  const r = await sync.sync("manual");
  assert.equal(r.state, "synced");
  assert.equal((r as any).capturedMutationGeneration, 1);
  // 模拟 finalize：清 gen<=1，剩余 gen2 → dirty + 调度
  assert.equal(typeof (sync as any).applyMutationFinalizeResult, "function");
  (sync as any).applyMutationFinalizeResult({
    remainingPending: true,
    editEpochUnchanged: true,
  });
  assert.equal(local.dirty, true);
  // 第二次同步
  const r2 = await sync.sync("manual");
  assert.equal(r2.state, "synced");
  assert.equal((r2 as any).capturedMutationGeneration, 2);
  assert.equal(remote.publishes.length, 2, "必须实际完成第二次上传");
});

// ---------- 3) captured=0 不得清后续 generation ----------
test("RED：快照无 pending 时 captured=0；其后新 generation 不得被 finalize 清除", async () => {
  const journal = await import("../../src/tianjiang/runtime/legacy-mutation-journal");
  const tmp = path.join(worktreeRoot, ".tmp", "r6g-zero", String(Date.now()));
  const dbPath = path.join(tmp, "project.sqlite");
  // 无 pending
  seedJournal(dbPath, [9], "cleared");
  const probeSnap = (journal as any).readMutationCaptureFromSqliteFile(dbPath);
  assert.equal(probeSnap.kind === "none" || probeSnap === 0 || probeSnap.value === 0, true);

  // 上传后 live 新增 generation 10
  insertPendingGen(dbPath, 10);
  // finalize with captured=0 不得清 10
  assert.throws(
    () => {
      // 旧 API undefined 清全部必须禁止
      (journal as any).clearPendingMutationJournalOnFile(dbPath);
    },
    /captured|generation|禁止|required/i,
  );
  (journal as any).clearPendingMutationJournalOnFile(dbPath, { captured: 0 });
  assert.deepEqual(pendingGens(dbPath), [10], "captured=0 不得清除 generation 10");
});

// ---------- 4) captured 缺失 / 锁定 / 损坏：clear 失败且 pending 全保留 ----------
test("RED：captured 缺失或探测失败时 clear 失败且 pending 全保留", async () => {
  const journal = await import("../../src/tianjiang/runtime/legacy-mutation-journal");
  const tmp = path.join(worktreeRoot, ".tmp", "r6g-failclear", String(Date.now()));
  const dbPath = path.join(tmp, "project.sqlite");
  seedJournal(dbPath, [3, 4]);

  await assert.rejects(async () => {
    (journal as any).clearPendingMutationJournalOnFile(dbPath, { captured: "unknown" });
  });
  await assert.rejects(async () => {
    (journal as any).clearPendingMutationJournalOnFile(dbPath, {});
  });
  assert.deepEqual(pendingGens(dbPath), [3, 4]);

  const bad = path.join(tmp, "bad.sqlite");
  fs.writeFileSync(bad, "not-sqlite");
  const probe = (journal as any).probeProjectMutationJournal(bad);
  assert.equal(probe.ok, false);
  assert.equal(probe.pending, true);
});

// ---------- 5) 全同步入口消费 finalize ----------
test("RED：idle/checkpoint/manual/close 结果均带 mutationCapture 供 finalize", async () => {
  class Local implements PersonalLocal {
    current: PersonalManifest = {
      version: 1,
      objects: [{ relativePath: "project.sqlite", md5: "x" }],
    };
    dirty = true;
    async install(r: PersonalManifest) {
      this.current = structuredClone(r);
    }
    async createSnapshot(): Promise<PersonalManifest> {
      return {
        version: 1,
        objects: [{ relativePath: "project.sqlite", md5: `u-${Date.now()}` }],
        capturedMutationGeneration: 2,
      } as PersonalManifest;
    }
    async createRecovery() {}
  }
  class Remote implements PersonalRemote {
    current: PersonalManifest = {
      version: 1,
      objects: [{ relativePath: "project.sqlite", md5: "base" }],
    };
    async latest() {
      return structuredClone(this.current);
    }
    async publish(base: number, next: PersonalManifest) {
      this.current = { version: base + 1, objects: next.objects };
      return structuredClone(this.current);
    }
  }
  for (const reason of ["idle", "checkpoint", "manual", "close"] as const) {
    const local = new Local();
    local.dirty = true;
    const sync = new PersonalProjectSync(local, new Remote(), () => true);
    sync.open();
    const result =
      reason === "close" ? await sync.close() : await sync.sync(reason);
    assert.ok(
      result.state === "synced" || result.state === "unchanged" || result.state === "offline_pending",
    );
    if (result.state === "synced") {
      assert.equal(
        typeof (result as any).capturedMutationGeneration === "number" ||
          (result as any).mutationCapture != null,
        true,
        `${reason} 必须带回 capture`,
      );
    }
  }
});

// ---------- 6) edit epoch：上传期间编辑不得清 dirty ----------
test("RED：上传期间新编辑时 epoch 变化，成功后 dirty 保持", async () => {
  let inPublish = false;
  class Local implements PersonalLocal {
    current: PersonalManifest = {
      version: 1,
      objects: [{ relativePath: "project.sqlite", md5: "a" }],
    };
    dirty = true;
    async install(r: PersonalManifest) {
      this.current = structuredClone(r);
    }
    async createSnapshot(): Promise<PersonalManifest> {
      return {
        version: 1,
        objects: [{ relativePath: "project.sqlite", md5: "b" }],
        capturedMutationGeneration: 1,
      } as PersonalManifest;
    }
    async createRecovery() {}
  }
  class Remote implements PersonalRemote {
    current: PersonalManifest = {
      version: 1,
      objects: [{ relativePath: "project.sqlite", md5: "a" }],
    };
    async latest() {
      return structuredClone(this.current);
    }
    async publish(base: number, next: PersonalManifest) {
      inPublish = true;
      // 模拟上传中编辑
      sync.markEdited();
      inPublish = false;
      this.current = { version: base + 1, objects: next.objects };
      return structuredClone(this.current);
    }
  }
  const local = new Local();
  const remote = new Remote();
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();
  const result = await sync.sync("manual");
  assert.equal(result.state, "synced");
  assert.equal(local.dirty, true, "上传期间有新编辑则 dirty 必须保留");
  void inPublish;
});

// ---------- 7) Team release receipt 持久化，重启禁止重复 publish ----------
test("RED：Team publish 成功 release 连续失败后重启，禁止重复 publish，可恢复 release", async () => {
  const dataRoot = path.join(worktreeRoot, ".tmp", "r6g-receipt", String(Date.now()));
  const segment = "d".repeat(32);
  const projectUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  fs.mkdirSync(dataRoot, { recursive: true });

  const events: string[] = [];
  let releaseFailLeft = 3;
  const makeLocal = (): TeamLocal => ({
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
        capturedMutationGeneration: 3,
      } as PersonalManifest;
    },
  });
  const makeRemote = (): TeamRemote => ({
    async acquire() {
      events.push("acquire");
      return { lockId: "L-r6g", fencingToken: 7 };
    },
    async download() {
      events.push("download");
    },
    async publish() {
      events.push("publish");
    },
    async release() {
      events.push("release");
      if (releaseFailLeft > 0) {
        releaseFailLeft -= 1;
        throw new Error("release failed");
      }
    },
    async heartbeat() {
      events.push("heartbeat");
    },
  });

  // 进程 1：publish 成功，release 失败，应落盘 receipt
  {
    const scheduleUnref = (run: () => void, delay: number) => {
      const t = setTimeout(run, delay);
      t.unref?.();
      return t;
    };
    const sync = new TeamProjectSync(
      "editor",
      makeLocal(),
      makeRemote(),
      () => ({}),
      scheduleUnref,
      60_000,
    );
    // 注入持久化路径
    assert.equal(typeof (sync as any).configureReleaseReceiptStore, "function");
    (sync as any).configureReleaseReceiptStore({
      dataRoot,
      userSegment: segment,
      projectUuid,
    });
    await sync.open();
    await assert.rejects(() => sync.close());
    const receiptPath = path.join(
      dataRoot,
      "runtime-users",
      segment,
      "team-release-receipts",
      `${projectUuid}.json`,
    );
    assert.equal(fs.existsSync(receiptPath), true, "release-pending receipt 必须落盘");
  }

  // 进程 2：新 runtime，不得 publish，只 release
  events.length = 0;
  releaseFailLeft = 0;
  {
    const scheduleUnref = (run: () => void, delay: number) => {
      const t = setTimeout(run, delay);
      t.unref?.();
      return t;
    };
    const sync2 = new TeamProjectSync(
      "editor",
      makeLocal(),
      makeRemote(),
      () => ({}),
      scheduleUnref,
      60_000,
    );
    (sync2 as any).configureReleaseReceiptStore({
      dataRoot,
      userSegment: segment,
      projectUuid,
    });
    await sync2.open();
    // open 时 protect 与 receipt 恢复
    assert.equal(typeof (sync2 as any).restoreReleaseReceiptIfPresent, "function");
    (sync2 as any).restoreReleaseReceiptIfPresent();
    const result = await sync2.close();
    // release 成功后 Team 返回 released_cleanup_pending（协调器 finalize 后才 published）
    assert.equal((result as any).state, "released_cleanup_pending");
    assert.equal(events.filter((e) => e === "publish").length, 0, "重启后禁止重复 publish");
    assert.ok(events.includes("release"));
  }
});

// ---------- 8) Team pending 远端版本前进 → 立即 recovery ----------
test("RED：Team pending 打开时远端版本已前进则立即只读 recovery，不 download", async () => {
  const events: string[] = [];
  const local: TeamLocal & { current?: PersonalManifest } = {
    current: {
      version: 2,
      objects: [{ relativePath: "project.sqlite", md5: "local" }],
    },
    async install() {
      events.push("install");
    },
    async setReadonly(reason: string) {
      events.push(`readonly:${reason}`);
    },
    async createRecovery(reason: string) {
      events.push(`recovery:${reason}`);
    },
    async createSnapshot() {
      return this.current!;
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
    async publish() {},
    async release() {},
    async heartbeat() {},
    async latestVersion() {
      return 5;
    },
  } as TeamRemote;
  const sync = new TeamProjectSync("editor", local, remote, () => ({}));
  sync.setProtectPendingLocal(true);
  await sync.open();
  assert.ok(!events.includes("download"), "远端已前进不得 download");
  assert.equal(sync.state().editable, false);
  assert.equal(sync.state().recoveryRequired, true);
  assert.ok(events.some((e) => e.startsWith("recovery:")));
});

// ---------- 9) probe 不用 existsSync 伪 missing；ENOENT 以外 fail-closed ----------
test("RED：probe 仅 ENOENT 视为 missing，其余 fail-closed", async () => {
  const journal = await import("../../src/tianjiang/runtime/legacy-mutation-journal");
  const missing = path.join(
    worktreeRoot,
    ".tmp",
    "r6g-enoent",
    String(Date.now()),
    "no-such.sqlite",
  );
  const p = (journal as any).probeProjectMutationJournal(missing);
  assert.equal(p.ok, true);
  assert.equal(p.missing, true);
  assert.equal(p.pending, false);
});

// ---------- 10) 快照剥离后可验证无 pending 行且表结构保留 ----------
test("RED：strip journal 后快照无 pending 行且保留表结构", async () => {
  const journal = await import("../../src/tianjiang/runtime/legacy-mutation-journal");
  const tmp = path.join(worktreeRoot, ".tmp", "r6g-strip", String(Date.now()));
  const snap = path.join(tmp, "snap.sqlite");
  seedJournal(snap, [1, 2]);
  await (journal as any).stripMutationJournalFromSnapshotFile(snap);
  assert.deepEqual(pendingGens(snap), []);
  const db = new Database(snap, { readonly: true });
  try {
    const table = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?")
      .get("o_legacyMutationJournal");
    assert.ok(table, "必须保留空表结构");
    const cnt = db.prepare("SELECT COUNT(*) AS c FROM o_legacyMutationJournal").get() as {
      c: number;
    };
    assert.equal(cnt.c, 0);
  } finally {
    db.close();
  }
});
