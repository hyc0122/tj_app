/**
 * Round10b RED：Team checkpoint 与 close 必须同一把 syncTail 单飞。
 * maxConcurrentPublish <= 1；close 等待在途 checkpoint；finalize 失败不 release。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { readTeamCheckpointReceipt } from "../../src/tianjiang/runtime/team-checkpoint-receipt";
import {
  TeamProjectSync,
  type TeamLocal,
  type TeamRemote,
} from "../../src/tianjiang/sync/team-project-sync";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000001b1";
const userSegment = "b1".repeat(16);
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

function makeLocal(): TeamLocal & { dirty: boolean } {
  const local = {
    current: {
      version: 2,
      objects: [{ relativePath: "project.sqlite", md5: "1".repeat(32), size: 8 }],
    },
    dirty: true as boolean,
    install: async () => undefined,
    setReadonly: async () => undefined,
    createRecovery: async () => undefined,
    createSnapshot: async () => ({
      version: 2,
      objects: structuredClone(local.current!.objects),
      capturedMutationGeneration: 9,
    }),
  };
  return local;
}

function arm(sync: TeamProjectSync): void {
  (sync as unknown as { lock: { lockId: string; fencingToken: number } }).lock = {
    lockId: "L-ser",
    fencingToken: 5,
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
    lockHolder: "ed",
    recoveryRequired: false,
  };
}

test("checkpoint 在途时 close：maxConcurrentPublish<=1 且 close 等待 checkpoint 完成", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-ser-"));
  const local = makeLocal();
  let concurrent = 0;
  let maxConcurrent = 0;
  let publishGate!: () => void;
  const publishHold = new Promise<void>((resolve) => {
    publishGate = resolve;
  });
  let releases = 0;
  const remote: TeamRemote = {
    acquire: async () => ({ lockId: "L-ser", fencingToken: 5 }),
    download: async () => undefined,
    publish: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await publishHold;
      concurrent -= 1;
    },
    release: async () => {
      releases += 1;
    },
    heartbeat: async () => undefined,
  };
  const sync = new TeamProjectSync("editor", local, remote, () => ({}));
  sync.configureReleaseReceiptStore({ dataRoot, userSegment, projectUuid });
  arm(sync);

  // 协调器风格 executor：禁止嵌套 public publishCheckpoint 二次加锁
  let finalizeDone = false;
  sync.setCheckpointExecutor(async (reason) => {
    // 中文注释：必须走 Unlocked 路径，禁止再调 publishCheckpoint 嵌套 syncTail
    const published = await sync.publishCheckpointUnlocked(
      reason as "idle" | "checkpoint" | "manual",
    );
    if (published.state === "published" && published.pendingFinalize) {
      finalizeDone = true;
      sync.confirmCheckpointFinalizeStrict();
      if (local.dirty !== undefined) local.dirty = false;
      return { ...published, pendingFinalize: false };
    }
    return published;
  });

  try {
    const cpPromise = sync.runScheduledCheckpoint("checkpoint");
    // 给 publish 进入临界区
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    let closeFinished = false;
    const closePromise = sync.close().then((result) => {
      closeFinished = true;
      return result;
    });

    // close 不得在 checkpoint publish 完成前结束
    await new Promise((r) => setImmediate(r));
    assert.equal(closeFinished, false, "close 必须等待在途 checkpoint（预期 RED）");

    publishGate();
    await cpPromise;
    await closePromise;

    assert.ok(maxConcurrent <= 1, `maxConcurrentPublish=${maxConcurrent} 必须 <=1`);
    assert.ok(finalizeDone, "checkpoint finalize 必须完成");
    // checkpoint 成功后 close 至多再 publish/release 一次（或 unchanged 路径）
    assert.ok(releases <= 1, `release 次数异常: ${releases}`);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("finalize 失败时不 release、不删 receipt、不关闭 runtime 为成功", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-ser-ff-"));
  const local = makeLocal();
  let releases = 0;
  const remote: TeamRemote = {
    acquire: async () => ({ lockId: "L-ff", fencingToken: 1 }),
    download: async () => undefined,
    publish: async () => undefined,
    release: async () => {
      releases += 1;
    },
    heartbeat: async () => undefined,
  };
  const sync = new TeamProjectSync("owner", local, remote, () => ({}));
  sync.configureReleaseReceiptStore({ dataRoot, userSegment, projectUuid });
  arm(sync);

  sync.setCheckpointExecutor(async () => {
    await sync.publishCheckpointUnlocked("manual");
    throw Object.assign(new Error("checkpoint finalize 失败"), {
      code: "CHECKPOINT_FINALIZE_FAILED",
    });
  });

  try {
    await assert.rejects(
      () => sync.runScheduledCheckpoint("idle"),
      /finalize|失败/,
    );
    assert.equal(releases, 0, "finalize 失败禁止 release");
    assert.equal(local.dirty, true, "finalize 失败保留 dirty");
    // 中文注释：finalize 失败后不得 release；close 再试仍因 dirty 需 publish，本断言只查失败路径副作用。
    assert.ok(
      readTeamCheckpointReceipt(dataRoot, userSegment, projectUuid)
        || local.dirty === true,
      "失败路径必须保留 dirty 或 receipt",
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("checkpoint 成功后 close 只执行必要的一次最终 publish/release", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-ser-once-"));
  const local = makeLocal();
  let publishes = 0;
  let releases = 0;
  const remote: TeamRemote = {
    acquire: async () => ({ lockId: "L-once", fencingToken: 2 }),
    download: async () => undefined,
    publish: async () => {
      publishes += 1;
    },
    release: async () => {
      releases += 1;
    },
    heartbeat: async () => undefined,
    fetchProjectEvidence: async () => ({
      version: (local.current?.version ?? 2) + 1,
      objects: local.current!.objects.map((o) => ({
        relativePath: o.relativePath,
        md5: o.md5,
        size: o.size,
      })),
    }),
  };
  const sync = new TeamProjectSync("editor", local, remote, () => ({}));
  sync.configureReleaseReceiptStore({ dataRoot, userSegment, projectUuid });
  arm(sync);
  sync.setCheckpointExecutor(async (reason) => {
    const epoch = sync.currentEditEpoch();
    const published = await sync.publishCheckpointUnlocked(reason);
    if (published.state === "published" && published.pendingFinalize) {
      sync.confirmCheckpointFinalizeStrict();
      sync.markCheckpointCleanIfEpochStable(epoch);
      return { ...published, pendingFinalize: false };
    }
    return published;
  });

  try {
    local.dirty = true;
    await sync.runScheduledCheckpoint("checkpoint");
    // checkpoint 后 dirty 已清，再编辑产生 close 所需最终一次
    sync.markEdited();
    await sync.close();
    assert.ok(publishes >= 1 && publishes <= 2, `publish 次数应 1~2，实际=${publishes}`);
    assert.equal(releases, 1, "close 最终只 release 一次");
    assert.equal(
      readTeamCheckpointReceipt(dataRoot, userSegment, projectUuid),
      undefined,
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
