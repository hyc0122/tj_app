/**
 * 真实待同步上传消费者：证明重启后仍会执行上传，而非仅保留队列行。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { SyncQueue } from "../../src/tianjiang/sync/queue";
import {
  classifyPendingSyncFailure,
  runPendingSyncConsumer,
  safePendingSyncFailureSummary,
} from "../../src/tianjiang/sync/pending-sync-consumer";

function tempRoot(name: string): string {
  const root = path.join(process.cwd(), "..", ".tmp", `psc-${name}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

test("失败分类：网络/存储/认证可恢复；契约损坏 fatal", () => {
  assert.equal(
    classifyPendingSyncFailure(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
    "retryable",
  );
  assert.equal(
    classifyPendingSyncFailure(Object.assign(new Error("storage"), { code: "STORAGE_UNAVAILABLE" })),
    "retryable",
  );
  assert.equal(
    classifyPendingSyncFailure(Object.assign(new Error("auth"), { code: "AUTH_EXPIRED" })),
    "retryable",
  );
  assert.equal(
    classifyPendingSyncFailure(Object.assign(new Error("bad"), { code: "CONTRACT_INVALID" })),
    "fatal",
  );
  assert.equal(
    classifyPendingSyncFailure(new Error("项目同步对象校验失败")),
    "fatal",
  );
  const summary = safePendingSyncFailureSummary(
    Object.assign(new Error("x"), { code: "CONTRACT_INVALID" }),
  );
  assert.match(summary, /停止自动重试|无法校验/);
  assert.equal(summary.includes("C:\\"), false);
});

test("关闭进程后重新构造：真实上传消费者仍会执行 uploadProject", async () => {
  const root = tempRoot("resume");
  const dbPath = path.join(root, "sync-queue.sqlite");
  const projectUUID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  // 会话过期时间必须远大于所有测试时钟，否则 reopen 会被 expireSessions 误杀。
  const sessionExpiresAt = 50_000_000;
  try {
    // 进程 1：退出时写入 pending（running → fail → retry_wait）
    {
      let now = 10_000;
      const queue = new SyncQueue(dbPath, () => now);
      const id = queue.ensureUploadQueued(projectUUID, sessionExpiresAt);
      queue.markRunning(id);
      queue.fail(id, "STORAGE_UNAVAILABLE", true);
      const afterFail = queue.get(id)!;
      assert.equal(afterFail.status, "retry_wait");
      assert.ok(afterFail.nextAttemptAt > now);
      assert.ok(queue.countPending() >= 1);
      queue.close();
    }

    // 进程 2：重新打开队列 + 消费者，必须真正调用上传
    const uploads: string[] = [];
    const protocolSteps: string[] = [];
    {
      // 时钟拨到 next_attempt 之后且仍早于 session 过期
      let now = 20_000;
      const queue = new SyncQueue(dbPath, () => now);
      const result = await runPendingSyncConsumer({
        queue,
        isActive: () => true,
        executor: {
          uploadProject: async (uuid) => {
            protocolSteps.push("begin");
            protocolSteps.push("object-upload");
            protocolSteps.push("confirm");
            protocolSteps.push("commit");
            uploads.push(uuid);
          },
        },
      });
      assert.equal(result.completed, 1);
      assert.deepEqual(result.uploadedProjectUuids, [projectUUID]);
      assert.deepEqual(uploads, [projectUUID], "必须真实执行上传而非只查队列");
      assert.deepEqual(protocolSteps, ["begin", "object-upload", "confirm", "commit"]);
      assert.equal(queue.countPending(), 0);
      queue.close();
    }

    // 进程 3：再次打开不得重复上传
    {
      const queue = new SyncQueue(dbPath, () => 30_000);
      let called = 0;
      const result = await runPendingSyncConsumer({
        queue,
        isActive: () => true,
        executor: {
          uploadProject: async () => {
            called += 1;
          },
        },
      });
      assert.equal(result.attempted, 0);
      assert.equal(called, 0, "已完成任务不得重复上传");
      queue.close();
    }

    // 所有句柄关闭后目录必须可删；EPERM 视为失败
    try {
      fs.rmSync(root, { recursive: true, force: false });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: string }).code)
        : "";
      assert.fail(`关闭后应可删除测试目录: ${code || error}`);
    }
  } catch (error) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // 失败路径尽力清理，不掩盖主错误
    }
    throw error;
  }
});

test("commit 前失败不得 complete；可恢复进入退避", async () => {
  const root = tempRoot("fail-before-commit");
  const dbPath = path.join(root, "q.sqlite");
  try {
    const queue = new SyncQueue(dbPath, () => 5_000);
    const id = queue.enqueue({
      type: "upload",
      projectUUID: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      sessionExpiresAt: 99_000,
    });
    const result = await runPendingSyncConsumer({
      queue,
      isActive: () => true,
      executor: {
        uploadProject: async () => {
          throw Object.assign(new Error("network"), { code: "NETWORK_OFFLINE" });
        },
      },
    });
    assert.equal(result.completed, 0);
    assert.equal(result.retryable, 1);
    const task = queue.get(id);
    assert.equal(task?.status, "retry_wait");
    assert.ok((task?.nextAttemptAt ?? 0) > 5_000);
    queue.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("契约损坏进入 failed 且不再无限重试", async () => {
  const root = tempRoot("fatal");
  const dbPath = path.join(root, "q.sqlite");
  try {
    const queue = new SyncQueue(dbPath, () => 2_000);
    const id = queue.enqueue({
      type: "upload",
      projectUUID: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
      sessionExpiresAt: 99_000,
    });
    const result = await runPendingSyncConsumer({
      queue,
      isActive: () => true,
      executor: {
        uploadProject: async () => {
          throw Object.assign(new Error("非法本地数据"), { code: "CONTRACT_INVALID" });
        },
      },
    });
    assert.equal(result.fatal, 1);
    assert.equal(queue.get(id)?.status, "failed");
    // 再次消费不得再 claim failed
    const again = await runPendingSyncConsumer({
      queue,
      isActive: () => true,
      executor: { uploadProject: async () => undefined },
    });
    assert.equal(again.attempted, 0);
    queue.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shutdown epoch 后 isActive=false 不得 complete 也不得再 claim", async () => {
  const root = tempRoot("epoch");
  const dbPath = path.join(root, "q.sqlite");
  try {
    const queue = new SyncQueue(dbPath, () => 3_000);
    queue.enqueue({
      type: "upload",
      projectUUID: "dddddddd-dddd-4ddd-dddd-dddddddddddd",
      sessionExpiresAt: 99_000,
    });
    let active = true;
    const result = await runPendingSyncConsumer({
      queue,
      isActive: () => active,
      executor: {
        uploadProject: async () => {
          active = false; // 模拟上传中 shutdown
        },
      },
    });
    // 上传执行了但 epoch 失效后不得 complete
    assert.equal(result.completed, 0);
    queue.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
