/**
 * Round10 RED：Team checkpoint 必须经 coordinator executor 完成
 * publish → finalize captured → confirmCheckpointFinalizeStrict。
 * finalize/清 receipt 前禁止 dirty=false；published_pending_finalize 重启需中央证据。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  readTeamCheckpointReceipt,
  writeTeamCheckpointReceipt,
} from "../../src/tianjiang/runtime/team-checkpoint-receipt";
import {
  TeamProjectSync,
  type TeamLocal,
  type TeamRemote,
} from "../../src/tianjiang/sync/team-project-sync";

type TeamCheckpointExecutor = (
  reason: "idle" | "checkpoint" | "manual",
) => Promise<{ state: string; retainedLock: true; capturedMutationGeneration?: number | "unknown" }>;

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000000a1";
const userSegment = "a1".repeat(16);
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

function makeLocal(dirty = true): TeamLocal & { dirty: boolean } {
  const local = {
    current: {
      version: 3,
      objects: [
        { relativePath: "project.sqlite", md5: "1".repeat(32), size: 10 },
        { relativePath: "files/videos/v.mp4", md5: "2".repeat(32), size: 100, mediaType: "video" as const },
      ],
    },
    dirty,
    install: async () => undefined,
    setReadonly: async () => undefined,
    createRecovery: async () => undefined,
    createSnapshot: async () => ({
      version: 3,
      objects: structuredClone(local.current!.objects),
      capturedMutationGeneration: 11,
    }),
  };
  return local;
}

function armEditable(sync: TeamProjectSync, lockId = "L-cp", fencing = 4): void {
  (sync as unknown as { lock: { lockId: string; fencingToken: number } }).lock = {
    lockId,
    fencingToken: fencing,
  };
  (sync as unknown as {
    current: {
      editable: boolean;
      readonlyReason: string;
      lockHolder: string;
      recoveryRequired: boolean;
    };
  }).current = {
    editable: true,
    readonlyReason: "",
    lockHolder: "editor",
    recoveryRequired: false,
  };
}

test("定时器路径必须走 checkpoint executor：publish 后 finalize 与清 receipt 成功前 dirty 保持 true", async () => {
  const local = makeLocal(true);
  let publishes = 0;
  const remote: TeamRemote = {
    acquire: async () => ({ lockId: "L-cp", fencingToken: 4 }),
    download: async () => undefined,
    publish: async () => {
      publishes += 1;
    },
    release: async () => undefined,
    heartbeat: async () => undefined,
    fetchProjectEvidence: async () => ({
      version: 4,
      objects: local.current!.objects.map((o) => ({
        relativePath: o.relativePath,
        md5: o.md5,
        size: o.size,
      })),
    }),
  };
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-team-cp-exec-"));
  const scheduled: Array<() => void> = [];
  const sync = new TeamProjectSync(
    "editor",
    local,
    remote,
    () => ({}),
    (run) => {
      scheduled.push(run);
      return { cancel() { /* noop */ } };
    },
  );
  sync.configureReleaseReceiptStore({ dataRoot, userSegment, projectUuid });
  armEditable(sync);

  const steps: string[] = [];
  const executor: TeamCheckpointExecutor = async (reason) => {
    steps.push(`exec:${reason}`);
    // 模拟协调器：已在 syncTail 内，用 Unlocked 禁止嵌套锁
    const published = await sync.publishCheckpointUnlocked(reason);
    steps.push(`published:${published.state}`);
    // finalize 前 dirty 必须仍为 true（本契约核心 RED）
    assert.equal(local.dirty, true, "finalize 前禁止 dirty=false");
    // 协调器 finalize
    steps.push("finalize");
    sync.confirmCheckpointFinalizeStrict();
    steps.push("receipt-cleared");
    if (local.dirty !== undefined) local.dirty = false;
    return published;
  };
  // 生产必须注入；未注入时定时器不得直接 publish 并清 dirty
  if (typeof (sync as { setCheckpointExecutor?: unknown }).setCheckpointExecutor === "function") {
    (sync as { setCheckpointExecutor: (e: TeamCheckpointExecutor) => void }).setCheckpointExecutor(executor);
  }

  try {
    sync.markEdited();
    assert.ok(scheduled.length >= 1, "必须调度 idle/checkpoint");
    // 触发 idle 回调
    scheduled[0]!();
    // 等待 microtask
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.ok(
      steps.some((s) => s.startsWith("exec:")),
      `定时器必须调用 executor，实际 steps=${steps.join(",")}`,
    );
    assert.ok(steps.includes("finalize"), "executor 必须 finalize");
    assert.ok(steps.includes("receipt-cleared"), "executor 必须清 checkpoint receipt");
    assert.equal(publishes, 1);
    assert.equal(local.dirty, false, "仅 finalize 成功后才可 dirty=false");
    assert.equal(
      readTeamCheckpointReceipt(dataRoot, userSegment, projectUuid),
      undefined,
      "receipt 必须已清除",
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("finalize 或清 receipt 失败必须保留 dirty 且不得伪装 published 终态", async () => {
  const local = makeLocal(true);
  const remote: TeamRemote = {
    acquire: async () => ({ lockId: "L2", fencingToken: 1 }),
    download: async () => undefined,
    publish: async () => undefined,
    release: async () => undefined,
    heartbeat: async () => undefined,
  };
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-team-cp-fail-"));
  const sync = new TeamProjectSync("owner", local, remote, () => ({}));
  sync.configureReleaseReceiptStore({ dataRoot, userSegment, projectUuid });
  armEditable(sync, "L2", 1);

  try {
    if (typeof (sync as { setCheckpointExecutor?: unknown }).setCheckpointExecutor !== "function") {
      assert.fail("缺少 setCheckpointExecutor（预期 RED）");
    }
    (sync as { setCheckpointExecutor: (e: TeamCheckpointExecutor) => void }).setCheckpointExecutor(
      async () => {
        await sync.publishCheckpointUnlocked("manual");
        // 模拟 finalize 失败：抛错且不清 receipt
        throw Object.assign(new Error("mutation finalize 失败"), {
          code: "CHECKPOINT_FINALIZE_FAILED",
        });
      },
    );
    await assert.rejects(
      () => (sync as { runScheduledCheckpoint?: (r: "idle") => Promise<unknown> }).runScheduledCheckpoint?.("idle")
        ?? (sync as { publishCheckpoint: (r: "idle") => Promise<unknown> }).publishCheckpoint("idle").then(async (r) => {
          // 若无 executor 包装，仍应在 finalize 失败契约下保留 dirty
          throw Object.assign(new Error("mutation finalize 失败"), { code: "CHECKPOINT_FINALIZE_FAILED" });
        }),
      /finalize|失败/,
    );
    assert.equal(local.dirty, true, "finalize 失败必须保留 dirty");
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("published_pending_finalize 重启：证据一致只 finalize 不重复 publish；证据不确定 fail-closed", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-team-cp-recovery-"));
  const objects = [
    { relativePath: "project.sqlite", md5: "a".repeat(32), size: 10 },
    { relativePath: "files/videos/v.mp4", md5: "b".repeat(32), size: 20 },
  ];
  writeTeamCheckpointReceipt(dataRoot, userSegment, {
    projectUuid,
    lockId: "L-rec",
    fencingToken: 7,
    phase: "published_pending_finalize",
    baseVersion: 5,
    expectedVersion: 6,
    capturedMutationGeneration: 15,
    objects,
  });

  let publishes = 0;
  const local = makeLocal(true);
  local.current = { version: 5, objects: structuredClone(objects) };
  const remote: TeamRemote = {
    acquire: async () => ({ lockId: "L-rec", fencingToken: 7 }),
    download: async () => undefined,
    publish: async () => {
      publishes += 1;
    },
    release: async () => undefined,
    heartbeat: async () => undefined,
    fetchProjectEvidence: async () => ({
      version: 6,
      objects: structuredClone(objects),
    }),
  };
  const sync = new TeamProjectSync("editor", local, remote, () => ({}));
  sync.configureReleaseReceiptStore({ dataRoot, userSegment, projectUuid });

  try {
    const recover = (sync as {
      recoverCheckpointReceiptIfPresent?: () => Promise<boolean>;
    }).recoverCheckpointReceiptIfPresent;
    assert.equal(typeof recover, "function", "必须实现 checkpoint receipt 恢复（预期 RED）");
    const recovered = await recover!.call(sync);
    // Round10b：recover 仅返回 pendingFinalize 结构体；清 receipt 由协调器完成。
    assert.ok(
      recovered === true
        || (typeof recovered === "object" && recovered && (recovered as { pendingFinalize?: boolean }).pendingFinalize === true),
      "恢复必须成功或返回 pendingFinalize",
    );
    assert.equal(publishes, 0, "证据一致时禁止重复 publish");
    // 协调器路径会清 receipt；裸 recover 保留 receipt 待 finalize
    if (typeof recovered === "object" && recovered && (recovered as { pendingFinalize?: boolean }).pendingFinalize) {
      sync.confirmCheckpointFinalizeStrict();
    }
    assert.equal(
      readTeamCheckpointReceipt(dataRoot, userSegment, projectUuid),
      undefined,
      "恢复 finalize 后必须清 receipt",
    );

    // 证据不确定
    writeTeamCheckpointReceipt(dataRoot, userSegment, {
      projectUuid,
      lockId: "L-rec2",
      fencingToken: 8,
      phase: "published_pending_finalize",
      baseVersion: 6,
      expectedVersion: 7,
      capturedMutationGeneration: 16,
      objects,
    });
    const remoteUncertain: TeamRemote = {
      ...remote,
      fetchProjectEvidence: async () => {
        throw new Error("中央证据不可用");
      },
    };
    const sync2 = new TeamProjectSync("editor", makeLocal(true), remoteUncertain, () => ({}));
    sync2.configureReleaseReceiptStore({ dataRoot, userSegment, projectUuid });
    await assert.rejects(
      () => (sync2 as { recoverCheckpointReceiptIfPresent: () => Promise<boolean> })
        .recoverCheckpointReceiptIfPresent(),
      /证据|不确定|fail|不可用|恢复/i,
    );
    assert.ok(
      readTeamCheckpointReceipt(dataRoot, userSegment, projectUuid),
      "证据不确定必须保留 receipt",
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
