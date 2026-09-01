/**
 * RED→GREEN：远端 completed 必须带着规范化产物，并由幂等 finalizer 与 o_tasks 同事务落库。
 * 缺少产物时任务中心不得显示已完成。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import {
  recoverGenerationTasks,
  type RemoteGenerationResult,
} from "../../src/tianjiang/tasks/generation-task-recovery";
import { normalizeRemoteState } from "../../src/tianjiang/tasks/vendor-status-adapters";
import { stringifyGenerationCompletionContract, createGenerationCompletionContract } from "../../src/tianjiang/tasks/generation-completion-contract";
import { writeMinimalPng } from "./helpers/minimal-png";
import { installManagedStaging } from "./helpers/managed-generation-staging";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { runWithProjectStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";

syncCoordinator.listProjects = (() => [{
  projectUuid: UUID,
  kind: "personal",
  myRole: "owner",
  openMode: "editable",
}]) as typeof syncCoordinator.listProjects;
syncCoordinator.peekProject = ((projectUuid: string) => projectUuid === UUID
  ? { projectUuid: UUID, kind: "personal", myRole: "owner", openMode: "editable" }
  : undefined) as typeof syncCoordinator.peekProject;

const NOW = 2_800_000_000_000;
const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FIXTURE_MP4 = path.resolve(__dirname, "fixtures", "minimal-adoptable.mp4");

const TASK_CASES = [
  {
    name: "视频",
    taskClass: "视频生成",
    related: createGenerationCompletionContract({ kind: "video", mediaType: "video", videoId: 1, relativePath: "files/videos/recovered.mp4" }),
    mediaType: "video" as const,
    table: "o_video",
    rowId: 1,
    successState: "生成成功",
  },
  {
    name: "图片",
    taskClass: "生成图片",
    related: createGenerationCompletionContract({ kind: "image", mediaType: "image", imageId: 2, relativePath: "files/images/recovered.png" }),
    mediaType: "image" as const,
    table: "o_image",
    rowId: 2,
    successState: "已完成",
  },
  {
    name: "编辑图",
    taskClass: "工作流图片生成",
    related: createGenerationCompletionContract({ kind: "workflow-image", mediaType: "image", imageId: 3, relativePath: "files/images/workflow.png" }),
    mediaType: "image" as const,
    table: "o_image",
    rowId: 3,
    successState: "已完成",
  },
  {
    name: "批量素材",
    taskClass: "角色图生成",
    related: createGenerationCompletionContract({ kind: "asset-image", mediaType: "image", imageId: 4, assetsId: 9, relativePath: "files/images/asset.png" }),
    mediaType: "image" as const,
    table: "o_image",
    rowId: 4,
    successState: "已完成",
  },
  {
    name: "分镜图片",
    taskClass: "生成分镜图片",
    related: createGenerationCompletionContract({ kind: "storyboard-image", mediaType: "image", storyboardId: 5, relativePath: "files/images/shot.png" }),
    mediaType: "image" as const,
    table: "o_storyboard",
    rowId: 5,
    successState: "已完成",
  },
  {
    name: "普通供应商分镜",
    taskClass: "storyboard",
    related: createGenerationCompletionContract({
      kind: "vendor-storyboard",
      taskUuid: "11111111-1111-4111-a111-111111111111",
      shotUuid: "22222222-2222-4222-a222-222222222222",
      mediaType: "video",
      relativePath: "files/videos/vendor.mp4",
    }),
    mediaType: "video" as const,
    table: "o_storyboardGenerationTask",
    rowId: "11111111-1111-4111-a111-111111111111",
    successState: "completed",
  },
  {
    name: "Dreamina",
    taskClass: "storyboard",
    related: createGenerationCompletionContract({
      kind: "dreamina",
      taskUuid: "33333333-3333-4333-a333-333333333333",
      shotUuid: "44444444-4444-4444-a444-444444444444",
      mediaType: "image",
      relativePath: "files/images/dreamina.png",
    }),
    mediaType: "image" as const,
    table: "o_storyboardGenerationTask",
    rowId: "33333333-3333-4333-a333-333333333333",
    successState: "completed",
  },
] as const;

function fixtureRoot(): string {
  const root = path.join(process.cwd(), "..", ".tmp", `artifact-finalizer-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
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
    table.text("relatedObjects");
    table.integer("createdAt");
    table.integer("lastPollAt");
    table.string("generationStatus");
    table.integer("manualRetryRequired");
    table.integer("recoveryAttemptedAt");
    table.text("resultLocator");
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
  await database.schema.createTable("o_storyboard", (table) => {
    table.integer("id").primary();
    table.text("filePath");
    table.string("state");
    table.text("reason");
  });
  await database.schema.createTable("o_storyboardGenerationTask", (table) => {
    table.string("taskUuid").primary();
    table.string("shotUuid");
    table.string("mediaType");
    table.string("providerId");
    table.string("status");
    table.text("errorSummary");
    table.integer("updatedAt");
    table.integer("providerCompletedAt");
    table.string("resultLocatorDigest");
    table.integer("progress");
    table.string("errorCode");
  });
  await database.schema.createTable("o_storyboardCandidate", (table) => {
    table.increments("id").primary();
    table.string("candidateUuid");
    table.string("shotUuid");
    table.string("mediaType");
    table.string("relativePath");
    table.integer("selected");
    table.string("createdAt");
  });
  return database;
}

const TEST_IDENTITY = { issuer: "https://api.j11.com.cn", userId: 8808 };

async function recoverInProject(
  database: Knex,
  poller: { poll: (task: never) => Promise<RemoteGenerationResult> },
  now = NOW,
) {
  return runWithUserStorage(TEST_IDENTITY, () =>
    runWithProjectStorage(UUID, () => recoverGenerationTasks(database, poller as never, now)));
}

async function seedTask(
  database: Knex,
  input: {
    id: number;
    taskClass: string;
    related: unknown;
    remoteTaskId: string;
  },
): Promise<void> {
  await database("o_tasks").insert({
    id: input.id,
    projectId: 1,
    state: "进行中",
    provider: "synthetic-provider",
    remoteTaskId: input.remoteTaskId,
    projectUuid: UUID,
    requestDigest: "a".repeat(64),
    taskClass: input.taskClass,
    relatedObjects: stringifyGenerationCompletionContract(input.related as never),
    createdAt: NOW - 1_000,
    generationStatus: "polling",
    manualRetryRequired: 0,
  });
}

test("查询适配器必须从供应商成功响应中抽出规范化产物，而不是只返回 state", () => {
  const result = normalizeRemoteState({
    status: "success",
    url: "https://cdn.example/result.mp4",
    content_type: "video/mp4",
  }) as RemoteGenerationResult & { artifact?: { remoteUrl?: string; mediaType?: string } };
  assert.equal(result.state, "completed");
  assert.equal(result.artifact?.remoteUrl, "https://cdn.example/result.mp4");
  assert.equal(result.artifact?.mediaType, "video");
});

test("远端 completed 但没有规范化产物时不得把 o_tasks 标成已完成", async () => {
  const root = fixtureRoot();
  const database = await createDatabase(root);
  try {
    await seedTask(database, {
      id: 1,
      taskClass: "视频生成",
      related: createGenerationCompletionContract({ kind: "video", mediaType: "video", videoId: 1, relativePath: "files/videos/missing.mp4" }),
      remoteTaskId: "remote-no-artifact",
    });
    await database("o_video").insert({ id: 1, filePath: "", state: "生成中" });
    await recoverInProject(database, {
      poll: async () => ({ state: "completed" }),
    }, NOW);
    const task = await database("o_tasks").where("id", 1).first();
    const video = await database("o_video").where("id", 1).first();
    assert.notEqual(task.state, "已完成", "缺少产物落库时禁止显示任务已完成");
    assert.notEqual(task.generationStatus, "completed");
    assert.equal(video.state, "生成中");
    assert.equal(video.filePath, "");
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("产物文件缺失时 finalizer 失败，业务表与 o_tasks 保持非终态", async () => {
  const root = fixtureRoot();
  const database = await createDatabase(root);
  try {
    await seedTask(database, {
      id: 8,
      taskClass: "视频生成",
      related: createGenerationCompletionContract({ kind: "video", mediaType: "video", videoId: 8, relativePath: "files/videos/absent.mp4" }),
      remoteTaskId: "remote-absent-file",
    });
    await database("o_video").insert({ id: 8, filePath: "", state: "生成中" });
    await recoverInProject(database, {
      poll: async () => ({
        state: "completed",
        artifact: {
          mediaType: "video",
          sourceKind: "local_path",
          localPath: path.join(root, "does-not-exist.mp4"),
        },
      }),
    }, NOW);
    const task = await database("o_tasks").where("id", 8).first();
    const video = await database("o_video").where("id", 8).first();
    assert.notEqual(task.state, "已完成");
    assert.equal(video.state, "生成中");
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const [index, item] of TASK_CASES.entries()) {
  test(`${item.name}：completed + 产物必须幂等写入业务表，并与 o_tasks 终态一致`, async () => {
    const root = fixtureRoot();
    const staging = installManagedStaging(root);
    const database = await createDatabase(root);
    const destRoot = path.join(root, "files-out");
    fs.mkdirSync(destRoot, { recursive: true });
    try {
      await seedTask(database, {
        id: 10 + index,
        taskClass: item.taskClass,
        related: item.related,
        remoteTaskId: `remote-${item.name}`,
      });
      if (item.table === "o_video") {
        await database("o_video").insert({ id: item.rowId, filePath: "", state: "生成中" });
      } else if (item.table === "o_image") {
        await database("o_image").insert({
          id: item.rowId,
          assetsId: "assetsId" in item.related ? item.related.assetsId : null,
          filePath: "",
          state: "生成中",
        });
      } else if (item.table === "o_storyboard") {
        await database("o_storyboard").insert({ id: item.rowId, filePath: "", state: "生成中" });
      } else {
        const related = item.related as {
          shotUuid: string;
          mediaType: string;
          kind: string;
        };
        await database("o_storyboardGenerationTask").insert({
          taskUuid: item.rowId,
          shotUuid: related.shotUuid,
          mediaType: related.mediaType,
          providerId: related.kind === "dreamina" ? "dreamina-cli" : "synthetic-provider",
          status: "submitting",
          updatedAt: NOW - 1_000,
        });
      }

      const localPath = item.mediaType === "video"
        ? staging.stage(FIXTURE_MP4)
        : staging.stage(writeMinimalPng(path.join(root, `src-${index}.png`)));
      const artifact: RemoteGenerationResult = {
        state: "completed",
        artifact: {
          mediaType: item.mediaType,
          sourceKind: "local_path",
          localPath,
        },
      } as RemoteGenerationResult;

      await recoverInProject(database, { poll: async () => artifact }, NOW);
      await recoverInProject(database, { poll: async () => artifact }, NOW + 1_000);

      const task = await database("o_tasks").where("id", 10 + index).first();
      assert.equal(task.state, "已完成");
      assert.equal(task.generationStatus, "completed");

      if (item.table === "o_storyboardGenerationTask") {
        const rows = await database("o_storyboardGenerationTask").where("taskUuid", item.rowId);
        assert.equal(rows.length, 1, "finalizer 必须幂等，不得插入重复任务行");
        assert.equal(rows[0].status, item.successState);
      } else {
        const rows = await database(item.table).where("id", item.rowId);
        assert.equal(rows.length, 1, "finalizer 必须幂等，不得插入重复业务行");
        assert.equal(rows[0].state, item.successState);
        assert.ok(String(rows[0].filePath || "").length > 0, "业务表必须写入产物路径");
      }
    } finally {
      staging.dispose();
      await database.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
