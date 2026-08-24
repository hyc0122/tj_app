import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { atomicSwitchProject } from "../../src/tianjiang/sync/atomic-switch";
import { SyncQueue } from "../../src/tianjiang/sync/queue";
import { downloadWithResume, type RangeSource } from "../../src/tianjiang/sync/transfer";

test("同步队列持久化重试、进度、取消和会话过期状态", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-queue-"));
  const database = path.join(root, "sync-queue.sqlite");
  let queue = new SyncQueue(database, () => 1_000);
  const id = queue.enqueue({ type: "download", projectUUID: "project-1", sessionExpiresAt: 10_000 });
  queue.updateProgress(id, 128, 1024);
  queue.close();

  queue = new SyncQueue(database, () => 1_000);
  assert.deepEqual(queue.get(id)?.progress, { completed: 128, total: 1024 });
  queue.fail(id, "network", true);
  assert.equal(queue.get(id)?.status, "retry_wait");
  queue.cancel(id);
  assert.equal(queue.get(id)?.status, "cancelled");
  const expired = queue.enqueue({ type: "upload", projectUUID: "project-2", sessionExpiresAt: 900 });
  assert.equal(queue.nextReady(), undefined);
  assert.equal(queue.get(expired)?.status, "session_expired");
  queue.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("下载中断后从已校验偏移续传并在摘要不符时拒绝正式发布", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-transfer-"));
  const content = Buffer.from("abcdefghijklmnopqrstuvwxyz".repeat(4096));
  const destination = path.join(root, "download.bin");
  const offsets: number[] = [];
  let first = true;
  const source: RangeSource = {
    async *readFrom(offset) {
      offsets.push(offset);
      const end = first ? Math.min(content.length, offset + 8192) : content.length;
      first = false;
      yield content.subarray(offset, end);
      if (end < content.length) throw new Error("simulated interruption");
    },
  };
  const md5 = crypto.createHash("md5").update(content).digest("hex");
  await assert.rejects(() => downloadWithResume(source, destination, content.length, md5), /interruption/);
  await downloadWithResume(source, destination, content.length, md5);
  assert.deepEqual(fs.readFileSync(destination), content);
  assert.equal(offsets[1], 8192);

  fs.writeFileSync(destination, "old");
  await assert.rejects(
    () => downloadWithResume({ async *readFrom() { yield Buffer.from("bad"); } }, destination, 3, md5),
    /对象摘要校验失败/,
  );
  assert.equal(fs.readFileSync(destination, "utf8"), "old");
  fs.rmSync(root, { recursive: true, force: true });
});

test("空间不足、损坏暂存和切换失败时旧项目始终可打开", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-switch-"));
  const current = path.join(root, "current");
  const staging = path.join(root, "staging");
  const recovery = path.join(root, "recovery");
  fs.mkdirSync(current); fs.writeFileSync(path.join(current, "version.txt"), "old");
  fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, "version.txt"), "new");

  await assert.rejects(
    () => atomicSwitchProject({ current, staging, recovery, requiredBytes: 10, availableBytes: 1, validate: async () => true }),
    /磁盘空间不足/,
  );
  assert.equal(fs.readFileSync(path.join(current, "version.txt"), "utf8"), "old");
  await assert.rejects(
    () => atomicSwitchProject({ current, staging, recovery, requiredBytes: 10, availableBytes: 100, validate: async () => false }),
    /暂存项目校验失败/,
  );
  await assert.rejects(
    () => atomicSwitchProject({
      current, staging, recovery, requiredBytes: 10, availableBytes: 100,
      validate: async () => true, simulatePublishFailure: true,
    }),
    /原子切换失败/,
  );
  assert.equal(fs.readFileSync(path.join(current, "version.txt"), "utf8"), "old");
  fs.rmSync(root, { recursive: true, force: true });
});
