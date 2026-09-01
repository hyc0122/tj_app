/**
 * staging 清理接入激活/恢复周期；仅未完成任务的有效 locator 保护文件；
 * 持久化 stagingPath 只能引用本账号 generation-staging 下的 gen-* 真实路径。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  pauseGenerationTaskRecovery,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  cleanupStaleGenerationStaging,
  materializeGenerationArtifact,
  setGenerationArtifactDownloaderForTests,
  stageInlineGenerationArtifact,
  UnsafeGenerationArtifactUrlError,
} from "../../src/tianjiang/tasks/generation-artifact-downloader";
import { settleCompletedGenerationTask } from "../../src/tianjiang/tasks/generation-task-recovery";
import { createGenerationCompletionContract, stringifyGenerationCompletionContract } from "../../src/tianjiang/tasks/generation-completion-contract";
import {
  currentUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
  userStorageRoot,
} from "../../src/tianjiang/runtime/user-storage-context";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import getPath from "../../src/utils/getPath";
import { MINIMAL_PNG, writeMinimalPng } from "./helpers/minimal-png";

const NOW = 2_840_000_000_000;
const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 8842 };
const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa42";

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
  await database.schema.createTable("o_image", (table) => {
    table.integer("id").primary();
    table.text("filePath");
    table.string("state");
    table.text("errorReason");
  });
  return database;
}

test("过期未引用删除、pending 引用保留、非 gen- 文件不删", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `stg-clean-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const staging = path.join(root, "generation-staging");
  fs.mkdirSync(staging, { recursive: true });
  const expired = path.join(staging, "gen-expired");
  const pending = path.join(staging, "gen-pending");
  const other = path.join(staging, "readme.txt");
  fs.writeFileSync(expired, "old");
  fs.writeFileSync(pending, "keep");
  fs.writeFileSync(other, "no");
  const old = (NOW - 2 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(expired, old, old);
  fs.utimesSync(pending, old, old);
  fs.utimesSync(other, old, old);
  const database = await createDatabase(root);
  await database("o_tasks").insert({
    id: 1,
    projectId: 1,
    state: "进行中",
    provider: "atlascloud",
    remoteTaskId: "remote-pending",
    projectUuid: UUID,
    requestDigest: "c".repeat(64),
    taskClass: "工作流图片生成",
    createdAt: NOW,
    generationStatus: "pending_finalize",
    manualRetryRequired: 0,
    resultLocator: JSON.stringify({ mediaType: "image", stagingPath: pending }),
  });
  await database("o_tasks").insert({
    id: 2,
    projectId: 1,
    state: "已完成",
    provider: "atlascloud",
    remoteTaskId: "remote-done",
    projectUuid: UUID,
    requestDigest: "d".repeat(64),
    taskClass: "工作流图片生成",
    createdAt: NOW,
    generationStatus: "completed",
    manualRetryRequired: 0,
    resultLocator: JSON.stringify({ mediaType: "image", stagingPath: expired }),
  });
  setGenerationArtifactDownloaderForTests({ stagingRoot: staging });
  try {
    const removed = await cleanupStaleGenerationStaging(database, NOW, 60 * 60 * 1000);
    assert.ok(removed >= 1);
    assert.equal(fs.existsSync(expired), false);
    assert.equal(fs.existsSync(pending), true);
    assert.equal(fs.existsSync(other), true);
  } finally {
    setGenerationArtifactDownloaderForTests(null);
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("任一项目库无法核对引用时必须停止本轮回收，禁止误删仍被引用的 staging", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `stg-fail-safe-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const previousCwd = process.cwd();
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  const identity = { issuer: IDENTITY.issuer, userId: IDENTITY.userId + 100 };
  try {
    await runWithUserStorage(identity, async () => {
      const context = currentUserStorage()!;
      const accountRoot = userStorageRoot(getPath(), context);
      const staging = path.join(accountRoot, "generation-staging");
      const projectRoot = path.join(accountRoot, "projects", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      fs.mkdirSync(staging, { recursive: true });
      fs.mkdirSync(projectRoot, { recursive: true });

      const candidate = path.join(staging, `gen-${crypto.randomUUID()}`);
      fs.writeFileSync(candidate, MINIMAL_PNG);
      const old = (NOW - 2 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(candidate, old, old);

      // 中文注释：模拟暂时无法读取的项目库。此时无法证明 candidate 未被任务引用，回收必须失败安全。
      fs.writeFileSync(path.join(projectRoot, "project.sqlite"), "not-a-sqlite-database");
      setGenerationArtifactDownloaderForTests({ stagingRoot: staging });
      const removed = await cleanupStaleGenerationStaging(undefined, NOW, 60 * 60 * 1000);

      assert.equal(removed, 0, "项目引用核对不完整时不得回收任何 staging 文件");
      assert.equal(fs.existsSync(candidate), true, "无法核对的项目可能仍引用该文件，必须保留");
    });
  } finally {
    setGenerationArtifactDownloaderForTests(null);
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("内联产物不得用补零绕过最小文件头长度", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `stg-short-magic-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const staging = path.join(root, "generation-staging");
  fs.mkdirSync(staging, { recursive: true });
  setGenerationArtifactDownloaderForTests({ stagingRoot: staging });
  try {
    // 中文注释：只有 PNG 签名、没有最小容器正文的 8 字节数据不能作为生成产物落盘。
    await assert.rejects(
      () => stageInlineGenerationArtifact({
        bytes: MINIMAL_PNG.subarray(0, 8),
        mediaType: "image",
        contentType: "image/png",
      }),
      /文件头过短/,
    );
    assert.deepEqual(fs.readdirSync(staging), [], "拒绝的短产物不得留下 staging 文件");
  } finally {
    setGenerationArtifactDownloaderForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("账号激活维护周期会清理过期未引用的 gen-* staging", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `stg-act-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const previousCwd = process.cwd();
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      const staging = path.join(userStorageRoot(getPath(), currentUserStorage()!), "generation-staging");
      fs.mkdirSync(staging, { recursive: true });
      const stale = path.join(staging, "gen-stale-activate");
      const other = path.join(staging, "notes.txt");
      fs.writeFileSync(stale, "old");
      fs.writeFileSync(other, "keep");
      const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(stale, old, old);
      fs.utimesSync(other, old, old);
      await activateUserDatabase(IDENTITY);
      assert.equal(fs.existsSync(stale), false, "激活周期必须删除过期未引用 gen-*");
      assert.equal(fs.existsSync(other), true, "非 gen- 文件不得删除");
    });
  } finally {
    await pauseGenerationTaskRecovery().catch(() => undefined);
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("持久化 stagingPath 禁止 dataRoot、tmpdir 与任意绝对路径", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `stg-path-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const staging = path.join(root, "generation-staging");
  fs.mkdirSync(staging, { recursive: true });
  const managed = path.join(staging, `gen-${crypto.randomUUID()}`);
  fs.writeFileSync(managed, MINIMAL_PNG);
  const tmpFile = path.join(os.tmpdir(), `tj-stg-${process.pid}.png`);
  writeMinimalPng(tmpFile);
  const dataFile = writeMinimalPng(path.join(root, "data.png"));
  const database = await createDatabase(root);
  await database("o_image").insert({ id: 9, filePath: "", state: "生成中" });
  setGenerationArtifactDownloaderForTests({ stagingRoot: staging });
  const relatedObjects = stringifyGenerationCompletionContract(createGenerationCompletionContract({
    kind: "workflow-image",
    mediaType: "image",
    imageId: 9,
    relativePath: "files/images/managed.png",
    projectId: 1,
  }));
  await database("o_tasks").insert({
    id: 9,
    projectId: 1,
    state: "进行中",
    provider: "atlascloud",
    remoteTaskId: "remote-path",
    projectUuid: UUID,
    requestDigest: "e".repeat(64),
    taskClass: "工作流图片生成",
    relatedObjects,
    createdAt: NOW,
    generationStatus: "polling",
    manualRetryRequired: 0,
  });
  try {
    await runWithUserStorage(IDENTITY, () => runWithProjectStorage(UUID, async () => {
      await assert.rejects(
        () => materializeGenerationArtifact({
          mediaType: "image",
          sourceKind: "local_path",
          localPath: tmpFile,
        }),
        UnsafeGenerationArtifactUrlError,
      );
      await assert.rejects(
        () => materializeGenerationArtifact({
          mediaType: "image",
          sourceKind: "local_path",
          localPath: dataFile,
        }),
        UnsafeGenerationArtifactUrlError,
      );
      await assert.rejects(() => settleCompletedGenerationTask({
        database,
        task: {
          id: 9,
          taskClass: "工作流图片生成",
          relatedObjects,
          projectUuid: UUID,
          remoteTaskId: "remote-path",
          provider: "atlascloud",
        },
        artifact: {
          mediaType: "image",
          sourceKind: "local_path",
          localPath: tmpFile,
        },
        now: NOW,
      }), /受管|staging|禁止/);
      await settleCompletedGenerationTask({
        database,
        task: {
          id: 9,
          taskClass: "工作流图片生成",
          relatedObjects,
          projectUuid: UUID,
          remoteTaskId: "remote-path",
          provider: "atlascloud",
        },
        artifact: {
          mediaType: "image",
          sourceKind: "local_path",
          localPath: managed,
        },
        now: NOW,
      });
    }));
    const task = await database("o_tasks").where("id", 9).first();
    assert.equal(task.state, "已完成");
    const locator = JSON.parse(String(task.resultLocator ?? "{}"));
    assert.equal(locator.stagingPath, undefined);
  } finally {
    setGenerationArtifactDownloaderForTests(null);
    await database.destroy();
    try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
