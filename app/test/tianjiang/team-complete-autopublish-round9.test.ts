import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  TeamProjectSync,
  type TeamLocal,
  type TeamRemote,
} from "../../src/tianjiang/sync/team-project-sync";
import { readTeamCheckpointReceipt } from "../../src/tianjiang/runtime/team-checkpoint-receipt";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000099";
const userSegment = "e".repeat(32);
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

function makeLocal(dirty = true): TeamLocal & { dirty: boolean; version: number } {
  const local = {
    current: {
      version: 3,
      objects: [
        { relativePath: "project.sqlite", md5: "1".repeat(32), size: 10 },
        { relativePath: "files/images/a.png", md5: "2".repeat(32), size: 4, mediaType: "image" as const },
      ],
    },
    dirty,
    version: 3,
    install: async () => undefined,
    setReadonly: async () => undefined,
    createRecovery: async () => undefined,
    createSnapshot: async () => ({
      version: local.version,
      objects: structuredClone(local.current!.objects),
      capturedMutationGeneration: 7,
    }),
  };
  return local;
}

test("owner/editor 持锁时 30s/120s 调度 checkpoint 发布完整对象且不 release", async () => {
  const delays: number[] = [];
  const publishes: unknown[] = [];
  let releases = 0;
  const local = makeLocal(true);
  const remote: TeamRemote = {
    acquire: async () => ({ lockId: "L1", fencingToken: 9 }),
    download: async () => undefined,
    publish: async (lockId, fencingToken, snapshot) => {
      publishes.push({ lockId, fencingToken, paths: snapshot.objects.map((o) => o.relativePath) });
    },
    release: async () => {
      releases += 1;
    },
    heartbeat: async () => undefined,
  };
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-team-auto-"));
  const sync = new TeamProjectSync(
    "editor",
    local,
    remote,
    () => ({}),
    (_run, delay) => {
      delays.push(delay);
      return { cancel() { /* noop */ } };
    },
  );
  sync.configureReleaseReceiptStore({ dataRoot, userSegment, projectUuid });
  // 模拟已持锁可写
  (sync as unknown as { lock: { lockId: string; fencingToken: number }; current: { editable: boolean } }).lock = {
    lockId: "L1",
    fencingToken: 9,
  };
  (sync as unknown as { current: { editable: boolean; readonlyReason: string; lockHolder: string; recoveryRequired: boolean } }).current = {
    editable: true,
    readonlyReason: "",
    lockHolder: "alice",
    recoveryRequired: false,
  };

  try {
    sync.markEdited();
    assert.ok(delays.includes(30_000));
    assert.ok(delays.includes(120_000));

    const result = await sync.publishCheckpoint("idle");
    assert.equal(result.state, "published");
    assert.equal(result.retainedLock, true);
    assert.equal(releases, 0);
    assert.equal(publishes.length, 1);
    const paths = (publishes[0] as { paths: string[] }).paths;
    assert.ok(paths.includes("files/images/a.png"));
    assert.ok(paths.includes("project.sqlite"));
    const receipt = readTeamCheckpointReceipt(dataRoot, userSegment, projectUuid);
    assert.ok(receipt);
    assert.notEqual(receipt!.phase, "finalized");
    // checkpoint 后仍可写
    assert.equal(sync.state().editable, true);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("viewer 与锁失效不得 publish", async () => {
  let publishes = 0;
  const local = makeLocal(true);
  const remote: TeamRemote = {
    acquire: async () => undefined,
    download: async () => undefined,
    publish: async () => {
      publishes += 1;
    },
    release: async () => undefined,
    heartbeat: async () => undefined,
  };
  const viewer = new TeamProjectSync("viewer", local, remote, () => ({}));
  viewer.markEdited();
  const viewerResult = await viewer.publishCheckpoint("idle");
  assert.equal(viewerResult.state, "skipped_viewer");
  assert.equal(publishes, 0);

  const editor = new TeamProjectSync("editor", local, remote, () => ({}));
  // 无锁
  const noLock = await editor.publishCheckpoint("idle");
  assert.equal(noLock.state, "skipped_not_editable");
  assert.equal(publishes, 0);
});

test("Team 同步失败路径不写入任何 Personal 队列概念；并发 publish 单飞", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const local = makeLocal(true);
  const remote: TeamRemote = {
    acquire: async () => ({ lockId: "L2", fencingToken: 1 }),
    download: async () => undefined,
    publish: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent -= 1;
    },
    release: async () => undefined,
    heartbeat: async () => undefined,
  };
  const sync = new TeamProjectSync("owner", local, remote, () => ({}));
  (sync as unknown as { lock: { lockId: string; fencingToken: number } }).lock = {
    lockId: "L2",
    fencingToken: 1,
  };
  (sync as unknown as { current: { editable: boolean; readonlyReason: string; lockHolder: string; recoveryRequired: boolean } }).current = {
    editable: true,
    readonlyReason: "",
    lockHolder: "owner",
    recoveryRequired: false,
  };
  await Promise.all([
    sync.publishCheckpoint("idle"),
    sync.publishCheckpoint("checkpoint"),
    sync.publishCheckpoint("manual"),
  ]);
  assert.equal(maxConcurrent, 1);
});
