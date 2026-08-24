/**
 * round6i RED：Team receipt 崩溃边界与中央证据门禁
 * - publishing 写入后 publish 前崩溃
 * - commitVersion 成功但客户端未收到
 * - publishing 期间远端被他人推进
 * - receipt 删除失败
 * - released_cleanup_pending 重启不得再 publish/release
 * - 无中央版本+manifest 摘要证据不得 published / 清 journal
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
  clearTeamReleaseReceipt,
  readTeamReleaseReceiptStrict,
  writeTeamReleaseReceipt,
  type TeamReleaseReceipt,
} from "../../src/tianjiang/runtime/team-release-receipt";
import crypto from "node:crypto";

const worktreeRoot = path.resolve(__dirname, "../..", "..");

function scheduleUnref(run: () => void, delay: number) {
  const t = setTimeout(run, delay);
  t.unref?.();
  return t;
}

function fixture(name: string) {
  const root = path.join(worktreeRoot, ".tmp", "r6i", name, String(Date.now()));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

const segment = "a".repeat(32);
const projectUuid = "11111111-1111-4111-8111-111111111111";

/** 测试侧指纹算法（与生产约定一致：排序 path+md5+size 后 sha256） */
function testFingerprint(
  objects: Array<{ relativePath: string; md5: string; size?: number }>,
): string {
  const norm = [...objects]
    .map((o) => `${o.relativePath}\0${o.md5.toLowerCase()}\0${o.size ?? ""}`)
    .sort();
  return crypto.createHash("sha256").update(norm.join("\n")).digest("hex");
}

/** 直接落盘 receipt（绕过生产 phase 白名单，用于构造 RED 场景） */
function writeReceiptRaw(dataRoot: string, receipt: Record<string, unknown>): void {
  const dir = path.join(dataRoot, "runtime-users", segment, "team-release-receipts");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${projectUuid}.json`);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2), "utf8");
}

function makeLocal(events: string[]): TeamLocal {
  return {
    current: {
      version: 3,
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
        version: 3,
        objects: [{ relativePath: "project.sqlite", md5: "snapmd5", size: 20 }],
        capturedMutationGeneration: 7,
      } as PersonalManifest;
    },
  };
}

// ---------- 指纹 API ----------
test("RED：生产 computeManifestFingerprint 存在且与约定算法一致", async () => {
  const mod = await import("../../src/tianjiang/runtime/team-release-receipt");
  assert.equal(typeof (mod as any).computeManifestFingerprint, "function");
  const objects = [
    { relativePath: "b", md5: "2", size: 2 },
    { relativePath: "a", md5: "1", size: 1 },
  ];
  assert.equal((mod as any).computeManifestFingerprint(objects), testFingerprint(objects));
});

test("RED：未 publish 的锁释放失败必须用独立 receipt，重启只 release 后保留 mutation", async () => {
  const dataRoot = fixture("acquired-release-only");
  const events: string[] = [];
  let releaseFails = true;
  let publishCalls = 0;
  let releaseCalls = 0;
  const remote: TeamRemote = {
    async acquire() {
      events.push("acquire");
      return { lockId: "LOCK-NO-PUBLISH", fencingToken: 19 };
    },
    async download() {
      events.push("download");
    },
    async publish() {
      publishCalls += 1;
    },
    async release() {
      releaseCalls += 1;
      if (releaseFails) throw new Error("release failed before publish");
    },
    async heartbeat() {},
    async latestVersion() {
      return 4;
    },
  };

  const first = new TeamProjectSync(
    "editor",
    makeLocal(events),
    remote,
    () => ({}),
    scheduleUnref,
    60_000,
  );
  first.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid });
  first.setProtectPendingLocal(true);
  await first.open();

  const pending = readTeamReleaseReceiptStrict(dataRoot, segment, projectUuid);
  assert.equal(pending.kind, "ok");
  if (pending.kind === "ok") {
    assert.equal(
      pending.receipt.phase,
      "acquired_release_pending",
      "尚未 publish 的锁不得冒充 published_release_pending",
    );
  }
  assert.equal(publishCalls, 0);

  releaseFails = false;
  const second = new TeamProjectSync(
    "editor",
    makeLocal(events),
    remote,
    () => ({}),
    scheduleUnref,
    60_000,
  );
  second.configureReleaseReceiptStore({ dataRoot, userSegment: segment, projectUuid });
  second.setProtectPendingLocal(true);
  await second.open();
  assert.equal(second.state().releaseOnly, true);
  assert.equal(second.state().editable, false);
  const result = await second.close();
  assert.equal(result.state, "recovery_required", "未 publish 路径不得触发 mutation finalize");
  assert.equal(readTeamReleaseReceiptStrict(dataRoot, segment, projectUuid).kind, "missing");
  assert.equal(publishCalls, 0);
  assert.equal(releaseCalls, 2);
});

// ---------- 1) publishing 写入后、publish 前崩溃 ----------
test("RED：publishing receipt 后 publish 前崩溃；恢复不得误当 published", async () => {
  const dataRoot = fixture("pub-crash");
  const events: string[] = [];
  let publishCalls = 0;
  const remote: TeamRemote = {
    async acquire() {
      return { lockId: "L1", fencingToken: 1 };
    },
    async download() {},
    async publish() {
      publishCalls += 1;
      events.push("publish");
    },
    async release() {
      events.push("release");
    },
    async heartbeat() {},
    async fetchProjectEvidence() {
      // 仍在 baseVersion=3，未推进
      return {
        version: 3,
        objects: [{ relativePath: "project.sqlite", md5: "old", size: 1 }],
      };
    },
  };
  // 模拟：已写 publishing receipt，进程死在 publish 前
  const objects = [{ relativePath: "project.sqlite", md5: "snapmd5", size: 20 }];
  writeReceiptRaw(dataRoot, {
    projectUuid,
    lockId: "L1",
    fencingToken: 1,
    phase: "publishing",
    baseVersion: 3,
    expectedVersion: 4,
    capturedMutationGeneration: 7,
    manifestFingerprint: testFingerprint(objects),
    objects,
    publishedAt: new Date().toISOString(),
  });

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
  // 仍为 publishing 恢复：可重试 publish，但不得已是 release_only 当 published
  const st = sync.state();
  assert.notEqual(st.readonlyReason, "release_only_pending");
  assert.equal(st.releaseOnly, false);
  // 中央证据不足（版本未到 expected）时：允许重试 publish；若 close 返回 published 必须已调用 publish
  const close = await sync.close();
  if (close.state === "published") {
    assert.ok(publishCalls >= 1, "无中央已发布证据时不得跳过 publish 直接 published");
  }
});

// ---------- 2) commitVersion 成功但客户端未收到 ----------
test("RED：commitVersion 已成功客户端未收到：getProject 版本+摘要匹配后只 release 不 re-publish", async () => {
  const dataRoot = fixture("commit-ok-no-resp");
  const events: string[] = [];
  const objects = [{ relativePath: "project.sqlite", md5: "snapmd5", size: 20 }];
  const fp = testFingerprint(objects);
  writeReceiptRaw(dataRoot, {
    projectUuid,
    lockId: "L2",
    fencingToken: 2,
    phase: "publishing",
    baseVersion: 3,
    expectedVersion: 4,
    capturedMutationGeneration: 7,
    manifestFingerprint: fp,
    objects,
    publishedAt: new Date().toISOString(),
  });
  const remote: TeamRemote = {
    async acquire() {
      return { lockId: "L2", fencingToken: 2 };
    },
    async download() {},
    async publish() {
      events.push("publish");
    },
    async release() {
      events.push("release");
    },
    async heartbeat() {},
    async fetchProjectEvidence() {
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
  const close = await sync.close();
  assert.equal(close.state, "released_cleanup_pending");
  assert.ok(!events.includes("publish"), "证据匹配后禁止 re-publish");
  assert.ok(events.includes("release"));
  assert.equal(close.capturedMutationGeneration, 7);
  assert.equal(
    readTeamReleaseReceiptStrict(dataRoot, segment, projectUuid).kind,
    "ok",
    "Team 层不得先删 receipt",
  );
});

// ---------- 3) publishing 期间远端被他人推进 ----------
test("RED：publishing 期间远端被其他发布推进：fail-closed 不 re-publish", async () => {
  const dataRoot = fixture("remote-advanced");
  const events: string[] = [];
  const objects = [{ relativePath: "project.sqlite", md5: "mine", size: 20 }];
  writeReceiptRaw(dataRoot, {
    projectUuid,
    lockId: "L3",
    fencingToken: 3,
    phase: "publishing",
    baseVersion: 3,
    expectedVersion: 4,
    capturedMutationGeneration: 7,
    manifestFingerprint: testFingerprint(objects),
    objects,
    publishedAt: new Date().toISOString(),
  });
  const remote: TeamRemote = {
    async acquire() {
      return { lockId: "Lx", fencingToken: 9 };
    },
    async download() {},
    async publish() {
      events.push("publish");
    },
    async release() {
      events.push("release");
    },
    async heartbeat() {},
    async fetchProjectEvidence() {
      // 他人推进到 5，摘要不同
      return {
        version: 5,
        objects: [{ relativePath: "project.sqlite", md5: "other", size: 99 }],
      };
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
  assert.equal(sync.state().editable, false);
  assert.equal(sync.state().recoveryRequired, true);
  assert.ok(!events.includes("publish"));
  // 不得返回 published
  const close = await sync.close();
  assert.notEqual(close.state, "published");
});

// ---------- 4) receipt 删除失败不得伪装成功 ----------
test("RED：release 成功后 receipt 删除失败不得返回 published 成功清场", async () => {
  const dataRoot = fixture("del-fail");
  const events: string[] = [];
  const remote: TeamRemote = {
    async acquire() {
      return { lockId: "L4", fencingToken: 4 };
    },
    async download() {},
    async publish() {
      events.push("publish");
    },
    async release() {
      events.push("release");
    },
    async heartbeat() {},
    async fetchProjectEvidence() {
      return { version: 3, objects: [] };
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
  // 注入删除失败：仅协调器 confirmReleasedCleanupStrict 才删除
  assert.equal(typeof (sync as any).setReceiptClearHook, "function");
  (sync as any).setReceiptClearHook(() => {
    throw new Error("EPERM delete receipt");
  });
  await sync.open();
  const close = await sync.close();
  assert.equal(close.state, "released_cleanup_pending");
  // Team 层不删；协调器 confirm 时失败
  await assert.rejects(async () => {
    (sync as any).confirmReleasedCleanupStrict();
  }, /receipt|清理|删除|EPERM/i);
  const r = readTeamReleaseReceiptStrict(dataRoot, segment, projectUuid);
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") {
    assert.equal(r.receipt.phase, "released_cleanup_pending");
  }
});

// ---------- 5) released_cleanup_pending 重启 ----------
test("RED：released_cleanup_pending 重启后不得 publish/release，只本地清理", async () => {
  const dataRoot = fixture("cleanup-only");
  const events: string[] = [];
  writeReceiptRaw(dataRoot, {
    projectUuid,
    lockId: "L5",
    fencingToken: 5,
    phase: "released_cleanup_pending",
    baseVersion: 3,
    expectedVersion: 4,
    capturedMutationGeneration: 7,
    manifestFingerprint: "fp",
    publishedAt: new Date().toISOString(),
  });
  const remote: TeamRemote = {
    async acquire() {
      events.push("acquire");
      return { lockId: "L5", fencingToken: 5 };
    },
    async download() {},
    async publish() {
      events.push("publish");
    },
    async release() {
      events.push("release");
    },
    async heartbeat() {},
    async fetchProjectEvidence() {
      events.push("fetch");
      return { version: 4, objects: [] };
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
  assert.equal(sync.state().editable, false);
  assert.equal((sync.state() as any).cleanupOnly === true || sync.state().readonlyReason.includes("cleanup"), true);
  const close = await sync.close();
  // Team 层只返回 released_cleanup_pending，不得 publish/release；receipt 仍在
  assert.ok(!events.includes("publish"));
  assert.ok(!events.includes("release"));
  assert.equal(close.state, "released_cleanup_pending");
  assert.equal(close.capturedMutationGeneration, 7);
  const after = readTeamReleaseReceiptStrict(dataRoot, segment, projectUuid);
  assert.equal(after.kind, "ok", "Team.close 不得删除 receipt；协调器 finalize 后才删");
  // 协调器确认清理
  (sync as any).confirmReleasedCleanupStrict();
  assert.equal(readTeamReleaseReceiptStrict(dataRoot, segment, projectUuid).kind, "missing");
});

// ---------- 6) 无中央证据不得 published / 清 journal 语义 ----------
test("RED：无中央版本+manifest 摘要证据时 close 不得 published", async () => {
  const dataRoot = fixture("no-evidence");
  const events: string[] = [];
  writeReceiptRaw(dataRoot, {
    projectUuid,
    lockId: "L6",
    fencingToken: 6,
    phase: "publishing",
    baseVersion: 3,
    expectedVersion: 4,
    capturedMutationGeneration: 7,
    // 故意缺 fingerprint
    publishedAt: new Date().toISOString(),
  });
  const remote: TeamRemote = {
    async acquire() {
      return { lockId: "L6", fencingToken: 6 };
    },
    async download() {},
    async publish() {
      events.push("publish");
    },
    async release() {
      events.push("release");
    },
    async heartbeat() {},
    async fetchProjectEvidence() {
      // 仅版本匹配但无 objects / 与指纹对不上
      return { version: 4, objects: [] };
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
  // 缺指纹证据：不得 release_only 当已发布
  if (sync.state().releaseOnly) {
    // 若错误进入 release_only，close 仍不得 published（无证据）
    const close = await sync.close();
    assert.notEqual(close.state, "published");
  }
});

// ---------- clear 失败不得吞 ----------
test("RED：clearTeamReleaseReceipt 失败必须抛出", () => {
  const dataRoot = fixture("clear-throw");
  writeReceiptRaw(dataRoot, {
    projectUuid,
    lockId: "L7",
    fencingToken: 7,
    phase: "released_cleanup_pending",
    publishedAt: new Date().toISOString(),
  });
  const file = path.join(
    dataRoot,
    "runtime-users",
    segment,
    "team-release-receipts",
    `${projectUuid}.json`,
  );
  // 换成目录使 rm 文件失败
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file, { recursive: true });
  assert.throws(() => clearTeamReleaseReceipt(dataRoot, segment, projectUuid));
});
