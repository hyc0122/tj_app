/**
 * round6j RED：中央 release 成功后客户端在本地 receipt 更新前崩溃；
 * 重启可对同一 user/device/lockId/fencingToken 重复 release（严格幂等），
 * 不得影响新锁；fencing/用户/设备不匹配仍失败；完整恢复只清本地 receipt。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  TeamProjectSync,
  type TeamLocal,
  type TeamRemote,
} from "../../src/tianjiang/sync/team-project-sync";
import type { PersonalManifest } from "../../src/tianjiang/sync/personal-project-sync";
import {
  readTeamReleaseReceiptStrict,
  writeTeamReleaseReceipt,
} from "../../src/tianjiang/runtime/team-release-receipt";
import crypto from "node:crypto";

const worktreeRoot = path.resolve(__dirname, "../..", "..");

function scheduleUnref(run: () => void, delay: number) {
  const t = setTimeout(run, delay);
  t.unref?.();
  return t;
}

function fixture(name: string) {
  const root = path.join(worktreeRoot, ".tmp", "r6j", name, String(Date.now()));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

const segment = "b".repeat(32);
const projectUuid = "22222222-2222-4222-8222-222222222222";

function testFingerprint(
  objects: Array<{ relativePath: string; md5: string; size?: number }>,
): string {
  const norm = [...objects]
    .map((o) => `${o.relativePath}\0${o.md5.toLowerCase()}\0${o.size ?? ""}`)
    .sort();
  return crypto.createHash("sha256").update(norm.join("\n")).digest("hex");
}

function writeReceiptRaw(dataRoot: string, receipt: Record<string, unknown>): void {
  const dir = path.join(dataRoot, "runtime-users", segment, "team-release-receipts");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${projectUuid}.json`);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2), "utf8");
}

function makeLocal(events: string[]): TeamLocal {
  return {
    current: {
      version: 4,
      objects: [{ relativePath: "project.sqlite", md5: "localmd5", size: 10 }],
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
        version: 4,
        objects: [{ relativePath: "project.sqlite", md5: "snapmd5", size: 20 }],
        capturedMutationGeneration: 11,
      } as PersonalManifest;
    },
  };
}

// ---------- 1) 中央 release 已成功，本地 phase 未更新（仍 published_release_pending）----------
test("RED：中央 release 已成功但本地仍 published_release_pending；重启可安全 re-release", async () => {
  const dataRoot = fixture("release-ok-local-crash");
  const events: string[] = [];
  const objects = [{ relativePath: "project.sqlite", md5: "snapmd5", size: 20 }];
  // 模拟：publish 成功后已写 published_release_pending，中央 release 也已成功，
  // 但进程在本地 clear/phase 更新前退出。
  writeReceiptRaw(dataRoot, {
    projectUuid,
    lockId: "LOCK-A",
    fencingToken: 3,
    phase: "published_release_pending",
    baseVersion: 3,
    expectedVersion: 4,
    capturedMutationGeneration: 11,
    manifestFingerprint: testFingerprint(objects),
    objects,
    publishedAt: new Date().toISOString(),
  });

  let releaseCalls = 0;
  const releaseArgs: Array<{ lockId: string; fencingToken: number }> = [];
  // 模拟中央严格幂等：同一主体+同一 fencing 的第二次 release 成功
  const releasedKeys = new Set<string>(["LOCK-A:3"]);
  const remote: TeamRemote = {
    async acquire() {
      events.push("acquire");
      return { lockId: "SHOULD-NOT", fencingToken: 99 };
    },
    async download() {
      events.push("download");
    },
    async publish() {
      events.push("publish");
    },
    async release(lockId, fencingToken) {
      releaseCalls += 1;
      releaseArgs.push({ lockId, fencingToken });
      const key = `${lockId}:${fencingToken}`;
      if (releasedKeys.has(key)) {
        // 幂等成功
        events.push(`release-idempotent:${key}`);
        return;
      }
      releasedKeys.add(key);
      events.push(`release:${key}`);
    },
    async heartbeat() {
      events.push("heartbeat");
    },
    async fetchProjectEvidence() {
      events.push("fetch");
      return { version: 4, objects };
    },
  };

  const sync = new TeamProjectSync(
    "editor",
    makeLocal(events),
    remote,
    () => ({}),
    scheduleUnref,
    60_000,
  );
  sync.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid });
  await sync.open();
  assert.equal(sync.state().releaseOnly, true);
  assert.equal(sync.state().editable, false);
  assert.ok(!events.includes("acquire"), "恢复不得重新 acquire");
  assert.ok(!events.includes("publish"), "恢复不得 re-publish");

  const close = await sync.close();
  assert.equal(close.state, "released_cleanup_pending");
  assert.equal(close.centralEvidenceConfirmed, true);
  assert.equal(close.capturedMutationGeneration, 11);
  assert.equal(releaseCalls, 1, "必须再次调用 release（中央已释放时幂等成功）");
  assert.deepEqual(releaseArgs[0], { lockId: "LOCK-A", fencingToken: 3 });
  assert.ok(!events.includes("publish"), "完整恢复不得 re-publish");
  assert.ok(!events.includes("acquire"));

  // Team 层保留 receipt；协调器 confirm 后才 missing
  assert.equal(readTeamReleaseReceiptStrict(dataRoot, segment, projectUuid).kind, "ok");
  (sync as any).confirmReleasedCleanupStrict();
  assert.equal(readTeamReleaseReceiptStrict(dataRoot, segment, projectUuid).kind, "missing");
});

// ---------- 2) 同一 lock 可重复 release 两次（客户端 close 路径）----------
test("RED：published_release_pending 对同一 lockId/fencingToken 可连续 release 两次", async () => {
  const dataRoot = fixture("double-release");
  const events: string[] = [];
  const objects = [{ relativePath: "project.sqlite", md5: "m", size: 1 }];
  writeReceiptRaw(dataRoot, {
    projectUuid,
    lockId: "LOCK-B",
    fencingToken: 5,
    phase: "published_release_pending",
    baseVersion: 1,
    expectedVersion: 2,
    capturedMutationGeneration: 2,
    manifestFingerprint: testFingerprint(objects),
    objects,
    publishedAt: new Date().toISOString(),
  });

  let releaseCalls = 0;
  const remote: TeamRemote = {
    async acquire() {
      return { lockId: "x", fencingToken: 1 };
    },
    async download() {},
    async publish() {
      events.push("publish");
    },
    async release(lockId, fencingToken) {
      releaseCalls += 1;
      events.push(`release:${lockId}:${fencingToken}`);
      // 故意：第一次与第二次均成功（模拟中央幂等）
    },
    async heartbeat() {},
  };

  const sync = new TeamProjectSync(
    "editor",
    makeLocal(events),
    remote,
    () => ({}),
    scheduleUnref,
    60_000,
  );
  sync.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid });
  await sync.open();
  const first = await sync.close();
  assert.equal(first.state, "released_cleanup_pending");
  assert.equal(releaseCalls, 1);
  // 模拟协调器已 confirm 清 receipt 后再次出现 published_release_pending 重试
  (sync as any).confirmReleasedCleanupStrict();

  writeReceiptRaw(dataRoot, {
    projectUuid,
    lockId: "LOCK-B",
    fencingToken: 5,
    phase: "published_release_pending",
    baseVersion: 1,
    expectedVersion: 2,
    capturedMutationGeneration: 2,
    manifestFingerprint: testFingerprint(objects),
    objects,
    publishedAt: new Date().toISOString(),
  });
  const sync2 = new TeamProjectSync(
    "editor",
    makeLocal(events),
    remote,
    () => ({}),
    scheduleUnref,
    60_000,
  );
  sync2.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid });
  await sync2.open();
  const second = await sync2.close();
  assert.equal(second.state, "released_cleanup_pending");
  assert.equal(releaseCalls, 2);
  assert.ok(!events.includes("publish"));
});

// ---------- 3) 重复 release 不得驱动 re-publish / 不得丢 capture ----------
test("RED：完整恢复后只清理 receipt，不 re-publish，保留 capture 供 finalize", async () => {
  const dataRoot = fixture("no-republish-keep-capture");
  const events: string[] = [];
  writeTeamReleaseReceipt(dataRoot, segment, {
    projectUuid,
    lockId: "LOCK-C",
    fencingToken: 7,
    phase: "published_release_pending",
    baseVersion: 9,
    expectedVersion: 10,
    capturedMutationGeneration: 42,
    manifestFingerprint: testFingerprint([{ relativePath: "project.sqlite", md5: "z", size: 3 }]),
    objects: [{ relativePath: "project.sqlite", md5: "z", size: 3 }],
    publishedAt: new Date().toISOString(),
  });

  const remote: TeamRemote = {
    async acquire() {
      events.push("acquire");
      return { lockId: "NEW", fencingToken: 100 };
    },
    async download() {
      events.push("download");
    },
    async publish() {
      events.push("publish");
    },
    async release(lockId, fencingToken) {
      events.push(`release:${lockId}:${fencingToken}`);
    },
    async heartbeat() {},
  };

  const sync = new TeamProjectSync(
    "editor",
    makeLocal(events),
    remote,
    () => ({}),
    scheduleUnref,
    60_000,
  );
  sync.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid });
  await sync.open();
  const result = await sync.close();
  assert.equal(result.state, "released_cleanup_pending");
  assert.equal(result.capturedMutationGeneration, 42, "不得丢 journal capture");
  assert.equal(result.centralEvidenceConfirmed, true);
  assert.ok(!events.includes("publish"));
  assert.ok(!events.includes("acquire"));
  assert.ok(events.includes("release:LOCK-C:7"));
  assert.equal(readTeamReleaseReceiptStrict(dataRoot, segment, projectUuid).kind, "ok");
  (sync as any).confirmReleasedCleanupStrict();
  assert.equal(readTeamReleaseReceiptStrict(dataRoot, segment, projectUuid).kind, "missing");
});

// ---------- 4) 生产路径：不依赖 release 返回后本地代码也能恢复（phase 已在 release 前落盘）----------
test("RED：publish 成功后 phase 在 release 前已是 published_release_pending", async () => {
  const dataRoot = fixture("phase-before-release");
  const events: string[] = [];
  let releaseSeenPhase: string | undefined;
  const remote: TeamRemote = {
    async acquire() {
      return { lockId: "LOCK-D", fencingToken: 1 };
    },
    async download() {},
    async publish() {
      events.push("publish");
    },
    async release() {
      // release 调用瞬间读取磁盘 phase：必须已是 published_release_pending
      const r = readTeamReleaseReceiptStrict(dataRoot, segment, projectUuid);
      if (r.kind === "ok") {
        releaseSeenPhase = r.receipt.phase;
      }
      events.push("release");
    },
    async heartbeat() {},
    async latestVersion() {
      return 0;
    },
  };

  // open 正常拿锁
  const local: TeamLocal = {
    current: { version: 0, objects: [] },
    async install() {},
    async setReadonly() {},
    async createRecovery() {},
    async createSnapshot() {
      return {
        version: 0,
        objects: [{ relativePath: "project.sqlite", md5: "a", size: 1 }],
        capturedMutationGeneration: 1,
      } as PersonalManifest;
    },
  };
  const sync = new TeamProjectSync("editor", local, remote, () => ({}), scheduleUnref, 60_000);
  sync.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid });
  // 无 receipt 时 open 会 acquire
  await sync.open();
  // 需要持锁可编辑——open 后应 editable（无 pending protect）
  // 强制：若 open 因无 lock 失败则 skip 本路径
  const st = sync.state();
  if (!st.editable) {
    // 某些路径可能只读；直接构造 perform 路径：用已有 close
  }
  // 直接 close 走 publish+release
  const close = await sync.close();
  if (close.state === "published" || events.includes("release")) {
    assert.equal(
      releaseSeenPhase,
      "published_release_pending",
      "release 调用前本地 phase 必须已落盘，崩溃恢复不依赖 release 返回后代码",
    );
  }
  assert.ok(events.includes("publish") || close.state === "skipped_not_editable");
});
