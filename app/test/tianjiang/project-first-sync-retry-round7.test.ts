import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { SyncQueue } from "../../src/tianjiang/sync/queue";

test("旧业务写成功必须登记 durable intent，禁止仅修改内存 dirty", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../src/app.ts"), "utf8");
  assert.match(source, /recordAndMarkLegacyMutation\(projectUuid/);
  assert.doesNotMatch(source, /res\.statusCode < 400\) syncCoordinator\.markLegacyMutation/);
});

test("队列暴露下一次可执行时间，供 retry_wait 安装自动唤醒", () => {
  let now = 10_000;
  const temporaryRoot = path.resolve(process.cwd(), ".tmp");
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, "tj-round7-queue-"));
  const queue = new SyncQueue(path.join(root, "sync.sqlite"), () => now);
  try {
    const id = queue.enqueue({
      type: "upload",
      projectUUID: "77777777-7777-4777-a777-777777777777",
      sessionExpiresAt: now + 60_000,
    });
    queue.markRunning(id);
    queue.fail(id, "STORAGE_UNAVAILABLE", true);
    const runnableAt = (queue as SyncQueue & { nextRunnableAt(): number | undefined }).nextRunnableAt();
    assert.equal(runnableAt, now + 1_000);
    now = runnableAt!;
    assert.equal(queue.nextReady()?.id, id);
  } finally {
    queue.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("协调器必须安装 retry_wait 定时唤醒，并在停止后台工作时清理", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../src/tianjiang/runtime/sync-coordinator.ts"),
    "utf8",
  );
  assert.match(source, /pendingSyncRetryTimer/);
  assert.match(source, /schedulePendingSyncRetry/);
  assert.match(source, /clearPendingSyncRetryTimer\(\)/);
});

test("团队手动同步必须发布后重新打开，而不是拒绝首次同步", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../src/tianjiang/runtime/sync-coordinator.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /团队项目只允许在关闭时持锁发布/);
  assert.match(source, /await this\.closeProjectInternal\(session, projectUuid\)/);
  assert.match(source, /await this\.openProject\(session, projectUuid\)/);
});
