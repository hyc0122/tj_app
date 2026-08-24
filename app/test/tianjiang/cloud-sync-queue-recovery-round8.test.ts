import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { SyncQueue } from "../../src/tianjiang/sync/queue";
import { classifyPersonalCloseFailure } from "../../src/tianjiang/sync/shutdown-policy";

const PERSONAL_UUID = "11111111-1111-4111-a111-111111111111";
const TEAM_UUID = "22222222-2222-4222-a222-222222222222";

function withQueue(run: (queue: SyncQueue, now: number) => void): void {
  const temporaryRoot = path.resolve(process.cwd(), ".tmp");
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, "tj-cloud-recovery-"));
  const now = 100_000;
  const queue = new SyncQueue(path.join(root, "sync.sqlite"), () => now);
  try {
    run(queue, now);
  } finally {
    queue.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("历史通用 Error 的 Personal 失败任务可在 durable mutation 存在时原地恢复一次", () => {
  withQueue((queue, now) => {
    const id = queue.enqueue({
      type: "upload",
      projectUUID: PERSONAL_UUID,
      sessionExpiresAt: now + 60_000,
    });
    queue.markRunning(id);
    queue.fail(id, "Error", false);

    const revived = queue.reviveLegacyGenericUploadFailure(PERSONAL_UUID, now + 120_000);
    assert.equal(revived, id);
    assert.equal(queue.get(id)?.status, "queued");
    assert.equal(queue.get(id)?.errorCode, undefined);

    // 已经恢复为 queued 后不得再次制造新任务或重复复活。
    assert.equal(queue.reviveLegacyGenericUploadFailure(PERSONAL_UUID, now + 120_000), undefined);
    assert.equal(queue.ensureUploadQueued(PERSONAL_UUID, now + 120_000), id);
  });
});

test("已知 fatal 失败不得被历史兼容逻辑静默复活", () => {
  withQueue((queue, now) => {
    const id = queue.enqueue({
      type: "upload",
      projectUUID: PERSONAL_UUID,
      sessionExpiresAt: now + 60_000,
    });
    queue.markRunning(id);
    queue.fail(id, "SQLITE_CORRUPT", false);
    assert.equal(queue.reviveLegacyGenericUploadFailure(PERSONAL_UUID, now + 120_000), undefined);
    assert.equal(queue.get(id)?.status, "failed");
  });
});

test("Team 的历史 Personal upload 活跃任务必须在登录对账时终止", () => {
  withQueue((queue, now) => {
    const id = queue.enqueue({
      type: "upload",
      projectUUID: TEAM_UUID,
      sessionExpiresAt: now + 60_000,
    });
    queue.markRunning(id);
    queue.fail(id, "UNSUPPORTED_TASK_TYPE", true);

    assert.equal(queue.terminalizeActiveUploadsForProject(TEAM_UUID, "UNSUPPORTED_TASK_TYPE"), 1);
    assert.equal(queue.get(id)?.status, "failed");
    assert.equal(queue.get(id)?.errorCode, "UNSUPPORTED_TASK_TYPE");
    assert.equal(queue.countPending(), 0);
  });
});

test("UNSUPPORTED_TASK_TYPE 即使错误文案含离线也必须归类 fatal", () => {
  const error = Object.assign(new Error("团队项目不支持离线待同步上传"), {
    code: "UNSUPPORTED_TASK_TYPE",
  });
  assert.equal(classifyPersonalCloseFailure(error), "fatal");
});
