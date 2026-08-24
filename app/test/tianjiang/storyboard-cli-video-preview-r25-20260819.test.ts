/**
 * R25 RED：getModelDetail 不识别 dreamina-cli；工作台 generate 仍走普通供应商；
 * 旧预览地址 /tianjiang/runtime 未挂载到 /api。
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
import { invalidateDreaminaCapabilityCache, writeDreaminaCapabilityCache } from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import {
  DREAMINA_MODES,
  DREAMINA_VIDEO_MODELS,
  type DreaminaCapabilitySnapshot,
} from "../../src/tianjiang/model-providers/dreamina-cli/contracts";
import { resetDreaminaStartupStatusCheckForTests } from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import { stopDreaminaSchedulerLoop } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
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

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2501 };
const OTHER = { issuer: "https://api.j11.com.cn", userId: 2502 };
const PROJECT = "b0252501-2501-4501-a501-250125012501";
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");

function tinyValidMp4(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
    0x00, 0x00, 0x00, 0x10, 0x6d, 0x64, 0x61, 0x74,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
  ]);
}

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R25",
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

function leakFree(serialized: string): void {
  assert.equal(/[A-Za-z]:\\/.test(serialized), false);
  assert.equal(/SELECT /i.test(serialized), false);
  assert.equal(/cookie/i.test(serialized), false);
}

async function withApp(
  name: string,
  run: (input: { port: number; updateUrl: string }) => Promise<void>,
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
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 2501,
        name: "R25",
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
      await runWithProjectStorage(PROJECT, async () => {
        await activeDb("o_videoTrack").insert({
          id: 7,
          projectId: 2501,
          scriptId: 9,
          prompt: "夜戏跟拍",
          state: "未生成",
          duration: 5,
        }).catch(() => undefined);
      });
      syncCoordinator.listProjects = () => [catalogRow()] as never;
      const app = express();
      app.use(express.json({ limit: "2mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r25" },
        };
        next();
      });
      const { default: detail } = await import("../../src/routes/modelSelect/getModelDetail");
      const { default: generateVideo } = await import("../../src/routes/production/workbench/generateVideo");
      const { default: batchGenerateVideo } = await import("../../src/routes/production/workbench/batchGenerateVideo");
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/modelSelect/getModelDetail", detail);
      app.use("/api/production/workbench/generateVideo", generateVideo);
      app.use("/api/production/workbench/batchGenerateVideo", batchGenerateVideo);
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      try {
        await run({
          port,
          updateUrl: `http://127.0.0.1:${port}`,
        });
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
    await runWithUserStorage(OTHER, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test("getModelDetail 必须为 dreamina-cli 构造工作台视频 DTO，且不得跑 login", async () => {
  await withApp("r25-detail", async ({ updateUrl }) => {
    const result = await jsonRequest(`${updateUrl}/api/modelSelect/getModelDetail`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "dreamina-cli:seedance2.0fast" }),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const detail = result.body?.data ?? result.body;
    assert.equal(detail?.type, "video");
    assert.equal(detail?.modelName, "dreamina-cli:seedance2.0fast");
    assert.ok(Array.isArray(detail?.mode) && detail.mode.length > 0);
    assert.equal(typeof detail?.audio === "boolean" || detail?.audio === "optional", true);
    assert.ok(Array.isArray(detail?.durationResolutionMap) && detail.durationResolutionMap[0]?.duration?.length);
    assert.ok(Number.isInteger(detail.minReferences) || Number.isInteger(detail.maxReferences));
    const unknown = await jsonRequest(`${updateUrl}/api/modelSelect/getModelDetail`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "dreamina-cli:not-a-model" }),
    });
    assert.notEqual(unknown.status, 200);
    leakFree(JSON.stringify(unknown.body ?? {}));
    assert.match(String(unknown.body?.message ?? unknown.body?.code ?? ""), /不支持|无效|不可用/);
  });
});

test("工作台单项/批量即梦提交必须入队且 enabled=false 零写入", async () => {
  await withApp("r25-enqueue", async ({ updateUrl }) => {
    await runWithUserStorage(IDENTITY, () => writeDreaminaCliSettings({ enabled: false }));
    const body = {
      projectId: 2501,
      scriptId: 9,
      uploadData: [],
      prompt: "夜戏跟拍",
      model: "dreamina-cli:seedance2.0fast",
      mode: "text",
      resolution: "720p",
      duration: 5,
      audio: false,
      trackId: 7,
    };
    const generated = await jsonRequest(`${updateUrl}/api/production/workbench/generateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    leakFree(JSON.stringify(generated.body ?? {}));
    assert.notEqual(generated.status, 200, JSON.stringify(generated.body));
    assert.match(
      `${generated.body?.code ?? ""} ${generated.body?.message ?? ""}`,
      /DREAMINA_CLI_DISABLED|已关闭/,
    );
    const videos = await runWithProjectStorage(PROJECT, () => activeDb("o_video").select());
    const ops = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationOperation").select().catch(() => []));
    const tasks = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").select().catch(() => []));
    const dispatch = await accountDb("o_dreaminaCliDispatch").select().catch(() => []);
    assert.equal(videos.length, 0, "enabled=false 不得写 o_video");
    assert.equal(ops.length, 0);
    assert.equal(tasks.length, 0);
    assert.equal(dispatch.length, 0);

    await runWithUserStorage(IDENTITY, () => writeDreaminaCliSettings({ enabled: true }));
    writeReadyDreaminaTestCapability();
    const ok = await jsonRequest(`${updateUrl}/api/production/workbench/generateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const queuedTasks = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").select());
    const queuedDispatch = await accountDb("o_dreaminaCliDispatch").select();
    assert.ok(queuedTasks.length >= 1, "单项必须进入现有 Dreamina 队列");
    assert.ok(queuedDispatch.length >= 1);
    const parameters = JSON.parse(String(queuedTasks[0]?.parametersJson ?? "{}"));
    assert.equal(parameters?.workbenchOrigin?.origin, "workbench");
    assert.equal(parameters?.workbenchOrigin?.trackId, 7);
    const shot = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardShot").where({ shotUuid: queuedTasks[0]?.shotUuid }).first().catch(() => undefined));
    assert.equal(shot, undefined, "不得伪造分镜 shotUuid");

    const batch = await jsonRequest(`${updateUrl}/api/production/workbench/batchGenerateVideo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2501,
        scriptId: 9,
        model: "dreamina-cli:seedance2.0fast",
        mode: "text",
        resolution: "720p",
        audio: false,
        trackData: [{ uploadData: [], trackId: 7, prompt: "批量夜戏", duration: 5 }],
        paidBatchConfirmed: true,
      }),
    });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    const afterBatch = await accountDb("o_dreaminaCliDispatch").select();
    assert.ok(afterBatch.length >= 2, "批量必须进入现有 Dreamina 队列");
  });
});

test("旧 /tianjiang/runtime 预览地址不得命中，/api 路径 HEAD/Range 必须成功", async () => {
  await withApp("r25-files", async ({ updateUrl }) => {
    const segment = userStorageSegment(IDENTITY);
    const bytes = tinyValidMp4();
    writeProjectFileAtomic(getPath(), PROJECT, segment, "files/videos/storyboard/shot/a.mp4", bytes);
    const apiUrl = `${updateUrl}/api/tianjiang/runtime/projects/${PROJECT}/files/videos/storyboard/shot/a.mp4`;
    const legacyUrl = `${updateUrl}/tianjiang/runtime/projects/${PROJECT}/files/videos/storyboard/shot/a.mp4`;
    const legacy = await fetch(legacyUrl);
    assert.notEqual(legacy.status, 200, "旧地址不得命中受保护文件路由");
    const head = await fetch(apiUrl, { method: "HEAD" });
    assert.equal(head.status, 200);
    const ranged = await fetch(apiUrl, { headers: { Range: "bytes=0-7" } });
    assert.equal(ranged.status, 206);
    const escape = await fetch(`${updateUrl}/api/tianjiang/runtime/projects/${PROJECT}/files/../project.sqlite`);
    assert.ok(escape.status === 404 || escape.status === 400);
  });
});
