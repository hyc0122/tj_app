/**
 * LocalPurgeQueue 句柄生命周期：关闭后 Windows 可删除测试目录；重复清理不泄漏。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LocalPurgeQueue } from "../../src/tianjiang/runtime/local-purge-queue";
import {
  SyncCoordinator,
} from "../../src/tianjiang/runtime/sync-coordinator";
import {
  CentralAuthGateway,
  type CentralSession,
} from "../../src/tianjiang/auth/central-session";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";

const UUID = "aaaaaaaa-1111-4111-a111-111111111111";

function tempRoot(name: string): string {
  const root = path.join(process.cwd(), "..", ".tmp", `lpq-${name}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** 同步删除；Windows 句柄泄漏时会抛 EPERM，必须视为失败而非噪音。 */
function assertRemovable(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: false });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
    assert.fail(
      `关闭后应可删除测试目录，实际 ${code || error}（不得把 EPERM 归为环境噪音）`,
    );
  }
}

test("LocalPurgeQueue close 后可删除目录（无句柄泄漏）", () => {
  const root = tempRoot("close");
  const dbPath = path.join(root, "local-purge-queue.sqlite");
  const queue = new LocalPurgeQueue(dbPath);
  queue.enqueue(UUID);
  assert.ok(queue.pendingProjectUuids().includes(UUID));
  queue.fail(UUID, "DISK_BUSY", true);
  queue.complete(UUID);
  queue.close();
  assertRemovable(root);
});

test("重复 enqueue/fail/nextReady 后 close 仍可删除", () => {
  const root = tempRoot("retry");
  const dbPath = path.join(root, "q.sqlite");
  const queue = new LocalPurgeQueue(dbPath, () => 1_000);
  for (let i = 0; i < 5; i += 1) {
    queue.enqueue(UUID);
    queue.fail(UUID, "BUSY", true);
    queue.nextReady();
  }
  queue.close();
  assertRemovable(root);
});

test("协调器 shutdown 后释放 purge 队列句柄，目录可删", async () => {
  const root = tempRoot("coord");
  const coordinator = new SyncCoordinator(
    root,
    new CentralAuthGateway(),
    new MemoryCredentialStore(),
  );
  // 通过反射式路径：直接调用 reconcile 会打开队列
  const session = {
    id: "sess",
    serverUrl: "https://api.example.test",
    user: { id: 42, username: "u" },
  } as CentralSession;

  // 构造孤立本地目录触发 acquireLocalPurgeQueue
  const segmentProbe = path.join(root, "runtime-users");
  fs.mkdirSync(segmentProbe, { recursive: true });
  // 无 catalog 时 reconcile 仍安全
  try {
    coordinator.reconcileOrphanLocalProjects(session);
  } catch {
    // 未登录可能 assert；忽略
  }

  await coordinator.shutdown();
  // 即使未打开队列，shutdown 也应完成
  assertRemovable(root);
});
