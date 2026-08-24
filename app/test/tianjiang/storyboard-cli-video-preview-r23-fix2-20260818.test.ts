/**
 * R23-fix2 RED：关闭后 spawn、探测代际、fd 身份、复制 TOCTOU、短读/双关、非 fast-start、GET 脱敏。
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
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  prepareProjectDatabase,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { invalidateDreaminaCapabilityCache, readDreaminaCapabilityCache } from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import { resetDreaminaStartupStatusCheckForTests } from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import { resetDreaminaEnablementForTests } from "../../src/tianjiang/model-providers/dreamina-cli/dreamina-enablement";
import {
  setDreaminaSchedulerAfterLastEnabledCheckForTests,
  stopDreaminaSchedulerLoop,
  tickDreaminaScheduler,
} from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import {
  readDreaminaCliSettings,
  setDreaminaCliSettingsReadHookForTests,
  writeDreaminaCliSettings,
} from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { installDreaminaResult, setAfterDreaminaResultValidatedForTests } from "../../src/tianjiang/model-providers/dreamina-cli/result-installer";
import {
  persistVendorGenerationResult,
  setAfterVendorVideoWrittenForTests,
} from "../../src/tianjiang/storyboard/storyboard-generation-service";
import {
  readProjectFileCloseCountForTests,
  resetProjectFileCloseCountForTests,
  setProjectFileAfterOpenHookForTests,
  setProjectFileBeforeOpenHookForTests,
  setProjectFileReadSyncHookForTests,
  writeProjectFileAtomic,
} from "../../src/tianjiang/media/project-file-store";
import { assertAdoptableStagingVideo } from "../../src/tianjiang/media/adoptable-generated-video";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  currentUserStorage,
  enterUserStorage,
  runWithUserStorage,
  userStorageSegment,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import getPath from "../../src/utils/getPath";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import {
  build64BitBoxAdoptableMp4,
  buildMinimalAdoptableMp4,
  buildNonFastStartAdoptableMp4,
  fakeFtypOnly,
  truncated64BitBox,
} from "./helpers/minimal-mp4";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2325 };
const PROJECT = "b0232325-2325-4325-a325-232523252325";
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");
const SEEDANCE_FAST = "dreamina-cli:seedance2.0fast";
const LEAK = "E:\\\\data\\\\db2.sqlite SELECT * FROM o_dreaminaCliSettings at session-store.ts:58 cookie=abc token=sk-secret";

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R23-fix2",
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

function leakFree(body: { message?: unknown; code?: unknown } | null): void {
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
    settingsUrl: string;
    setEnabledUrl: string;
    logFile: string;
    port: number;
  }) => Promise<void>,
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${process.pid}-${crypto.randomUUID()}`);
  const logFile = path.join(root, "cli.jsonl");
  const previousCwd = process.cwd();
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    DREAMINA_TEST_EXECUTABLE: process.env.DREAMINA_TEST_EXECUTABLE,
    DREAMINA_FAKE_LOG: process.env.DREAMINA_FAKE_LOG,
    DREAMINA_FAKE_PROBE_DELAY_MS: process.env.DREAMINA_FAKE_PROBE_DELAY_MS,
  };
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.DREAMINA_FAKE_LOG = logFile;
  delete process.env.DREAMINA_FAKE_PROBE_DELAY_MS;
  resetDatabaseRuntimeForServe();
  resetDreaminaStartupStatusCheckForTests();
  resetDreaminaEnablementForTests();
  invalidateDreaminaCapabilityCache();
  setDreaminaSchedulerAfterLastEnabledCheckForTests(null);
  setDreaminaCliSettingsReadHookForTests(null);
  setAfterDreaminaResultValidatedForTests(null);
  setAfterVendorVideoWrittenForTests(null);
  setProjectFileBeforeOpenHookForTests(null);
  setProjectFileAfterOpenHookForTests(null);
  setProjectFileReadSyncHookForTests(null);
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 2325,
        name: "R23-fix2",
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
          user: { id: IDENTITY.userId, username: "r23fix2" },
        };
        next();
      });
      app.use("/api/tianjiang/runtime", (await import("../../src/routes/tianjiang/runtime")).default);
      app.use("/api/setting/dreaminaCli/getStatus", (await import("../../src/routes/setting/dreaminaCli/getStatus")).default);
      app.use("/api/setting/dreaminaCli/getSettings", (await import("../../src/routes/setting/dreaminaCli/getSettings")).default);
      app.use("/api/setting/dreaminaCli/setEnabled", (await import("../../src/routes/setting/dreaminaCli/setEnabled")).default);
      await prepareProjectDatabase(PROJECT);
      const { server, port } = await listen(app);
      try {
        await run({
          shotUuid: shot.shotUuid,
          generateUrl: `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`,
          previewUrl: `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate/preview`,
          statusUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/getStatus`,
          settingsUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/getSettings`,
          setEnabledUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/setEnabled`,
          logFile,
          port,
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    setDreaminaSchedulerAfterLastEnabledCheckForTests(null);
    setDreaminaCliSettingsReadHookForTests(null);
    setAfterDreaminaResultValidatedForTests(null);
    setAfterVendorVideoWrittenForTests(null);
    setProjectFileBeforeOpenHookForTests(null);
    setProjectFileAfterOpenHookForTests(null);
    setProjectFileReadSyncHookForTests(null);
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

async function enqueueVideo(urls: { previewUrl: string; generateUrl: string }, shotUuid: string): Promise<void> {
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

test("P1-1 最后一次 enabled 检查后关闭，返回后不得 spawn 或新 dispatch", async () => {
  await withRuntime("r23-fix2-spawn", async ({ shotUuid, generateUrl, previewUrl, setEnabledUrl, logFile }) => {
    await enqueueVideo({ previewUrl, generateUrl }, shotUuid);
    fs.writeFileSync(logFile, "");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    setDreaminaSchedulerAfterLastEnabledCheckForTests(async () => {
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
    await tick;
    const generateLines = commandLines(logFile).filter((line) =>
      String(line.args[0]).endsWith("2video") && !line.args.includes("-h"));
    assert.deepEqual(generateLines, []);
    const claiming = await accountDb("o_dreaminaCliDispatch").where({ queueState: "claiming" });
    assert.equal(claiming.length, 0);
    const queued = await accountDb("o_dreaminaCliDispatch").where({ queueState: "queued" });
    assert.ok(queued.length >= 1, "关闭不得删除已排队任务");
  });
});

test("P1-2 旧探测结束不得清掉新代际，关闭后不得回写缓存", async () => {
  await withRuntime("r23-fix2-probe-gen", async ({ setEnabledUrl, statusUrl, logFile }) => {
    await jsonRequest(setEnabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    fs.writeFileSync(logFile, "");
    process.env.DREAMINA_FAKE_PROBE_DELAY_MS = "700";
    const probeA = jsonRequest(setEnabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const started = Date.now();
    while (Date.now() - started < 2000 && commandLines(logFile).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const probeB = jsonRequest(setEnabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    await probeA;
    invalidateDreaminaCapabilityCache();
    const afterA = await readDreaminaCliSettings();
    const closed = await jsonRequest(setEnabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(closed.body?.data?.enabled, false);
    const afterClose = await readDreaminaCliSettings();
    await probeB;
    const afterB = await readDreaminaCliSettings();
    assert.equal(afterB.enabled, false);
    assert.equal(afterB.updatedAt, afterClose.updatedAt, "旧探测 B 不得在关闭后回写设置");
    assert.notEqual(readDreaminaCapabilityCache().state, "ready");
    const status = await jsonRequest(statusUrl);
    assert.equal(status.body?.data?.enabled, false);

    fs.writeFileSync(logFile, "");
    process.env.DREAMINA_FAKE_PROBE_DELAY_MS = "500";
    await jsonRequest(setEnabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }).catch(() => undefined);
    const statusInflight = jsonRequest(statusUrl);
    const startedStatus = Date.now();
    while (Date.now() - startedStatus < 2000 && commandLines(logFile).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const closedDuringGet = await jsonRequest(setEnabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const afterGetClose = await readDreaminaCliSettings();
    await statusInflight;
    const afterGet = await readDreaminaCliSettings();
    assert.equal(closedDuringGet.body?.data?.enabled, false);
    assert.equal(afterGet.enabled, false);
    assert.equal(afterGet.updatedAt, afterGetClose.updatedAt);
    void afterA;
  });
});

test("P1-3 打开后两次替换路径不得读出项目外内容", async () => {
  const dataRoot = fs.mkdtempSync(path.resolve(__dirname, "../../../.tmp", "r23-fix2-fd-"));
  process.env.TIANJIANG_TEST_DATA_ROOT = dataRoot;
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = path.resolve(__dirname, "../../..");
  const session = { serverUrl: IDENTITY.issuer, user: { id: IDENTITY.userId, username: "r23fix2" } };
  const segment = userStorageSegment({ issuer: session.serverUrl, userId: session.user.id });
  writeProjectFileAtomic(dataRoot, PROJECT, segment, "files/videos/storyboard/shot/a.mp4", buildMinimalAdoptableMp4());
  const outside = path.join(dataRoot, "outside-secret.bin");
  fs.writeFileSync(outside, "SECRET-OUTSIDE-FD");
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  syncCoordinator.listProjects = ((incoming: { user?: { id?: number } }) => (
    incoming?.user?.id === IDENTITY.userId ? [catalogRow()] : []
  )) as typeof syncCoordinator.listProjects;
  const app = express();
  app.use((req, _res, next) => {
    (req as { centralSession?: unknown }).centralSession = session;
    next();
  });
  app.use("/api/tianjiang/runtime", (await import("../../src/routes/tianjiang/runtime")).default);
  const { server, port } = await listen(app);
  const fileUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/files/videos/storyboard/shot/a.mp4`;
  const target = path.join(dataRoot, "runtime-users", segment, "projects", PROJECT, "files", "videos", "storyboard", "shot", "a.mp4");
  try {
    setProjectFileBeforeOpenHookForTests(() => {
      fs.rmSync(target, { force: true });
      try {
        fs.symlinkSync(outside, target);
      } catch {
        fs.writeFileSync(target, "SECRET-OUTSIDE-FD");
      }
    });
    setProjectFileAfterOpenHookForTests(() => {
      fs.rmSync(target, { force: true });
      fs.writeFileSync(target, buildMinimalAdoptableMp4());
    });
    const swapped = await fetch(fileUrl);
    assert.notEqual(swapped.status, 200);
    const body = Buffer.from(await swapped.arrayBuffer());
    assert.equal(body.includes(Buffer.from("SECRET-OUTSIDE-FD")), false);
  } finally {
    setProjectFileBeforeOpenHookForTests(null);
    setProjectFileAfterOpenHookForTests(null);
    syncCoordinator.listProjects = originalList;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("P1-4 校验后复制前替换源文件不得采用", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `r23-fix2-copy-${process.pid}-${crypto.randomUUID()}`);
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
        id: 2325,
        name: "R23-fix2",
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
      const valid = path.join(staging, "good.mp4");
      fs.writeFileSync(valid, buildMinimalAdoptableMp4(Buffer.from("ORIGINAL")));
      setAfterDreaminaResultValidatedForTests(() => {
        fs.writeFileSync(valid, buildMinimalAdoptableMp4(Buffer.from("REPLACED-SRC")));
      });
      await assert.rejects(() => installDreaminaResult({
        projectUuid: PROJECT,
        taskUuid: crypto.randomUUID(),
        shotUuid: shot.shotUuid,
        mediaType: "video",
        stagingDirectory: staging,
        files: [valid],
      }));
      const destDir = path.join(projectDirectory(getPath(), PROJECT, currentUserStorage()!.segment), "files", "videos", "storyboard", shot.shotUuid);
      if (fs.existsSync(destDir)) {
        const installed = fs.readdirSync(destDir);
        for (const name of installed) {
          const bytes = fs.readFileSync(path.join(destDir, name));
          assert.equal(bytes.includes(Buffer.from("REPLACED-SRC")), false);
        }
      }
      setAfterDreaminaResultValidatedForTests(null);
      setAfterVendorVideoWrittenForTests((dest) => {
        fs.writeFileSync(dest, buildMinimalAdoptableMp4(Buffer.from("REPLACED-VENDOR")));
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
              const dest = path.join(
                projectDirectory(getPath(), PROJECT, currentUserStorage()!.segment),
                ...String(target).split("/"),
              );
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.writeFileSync(dest, buildMinimalAdoptableMp4(Buffer.from("ORIGINAL-VENDOR")));
            },
          }),
        },
      }));
    });
  } finally {
    setAfterDreaminaResultValidatedForTests(null);
    setAfterVendorVideoWrittenForTests(null);
    syncCoordinator.listProjects = originalList;
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("P1-5 Range/HEAD/416/短读/中断不得双关或零填充成功", async () => {
  const dataRoot = fs.mkdtempSync(path.resolve(__dirname, "../../../.tmp", "r23-fix2-fdio-"));
  process.env.TIANJIANG_TEST_DATA_ROOT = dataRoot;
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = path.resolve(__dirname, "../../..");
  const session = { serverUrl: IDENTITY.issuer, user: { id: IDENTITY.userId, username: "r23fix2" } };
  const segment = userStorageSegment({ issuer: session.serverUrl, userId: session.user.id });
  const small = buildMinimalAdoptableMp4();
  writeProjectFileAtomic(dataRoot, PROJECT, segment, "files/videos/storyboard/shot/small.mp4", small);
  const large = Buffer.concat([buildMinimalAdoptableMp4(), Buffer.alloc(2 * 1024 * 1024 + 32, 7)]);
  writeProjectFileAtomic(dataRoot, PROJECT, segment, "files/videos/storyboard/shot/large.mp4", large);
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  syncCoordinator.listProjects = ((incoming: { user?: { id?: number } }) => (
    incoming?.user?.id === IDENTITY.userId ? [catalogRow()] : []
  )) as typeof syncCoordinator.listProjects;
  const app = express();
  app.use((req, _res, next) => {
    (req as { centralSession?: unknown }).centralSession = session;
    next();
  });
  app.use("/api/tianjiang/runtime", (await import("../../src/routes/tianjiang/runtime")).default);
  const { server, port } = await listen(app);
  const smallUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/files/videos/storyboard/shot/small.mp4`;
  const largeUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/files/videos/storyboard/shot/large.mp4`;
  try {
    resetProjectFileCloseCountForTests();
    const full = await fetch(smallUrl);
    assert.equal(full.status, 200);
    const ranged = await fetch(smallUrl, { headers: { Range: "bytes=0-7" } });
    assert.equal(ranged.status, 206);
    const invalid = await fetch(smallUrl, { headers: { Range: "bytes=999999-9999999" } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), `bytes */${small.length}`);
    const head = await fetch(smallUrl, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(Buffer.from(await head.arrayBuffer()).length, 0);
    setProjectFileReadSyncHookForTests((_fd, _target, _length) => 1);
    const shorted = await fetch(smallUrl);
    const shortBody = Buffer.from(await shorted.arrayBuffer());
    assert.notEqual(shorted.status, 200);
    assert.equal(shortBody.includes(Buffer.alloc(8)), false);
    setProjectFileReadSyncHookForTests(null);
    const controller = new AbortController();
    const pending = fetch(largeUrl, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await pending.catch(() => undefined);
    assert.ok(readProjectFileCloseCountForTests() >= 1);
  } finally {
    setProjectFileReadSyncHookForTests(null);
    syncCoordinator.listProjects = originalList;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("P1-6 非 fast-start 与合法 64 位 box 必须可通过，截断仍拒绝", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `r23-fix2-moov-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  const staging = path.join(root, "staging");
  fs.mkdirSync(staging, { recursive: true });
  const late = path.join(staging, "late.mp4");
  fs.writeFileSync(late, buildNonFastStartAdoptableMp4());
  assert.doesNotThrow(() => assertAdoptableStagingVideo(late, staging));
  const wide = path.join(staging, "wide.mp4");
  fs.writeFileSync(wide, build64BitBoxAdoptableMp4());
  assert.doesNotThrow(() => assertAdoptableStagingVideo(wide, staging));
  const truncated = path.join(staging, "trunc.mp4");
  fs.writeFileSync(truncated, truncated64BitBox());
  assert.throws(() => assertAdoptableStagingVideo(truncated, staging));
  const fake = path.join(staging, "fake.mp4");
  fs.writeFileSync(fake, fakeFtypOnly());
  assert.throws(() => assertAdoptableStagingVideo(fake, staging));
  fs.rmSync(root, { recursive: true, force: true });
});

test("P1-7 GET 错误必须脱敏，探测后必须返回权威 updatedAt", async () => {
  await withRuntime("r23-fix2-get-leak", async ({ statusUrl, settingsUrl }) => {
    setDreaminaCliSettingsReadHookForTests(() => {
      throw new Error(LEAK);
    });
    const status = await jsonRequest(statusUrl);
    leakFree(status.body);
    assert.notEqual(String(status.body?.message ?? ""), LEAK);
    const settings = await jsonRequest(settingsUrl);
    leakFree(settings.body);
    assert.notEqual(String(settings.body?.message ?? ""), LEAK);
    setDreaminaCliSettingsReadHookForTests(null);

    const before = await jsonRequest(statusUrl);
    const beforeAt = Number(before.body?.data?.updatedAt);
    const latest = await readDreaminaCliSettings();
    assert.ok(Number(before.body?.data?.updatedAt) >= beforeAt);
    assert.ok(latest.updatedAt <= Number(before.body?.data?.updatedAt) || latest.updatedAt === Number(before.body?.data?.updatedAt));
    assert.equal(Number(before.body?.data?.updatedAt), latest.updatedAt, "GET 必须返回探测后的权威 updatedAt");
  });
});
