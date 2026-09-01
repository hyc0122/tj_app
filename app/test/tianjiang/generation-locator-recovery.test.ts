/**
 * 一旦 resultLocator/staging 已持久化，后续失败保持 pending_finalize；
 * 崩溃在初始 locator 与 staging locator 之间时优先使用已有 locator，不轮询供应商。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import {
  recoverGenerationTasks,
  settleCompletedGenerationTask,
} from "../../src/tianjiang/tasks/generation-task-recovery";
import { createGenerationCompletionContract, stringifyGenerationCompletionContract } from "../../src/tianjiang/tasks/generation-completion-contract";
import { runWithProjectStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { setGenerationArtifactDownloaderForTests } from "../../src/tianjiang/tasks/generation-artifact-downloader";

const NOW = 2_830_000_000_000;
const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa83";
const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 8883 };
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
  return database;
}

test("polling 但已有初始 locator 时恢复不得再查询供应商", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `loc-init-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const staging = path.join(root, "generation-staging");
  fs.mkdirSync(staging, { recursive: true });
  const staged = path.join(staging, `gen-${process.pid}`);
  fs.copyFileSync(FIXTURE_MP4, staged);
  const database = await createDatabase(root);
  await database("o_tasks").insert({
    id: 1,
    projectId: 1,
    state: "进行中",
    provider: "atlascloud",
    remoteTaskId: "remote-init",
    projectUuid: UUID,
    requestDigest: "a".repeat(64),
    taskClass: "视频生成",
    relatedObjects: stringifyGenerationCompletionContract(createGenerationCompletionContract({
      kind: "video",
      mediaType: "video",
      videoId: 1,
      relativePath: "files/videos/init.mp4",
    })),
    createdAt: NOW,
    generationStatus: "polling",
    manualRetryRequired: 0,
    resultLocator: JSON.stringify({
      remoteUrl: "https://expired.example/gone.mp4",
      mediaType: "video",
      stagingPath: staged,
    }),
  });
  await database("o_video").insert({ id: 1, filePath: "", state: "生成中" });
  let polled = 0;
  setGenerationArtifactDownloaderForTests({ stagingRoot: staging });
  try {
    await runWithUserStorage(IDENTITY, () => runWithProjectStorage(UUID, () =>
      recoverGenerationTasks(database, {
        poll: async () => {
          polled += 1;
          throw new Error("must-not-poll");
        },
      }, NOW)));
    const task = await database("o_tasks").where("id", 1).first();
    assert.equal(polled, 0, "已有 locator 时禁止再次轮询供应商");
    assert.equal(task.state, "已完成");
    assert.equal(task.generationStatus, "completed");
  } finally {
    setGenerationArtifactDownloaderForTests(null);
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settle 在 locator 写入后失败必须保持 pending_finalize", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `loc-fail-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const database = await createDatabase(root);
  await database("o_tasks").insert({
    id: 2,
    projectId: 1,
    state: "进行中",
    provider: "atlascloud",
    remoteTaskId: "remote-fail",
    projectUuid: UUID,
    requestDigest: "b".repeat(64),
    taskClass: "视频生成",
    relatedObjects: stringifyGenerationCompletionContract(createGenerationCompletionContract({
      kind: "video",
      mediaType: "video",
      videoId: 2,
      relativePath: "files/videos/fail.mp4",
    })),
    createdAt: NOW,
    generationStatus: "polling",
    manualRetryRequired: 0,
  });
  await database("o_video").insert({ id: 2, filePath: "", state: "生成中" });
  setGenerationArtifactDownloaderForTests({
    lookup: async () => {
      throw new Error("download-boom");
    },
  });
  try {
    await runWithUserStorage(IDENTITY, () => runWithProjectStorage(UUID, async () => {
      await assert.rejects(() => settleCompletedGenerationTask({
        database,
        task: {
          id: 2,
          taskClass: "视频生成",
          relatedObjects: stringifyGenerationCompletionContract(createGenerationCompletionContract({
            kind: "video",
            mediaType: "video",
            videoId: 2,
            relativePath: "files/videos/fail.mp4",
          })),
          projectUuid: UUID,
          remoteTaskId: "remote-fail",
          provider: "atlascloud",
        },
        artifact: {
          mediaType: "video",
          sourceKind: "remote_url",
          remoteUrl: "https://cdn.example/fail.mp4",
        },
        now: NOW,
      }));
    }));
    const task = await database("o_tasks").where("id", 2).first();
    assert.ok(task.resultLocator, "失败前必须已持久化 locator");
    assert.equal(task.state, "进行中");
    assert.equal(task.generationStatus, "pending_finalize");
  } finally {
    setGenerationArtifactDownloaderForTests(null);
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
