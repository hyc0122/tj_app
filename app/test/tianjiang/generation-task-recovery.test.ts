import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import knex from "knex";

import {
  recoverGenerationTasks,
  retryExistingRemoteTask,
  type GenerationTaskIdentity,
  type RemoteGenerationResult,
} from "../../src/tianjiang/tasks/generation-task-recovery";

const HOUR = 60 * 60 * 1000;
const NOW = 2_000_000_000_000;

test("重启后 24 小时内只按原远端 ID 继续轮询并完成", async () => {
  const fixture = await createFixture();
  const calls: GenerationTaskIdentity[] = [];
  try {
    await fixture.addTask({ id: 1, createdAt: NOW - HOUR });
    const first = await recoverGenerationTasks(fixture.database, {
      poll: async (task) => {
        calls.push(task);
        return { state: "pending" };
      },
    }, NOW);
    assert.deepEqual(first, { checked: 1, completed: 0, pending: 1, manualRetry: 0 });
    assert.deepEqual(calls.map((call) => call.remoteTaskId), ["remote-1"]);

    const second = await recoverGenerationTasks(fixture.database, {
      poll: async (task) => {
        calls.push(task);
        return { state: "completed" };
      },
    }, NOW + 5_000);
    assert.equal(second.completed, 1);
    const row = await fixture.database("o_tasks").where("id", 1).first();
    assert.equal(row.state, "已完成");
    assert.equal(row.generationStatus, "completed");
    assert.equal(row.remoteTaskId, "remote-1", "恢复完成不得替换或重发远端任务 ID");
  } finally {
    await fixture.close();
  }
});

test("超过 24 小时只再查询原 ID 一次，随后要求人工重试", async () => {
  const fixture = await createFixture();
  let polls = 0;
  try {
    await fixture.addTask({ id: 2, createdAt: NOW - 25 * HOUR });
    const poller = {
      poll: async (): Promise<RemoteGenerationResult> => {
        polls += 1;
        return { state: "pending" };
      },
    };
    const first = await recoverGenerationTasks(fixture.database, poller, NOW);
    assert.equal(first.manualRetry, 1);
    await recoverGenerationTasks(fixture.database, poller, NOW + 5_000);
    assert.equal(polls, 1, "过期任务不得自动重复查询，更不得自动重发");
    const row = await fixture.database("o_tasks").where("id", 2).first();
    assert.equal(row.manualRetryRequired, 1);
    assert.equal(row.generationStatus, "manual_retry");

    await retryExistingRemoteTask(fixture.database, 2);
    const retryRow = await fixture.database("o_tasks").where("id", 2).first();
    assert.equal(retryRow.remoteTaskId, "remote-2");
    assert.equal(retryRow.manualRetryRequired, 0);
  } finally {
    await fixture.close();
  }
});

test("普通断网和临时轮询失败始终保留进行中；只有远端明确不存在才失败", async () => {
  const fixture = await createFixture();
  try {
    await fixture.addTask({ id: 3, createdAt: NOW - HOUR });
    const offline = await recoverGenerationTasks(fixture.database, {
      poll: async () => {
        throw new Error("ECONNRESET");
      },
    }, NOW);
    assert.equal(offline.pending, 1);
    let row = await fixture.database("o_tasks").where("id", 3).first();
    assert.equal(row.state, "进行中");
    assert.equal(row.generationStatus, "temporary_failure");

    const stillOffline = await recoverGenerationTasks(fixture.database, {
      poll: async () => ({ state: "temporary_error", reason: "ETIMEDOUT" }),
    }, NOW + 5_000);
    assert.equal(stillOffline.pending, 1);
    row = await fixture.database("o_tasks").where("id", 3).first();
    assert.equal(row.state, "进行中");
    assert.equal(row.generationStatus, "temporary_failure");
    assert.equal(row.reason, "普通供应商生成失败，请检查模型配置或稍后重试");

    const missing = await recoverGenerationTasks(fixture.database, {
      poll: async () => ({ state: "not_found", reason: "404" }),
    }, NOW + 10_000);
    assert.equal(missing.manualRetry, 1);
    row = await fixture.database("o_tasks").where("id", 3).first();
    assert.equal(row.state, "生成失败");
    assert.equal(row.manualRetryRequired, 1);
    assert.equal(row.reason, "普通供应商生成失败，请检查模型配置或稍后重试");
  } finally {
    await fixture.close();
  }
});

test("远端恢复错误写入任务前必须消毒密钥、签名 URL 与本机路径", async () => {
  const fixture = await createFixture();
  const leaked = "sk-secret https://signed.example/x C:\\private\\result.mp4";
  try {
    await fixture.addTask({ id: 4, createdAt: NOW - HOUR });
    await recoverGenerationTasks(fixture.database, {
      poll: async () => ({ state: "failed", reason: leaked }),
    }, NOW);
    const row = await fixture.database("o_tasks").where("id", 4).first();
    assert.equal(row.reason, "普通供应商生成失败，请检查模型配置或稍后重试");
    assert.doesNotMatch(String(row.reason), /sk-secret|signed\.example|C:\\private/i);
  } finally {
    await fixture.close();
  }
});

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-generation-recovery-"));
  const database = knex({
    client: "better-sqlite3",
    connection: { filename: path.join(root, "tasks.sqlite") },
    useNullAsDefault: true,
  });
  await database.schema.createTable("o_tasks", (table) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.string("state");
    table.text("reason");
    table.string("provider");
    table.string("remoteTaskId");
    table.string("projectUuid");
    table.string("requestDigest");
    table.integer("createdAt");
    table.integer("lastPollAt");
    table.string("generationStatus");
    table.integer("manualRetryRequired");
    table.integer("recoveryAttemptedAt");
  });
  return {
    database,
    async addTask(input: { id: number; createdAt: number }) {
      await database("o_tasks").insert({
        id: input.id,
        projectId: 1,
        state: "进行中",
        provider: "synthetic-provider",
        remoteTaskId: `remote-${input.id}`,
        projectUuid: "11111111-1111-4111-a111-111111111111",
        requestDigest: "a".repeat(64),
        createdAt: input.createdAt,
        generationStatus: "polling",
        manualRetryRequired: 0,
      });
    },
    async close() {
      await database.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
