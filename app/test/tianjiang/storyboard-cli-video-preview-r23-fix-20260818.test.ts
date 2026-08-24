/**
 * R23-fix RED：关闭竞态、统一启停、错误脱敏、单调 revision、文件 TOCTOU、无效 MP4。
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
import { resetDreaminaEnablementForTests } from "../../src/tianjiang/model-providers/dreamina-cli/dreamina-enablement";
import {
  setDreaminaSchedulerAfterEnabledReadForTests,
  stopDreaminaSchedulerLoop,
  tickDreaminaScheduler,
} from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import {
  readDreaminaCliSettings,
  setDreaminaCliSettingsWriteHookForTests,
  writeDreaminaCliSettings,
} from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { installDreaminaResult, setAfterDreaminaResultValidatedForTests } from "../../src/tianjiang/model-providers/dreamina-cli/result-installer";
import { persistVendorGenerationResult } from "../../src/tianjiang/storyboard/storyboard-generation-service";
import {
  setProjectFileAfterStatHookForTests,
  writeProjectFileAtomic,
} from "../../src/tianjiang/media/project-file-store";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
  userStorageSegment,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import getPath from "../../src/utils/getPath";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import {
  buildMinimalAdoptableMp4,
  fakeFtypOnly,
  ftypPlusMdatOnly,
} from "./helpers/minimal-mp4";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2323 };
const OTHER = { issuer: "https://api.j11.com.cn", userId: 2324 };
const PROJECT = "b0232323-2323-4323-a323-232323232323";
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");
const SEEDANCE_FAST = "dreamina-cli:seedance2.0fast";
const LEAK = "E:\\\\data\\\\db2.sqlite SELECT * FROM o_dreaminaCliSettings at session-store.ts:58 cookie=abc token=sk-secret";

function catalogRow(projectUuid = PROJECT, userId = IDENTITY.userId) {
  return {
    projectUuid,
    name: "R23-fix",
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

async function jsonRequest(url: string, init: RequestInit = {}): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

function commandLines(logFile: string): Array<{ args: string[] }> {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").trim().split(/\n/).filter(Boolean).map((line) =>
    JSON.parse(line) as { args: string[] });
}

function leakFreeMessage(body: { message?: unknown; code?: unknown } | null): void {
  const serialized = `${String(body?.code ?? "")}:${String(body?.message ?? "")}`;
  assert.equal(/[A-Za-z]:\\/.test(serialized), false, serialized);
  assert.equal(serialized.includes("sk-"), false, serialized);
  assert.equal(serialized.includes("SELECT "), false, serialized);
  assert.equal(serialized.toLowerCase().includes("cookie"), false, serialized);
  assert.equal(/at\s+\S+\.(ts|js)/i.test(serialized), false, serialized);
}

async function withRuntime(
  name: string,
  run: (input: {
    shotUuid: string;
    generateUrl: string;
    previewUrl: string;
    statusUrl: string;
    setEnabledUrl: string;
    updateSettingsUrl: string;
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
    DREAMINA_FAKE_PROBE_DELAY_MS: process.env.DREAMINA_FAKE_PROBE_DELAY_MS,
    DREAMINA_FAKE_DELAY_MS: process.env.DREAMINA_FAKE_DELAY_MS,
    DREAMINA_SCHEDULER_INTERVAL_MS: process.env.DREAMINA_SCHEDULER_INTERVAL_MS,
  };
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.DREAMINA_FAKE_LOG = logFile;
  delete process.env.DREAMINA_FAKE_SCENARIO;
  delete process.env.DREAMINA_FAKE_PROBE_DELAY_MS;
  delete process.env.DREAMINA_FAKE_DELAY_MS;
  delete process.env.DREAMINA_SCHEDULER_INTERVAL_MS;
  resetDatabaseRuntimeForServe();
  resetDreaminaStartupStatusCheckForTests();
  resetDreaminaEnablementForTests();
  invalidateDreaminaCapabilityCache();
  setDreaminaSchedulerAfterEnabledReadForTests(null);
  setDreaminaCliSettingsWriteHookForTests(null);
  setAfterDreaminaResultValidatedForTests(null);
  setProjectFileAfterStatHookForTests(null);
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 2323,
        name: "R23-fix",
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
      app.use((_req, _res, next) => {
        enterUserStorage(IDENTITY);
        (_req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r23fix" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      app.use("/api/setting/dreaminaCli/getStatus", (await import("../../src/routes/setting/dreaminaCli/getStatus")).default);
      app.use("/api/setting/dreaminaCli/setEnabled", (await import("../../src/routes/setting/dreaminaCli/setEnabled")).default);
      app.use("/api/setting/dreaminaCli/updateSettings", (await import("../../src/routes/setting/dreaminaCli/updateSettings")).default);
      await prepareProjectDatabase(PROJECT);
      const { server, port } = await listen(app);
      try {
        await run({
          shotUuid: shot.shotUuid,
          generateUrl: `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`,
          previewUrl: `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate/preview`,
          statusUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/getStatus`,
          setEnabledUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/setEnabled`,
          updateSettingsUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/updateSettings`,
          logFile,
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    setDreaminaSchedulerAfterEnabledReadForTests(null);
    setDreaminaCliSettingsWriteHookForTests(null);
    setAfterDreaminaResultValidatedForTests(null);
    setProjectFileAfterStatHookForTests(null);
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

async function enqueueVideo(
  urls: { previewUrl: string; generateUrl: string },
  shotUuid: string,
): Promise<void> {
  const body = {
    shotUuid,
    mediaType: "video",
    providerModel: SEEDANCE_FAST,
    mode: "text2video",
    durationMs: 5000,
    aspectRatio: "9:16",
  };
  const preview = await jsonRequest(urls.previewUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const generated = await jsonRequest(urls.generateUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...body,
      expectedPreviewDigest: preview.body?.data?.previewDigest,
      clientOperationId: crypto.randomUUID(),
    }),
  });
  assert.equal(generated.status, 200, JSON.stringify(generated.body));
}

test("P1 关闭必须挡住 enabled 检查后的 claim/spawn，且不杀在途、不丢排队", async () => {
  await withRuntime("r23-fix-race", async ({ shotUuid, generateUrl, previewUrl, setEnabledUrl, logFile }) => {
    await enqueueVideo({ previewUrl, generateUrl }, shotUuid);
    fs.writeFileSync(logFile, "");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let sawEnabledWindow = false;
    setDreaminaSchedulerAfterEnabledReadForTests(async () => {
      sawEnabledWindow = true;
      const closed = await jsonRequest(setEnabledUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      assert.equal(closed.body?.data?.enabled, false);
      release();
    });
    const tick = tickDreaminaScheduler();
    await held;
    const result = await tick;
    assert.equal(sawEnabledWindow, true);
    assert.deepEqual(result.claimed, []);
    const generateLines = commandLines(logFile).filter((line) => String(line.args[0]).endsWith("2video") && !line.args.includes("-h"));
    assert.deepEqual(generateLines, []);
    const queued = await accountDb("o_dreaminaCliDispatch").where({ queueState: "queued" });
    assert.ok(queued.length >= 1, "关闭不得删除已排队任务");
    leakFreeMessage((await jsonRequest(setEnabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })).body);
  });
});

test("P1 打开探测未完成时关闭，旧探测不得重新启用或唤醒调度", async () => {
  await withRuntime("r23-fix-stale-probe", async ({ setEnabledUrl, statusUrl, logFile }) => {
    const closedFirst = await jsonRequest(setEnabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(closedFirst.body?.data?.enabled, false);
    fs.writeFileSync(logFile, "");
    process.env.DREAMINA_FAKE_PROBE_DELAY_MS = "600";
    const opening = jsonRequest(setEnabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const started = Date.now();
    while (Date.now() - started < 2000 && commandLines(logFile).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const closed = await jsonRequest(setEnabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.body?.data?.enabled, false);
    const opened = await opening;
    leakFreeMessage(opened.body);
    assert.equal((await readDreaminaCliSettings()).enabled, false);
    assert.equal(opened.body?.data?.enabled, false);
    const status = await jsonRequest(statusUrl);
    assert.equal(status.body?.data?.enabled, false);
    assert.equal(status.body?.data?.queue?.paused, true);
    const heads = commandLines(logFile).map((line) => line.args[0]);
    assert.equal(heads.includes("login"), false);
    assert.equal(heads.some((item) => String(item).endsWith("2video") && !commandLines(logFile).some((line) => line.args.includes("-h"))), false);
  });
});

test("P1 通用 updateSettings 不得再改 enabled，启停错误必须脱敏", async () => {
  await withRuntime("r23-fix-unify-leak", async ({ setEnabledUrl, updateSettingsUrl, statusUrl }) => {
    const bypass = await jsonRequest(updateSettingsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    leakFreeMessage(bypass.body);
    assert.notEqual(bypass.status, 200, JSON.stringify(bypass.body));
    assert.notEqual((await readDreaminaCliSettings()).enabled, false);

    setDreaminaCliSettingsWriteHookForTests(() => {
      throw new Error(LEAK);
    });
    const leaked = await jsonRequest(setEnabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    leakFreeMessage(leaked.body);
    assert.equal(leaked.body?.code, "DREAMINA_CLI_SET_ENABLED_FAILED");
    assert.equal(leaked.body?.message, "即梦 CLI 状态更新失败，请稍后重试");

    const settingsLeak = await jsonRequest(updateSettingsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxConcurrency: 2 }),
    });
    leakFreeMessage(settingsLeak.body);
    assert.notEqual(String(settingsLeak.body?.message ?? ""), LEAK);
    setDreaminaCliSettingsWriteHookForTests(null);

    const status = await jsonRequest(statusUrl);
    assert.equal(status.body?.data?.queue?.paused, false);
    await jsonRequest(setEnabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }).catch(() => undefined);
  });
});

test("P1 updatedAt 必须严格单调，同毫秒旧 GET 不得覆盖新 POST", async () => {
  await withRuntime("r23-fix-revision", async ({ setEnabledUrl, statusUrl }) => {
    const originalNow = Date.now;
    Date.now = () => 1_777_000_000_000;
    try {
      const first = await jsonRequest(setEnabledUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      const second = await jsonRequest(setEnabledUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      const firstAt = Number(first.body?.data?.updatedAt);
      const secondAt = Number(second.body?.data?.updatedAt);
      assert.ok(secondAt > firstAt, JSON.stringify({ firstAt, secondAt }));
      const status = await jsonRequest(statusUrl);
      assert.ok(Number(status.body?.data?.updatedAt) >= secondAt);
    } finally {
      Date.now = originalNow;
    }
  });
});

test("P1 项目文件 TOCTOU：校验后替换为越界链接必须 fail-closed", async () => {
  const dataRoot = fs.mkdtempSync(path.resolve(__dirname, "../../../.tmp", "r23-fix-toctou-"));
  const previousDataRoot = process.env.TIANJIANG_TEST_DATA_ROOT;
  const previousWorktree = process.env.TIANJIANG_TEST_WORKTREE_ROOT;
  process.env.TIANJIANG_TEST_DATA_ROOT = dataRoot;
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = path.resolve(__dirname, "../../..");
  const session = { serverUrl: IDENTITY.issuer, user: { id: IDENTITY.userId, username: "r23fix" } };
  const segment = userStorageSegment({ issuer: session.serverUrl, userId: session.user.id });
  const bytes = buildMinimalAdoptableMp4();
  writeProjectFileAtomic(dataRoot, PROJECT, segment, "files/videos/storyboard/shot/a.mp4", bytes);
  const outside = path.join(dataRoot, "outside-secret.bin");
  fs.writeFileSync(outside, "SECRET-OUTSIDE");
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  syncCoordinator.listProjects = ((incoming: { user?: { id?: number } }) => {
    if (incoming?.user?.id === IDENTITY.userId) return [catalogRow()] as never;
    return [] as never;
  }) as typeof syncCoordinator.listProjects;
  const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
  const app = express();
  app.use((req, _res, next) => {
    (req as { centralSession?: unknown }).centralSession = session;
    next();
  });
  app.use("/api/tianjiang/runtime", runtimeRouter);
  const { server, port } = await listen(app);
  const fileUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/files/videos/storyboard/shot/a.mp4`;
  try {
    setProjectFileAfterStatHookForTests(() => {
      const target = path.join(dataRoot, "runtime-users", segment, "projects", PROJECT, "files", "videos", "storyboard", "shot", "a.mp4");
      fs.rmSync(target, { force: true });
      try {
        fs.symlinkSync(outside, target);
      } catch {
        fs.writeFileSync(target, "SECRET-OUTSIDE");
        throw new Error("无法创建符号链接，且不得退回读取替换后的越界内容");
      }
    });
    const swapped = await fetch(fileUrl);
    assert.notEqual(swapped.status, 200);
    const body = Buffer.from(await swapped.arrayBuffer());
    assert.equal(body.includes(Buffer.from("SECRET-OUTSIDE")), false);
  } finally {
    setProjectFileAfterStatHookForTests(null);
    syncCoordinator.listProjects = originalList;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDataRoot === undefined) delete process.env.TIANJIANG_TEST_DATA_ROOT;
    else process.env.TIANJIANG_TEST_DATA_ROOT = previousDataRoot;
    if (previousWorktree === undefined) delete process.env.TIANJIANG_TEST_WORKTREE_ROOT;
    else process.env.TIANJIANG_TEST_WORKTREE_ROOT = previousWorktree;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("P1 无效视频不得采用：png/txt/假 ftyp/截断/越界/替换", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `r23-fix-mp4-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  const previousCwd = process.cwd();
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 2323,
        name: "R23-fix",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow()] as never;
      const service = new StoryboardService(PROJECT);
      const shot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "夜戏",
        videoPrompt: "跟拍",
        durationMs: 5000,
      });
      const staging = path.join(root, "staging", shot.shotUuid);
      fs.mkdirSync(staging, { recursive: true });
      const rejectCases: Array<{ name: string; file: string; bytes: Buffer }> = [
        { name: "png", file: path.join(staging, "result.png"), bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        { name: "txt", file: path.join(staging, "result.txt"), bytes: Buffer.from("not-a-video") },
        { name: "fake-ftyp", file: path.join(staging, "result.mp4"), bytes: fakeFtypOnly() },
        { name: "truncated", file: path.join(staging, "result.mp4"), bytes: ftypPlusMdatOnly() },
      ];
      for (const item of rejectCases) {
        fs.writeFileSync(item.file, item.bytes);
        await assert.rejects(() => installDreaminaResult({
          projectUuid: PROJECT,
          taskUuid: crypto.randomUUID(),
          shotUuid: shot.shotUuid,
          mediaType: "video",
          stagingDirectory: staging,
          files: [item.file],
        }), item.name);
      }
      const outside = path.join(root, "outside.mp4");
      fs.writeFileSync(outside, buildMinimalAdoptableMp4());
      await assert.rejects(() => installDreaminaResult({
        projectUuid: PROJECT,
        taskUuid: crypto.randomUUID(),
        shotUuid: shot.shotUuid,
        mediaType: "video",
        stagingDirectory: staging,
        files: [outside],
      }), "outside");
      const link = path.join(staging, "linked.mp4");
      try {
        fs.symlinkSync(outside, link);
        await assert.rejects(() => installDreaminaResult({
          projectUuid: PROJECT,
          taskUuid: crypto.randomUUID(),
          shotUuid: shot.shotUuid,
          mediaType: "video",
          stagingDirectory: staging,
          files: [link],
        }), "symlink");
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
      }
      const valid = path.join(staging, "good.mp4");
      fs.writeFileSync(valid, buildMinimalAdoptableMp4());
      setAfterDreaminaResultValidatedForTests(() => {
        fs.writeFileSync(valid, fakeFtypOnly());
      });
      await assert.rejects(() => installDreaminaResult({
        projectUuid: PROJECT,
        taskUuid: crypto.randomUUID(),
        shotUuid: shot.shotUuid,
        mediaType: "video",
        stagingDirectory: staging,
        files: [valid],
      }), "swap");
      setAfterDreaminaResultValidatedForTests(null);
      fs.writeFileSync(valid, buildMinimalAdoptableMp4());
      const installed = await installDreaminaResult({
        projectUuid: PROJECT,
        taskUuid: crypto.randomUUID(),
        shotUuid: shot.shotUuid,
        mediaType: "video",
        stagingDirectory: staging,
        files: [valid],
      });
      assert.ok(installed?.relativePath.endsWith(".mp4"));
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
              const dest = path.join(
                projectDirectory(getPath(), PROJECT, currentUserStorage()!.segment),
                ...String(target).split("/"),
              );
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.writeFileSync(dest, fakeFtypOnly());
            },
          }),
        },
      }));
    });
  } finally {
    setAfterDreaminaResultValidatedForTests(null);
    syncCoordinator.listProjects = originalList;
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
