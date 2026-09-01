/**
 * RED→GREEN：应用重启后必须从持久化任务记录恢复未完成任务，且不得重复提交供应商请求。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import type {
  GenerationTaskIdentity,
  RemoteGenerationResult,
} from "../../src/tianjiang/tasks/generation-task-recovery";
import { stringifyGenerationCompletionContract, createGenerationCompletionContract } from "../../src/tianjiang/tasks/generation-completion-contract";
import { installManagedStaging } from "./helpers/managed-generation-staging";

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = 2_700_000_000_000;
const FIXTURE_MP4 = path.resolve(__dirname, "fixtures", "minimal-adoptable.mp4");

function completedVideo(localPath: string): RemoteGenerationResult {
  return {
    state: "completed",
    artifact: {
      mediaType: "video",
      sourceKind: "local_path",
      localPath,
    },
  };
}
const SUPERVISOR_SPEC = "../../src/tianjiang/tasks/background-task-supervisor";

interface Supervisor {
  restoreFromPersistence(): Promise<void>;
  tick(now?: number): Promise<void>;
  notifyExplicitShutdown(): Promise<void>;
  runtimeCount(): number;
  listRuntimeTasks(): Array<Record<string, unknown>>;
  submitCount(): number;
  cancelCount(): number;
  pollCount(): number;
}

async function loadSupervisor(): Promise<{
  createBackgroundTaskSupervisor: (deps: Record<string, unknown>) => Supervisor;
}> {
  return import(SUPERVISOR_SPEC);
}

async function createDatabase(root: string): Promise<Knex> {
  const database = knex({
    client: "better-sqlite3",
    connection: { filename: path.join(root, "project.sqlite") },
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
    table.string("taskClass");
    table.integer("createdAt");
    table.integer("lastPollAt");
    table.string("generationStatus");
    table.integer("manualRetryRequired");
    table.integer("recoveryAttemptedAt");
    table.integer("startTime");
    table.text("relatedObjects");
    table.text("resultLocator");
  });
  await database.schema.createTable("o_video", (table) => {
    table.integer("id").primary();
    table.text("filePath");
    table.string("state");
    table.text("errorReason");
  });
  return database;
}

function fixtureRoot(): string {
  const root = path.join(process.cwd(), "..", ".tmp", `bg-restart-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

test("重启后只按原远端 ID 恢复轮询，完成后清理运行态，绝不重提", async () => {
  const root = fixtureRoot();
  const staging = installManagedStaging(root);
  const database = await createDatabase(root);
  const polls: GenerationTaskIdentity[] = [];
  const submits: string[] = [];
  try {
    await database("o_tasks").insert({
      id: 41,
      projectId: 1,
      state: "进行中",
      provider: "synthetic-provider",
      remoteTaskId: "remote-restart-41",
      projectUuid: UUID_A,
      requestDigest: "b".repeat(64),
      taskClass: "视频生成",
      relatedObjects: stringifyGenerationCompletionContract(createGenerationCompletionContract({
        kind: "video", mediaType: "video", videoId: 41, relativePath: "files/videos/r41.mp4",
      })),
      createdAt: NOW - 3_000,
      startTime: NOW - 3_000,
      generationStatus: "polling",
      manualRetryRequired: 0,
    });
    await database("o_tasks").insert({
      id: 42,
      projectId: 1,
      state: "进行中",
      provider: "synthetic-provider",
      remoteTaskId: "remote-restart-42",
      projectUuid: UUID_A,
      requestDigest: "c".repeat(64),
      taskClass: "视频生成",
      relatedObjects: stringifyGenerationCompletionContract(createGenerationCompletionContract({
        kind: "video", mediaType: "video", videoId: 42, relativePath: "files/videos/r42.mp4",
      })),
      createdAt: NOW - 2_000,
      startTime: NOW - 2_000,
      generationStatus: "temporary_failure",
      manualRetryRequired: 0,
    });
    await database("o_video").insert({ id: 41, filePath: "", state: "生成中" });
    await database("o_video").insert({ id: 42, filePath: "", state: "生成中" });

    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    const first = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:9",
      now: () => NOW,
      poll: async (task: GenerationTaskIdentity): Promise<RemoteGenerationResult> => {
        polls.push(task);
        return { state: "pending" };
      },
      listSources: async () => [{ projectUuid: UUID_A, localProjectId: 41, database }],
    });
    await first.restoreFromPersistence();
    assert.equal(first.runtimeCount(), 2);
    await first.tick(NOW);
    await first.notifyExplicitShutdown();

    const second = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:9",
      now: () => NOW + 10_000,
      poll: async (task: GenerationTaskIdentity): Promise<RemoteGenerationResult> => {
        polls.push(task);
        submits.push("must-not-happen");
        return completedVideo(staging.stage(FIXTURE_MP4));
      },
      listSources: async () => [{ projectUuid: UUID_A, localProjectId: 41, database }],
    });
    await second.restoreFromPersistence();
    assert.equal(second.runtimeCount(), 2, "重启必须从 SQLite 恢复未完成任务");
    assert.deepEqual(
      second.listRuntimeTasks().map((task) => task.remoteTaskId).sort(),
      ["remote-restart-41", "remote-restart-42"],
    );
    // 覆盖上面误写入 submits 的探针：真正实现不得提供 submit。
    submits.length = 0;
    const completing = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:9",
      now: () => NOW + 20_000,
      poll: async (task: GenerationTaskIdentity): Promise<RemoteGenerationResult> => {
        polls.push(task);
        return completedVideo(staging.stage(FIXTURE_MP4));
      },
      listSources: async () => [{ projectUuid: UUID_A, localProjectId: 41, database }],
    });
    await completing.restoreFromPersistence();
    await completing.tick(NOW + 20_000);
    assert.equal(completing.runtimeCount(), 0);
    assert.equal(completing.submitCount(), 0);
    assert.equal(completing.cancelCount(), 0);
    const rows = await database("o_tasks").orderBy("id");
    assert.equal(rows[0].state, "已完成");
    assert.equal(rows[0].remoteTaskId, "remote-restart-41");
    assert.equal(rows[1].state, "已完成");
    assert.equal(rows[1].remoteTaskId, "remote-restart-42");
    assert.ok(polls.every((task) => task.remoteTaskId.startsWith("remote-restart-")));
    assert.equal(submits.length, 0);
  } finally {
    staging.dispose();
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("重启恢复不得调用会向供应商创建新任务的适配器", async () => {
  const root = fixtureRoot();
  const database = await createDatabase(root);
  let createCalls = 0;
  try {
    await database("o_tasks").insert({
      id: 7,
      projectId: 1,
      state: "进行中",
      provider: "synthetic-provider",
      remoteTaskId: "already-submitted",
      projectUuid: UUID_A,
      requestDigest: "d".repeat(64),
      taskClass: "image",
      createdAt: NOW - 1_000,
      startTime: NOW - 1_000,
      generationStatus: "polling",
      manualRetryRequired: 0,
    });
    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    const supervisor = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:9",
      now: () => NOW,
      poll: async () => ({ state: "pending" }),
      createRemoteTask: async () => {
        createCalls += 1;
        return { remoteTaskId: "new-should-not-exist" };
      },
      listSources: async () => [{ projectUuid: UUID_A, localProjectId: 7, database }],
    });
    await supervisor.restoreFromPersistence();
    await supervisor.tick(NOW);
    assert.equal(createCalls, 0);
    assert.equal(supervisor.submitCount(), 0);
    const row = await database("o_tasks").where("id", 7).first();
    assert.equal(row.remoteTaskId, "already-submitted");
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
