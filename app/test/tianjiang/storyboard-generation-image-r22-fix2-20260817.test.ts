/**
 * R22-fix2 RED：Codex 确认的两个 P1。
 * P1-1 路径已解析但 version/-h 超时或失败必须是 CLI_UNAVAILABLE，不得伪装未安装。
 * P1-2 携带既有 request 的 retry 必须在写队列前走统一 ensureDreaminaExecuteReady。
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
import {
  invalidateDreaminaCapabilityCache,
  readDreaminaCapabilityCache,
  writeDreaminaCapabilityCache,
} from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import {
  DREAMINA_MODES,
  DREAMINA_VIDEO_MODELS,
  type DreaminaCapabilitySnapshot,
} from "../../src/tianjiang/model-providers/dreamina-cli/contracts";
import { resetDreaminaStartupStatusCheckForTests } from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import { stopDreaminaSchedulerLoop } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { enqueueAsyncMediaTasks } from "../../src/tianjiang/model-providers/async-generation-service";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { writeReadyDreaminaTestCapability } from "./helpers/dreamina-capability";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2212 };
const PROJECT = "b0222212-2212-4212-a212-221222122212";
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R22-fix2",
    kind: "personal",
    ownerUserId: IDENTITY.userId,
    role: "owner",
    myRole: "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-18T00:00:00Z",
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

async function jsonRequest(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function commandLog(logFile: string): string[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8")
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { args: string[] }).args[0]);
}

function leakFree(serialized: string): void {
  assert.equal(/[A-Za-z]:\\/.test(serialized), false);
  assert.equal(serialized.includes("sk-"), false);
  assert.equal(serialized.includes("SELECT "), false);
  assert.equal(serialized.toLowerCase().includes("cookie"), false);
}

function writeReadyModes(overrides: Partial<Record<string, { enabled: boolean; fields: string[] }>> = {}): void {
  const modes = Object.fromEntries(DREAMINA_MODES.map((mode) => [mode, {
    enabled: true,
    fields: ["--prompt", "--duration", "--ratio", "--video_resolution", "--model_version"],
    ...(overrides[mode] ?? {}),
  }])) as unknown as DreaminaCapabilitySnapshot["modes"];
  writeDreaminaCapabilityCache({
    state: "ready",
    snapshot: {
      installed: true,
      version: "r22-fix2",
      probedAt: Date.now(),
      loggedIn: true,
      modes,
      capabilities: [...DREAMINA_MODES],
      videoModels: [...DREAMINA_VIDEO_MODELS],
    },
    checkedAt: Date.now(),
  });
}

async function countRows(table: string): Promise<number> {
  return runWithProjectStorage(PROJECT, async () => {
    if (!await activeDb.schema.hasTable(table)) return 0;
    return (await activeDb(table).select()).length;
  });
}

async function withRuntime(
  name: string,
  run: (input: {
    boundShot: string;
    generateUrl: string;
    previewUrl: string;
    retryUrl: string;
    logFile: string;
  }) => Promise<void>,
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${process.pid}-${crypto.randomUUID()}`);
  const logFile = path.join(root, "cli.jsonl");
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousExec = process.env.DREAMINA_TEST_EXECUTABLE;
  const previousLog = process.env.DREAMINA_FAKE_LOG;
  const previousScenario = process.env.DREAMINA_FAKE_SCENARIO;
  const previousTimeout = process.env.DREAMINA_CLI_TIMEOUT_MS;
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.DREAMINA_FAKE_LOG = logFile;
  delete process.env.DREAMINA_FAKE_SCENARIO;
  delete process.env.DREAMINA_CLI_TIMEOUT_MS;
  resetDatabaseRuntimeForServe();
  resetDreaminaStartupStatusCheckForTests();
  invalidateDreaminaCapabilityCache();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 2212,
        name: "R22-fix2",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow()] as never;
      stopDreaminaSchedulerLoop();
      await writeDreaminaCliSettings({
        enabled: true,
        executablePath: FAKE_CLI,
        pauseNewClaims: true,
        maxConcurrency: 1,
      });
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({
        globalImagePrompt: "晨雾中的山谷",
        resolution: "720p",
        aspectRatio: "9:16",
        durationMs: 5000,
        imageConcurrency: 1,
        videoConcurrency: 1,
      });
      const first = await service.insertShot({
        afterShotUuid: null,
        sourceText: "角色近景",
        imagePrompt: "晨雾中的山谷",
        videoPrompt: "跟拍",
        durationMs: 5000,
      });
      const app = express();
      app.use(express.json({ limit: "2mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r22-fix2" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      const { default: retryRoute } = await import("../../src/routes/task/dreaminaQueue/retry");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      app.use("/api/task/dreaminaQueue/retry", retryRoute);
      await prepareProjectDatabase(PROJECT);
      const { server, port } = await listen(app);
      try {
        await run({
          boundShot: first.shotUuid,
          generateUrl: `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`,
          previewUrl: `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate/preview`,
          retryUrl: `http://127.0.0.1:${port}/api/task/dreaminaQueue/retry`,
          logFile,
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
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousExec === undefined) delete process.env.DREAMINA_TEST_EXECUTABLE;
    else process.env.DREAMINA_TEST_EXECUTABLE = previousExec;
    if (previousLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = previousLog;
    if (previousScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
    else process.env.DREAMINA_FAKE_SCENARIO = previousScenario;
    if (previousTimeout === undefined) delete process.env.DREAMINA_CLI_TIMEOUT_MS;
    else process.env.DREAMINA_CLI_TIMEOUT_MS = previousTimeout;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test("P1-1 CLI 路径存在但 version/-h 失败必须是 UNAVAILABLE 而不是未安装", async () => {
  await withRuntime("r22-fix2-install-failed", async ({ boundShot, generateUrl, previewUrl, logFile }) => {
    process.env.DREAMINA_FAKE_SCENARIO = "not_installed";
    resetDreaminaStartupStatusCheckForTests();
    invalidateDreaminaCapabilityCache();
    fs.writeFileSync(logFile, "");
    const body = {
      shotUuid: boundShot,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0",
      mode: "auto",
      durationMs: 5000,
      aspectRatio: "9:16",
    };
    const preview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const generated = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...body,
        expectedPreviewDigest: preview.body?.data?.previewDigest ?? "0".repeat(64),
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(generated.body));
    assert.equal(generated.body?.code, "STORYBOARD_DREAMINA_CLI_UNAVAILABLE", JSON.stringify(generated.body));
    assert.notEqual(generated.body?.code, "DREAMINA_CLI_NOT_INSTALLED");
    assert.equal(commandLog(logFile).includes("login"), false, JSON.stringify(commandLog(logFile)));
    assert.equal(await countRows("o_storyboardGenerationOperation"), 0);
    assert.equal(await countRows("o_storyboardGenerationTask"), 0);
    assert.equal(await countRows("o_dreaminaCliDispatch"), 0);
  });
});

test("P1-2 失败任务 retry 携带 request 时 failed/null 缓存必须先统一检测", async () => {
  await withRuntime("r22-fix2-retry-ready-check", async ({ boundShot, retryUrl, logFile }) => {
    writeReadyDreaminaTestCapability();
    const [parent] = await enqueueAsyncMediaTasks({
      projectUuid: PROJECT,
      clientOperationId: crypto.randomUUID(),
      paidBatchConfirmed: false,
      items: [{
        shotUuid: boundShot,
        mediaType: "image",
        providerModel: "dreamina-cli:text2image",
        mode: "text2image",
      }],
    });
    assert.ok(parent?.taskUuid);
    await accountDb("o_dreaminaCliDispatch").where({ taskUuid: parent.taskUuid }).update({
      queueState: "terminal",
      providerState: "failed",
      slotHeld: 0,
      dispatchReady: 1,
    });
    await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardGenerationTask").where({ taskUuid: parent.taskUuid }).update({
        status: "failed_retryable",
      }));

    const before = {
      operations: await countRows("o_storyboardGenerationOperation"),
      tasks: await countRows("o_storyboardGenerationTask"),
      dispatch: Number((await accountDb("o_dreaminaCliDispatch")
        .count<{ total: number }>("taskUuid as total").first())?.total ?? 0),
    };
    writeDreaminaCapabilityCache({
      state: "failed",
      snapshot: null,
      checkedAt: Date.now(),
      failureReason: "capability probe exception",
    });
    resetDreaminaStartupStatusCheckForTests();
    process.env.DREAMINA_FAKE_SCENARIO = "not_installed";
    fs.writeFileSync(logFile, "");
    const failedRetry = await jsonRequest(retryUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskUuid: parent.taskUuid,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(failedRetry.body));
    assert.equal(failedRetry.body?.code, "STORYBOARD_DREAMINA_CLI_UNAVAILABLE", JSON.stringify(failedRetry.body));
    assert.notEqual(failedRetry.body?.code, "DREAMINA_CLI_NOT_INSTALLED");
    const commands = commandLog(logFile);
    assert.ok(commands.includes("version") || commands.includes("-h"), JSON.stringify(commands));
    assert.equal(commands.includes("login"), false, JSON.stringify(commands));
    assert.equal(await countRows("o_storyboardGenerationOperation"), before.operations);
    assert.equal(await countRows("o_storyboardGenerationTask"), before.tasks);
    assert.equal(Number((await accountDb("o_dreaminaCliDispatch")
      .count<{ total: number }>("taskUuid as total").first())?.total ?? 0), before.dispatch);

    delete process.env.DREAMINA_FAKE_SCENARIO;
    delete process.env.DREAMINA_CLI_TIMEOUT_MS;
    writeReadyDreaminaTestCapability();
    resetDreaminaStartupStatusCheckForTests();
    fs.writeFileSync(logFile, "");
    const readyRetry = await jsonRequest(retryUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskUuid: parent.taskUuid,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(readyRetry.body));
    assert.equal(readyRetry.status, 200, JSON.stringify(readyRetry.body));
    const childUuid = String(readyRetry.body?.data?.taskUuid ?? readyRetry.body?.data?.tasks?.[0]?.taskUuid ?? "");
    assert.ok(childUuid && childUuid !== parent.taskUuid, JSON.stringify(readyRetry.body));
    assert.equal(commandLog(logFile).length, 0, JSON.stringify(commandLog(logFile)));
    assert.equal(readDreaminaCapabilityCache().state, "ready");
  });
});

test("P1-2 未安装/未登录/不可用/模式不支持必须保持四态且零授权", async () => {
  await withRuntime("r22-fix2-four-state", async ({ boundShot, generateUrl, previewUrl, logFile }) => {
    const dreaminaBody = {
      shotUuid: boundShot,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0",
      mode: "auto",
      durationMs: 5000,
      aspectRatio: "9:16",
    };

    const previousExec = process.env.DREAMINA_TEST_EXECUTABLE;
    delete process.env.DREAMINA_TEST_EXECUTABLE;
    await writeDreaminaCliSettings({ enabled: true, executablePath: path.join(process.cwd(), "missing-dreamina.exe") });
    resetDreaminaStartupStatusCheckForTests();
    invalidateDreaminaCapabilityCache();
    fs.writeFileSync(logFile, "");
    const missingPreview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dreaminaBody),
    });
    const missing = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...dreaminaBody,
        expectedPreviewDigest: missingPreview.body?.data?.previewDigest ?? "0".repeat(64),
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(missing.body));
    assert.equal(missing.body?.code, "DREAMINA_CLI_NOT_INSTALLED", JSON.stringify(missing.body));
    assert.equal(commandLog(logFile).includes("login"), false);

    process.env.DREAMINA_TEST_EXECUTABLE = previousExec ?? FAKE_CLI;
    await writeDreaminaCliSettings({ enabled: true, executablePath: FAKE_CLI });
    process.env.DREAMINA_FAKE_SCENARIO = "not_logged_in";
    resetDreaminaStartupStatusCheckForTests();
    invalidateDreaminaCapabilityCache();
    fs.writeFileSync(logFile, "");
    const loggedOutPreview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dreaminaBody),
    });
    const loggedOut = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...dreaminaBody,
        expectedPreviewDigest: loggedOutPreview.body?.data?.previewDigest ?? "0".repeat(64),
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(loggedOut.body));
    assert.equal(loggedOut.body?.code, "DREAMINA_CLI_NOT_LOGGED_IN", JSON.stringify(loggedOut.body));
    assert.equal(commandLog(logFile).includes("login"), false);

    process.env.DREAMINA_FAKE_SCENARIO = "not_installed";
    resetDreaminaStartupStatusCheckForTests();
    invalidateDreaminaCapabilityCache();
    fs.writeFileSync(logFile, "");
    const failedPreview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dreaminaBody),
    });
    const failed = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...dreaminaBody,
        expectedPreviewDigest: failedPreview.body?.data?.previewDigest ?? "0".repeat(64),
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(failed.body));
    assert.equal(failed.body?.code, "STORYBOARD_DREAMINA_CLI_UNAVAILABLE", JSON.stringify(failed.body));
    assert.notEqual(failed.body?.code, "DREAMINA_CLI_NOT_INSTALLED");
    assert.equal(commandLog(logFile).includes("login"), false);

    delete process.env.DREAMINA_FAKE_SCENARIO;
    writeReadyModes({
      text2video: { enabled: false, fields: [] },
    });
    fs.writeFileSync(logFile, "");
    const modePreview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dreaminaBody),
    });
    const unsupported = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...dreaminaBody,
        expectedPreviewDigest: modePreview.body?.data?.previewDigest ?? "0".repeat(64),
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(unsupported.body));
    assert.equal(unsupported.body?.code, "STORYBOARD_DREAMINA_MODE_UNSUPPORTED", JSON.stringify(unsupported.body));
    assert.equal(commandLog(logFile).includes("login"), false);
    assert.equal(commandLog(logFile).some((item) => String(item).endsWith("2video")), false);
  });
});
