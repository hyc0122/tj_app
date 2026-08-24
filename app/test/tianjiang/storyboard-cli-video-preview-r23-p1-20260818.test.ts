/**
 * R23 RED：即梦 CLI 提交必须有稳定码；启停服务独立；项目视频支持 Range 且可预览。
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
} from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import { resetDreaminaStartupStatusCheckForTests } from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import { stopDreaminaSchedulerLoop, tickDreaminaScheduler } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { writeProjectFileAtomic } from "../../src/tianjiang/media/project-file-store";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
  userStorageSegment,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { persistVendorGenerationResult } from "../../src/tianjiang/storyboard/storyboard-generation-service";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2301 };
const OTHER = { issuer: "https://api.j11.com.cn", userId: 2302 };
const PROJECT = "b0232301-2301-4301-a301-230123012301";
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");
const SEEDANCE_FAST = "dreamina-cli:seedance2.0fast";

function tinyValidMp4(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
    0x00, 0x00, 0x00, 0x10, 0x6d, 0x64, 0x61, 0x74,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
  ]);
}

function catalogRow(projectUuid = PROJECT, userId = IDENTITY.userId) {
  return {
    projectUuid,
    name: "R23",
    kind: "personal",
    ownerUserId: userId,
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

async function jsonRequest(url: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

function commandLines(logFile: string): Array<{ args: string[] }> {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").trim().split(/\n/).filter(Boolean).map((line) =>
    JSON.parse(line) as { args: string[] });
}

function leakFree(serialized: string): void {
  assert.equal(/[A-Za-z]:\\/.test(serialized), false);
  assert.equal(serialized.includes("sk-"), false);
  assert.equal(serialized.includes("SELECT "), false);
}

async function withStoryboardRuntime(
  name: string,
  run: (input: {
    shotUuid: string;
    generateUrl: string;
    previewUrl: string;
    statusUrl: string;
    setEnabledUrl: string;
    logFile: string;
  }) => Promise<void>,
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${process.pid}-${crypto.randomUUID()}`);
  const logFile = path.join(root, "cli.jsonl");
  const previousCwd = process.cwd();
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    DREAMINA_TEST_EXECUTABLE: process.env.DREAMINA_TEST_EXECUTABLE,
    DREAMINA_FAKE_LOG: process.env.DREAMINA_FAKE_LOG,
    DREAMINA_FAKE_SCENARIO: process.env.DREAMINA_FAKE_SCENARIO,
    DREAMINA_SCHEDULER_INTERVAL_MS: process.env.DREAMINA_SCHEDULER_INTERVAL_MS,
  };
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.DREAMINA_FAKE_LOG = logFile;
  delete process.env.DREAMINA_FAKE_SCENARIO;
  delete process.env.DREAMINA_SCHEDULER_INTERVAL_MS;
  resetDatabaseRuntimeForServe();
  resetDreaminaStartupStatusCheckForTests();
  invalidateDreaminaCapabilityCache();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 2301,
        name: "R23",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow()] as never;
      stopDreaminaSchedulerLoop();
      await writeDreaminaCliSettings({ enabled: true, executablePath: FAKE_CLI, pauseNewClaims: false });
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({
        globalVideoPrompt: "跟拍夜戏",
        resolution: "720p",
        aspectRatio: "9:16",
        durationMs: 5000,
      });
      const shot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "夜戏跟拍",
        videoPrompt: "跟拍",
        durationMs: 5000,
      });
      const app = express();
      app.use(express.json({ limit: "2mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r23" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      const statusRoute = (await import("../../src/routes/setting/dreaminaCli/getStatus")).default;
      app.use("/api/tianjiang/runtime", runtimeRouter);
      app.use("/api/setting/dreaminaCli/getStatus", statusRoute);
      try {
        const setEnabledRoute = (await import("../../src/routes/setting/dreaminaCli/setEnabled")).default;
        app.use("/api/setting/dreaminaCli/setEnabled", setEnabledRoute);
      } catch {
        // RED：路由尚未落地时只让 P1-2 合同失败。
      }
      await prepareProjectDatabase(PROJECT);
      const { server, port } = await listen(app);
      try {
        await run({
          shotUuid: shot.shotUuid,
          generateUrl: `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`,
          previewUrl: `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate/preview`,
          statusUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/getStatus`,
          setEnabledUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/setEnabled`,
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
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test("P1-1 已登录 seedance2.0fast 提交不得落入通用失败，且 CLI 必须带官方参数", async () => {
  await withStoryboardRuntime("r23-p1-submit", async ({ shotUuid, generateUrl, previewUrl, statusUrl, logFile }) => {
    const status = await jsonRequest(statusUrl);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body?.data?.install?.state ?? status.body?.install?.state, "installed");
    const body = {
      shotUuid,
      mediaType: "video",
      providerModel: SEEDANCE_FAST,
      mode: "text2video",
      durationMs: 5000,
      aspectRatio: "9:16",
    };
    const preview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    fs.writeFileSync(logFile, "");
    const generated = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...body,
        expectedPreviewDigest: preview.body?.data?.previewDigest,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(generated.body));
    assert.notEqual(generated.body?.message, "提交生成失败，请重试", JSON.stringify(generated.body));
    assert.notEqual(generated.status, 400, JSON.stringify(generated.body));
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    await tickDreaminaScheduler();
    const generateLine = commandLines(logFile).find((line) => line.args[0] === "text2video" && !line.args.includes("-h"));
    assert.ok(generateLine, JSON.stringify(commandLines(logFile)));
    assert.ok(generateLine?.args.some((item) => item === "--poll" || item.startsWith("--poll=")), JSON.stringify(generateLine));
    assert.ok(generateLine?.args.some((item) => item === "--model_version=seedance2.0fast" || item.includes("seedance2.0fast")), JSON.stringify(generateLine));
    assert.equal(generateLine?.args.includes("login"), false);
  });
});

test("P1-2 关闭即梦必须零探测零新入队，打开只跑允许的检测命令", async () => {
  await withStoryboardRuntime("r23-p1-enable", async ({
    shotUuid, generateUrl, previewUrl, statusUrl, setEnabledUrl, logFile,
  }) => {
    fs.writeFileSync(logFile, "");
    const closed = await jsonRequest(setEnabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body?.data?.enabled, false);
    const closedCommands = commandLines(logFile).map((line) => line.args[0]);
    assert.equal(closedCommands.includes("login"), false);
    assert.equal(closedCommands.some((item) => String(item).endsWith("2video") && !closedCommands.includes("-h")), false);

    fs.writeFileSync(logFile, "");
    const preview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid,
        mediaType: "video",
        providerModel: SEEDANCE_FAST,
        mode: "text2video",
        durationMs: 5000,
        aspectRatio: "9:16",
      }),
    });
    const generated = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid,
        mediaType: "video",
        providerModel: SEEDANCE_FAST,
        mode: "text2video",
        durationMs: 5000,
        aspectRatio: "9:16",
        expectedPreviewDigest: preview.body?.data?.previewDigest ?? "0".repeat(64),
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(generated.body));
    assert.equal(generated.body?.code, "DREAMINA_CLI_DISABLED", JSON.stringify(generated.body));
    assert.deepEqual(commandLines(logFile), []);

    const again = await jsonRequest(setEnabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(again.body?.data?.enabled, false);

    fs.writeFileSync(logFile, "");
    const opened = await jsonRequest(setEnabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body?.data?.enabled, true);
    assert.ok(opened.body?.data?.install);
    assert.ok(opened.body?.data?.account);
    assert.ok(opened.body?.data?.capability);
    const openedCommands = commandLines(logFile);
    const heads = openedCommands.map((line) => line.args[0]);
    assert.ok(heads.includes("version") || heads.includes("-h"), JSON.stringify(heads));
    assert.ok(heads.includes("user_credit"), JSON.stringify(heads));
    assert.equal(heads.includes("login"), false);
    for (const line of openedCommands) {
      const head = String(line.args[0] ?? "");
      if (head.endsWith("2video") || head.endsWith("2image")) {
        assert.ok(line.args.includes("-h") || line.args.includes("--help"), JSON.stringify(line.args));
      }
    }

    const staleStatus = await jsonRequest(statusUrl);
    const statusUpdatedAt = Number(staleStatus.body?.data?.updatedAt ?? staleStatus.body?.updatedAt ?? 0);
    const openedUpdatedAt = Number(opened.body?.data?.updatedAt ?? 0);
    assert.ok(statusUpdatedAt >= openedUpdatedAt, JSON.stringify({ statusUpdatedAt, openedUpdatedAt }));
  });
});

test("P1-3 项目视频 GET/Range/非法 Range 与权限必须 fail-closed，无效视频不得采用", async () => {
  const dataRoot = fs.mkdtempSync(path.resolve(__dirname, "../../../.tmp", "r23-files-"));
  const previousDataRoot = process.env.TIANJIANG_TEST_DATA_ROOT;
  const previousWorktree = process.env.TIANJIANG_TEST_WORKTREE_ROOT;
  process.env.TIANJIANG_TEST_DATA_ROOT = dataRoot;
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = path.resolve(__dirname, "../../..");
  const session = {
    serverUrl: IDENTITY.issuer,
    user: { id: IDENTITY.userId, username: "r23" },
  };
  const segment = userStorageSegment({ issuer: session.serverUrl, userId: session.user.id });
  const bytes = tinyValidMp4();
  writeProjectFileAtomic(dataRoot, PROJECT, segment, "files/videos/storyboard/shot/a.mp4", bytes);
  const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  syncCoordinator.listProjects = ((incoming: { user?: { id?: number } }) => {
    if (incoming?.user?.id === IDENTITY.userId) return [catalogRow()] as never;
    return [] as never;
  }) as typeof syncCoordinator.listProjects;
  const app = express();
  app.use((req, _res, next) => {
    (req as { centralSession?: unknown }).centralSession = req.headers["x-test-session"] === "other"
      ? { serverUrl: OTHER.issuer, user: { id: OTHER.userId, username: "other" } }
      : session;
    next();
  });
  app.use("/api/tianjiang/runtime", runtimeRouter);
  const { server, port } = await listen(app);
  const fileUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/files/videos/storyboard/shot/a.mp4`;
  try {
    const full = await fetch(fileUrl);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);

    const ranged = await fetch(fileUrl, { headers: { Range: "bytes=0-7" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), `bytes 0-7/${bytes.length}`);
    assert.equal(ranged.headers.get("content-length"), "8");
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(0, 8));

    const invalid = await fetch(fileUrl, { headers: { Range: "bytes=999-1000" } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), `bytes */${bytes.length}`);

    const head = await fetch(fileUrl, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("accept-ranges"), "bytes");

    const other = await fetch(fileUrl, { headers: { "x-test-session": "other" } });
    assert.equal(other.status, 404);
    const escape = await fetch(`http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/files/../project.sqlite`);
    assert.ok(escape.status === 404 || escape.status === 400);
    const missingProject = await fetch(`http://127.0.0.1:${port}/api/tianjiang/runtime/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/files/videos/storyboard/shot/a.mp4`);
    assert.equal(missingProject.status, 404);
  } finally {
    syncCoordinator.listProjects = originalList;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDataRoot === undefined) delete process.env.TIANJIANG_TEST_DATA_ROOT;
    else process.env.TIANJIANG_TEST_DATA_ROOT = previousDataRoot;
    if (previousWorktree === undefined) delete process.env.TIANJIANG_TEST_WORKTREE_ROOT;
    else process.env.TIANJIANG_TEST_WORKTREE_ROOT = previousWorktree;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("P1-3 空字节或非 MP4 结果不得标记为已采用候选", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `r23-invalid-${process.pid}-${crypto.randomUUID()}`);
  const previousCwd = process.cwd();
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 2301,
        name: "R23",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      const service = new StoryboardService(PROJECT);
      const shot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "夜戏",
        videoPrompt: "跟拍",
        durationMs: 5000,
      });
      await assert.rejects(() => persistVendorGenerationResult({
        projectUuid: PROJECT,
        shotUuid: shot.shotUuid,
        mediaType: "video",
        request: {
          providerModel: "volcengine:video",
          prompt: "x",
          references: [],
          options: { aspectRatio: "9:16", resolution: "720p", durationMs: 5000, mode: "text2video" },
        },
        runner: {
          run: async () => ({
            save: async (target: string) => {
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.writeFileSync(target, Buffer.alloc(0));
            },
          }),
        },
      }));
      const candidates = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardCandidate").select());
      assert.equal(candidates.length, 0);
    });
  } finally {
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
