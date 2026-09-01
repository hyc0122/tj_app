/**
 * 同步/异步生产完成事务：文件安装 + 业务表提交成功后，才能把 o_tasks 标完成。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import { settleCompletedGenerationTask, setGenerationFinalizeCrashHooks } from "../../src/tianjiang/tasks/generation-task-recovery";
import { buildWorkbenchVideoCompletionContract } from "../../src/routes/production/workbench/generateVideo";
import { buildWorkflowImageCompletionContract } from "../../src/routes/production/editImage/generateFlowImage";
import { runWithProjectStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { MINIMAL_PNG } from "./helpers/minimal-png";
import { installManagedStaging } from "./helpers/managed-generation-staging";

const NOW = 2_820_000_000_000;
const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa77";
const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 8877 };
const FIXTURE_MP4 = path.resolve(__dirname, "fixtures", "minimal-adoptable.mp4");

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
    table.text("resultLocator");
    table.integer("createdAt");
    table.integer("lastPollAt");
    table.string("generationStatus");
    table.integer("manualRetryRequired");
  });
  await database.schema.createTable("o_video", (table) => {
    table.integer("id").primary();
    table.text("filePath");
    table.string("state");
    table.text("errorReason");
  });
  await database.schema.createTable("o_image", (table) => {
    table.integer("id").primary();
    table.integer("assetsId");
    table.text("filePath");
    table.string("state");
    table.text("errorReason");
  });
  return database;
}

test("异步视频生产路由合同：文件与 o_video 提交前 o_tasks 不得完成", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `prod-video-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const staging = installManagedStaging(root);
  const database = await createDatabase(root);
  const relatedObjects = buildWorkbenchVideoCompletionContract({
    videoId: 11,
    videoPath: "/11/video/async.mp4",
    projectId: 11,
    scriptId: 3,
  });
  await database("o_tasks").insert({
    id: 11,
    projectId: 11,
    state: "进行中",
    provider: "atlascloud",
    remoteTaskId: "remote-async",
    projectUuid: UUID,
    requestDigest: "d".repeat(64),
    taskClass: "视频生成",
    relatedObjects,
    createdAt: NOW,
    generationStatus: "polling",
    manualRetryRequired: 0,
  });
  await database("o_video").insert({ id: 11, filePath: "", state: "生成中" });
  setGenerationFinalizeCrashHooks({
    beforeBusinessCommit: () => {
      throw new Error("crash-before-commit");
    },
  });
  try {
    await runWithUserStorage(IDENTITY, () => runWithProjectStorage(UUID, () =>
      settleCompletedGenerationTask({
        database,
        task: {
          id: 11,
          taskClass: "视频生成",
          relatedObjects,
          projectUuid: UUID,
          remoteTaskId: "remote-async",
          provider: "atlascloud",
        },
        artifact: {
          mediaType: "video",
          sourceKind: "local_path",
          localPath: staging.stage(FIXTURE_MP4),
        },
        now: NOW,
      }).catch(() => undefined)));
    const task = await database("o_tasks").where("id", 11).first();
    const video = await database("o_video").where("id", 11).first();
    assert.notEqual(task.state, "已完成");
    assert.equal(task.generationStatus, "pending_finalize");
    assert.equal(video.state, "生成中");
  } finally {
    setGenerationFinalizeCrashHooks(null);
    staging.dispose();
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("同步图片生产路由合同：文件与 o_image 成功后才完成 o_tasks", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `prod-image-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const staging = installManagedStaging(root);
  const png = staging.stageBytes(MINIMAL_PNG);
  const database = await createDatabase(root);
  const relatedObjects = buildWorkflowImageCompletionContract({
    imageId: 22,
    savePath: "22/workFlow/sync.png",
    projectId: 22,
  });
  await database("o_tasks").insert({
    id: 22,
    projectId: 22,
    state: "进行中",
    provider: "atlascloud",
    remoteTaskId: "remote-sync",
    projectUuid: UUID,
    requestDigest: "e".repeat(64),
    taskClass: "工作流图片生成",
    relatedObjects,
    createdAt: NOW,
    generationStatus: "polling",
    manualRetryRequired: 0,
  });
  await database("o_image").insert({ id: 22, filePath: "", state: "生成中" });
  try {
    await runWithUserStorage(IDENTITY, () => runWithProjectStorage(UUID, () =>
      settleCompletedGenerationTask({
        database,
        task: {
          id: 22,
          taskClass: "工作流图片生成",
          relatedObjects,
          projectUuid: UUID,
          remoteTaskId: "remote-sync",
          provider: "atlascloud",
        },
        artifact: {
          mediaType: "image",
          sourceKind: "local_path",
          localPath: png,
        },
        now: NOW,
      })));
    const task = await database("o_tasks").where("id", 22).first();
    const image = await database("o_image").where("id", 22).first();
    assert.equal(task.state, "已完成");
    assert.equal(task.generationStatus, "completed");
    assert.equal(image.state, "已完成");
    assert.ok(String(image.filePath || "").startsWith("files/"));
  } finally {
    staging.dispose();
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
