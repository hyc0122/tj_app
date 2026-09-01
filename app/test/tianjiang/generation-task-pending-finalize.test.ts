/**
 * 供应商返回后只能进入待终结；文件和业务表成功后才在事务中把 o_tasks 标完成。
 * 覆盖供应商返回后、文件落盘后、业务事务提交前三个崩溃点。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import {
  recoverGenerationTasks,
  setGenerationFinalizeCrashHooks,
} from "../../src/tianjiang/tasks/generation-task-recovery";
import { createGenerationCompletionContract, stringifyGenerationCompletionContract } from "../../src/tianjiang/tasks/generation-completion-contract";
import { runWithProjectStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { setGenerationArtifactDownloaderForTests } from "../../src/tianjiang/tasks/generation-artifact-downloader";
import { installManagedStaging } from "./helpers/managed-generation-staging";

const NOW = 2_810_000_000_000;
const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa99";
const FIXTURE_MP4 = path.resolve(__dirname, "fixtures", "minimal-adoptable.mp4");
const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 8810 };

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
    table.text("relatedObjects");
    table.integer("createdAt");
    table.integer("lastPollAt");
    table.string("generationStatus");
    table.integer("manualRetryRequired");
    table.text("resultLocator");
  });
  await database.schema.createTable("o_video", (table) => {
    table.integer("id").primary();
    table.text("filePath");
    table.string("state");
    table.text("errorReason");
  });
  await database("o_tasks").insert({
    id: 1,
    projectId: 1,
    state: "进行中",
    provider: "synthetic-provider",
    remoteTaskId: "remote-crash",
    projectUuid: UUID,
    requestDigest: "c".repeat(64),
    taskClass: "视频生成",
    relatedObjects: stringifyGenerationCompletionContract(createGenerationCompletionContract({
      kind: "video",
      mediaType: "video",
      videoId: 1,
      relativePath: "files/videos/crash.mp4",
    })),
    createdAt: NOW - 1_000,
    generationStatus: "polling",
    manualRetryRequired: 0,
  });
  await database("o_video").insert({ id: 1, filePath: "", state: "生成中" });
  return database;
}

async function recover(database: Knex, localPath: string) {
  return runWithUserStorage(IDENTITY, () =>
    runWithProjectStorage(UUID, () => recoverGenerationTasks(database, {
      poll: async () => ({
        state: "completed",
        artifact: {
          mediaType: "video",
          sourceKind: "local_path",
          localPath,
        },
      }),
    }, NOW)));
}

test("崩溃 1：供应商返回后只进入 pending_finalize，不得完成 o_tasks", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `crash1-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const staging = installManagedStaging(root);
  const database = await createDatabase(root);
  setGenerationFinalizeCrashHooks({
    afterVendorReturn: () => {
      throw new Error("crash-after-vendor");
    },
  });
  try {
    await recover(database, staging.stage(FIXTURE_MP4));
    const task = await database("o_tasks").where("id", 1).first();
    const video = await database("o_video").where("id", 1).first();
    assert.equal(task.state, "进行中");
    assert.equal(task.generationStatus, "pending_finalize");
    assert.equal(video.state, "生成中");
  } finally {
    setGenerationFinalizeCrashHooks(null);
    staging.dispose();
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("崩溃 2：文件落盘后业务表与 o_tasks 仍未完成", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `crash2-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const staging = installManagedStaging(root);
  const database = await createDatabase(root);
  setGenerationFinalizeCrashHooks({
    afterFileWritten: () => {
      throw new Error("crash-after-file");
    },
  });
  try {
    await recover(database, staging.stage(FIXTURE_MP4));
    const task = await database("o_tasks").where("id", 1).first();
    const video = await database("o_video").where("id", 1).first();
    assert.equal(task.state, "进行中");
    assert.equal(task.generationStatus, "pending_finalize");
    assert.equal(video.state, "生成中");
  } finally {
    setGenerationFinalizeCrashHooks(null);
    staging.dispose();
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pending_finalize 在供应商链接失效后仍可从 staging 恢复", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `staging-recover-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const staging = path.join(root, "generation-staging");
  fs.mkdirSync(staging, { recursive: true });
  const staged = path.join(staging, `gen-${process.pid}.part`);
  fs.copyFileSync(FIXTURE_MP4, staged);
  setGenerationArtifactDownloaderForTests({ stagingRoot: staging });
  const database = await createDatabase(root);
  const locator = JSON.stringify({
    remoteUrl: "https://expired.example/gone.mp4",
    mediaType: "video",
    stagingPath: staged,
  });
  await database("o_tasks").where("id", 1).delete();
  await database("o_tasks").insert({
    id: 9,
    projectId: 1,
    state: "进行中",
    provider: "atlascloud",
    remoteTaskId: "remote-expired",
    projectUuid: UUID,
    requestDigest: "f".repeat(64),
    taskClass: "视频生成",
    relatedObjects: stringifyGenerationCompletionContract(createGenerationCompletionContract({
      kind: "video",
      mediaType: "video",
      videoId: 1,
      relativePath: "files/videos/crash.mp4",
    })),
    createdAt: NOW,
    generationStatus: "pending_finalize",
    manualRetryRequired: 0,
    resultLocator: locator,
  });
  let polled = 0;
  try {
    await runWithUserStorage(IDENTITY, () => runWithProjectStorage(UUID, () =>
      recoverGenerationTasks(database, {
        poll: async () => {
          polled += 1;
          throw new Error("vendor-link-dead");
        },
      }, NOW)));
    const task = await database("o_tasks").where("id", 9).first();
    const video = await database("o_video").where("id", 1).first();
    assert.equal(polled, 0, "恢复不得强制重新查询供应商");
    assert.equal(task.state, "已完成");
    assert.equal(video.state, "生成成功");
  } finally {
    setGenerationArtifactDownloaderForTests(null);
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("崩溃 3：业务事务提交前必须回滚，o_tasks 不得标完成", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `crash3-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const staging = installManagedStaging(root);
  const database = await createDatabase(root);
  setGenerationFinalizeCrashHooks({
    beforeBusinessCommit: () => {
      throw new Error("crash-before-commit");
    },
  });
  try {
    await recover(database, staging.stage(FIXTURE_MP4));
    const task = await database("o_tasks").where("id", 1).first();
    const video = await database("o_video").where("id", 1).first();
    assert.equal(task.state, "进行中");
    assert.equal(task.generationStatus, "pending_finalize");
    assert.notEqual(task.state, "已完成");
    assert.equal(video.state, "生成中");
  } finally {
    setGenerationFinalizeCrashHooks(null);
    staging.dispose();
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
