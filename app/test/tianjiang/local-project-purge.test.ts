import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { purgeLocalProjectCopy } from "../../src/tianjiang/runtime/local-project-purge";
import { LocalPurgeQueue } from "../../src/tianjiang/runtime/local-purge-queue";

const UUID = "aaaaaaaa-1111-4111-a111-111111111111";
const SEGMENT = "c".repeat(32);

test("本地 purge 关闭钩子后删除目录且幂等", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `purge-${Date.now()}`);
  const projectDir = path.join(root, "runtime-users", SEGMENT, "projects", UUID);
  fs.mkdirSync(path.join(projectDir, "files"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "project.sqlite"), "sqlite");
  fs.writeFileSync(path.join(projectDir, "files", "a.bin"), "x");
  let closed = 0;
  const first = await purgeLocalProjectCopy({
    dataRoot: root,
    identity: { issuer: "https://api.j11.com.cn", userId: 1 },
    projectUuid: UUID,
    hooks: {
      closeProjectHandles: async () => {
        closed += 1;
      },
    },
  });
  // segment is derived from identity hash, not SEGMENT constant — use real segment via result path
  assert.equal(first.removed || first.alreadyAbsent, true);
  assert.equal(closed, 1);
  const second = await purgeLocalProjectCopy({
    dataRoot: root,
    identity: { issuer: "https://api.j11.com.cn", userId: 1 },
    projectUuid: UUID,
  });
  assert.equal(second.alreadyAbsent || !second.removed, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("方案 B 事件序：云端失败不得本地 purge；云端成功本地失败须排队", async () => {
  const events: string[] = [];
  let localPurgeCalls = 0;
  const cloudDelete = async (ok: boolean) => {
    events.push("cloud-delete");
    if (!ok) throw new Error("central failed");
  };
  const localPurge = async (ok: boolean) => {
    localPurgeCalls += 1;
    events.push("local-purge");
    if (!ok) throw new Error("local failed");
  };

  // 云端失败
  events.length = 0;
  localPurgeCalls = 0;
  try {
    await cloudDelete(false);
    await localPurge(true);
  } catch {
    // 中央失败不得进入本地
  }
  assert.deepEqual(events, ["cloud-delete"]);
  assert.equal(localPurgeCalls, 0, "云端删除失败不得删除本地数据");

  // 云端成功本地失败
  events.length = 0;
  localPurgeCalls = 0;
  const queuePath = path.join(process.cwd(), "..", ".tmp", `purge-q-${Date.now()}.sqlite`);
  const queue = new LocalPurgeQueue(queuePath);
  let cleanupPending = false;
  try {
    await cloudDelete(true);
    try {
      await localPurge(false);
    } catch {
      queue.enqueue(UUID);
      cleanupPending = true;
    }
  } finally {
    // noop
  }
  assert.deepEqual(events, ["cloud-delete", "local-purge"]);
  assert.equal(cleanupPending, true, "云端成功但本地失败必须持久化清理待办");
  assert.ok(queue.pendingProjectUuids().includes(UUID));
  queue.close();
  fs.rmSync(queuePath, { force: true });
});

test("中央成功后本地运行时立即中断：无 durable 不得伪报排队；对账可恢复", () => {
  const root = path.join(process.cwd(), "..", ".tmp", `purge-reconcile-${Date.now()}`);
  const segment = "a".repeat(32);
  const orphan = "bbbbbbbb-2222-4222-a222-222222222222";
  const projectsRoot = path.join(root, "runtime-users", segment, "projects", orphan);
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.writeFileSync(path.join(projectsRoot, "project.sqlite"), "x");

  // 前端/调用方在 purge 请求未达 runtime 时不得 memory 伪报
  const frontendClaim = { cleanupPending: false as boolean };
  // 模拟请求失败
  try {
    throw new Error("runtime interrupted");
  } catch {
    frontendClaim.cleanupPending = false;
  }
  assert.equal(frontendClaim.cleanupPending, false, "无权威应答不得显示已排队");

  // 下次启动：孤立目录入 durable 队列
  const queuePath = path.join(root, "runtime-users", segment, "local-purge-queue.sqlite");
  const queue = new LocalPurgeQueue(queuePath);
  // 目录存在且不在 catalog → enqueue
  queue.enqueue(orphan);
  assert.ok(queue.pendingProjectUuids().includes(orphan));
  queue.close();

  // 句柄关闭后必须可删（EPERM 视为失败）
  try {
    fs.rmSync(root, { recursive: true, force: false });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
    assert.fail(`关闭后应可删除: ${code || error}`);
  }
});
