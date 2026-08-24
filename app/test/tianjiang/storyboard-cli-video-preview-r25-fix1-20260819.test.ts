/**
 * R25-fix1 RED：工作台即梦丢弃 uploadData；队列 ready/wake 后再写 o_video；
 * 普通供应商被中央目录解析挡住。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import {
  accountDb,
  activateUserDatabase,
  db as activeDb,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  prepareProjectDatabase,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { invalidateDreaminaCapabilityCache } from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import { resetDreaminaStartupStatusCheckForTests } from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import {
  readDreaminaSchedulerWakeCountForTests,
  resetDreaminaSchedulerWakeCountForTests,
  stopDreaminaSchedulerLoop,
} from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { writeProjectFileAtomic } from "../../src/tianjiang/media/project-file-store";
import getPath from "../../src/utils/getPath";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
  userStorageSegment,
} from "../../src/tianjiang/runtime/user-storage-context";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import { writeReadyDreaminaTestCapability } from "./helpers/dreamina-capability";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2511 };
const PROJECT = "b0252511-2511-4511-a511-251125112511";
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");
const OP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const OP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

function tinyPng(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

function tinyValidMp4(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
    0x00, 0x00, 0x00, 0x10, 0x6d, 0x64, 0x61, 0x74,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
  ]);
}

function tinyMp3(): Buffer {
  return Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x00]);
}

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R25-fix1",
    kind: "personal",
    ownerUserId: IDENTITY.userId,
    role: "owner",
    myRole: "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-19T00:00:00Z",
    lockStatus: "none",
    lockHolderName: "",
    openMode: "editable",
    businessType: "storyboard",
  };
}

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function jsonRequest(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  const text = await response.text();
  try {
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, body: { message: text.slice(0, 180) } };
  }
}

async function counts(): Promise<{
  videos: number;
  ops: number;
  tasks: number;
  dispatch: number;
  readyDispatch: number;
}> {
  const videos = await runWithProjectStorage(PROJECT, () => activeDb("o_video").select());
  const ops = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationOperation").select().catch(() => []));
  const tasks = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").select().catch(() => []));
  const dispatch = await accountDb("o_dreaminaCliDispatch").select().catch(() => []);
  return {
    videos: videos.length,
    ops: ops.length,
    tasks: tasks.length,
    dispatch: dispatch.length,
    readyDispatch: dispatch.filter((row: { dispatchReady?: number }) => Number(row.dispatchReady) === 1).length,
  };
}

async function seedMedia(): Promise<void> {
  const segment = userStorageSegment(IDENTITY);
  const png = tinyPng();
  const mp4 = tinyValidMp4();
  const mp3 = tinyMp3();
  writeProjectFileAtomic(getPath(), PROJECT, segment, "files/images/workbench/a.png", png);
  writeProjectFileAtomic(getPath(), PROJECT, segment, "files/images/workbench/b.png", png);
  writeProjectFileAtomic(getPath(), PROJECT, segment, "files/images/workbench/c.png", png);
  writeProjectFileAtomic(getPath(), PROJECT, segment, "files/videos/workbench/ref.mp4", mp4);
  writeProjectFileAtomic(getPath(), PROJECT, segment, "files/audios/workbench/ref.mp3", mp3);
  await runWithProjectStorage(PROJECT, async () => {
    await activeDb("o_storyboard").insert({
      id: 11,
      scriptId: 9,
      projectId: 2501,
      filePath: "files/images/workbench/a.png",
      state: "已完成",
      prompt: "图A",
    }).catch(() => undefined);
    await activeDb("o_storyboard").insert({
      id: 12,
      scriptId: 9,
      projectId: 2501,
      filePath: "files/images/workbench/b.png",
      state: "已完成",
      prompt: "图B",
    }).catch(() => undefined);
    await activeDb("o_image").insert({
      id: 21,
      filePath: "files/images/workbench/c.png",
      type: "image",
      state: "生成成功",
    }).catch(() => undefined);
    await activeDb("o_image").insert({
      id: 22,
      filePath: "files/videos/workbench/ref.mp4",
      type: "video",
      state: "生成成功",
    }).catch(() => undefined);
    await activeDb("o_image").insert({
      id: 23,
      filePath: "files/audios/workbench/ref.mp3",
      type: "audio",
      state: "生成成功",
    }).catch(() => undefined);
    await activeDb("o_assets").insert({
      id: 31,
      name: "图C",
      type: "image",
      projectId: 2501,
      scriptId: 9,
      imageId: 21,
      assetUuid: "c0252511-2511-4511-a511-251125112531",
    }).catch(() => undefined);
    await activeDb("o_assets").insert({
      id: 32,
      name: "视频参考",
      type: "video",
      projectId: 2501,
      scriptId: 9,
      imageId: 22,
      assetUuid: "c0252511-2511-4511-a511-251125112532",
    }).catch(() => undefined);
    await activeDb("o_assets").insert({
      id: 33,
      name: "音频参考",
      type: "audio",
      projectId: 2501,
      scriptId: 9,
      imageId: 23,
      assetUuid: "c0252511-2511-4511-a511-251125112533",
    }).catch(() => undefined);
    await activeDb("o_storyboard").insert({
      id: 19,
      scriptId: 9,
      projectId: 2501,
      filePath: "../project.sqlite",
      state: "已完成",
      prompt: "穿越",
    }).catch(() => undefined);
    for (const id of [7, 8, 9]) {
      await activeDb("o_videoTrack").insert({
        id,
        projectId: 2501,
        scriptId: 9,
        prompt: `轨道${id}`,
        state: "未生成",
        duration: 5,
      }).catch(() => undefined);
    }
  });
}

async function withApp(
  name: string,
  run: (input: { port: number; updateUrl: string }) => Promise<void>,
  options: { catalog?: boolean } = {},
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${process.pid}-${crypto.randomUUID()}`);
  const previousCwd = process.cwd();
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    DREAMINA_TEST_EXECUTABLE: process.env.DREAMINA_TEST_EXECUTABLE,
  };
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  resetDatabaseRuntimeForServe();
  resetDreaminaStartupStatusCheckForTests();
  invalidateDreaminaCapabilityCache();
  stopDreaminaSchedulerLoop();
  resetDreaminaSchedulerWakeCountForTests();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 2501,
        name: "R25-fix1",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await prepareProjectDatabase(PROJECT);
      await writeDreaminaCliSettings({
        enabled: true,
        executablePath: FAKE_CLI,
        pauseNewClaims: true,
        maxConcurrency: 1,
      });
      writeReadyDreaminaTestCapability();
      await seedMedia();
      syncCoordinator.listProjects = options.catalog === false
        ? (() => [] as never)
        : (() => [catalogRow()] as never);
      const app = express();
      app.use(express.json({ limit: "2mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r25fix1" },
        };
        next();
      });
      const { default: generateVideo } = await import("../../src/routes/production/workbench/generateVideo");
      const { default: batchGenerateVideo } = await import("../../src/routes/production/workbench/batchGenerateVideo");
      app.use("/api/production/workbench/generateVideo", generateVideo);
      app.use("/api/production/workbench/batchGenerateVideo", batchGenerateVideo);
      const { server, port } = await listen(app);
      try {
        await run({ port, updateUrl: `http://127.0.0.1:${port}` });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    stopDreaminaSchedulerLoop();
    resetDreaminaStartupStatusCheckForTests();
    invalidateDreaminaCapabilityCache();
    syncCoordinator.listProjects = originalList;
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test("P1-1 单项/批量必须把 uploadData 解析进即梦 references，且不安全路径零写入", async () => {
  await withApp("r25f1-refs", async ({ updateUrl }) => {
    const single = await jsonRequest(`${updateUrl}/api/production/workbench/generateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        uploadData: [{ id: 11, sources: "storyboard" }],
        prompt: "单图跟拍",
        model: "dreamina-cli:seedance2.0fast",
        mode: "singleImage",
        resolution: "720p",
        duration: 5,
        audio: false,
        trackId: 7,
        clientOperationId: OP_A,
      }),
    });
    assert.equal(single.status, 200, JSON.stringify(single.body));
    const tasks = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").select());
    const parameters = JSON.parse(String(tasks[0]?.parametersJson ?? "{}"));
    assert.equal(parameters?.references?.length, 1, "单项单图不得把 references 固定成 []");
    assert.equal(parameters.references[0]?.relativePath, "files/images/workbench/a.png");
    assert.equal(parameters.references[0]?.mediaType, "image");
    assert.match(String(parameters.references[0]?.md5 ?? ""), /^[a-f0-9]{32}$/i);

    const frames = await jsonRequest(`${updateUrl}/api/production/workbench/generateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        uploadData: [
          { id: 11, sources: "storyboard" },
          { id: 12, sources: "storyboard" },
        ],
        prompt: "首尾帧",
        model: "dreamina-cli:seedance2.0fast",
        mode: "startEndRequired",
        resolution: "720p",
        duration: 5,
        audio: false,
        trackId: 8,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.equal(frames.status, 200, JSON.stringify(frames.body));
    const frameTask = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardGenerationTask").orderBy("createdAt", "desc").first());
    const frameParams = JSON.parse(String(frameTask?.parametersJson ?? "{}"));
    assert.equal(frameParams?.references?.length, 2);
    assert.deepEqual(frameParams.references.map((item: { relativePath: string }) => item.relativePath), [
      "files/images/workbench/a.png",
      "files/images/workbench/b.png",
    ]);

    const mixed = await jsonRequest(`${updateUrl}/api/production/workbench/batchGenerateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        model: "dreamina-cli:seedance2.0fast",
        mode: JSON.stringify(["imageReference:1", "videoReference:1", "audioReference:1"]),
        resolution: "720p",
        audio: true,
        paidBatchConfirmed: true,
        clientOperationId: crypto.randomUUID(),
        trackData: [{
          uploadData: [
            { id: 31, sources: "assets" },
            { id: 32, sources: "assets" },
            { id: 33, sources: "assets" },
          ],
          trackId: 9,
          prompt: "混合参考",
          duration: 5,
        }],
      }),
    });
    assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
    const mixedTask = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardGenerationTask").orderBy("createdAt", "desc").first());
    const mixedParams = JSON.parse(String(mixedTask?.parametersJson ?? "{}"));
    assert.equal(mixedParams?.references?.length, 3);
    assert.deepEqual(mixedParams.references.map((item: { mediaType: string }) => item.mediaType), [
      "image",
      "video",
      "audio",
    ]);

    const beforeBad = await counts();
    const incompatible = await jsonRequest(`${updateUrl}/api/production/workbench/generateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        uploadData: [{ id: 11, sources: "storyboard" }],
        prompt: "文生却带图",
        model: "dreamina-cli:seedance2.0fast",
        mode: "text",
        resolution: "720p",
        duration: 5,
        audio: false,
        trackId: 7,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.notEqual(incompatible.status, 200);
    assert.match(String(incompatible.body?.message ?? ""), /模式|参考|不支持/);
    const afterIncompatible = await counts();
    assert.equal(afterIncompatible.videos, beforeBad.videos);
    assert.equal(afterIncompatible.ops, beforeBad.ops);
    assert.equal(afterIncompatible.tasks, beforeBad.tasks);
    assert.equal(afterIncompatible.dispatch, beforeBad.dispatch);

    const escape = await jsonRequest(`${updateUrl}/api/production/workbench/generateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        uploadData: [{ id: 19, sources: "storyboard" }],
        prompt: "穿越",
        model: "dreamina-cli:seedance2.0fast",
        mode: "singleImage",
        resolution: "720p",
        duration: 5,
        audio: false,
        trackId: 7,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.notEqual(escape.status, 200);
    assert.equal(/[A-Za-z]:\\|SELECT /i.test(JSON.stringify(escape.body ?? {})), false);
    const afterEscape = await counts();
    assert.equal(afterEscape.videos, beforeBad.videos);
    assert.equal(afterEscape.ops, beforeBad.ops);
    assert.equal(afterEscape.tasks, beforeBad.tasks);
    assert.equal(afterEscape.dispatch, beforeBad.dispatch);
  });
});

test("P1-2 绑定必须在 dispatchReady/wake 之前完成，失败可重放且不得孤儿", async () => {
  await withApp("r25f1-bind", async ({ updateUrl }) => {
    const enqueue = await import("../../src/tianjiang/workbench/dreamina-workbench-enqueue");
    assert.equal(
      typeof enqueue.setWorkbenchAfterTaskPersistBeforeVideoHookForTests,
      "function",
      "必须能注入 operation/task 写入后、o_video 写入前失败",
    );
    assert.equal(
      typeof enqueue.setWorkbenchAfterVideoBeforeDispatchReadyHookForTests,
      "function",
      "必须能注入 o_video 写入后、dispatchReady 前失败",
    );
    assert.equal(
      typeof enqueue.setWorkbenchBindItemHookForTests,
      "function",
      "必须能注入批量中间一条绑定失败",
    );

    resetDreaminaSchedulerWakeCountForTests();
    enqueue.setWorkbenchAfterTaskPersistBeforeVideoHookForTests(() => {
      throw Object.assign(new Error("injected after persist"), { code: "TEST_INJECT_AFTER_PERSIST" });
    });
    const afterPersist = await jsonRequest(`${updateUrl}/api/production/workbench/generateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        uploadData: [],
        prompt: "注入 persist",
        model: "dreamina-cli:seedance2.0fast",
        mode: "text",
        resolution: "720p",
        duration: 5,
        audio: false,
        trackId: 7,
        clientOperationId: OP_A,
      }),
    });
    enqueue.setWorkbenchAfterTaskPersistBeforeVideoHookForTests(null);
    assert.notEqual(afterPersist.status, 200);
    const mid = await counts();
    assert.equal(mid.videos, 0, "o_video 写入前失败不得留下历史");
    assert.equal(mid.readyDispatch, 0);
    assert.equal(readDreaminaSchedulerWakeCountForTests(), 0, "绑定完成前调度器零 wake");
    const retryPersist = await jsonRequest(`${updateUrl}/api/production/workbench/generateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        uploadData: [],
        prompt: "注入 persist",
        model: "dreamina-cli:seedance2.0fast",
        mode: "text",
        resolution: "720p",
        duration: 5,
        audio: false,
        trackId: 7,
        clientOperationId: OP_A,
      }),
    });
    assert.equal(retryPersist.status, 200, JSON.stringify(retryPersist.body));
    const afterRetry = await counts();
    assert.equal(afterRetry.videos, 1);
    assert.equal(afterRetry.tasks, 1);
    assert.equal(afterRetry.ops, 1);

    resetDreaminaSchedulerWakeCountForTests();
    enqueue.setWorkbenchAfterVideoBeforeDispatchReadyHookForTests(() => {
      throw Object.assign(new Error("injected after video"), { code: "TEST_INJECT_AFTER_VIDEO" });
    });
    const afterVideo = await jsonRequest(`${updateUrl}/api/production/workbench/generateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        uploadData: [],
        prompt: "注入 video",
        model: "dreamina-cli:seedance2.0fast",
        mode: "text",
        resolution: "720p",
        duration: 5,
        audio: false,
        trackId: 8,
        clientOperationId: OP_B,
      }),
    });
    enqueue.setWorkbenchAfterVideoBeforeDispatchReadyHookForTests(null);
    assert.notEqual(afterVideo.status, 200);
    assert.equal(readDreaminaSchedulerWakeCountForTests(), 0);
    const readyB = await accountDb("o_dreaminaCliDispatch").where({ clientOperationId: OP_B }).select();
    assert.equal(
      readyB.filter((row: { dispatchReady?: number }) => Number(row.dispatchReady) === 1).length,
      0,
      "o_video 已写时仍不得 dispatchReady",
    );
    const retryVideo = await jsonRequest(`${updateUrl}/api/production/workbench/generateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        uploadData: [],
        prompt: "注入 video",
        model: "dreamina-cli:seedance2.0fast",
        mode: "text",
        resolution: "720p",
        duration: 5,
        audio: false,
        trackId: 8,
        clientOperationId: OP_B,
      }),
    });
    assert.equal(retryVideo.status, 200, JSON.stringify(retryVideo.body));
    const videosB = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_video").where({ videoTrackId: 8 }).select());
    assert.equal(videosB.length, 1, "重试不得重复 o_video");

    const lostOp = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
    const first = await jsonRequest(`${updateUrl}/api/production/workbench/generateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        uploadData: [],
        prompt: "响应丢失",
        model: "dreamina-cli:seedance2.0fast",
        mode: "text",
        resolution: "720p",
        duration: 5,
        audio: false,
        trackId: 9,
        clientOperationId: lostOp,
      }),
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const replay = await jsonRequest(`${updateUrl}/api/production/workbench/generateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        uploadData: [],
        prompt: "响应丢失",
        model: "dreamina-cli:seedance2.0fast",
        mode: "text",
        resolution: "720p",
        duration: 5,
        audio: false,
        trackId: 9,
        clientOperationId: lostOp,
      }),
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    const lostVideos = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_video").where({ videoTrackId: 9 }).select());
    const lostTasks = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardGenerationTask").where({ clientOperationId: lostOp }).select());
    assert.equal(lostVideos.length, 1, "响应丢失重试不得第二批 o_video");
    assert.equal(lostTasks.length, 1, "响应丢失重试不得第二批任务");

    let bindIndex = 0;
    enqueue.setWorkbenchBindItemHookForTests(async () => {
      bindIndex += 1;
      if (bindIndex === 2) {
        throw Object.assign(new Error("injected mid bind"), { code: "TEST_INJECT_MID_BIND" });
      }
    });
    const beforeBatch = await counts();
    const midBatch = await jsonRequest(`${updateUrl}/api/production/workbench/batchGenerateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        model: "dreamina-cli:seedance2.0fast",
        mode: "text",
        resolution: "720p",
        audio: false,
        paidBatchConfirmed: true,
        clientOperationId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
        trackData: [
          { uploadData: [], trackId: 7, prompt: "批量1", duration: 5 },
          { uploadData: [], trackId: 8, prompt: "批量2", duration: 5 },
          { uploadData: [], trackId: 9, prompt: "批量3", duration: 5 },
        ],
      }),
    });
    enqueue.setWorkbenchBindItemHookForTests(null);
    assert.notEqual(midBatch.status, 200);
    const afterMid = await counts();
    assert.equal(afterMid.videos, beforeBatch.videos, "批量中间绑定失败不得部分写 o_video");
    assert.equal(afterMid.readyDispatch, beforeBatch.readyDispatch);

    await runWithProjectStorage(PROJECT, async () => {
      const uuid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
      await activeDb("o_video").insert({
        filePath: "",
        time: Date.now(),
        state: "生成中",
        scriptId: 9,
        projectId: 2501,
        videoTrackId: 7,
        generationTaskUuid: uuid,
      });
      await assert.rejects(
        () => activeDb("o_video").insert({
          filePath: "",
          time: Date.now(),
          state: "生成中",
          scriptId: 9,
          projectId: 2501,
          videoTrackId: 8,
          generationTaskUuid: uuid,
        }),
        "generationTaskUuid 必须非空唯一",
      );
    });
  });
});

test("P1-2 结果安装在历史绑定缺失时必须失败关闭", async () => {
  await withApp("r25f1-install", async ({ updateUrl }) => {
    const created = await jsonRequest(`${updateUrl}/api/production/workbench/generateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        uploadData: [],
        prompt: "安装绑定",
        model: "dreamina-cli:seedance2.0fast",
        mode: "text",
        resolution: "720p",
        duration: 5,
        audio: false,
        trackId: 7,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const task = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardGenerationTask").orderBy("createdAt", "desc").first());
    await runWithProjectStorage(PROJECT, async () => {
      // 中文注释：此用例模拟旧版本已损坏项目，先显式撤下新版本 ready 绑定保护再造缺失历史。
      await activeDb.raw("DROP TRIGGER IF EXISTS trg_o_video_workbench_ready_delete_guard");
      await activeDb.raw("DROP TRIGGER IF EXISTS trg_o_video_workbench_ready_identity_guard");
      await activeDb("o_video").where({ generationTaskUuid: task?.taskUuid }).delete();
    });
    const { installDreaminaResult } = await import("../../src/tianjiang/model-providers/dreamina-cli/result-installer");
    const { buildMinimalAdoptableMp4 } = await import("./helpers/minimal-mp4");
    const staging = path.join(process.cwd(), "staging", String(task?.taskUuid));
    fs.mkdirSync(staging, { recursive: true });
    const file = path.join(staging, "result.mp4");
    fs.writeFileSync(file, buildMinimalAdoptableMp4());
    await assert.rejects(
      () => installDreaminaResult({
        projectUuid: PROJECT,
        taskUuid: String(task?.taskUuid),
        shotUuid: String(task?.shotUuid),
        mediaType: "video",
        stagingDirectory: staging,
        files: [file],
      }),
      "历史绑定缺失不得静默零行更新",
    );
  });
});

test("P1-3 普通供应商不得因中央目录缺失返回 WORKBENCH_PROJECT_NOT_FOUND", async () => {
  await withApp("r25f1-vendor-single", async ({ updateUrl }) => {
    const single = await jsonRequest(`${updateUrl}/api/production/workbench/generateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        uploadData: [],
        prompt: "供应商单项",
        model: "volcengine:demo-video",
        mode: "text",
        resolution: "720p",
        duration: 5,
        audio: false,
        trackId: 7,
      }),
    });
    assert.notEqual(single.body?.code, "WORKBENCH_PROJECT_NOT_FOUND");
    assert.equal(/项目不存在或不可见/.test(String(single.body?.message ?? "")), false);
  }, { catalog: false });

  await withApp("r25f1-vendor-batch", async ({ updateUrl }) => {
    const batch = await jsonRequest(`${updateUrl}/api/production/workbench/batchGenerateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        model: "volcengine:demo-video",
        mode: "text",
        resolution: "720p",
        audio: false,
        trackData: [{ uploadData: [], trackId: 7, prompt: "供应商批量", duration: 5 }],
      }),
    });
    assert.notEqual(batch.body?.code, "WORKBENCH_PROJECT_NOT_FOUND");
    assert.equal(/项目不存在或不可见/.test(String(batch.body?.message ?? "")), false);
  }, { catalog: false });
});
