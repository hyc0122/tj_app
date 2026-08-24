/**
 * R24-fix7 RED：ensureDreaminaExecuteReady 未原子预留探测身份，
 * 正式 generate / retry 会沿用旧 A 的 startup/capability inFlight，
 * 甚至把 A 的能力快照写回已经迁到 B 的当前缓存。
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
  refreshDreaminaCapabilities,
  setDreaminaCapabilityRefreshBeforeProbeHookForTests,
  writeDreaminaCapabilityCache,
} from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import {
  DREAMINA_MODES,
  DREAMINA_VIDEO_MODELS,
  type DreaminaCapabilitySnapshot,
} from "../../src/tianjiang/model-providers/dreamina-cli/contracts";
import {
  ensureDreaminaExecuteReady,
  resetDreaminaStartupStatusCheckForTests,
  setDreaminaStartupCheckBeforeProbeHookForTests,
} from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import { isDreaminaEnablementStaleError } from "../../src/tianjiang/model-providers/dreamina-cli/dreamina-enablement";
import {
  readDreaminaEnablementRevision,
  readDreaminaProbeEpoch,
  readDreaminaProbeGuardForTests,
  resetDreaminaEnablementForTests,
} from "../../src/tianjiang/model-providers/dreamina-cli/dreamina-enablement";
import {
  readDreaminaRuntimeState,
  writeDreaminaRuntimeState,
} from "../../src/tianjiang/model-providers/dreamina-cli/runtime-state-store";
import {
  readDreaminaSchedulerWakeCountForTests,
  stopDreaminaSchedulerLoop,
} from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import {
  readDreaminaCliSettings,
  writeDreaminaCliSettings,
} from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
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

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 3147 };
const OTHER = { issuer: "https://api.j11.com.cn", userId: 3148 };
const PROJECT = "b0240707-2407-4407-a407-240724072407";
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R24-fix7",
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
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch (err) {
    return { status: 0, body: { message: err instanceof Error ? err.message : String(err) } };
  }
}

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const normalize = (value: string) => (process.platform === "win32"
    ? path.resolve(value).toLocaleLowerCase("en-US")
    : path.resolve(value));
  return normalize(left) === normalize(right);
}

function commandLines(logFile: string): Array<{ args: string[] }> {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").trim().split(/\n/).filter(Boolean).map((line) =>
    JSON.parse(line) as { args: string[] });
}

function commandNames(logFile: string): string[] {
  return commandLines(logFile).map((entry) => String(entry.args[0] ?? ""));
}

function isGenerateCommand(name: string): boolean {
  return /^(text2image|image2image|text2video|image2video|frames2video|multiframe2video|multimodal2video)$/.test(name);
}

function leakFree(serialized: string): void {
  assert.equal(/[A-Za-z]:\\/.test(serialized), false);
  assert.equal(serialized.includes("SELECT "), false);
  assert.equal(serialized.toLowerCase().includes("cookie"), false);
}

function snapshotA(version: string): DreaminaCapabilitySnapshot {
  return {
    installed: true,
    version,
    probedAt: Date.now(),
    loggedIn: true,
    modes: Object.fromEntries(DREAMINA_MODES.map((mode) => [mode, {
      enabled: true,
      fields: ["--prompt", "--duration", "--ratio", "--video_resolution", "--model_version"],
    }])) as unknown as DreaminaCapabilitySnapshot["modes"],
    capabilities: [...DREAMINA_MODES],
    videoModels: [...DREAMINA_VIDEO_MODELS],
  };
}

async function countProjectRows(table: string): Promise<number> {
  return runWithProjectStorage(PROJECT, async () => {
    if (!await activeDb.schema.hasTable(table)) return 0;
    return (await activeDb(table).select()).length;
  });
}

async function countDispatch(): Promise<number> {
  return Number((await accountDb("o_dreaminaCliDispatch")
    .count<{ total: number }>("taskUuid as total").first())?.total ?? 0);
}

function installFirstHitGate(setHook: (hook: (() => Promise<void> | void) | null) => void): {
  firstReached: Promise<void>;
  releaseFirst: () => void;
} {
  let markReached!: () => void;
  let releaseFirst!: () => void;
  const firstReached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let hits = 0;
  setHook(async () => {
    hits += 1;
    if (hits !== 1) return;
    markReached();
    await hold;
  });
  return { firstReached, releaseFirst };
}

async function waitFor(label: string, check: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} 超时`);
}

type Harness = {
  updateUrl: string;
  generateUrl: string;
  previewUrl: string;
  retryUrl: string;
  pathA: string;
  pathB: string;
  logFile: string;
  timeline: string[];
  shotUuid: string;
};

async function withHarness(
  name: string,
  options: { withProject?: boolean },
  run: (input: Harness) => Promise<void>,
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${process.pid}-${crypto.randomUUID()}`);
  const logFile = path.join(root, "cli.jsonl");
  const pathB = path.join(root, "dreamina-b.bin");
  const previousCwd = process.cwd();
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    DREAMINA_TEST_EXECUTABLE: process.env.DREAMINA_TEST_EXECUTABLE,
    DREAMINA_FAKE_LOG: process.env.DREAMINA_FAKE_LOG,
    DREAMINA_FAKE_PROBE_DELAY_MS: process.env.DREAMINA_FAKE_PROBE_DELAY_MS,
    DREAMINA_FAKE_SCENARIO: process.env.DREAMINA_FAKE_SCENARIO,
  };
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  const timeline: string[] = [];
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(pathB, "not-a-cli");
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.DREAMINA_FAKE_LOG = logFile;
  delete process.env.DREAMINA_FAKE_PROBE_DELAY_MS;
  delete process.env.DREAMINA_FAKE_SCENARIO;
  resetDatabaseRuntimeForServe();
  resetDreaminaStartupStatusCheckForTests();
  resetDreaminaEnablementForTests();
  invalidateDreaminaCapabilityCache();
  setDreaminaStartupCheckBeforeProbeHookForTests(null);
  setDreaminaCapabilityRefreshBeforeProbeHookForTests(null);
  stopDreaminaSchedulerLoop();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await writeDreaminaCliSettings({
        enabled: true,
        executablePath: FAKE_CLI,
        pauseNewClaims: true,
        maxConcurrency: 1,
      });
      await writeDreaminaRuntimeState({
        executablePath: FAKE_CLI,
        preferredExecutionTarget: "windows_native",
        install: { state: "not_installed", executablePath: FAKE_CLI, reason: "seed-A" },
      });
      writeDreaminaCapabilityCache({
        state: "failed",
        snapshot: {
          installed: false,
          version: "mine-before-A",
          probedAt: 1,
          loggedIn: false,
          modes: {} as never,
          capabilities: [],
          videoModels: [],
        },
        checkedAt: 1,
        failureReason: "seed-not-ready",
      });
      let shotUuid = "";
      if (options.withProject) {
        await initializeWorkspaceProject(PROJECT, {
          id: 2407,
          name: "R24-fix7",
          projectType: "storyboard" as "novel",
          userId: IDENTITY.userId,
        });
        syncCoordinator.listProjects = () => [catalogRow()] as never;
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
        shotUuid = first.shotUuid;
        await prepareProjectDatabase(PROJECT);
      }
      const app = express();
      app.use(express.json({ limit: "2mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r24-fix7" },
        };
        next();
      });
      const updateSettingsMod = await import("../../src/routes/setting/dreaminaCli/updateSettings");
      app.use("/api/setting/dreaminaCli/updateSettings", updateSettingsMod.default);
      if (options.withProject) {
        const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
        const { default: retryRoute } = await import("../../src/routes/task/dreaminaQueue/retry");
        app.use("/api/tianjiang/runtime", runtimeRouter);
        app.use("/api/task/dreaminaQueue/retry", retryRoute);
      }
      const { server, port } = await listen(app);
      try {
        await run({
          updateUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/updateSettings`,
          generateUrl: `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`,
          previewUrl: `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate/preview`,
          retryUrl: `http://127.0.0.1:${port}/api/task/dreaminaQueue/retry`,
          pathA: FAKE_CLI,
          pathB,
          logFile,
          timeline,
          shotUuid,
        });
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          const closer = server as http.Server & { closeAllConnections?: () => void };
          closer.closeAllConnections?.();
          setTimeout(resolve, 500);
        });
      }
    });
  } finally {
    setDreaminaStartupCheckBeforeProbeHookForTests(null);
    setDreaminaCapabilityRefreshBeforeProbeHookForTests(null);
    stopDreaminaSchedulerLoop();
    resetDreaminaStartupStatusCheckForTests();
    resetDreaminaEnablementForTests();
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

async function migrateAToBAndRelease(input: Harness): Promise<{
  runtimeUpdatedAt: number;
  logAfterR2: number;
  wakesBefore: number;
  epochB: number;
  revisionB: number;
}> {
  fs.writeFileSync(input.logFile, "");
  const wakesBefore = readDreaminaSchedulerWakeCountForTests();
  input.timeline.push("start-R2-A-to-B");
  const r2 = await jsonRequest(input.updateUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ executablePath: input.pathB }),
  });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  await waitFor("R2-token-null", () => {
    const guard = runWithUserStorage(IDENTITY, () => readDreaminaProbeGuardForTests());
    return !guard.token && guard.refCount === 0;
  });
  const afterR2 = await runWithUserStorage(IDENTITY, async () => ({
    settings: await readDreaminaCliSettings(),
    runtime: await readDreaminaRuntimeState(),
    epoch: readDreaminaProbeEpoch(),
    revision: readDreaminaEnablementRevision(),
    guard: readDreaminaProbeGuardForTests(),
  }));
  assert.equal(samePath(afterR2.settings.executablePath, input.pathB), true, "R2 必须把 settings 迁到 B");
  assert.equal(samePath(afterR2.runtime.executablePath, input.pathB), true, "R2 必须把 runtime 迁到 B");
  assert.equal(afterR2.guard.token, undefined, "R2 探测结束后 token 必须释放");
  input.timeline.push("R2-finished-token-null");
  return {
    runtimeUpdatedAt: afterR2.runtime.updatedAt,
    logAfterR2: commandLines(input.logFile).length,
    wakesBefore,
    epochB: afterR2.epoch,
    revisionB: afterR2.revision,
  };
}

test("ensureDreaminaExecuteReady 在 A 启动检测中暂停，R2 迁到 B 后旧 A 必须 STALE 且零写入", async () => {
  await withHarness("r24-fix7-ready", { withProject: false }, async (harness) => {
    const { firstReached, releaseFirst } = installFirstHitGate(setDreaminaStartupCheckBeforeProbeHookForTests);
    harness.timeline.push("start-R1-executeReady");
    const r1Promise = runWithUserStorage(IDENTITY, () => ensureDreaminaExecuteReady()).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    await firstReached;
    harness.timeline.push("R1-paused-in-A-startup");
    const before = await runWithUserStorage(IDENTITY, async () => ({
      settings: await readDreaminaCliSettings(),
      runtime: await readDreaminaRuntimeState(),
      guard: readDreaminaProbeGuardForTests(),
    }));
    assert.equal(samePath(before.settings.executablePath, harness.pathA), true);
    const migrated = await migrateAToBAndRelease(harness);
    harness.timeline.push("release-R1");
    releaseFirst();
    const r1 = await r1Promise;
    harness.timeline.push("R1-finished");
    assert.equal(r1.ok, false, `旧 A 必须 STALE，不得把 readiness 当成当前结果: ${JSON.stringify(r1)}`);
    assert.equal(isDreaminaEnablementStaleError(r1.error), true, JSON.stringify(r1));
    const after = await runWithUserStorage(IDENTITY, async () => ({
      settings: await readDreaminaCliSettings(),
      runtime: await readDreaminaRuntimeState(),
      cache: readDreaminaCapabilityCache(),
    }));
    assert.equal(samePath(after.settings.executablePath, harness.pathB), true);
    assert.equal(samePath(after.runtime.executablePath, harness.pathB), true);
    assert.equal(after.runtime.updatedAt, migrated.runtimeUpdatedAt, "R1 不得写 runtime");
    assert.notEqual(after.cache.snapshot?.version, "1.4.4", "旧 A 不得把 fake CLI 能力快照写回当前缓存");
    assert.notEqual(after.cache.snapshot?.version, "mine-before-A");
    assert.equal(commandLines(harness.logFile).length, migrated.logAfterR2, "B 生效后不得再跑新的 A CLI");
    assert.equal(readDreaminaSchedulerWakeCountForTests(), migrated.wakesBefore, "R1 不得唤醒调度器");
    assert.deepEqual(harness.timeline, [
      "start-R1-executeReady",
      "R1-paused-in-A-startup",
      "start-R2-A-to-B",
      "R2-finished-token-null",
      "release-R1",
      "R1-finished",
    ]);
  });
});

test("正式 generate 走同一竞态：旧 A 恢复后不得创建 operation/task/dispatch", async () => {
  await withHarness("r24-fix7-generate", { withProject: true }, async (harness) => {
    const body = {
      shotUuid: harness.shotUuid,
      mediaType: "image",
      providerModel: "dreamina-cli:text2image",
      mode: "text2image",
      durationMs: 5000,
      aspectRatio: "9:16",
    };
    const preview = await jsonRequest(harness.previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const digest = String(preview.body?.data?.previewDigest ?? "");
    assert.match(digest, /^[a-f0-9]{64}$/);
    const { firstReached, releaseFirst } = installFirstHitGate(setDreaminaStartupCheckBeforeProbeHookForTests);
    harness.timeline.push("start-R1-generate");
    const r1Promise = jsonRequest(harness.generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...body,
        expectedPreviewDigest: digest,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    await firstReached;
    harness.timeline.push("R1-paused-in-A-startup");
    const migrated = await migrateAToBAndRelease(harness);
    const beforeCounts = {
      operations: await countProjectRows("o_storyboardGenerationOperation"),
      tasks: await countProjectRows("o_storyboardGenerationTask"),
      dispatch: await countDispatch(),
    };
    harness.timeline.push("release-R1");
    releaseFirst();
    const r1 = await r1Promise;
    harness.timeline.push("R1-finished");
    leakFree(JSON.stringify(r1.body ?? {}));
    assert.notEqual(r1.status, 200, `旧 A 不得成功入队: ${JSON.stringify(r1)}`);
    assert.equal(await countProjectRows("o_storyboardGenerationOperation"), beforeCounts.operations);
    assert.equal(await countProjectRows("o_storyboardGenerationTask"), beforeCounts.tasks);
    assert.equal(await countDispatch(), beforeCounts.dispatch);
    const cache = readDreaminaCapabilityCache();
    assert.notEqual(cache.snapshot?.version, "1.4.4", "不得把 A 能力缓存当成 B 的有效缓存");
    assert.equal(commandNames(harness.logFile).some(isGenerateCommand), false, JSON.stringify(commandNames(harness.logFile)));
    assert.equal(commandLines(harness.logFile).length, migrated.logAfterR2, "B 生效后不得再跑新的 A CLI");
    assert.equal(readDreaminaSchedulerWakeCountForTests(), migrated.wakesBefore);
  });
});

test("失败 retry 走同一竞态：过期 readiness 零新增，B ready 缓存可入队且零多余探测", async () => {
  await withHarness("r24-fix7-retry", { withProject: true }, async (harness) => {
    writeReadyDreaminaTestCapability();
    resetDreaminaStartupStatusCheckForTests();
    const [parent] = await enqueueAsyncMediaTasks({
      projectUuid: PROJECT,
      clientOperationId: crypto.randomUUID(),
      paidBatchConfirmed: false,
      items: [{
        shotUuid: harness.shotUuid,
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
    writeDreaminaCapabilityCache({
      state: "failed",
      snapshot: null,
      checkedAt: Date.now(),
      failureReason: "force-reprobe",
    });
    resetDreaminaStartupStatusCheckForTests();
    const before = {
      operations: await countProjectRows("o_storyboardGenerationOperation"),
      tasks: await countProjectRows("o_storyboardGenerationTask"),
      dispatch: await countDispatch(),
    };
    const { firstReached, releaseFirst } = installFirstHitGate(setDreaminaStartupCheckBeforeProbeHookForTests);
    harness.timeline.push("start-R1-retry");
    const r1Promise = jsonRequest(harness.retryUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskUuid: parent.taskUuid,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    await firstReached;
    harness.timeline.push("R1-paused-in-A-startup");
    const migrated = await migrateAToBAndRelease(harness);
    harness.timeline.push("release-R1");
    releaseFirst();
    const r1 = await r1Promise;
    harness.timeline.push("R1-finished");
    leakFree(JSON.stringify(r1.body ?? {}));
    assert.notEqual(r1.status, 200, `过期 readiness 不得入队: ${JSON.stringify(r1)}`);
    assert.equal(await countProjectRows("o_storyboardGenerationOperation"), before.operations);
    assert.equal(await countProjectRows("o_storyboardGenerationTask"), before.tasks);
    assert.equal(await countDispatch(), before.dispatch);
    assert.equal(commandNames(harness.logFile).some(isGenerateCommand), false);
    assert.equal(commandLines(harness.logFile).length, migrated.logAfterR2);
    assert.equal(readDreaminaSchedulerWakeCountForTests(), migrated.wakesBefore);

    writeReadyDreaminaTestCapability();
    resetDreaminaStartupStatusCheckForTests();
    fs.writeFileSync(harness.logFile, "");
    const readyRetry = await jsonRequest(harness.retryUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskUuid: parent.taskUuid,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(readyRetry.body ?? {}));
    assert.equal(readyRetry.status, 200, JSON.stringify(readyRetry.body));
    const childUuid = String(readyRetry.body?.data?.taskUuid ?? readyRetry.body?.data?.tasks?.[0]?.taskUuid ?? "");
    assert.ok(childUuid && childUuid !== parent.taskUuid, JSON.stringify(readyRetry.body));
    assert.equal(commandLines(harness.logFile).length, 0, "B 的 ready 缓存不得再跑无意义探测");
    assert.equal(readDreaminaCapabilityCache().state, "ready");
  });
});

test("capability inFlight 必须按身份隔离：B 不得 join 旧 A，A 完成不得回填 B 缓存", async () => {
  await withHarness("r24-fix7-inflight", { withProject: false }, async (harness) => {
    const { firstReached, releaseFirst } = installFirstHitGate(setDreaminaCapabilityRefreshBeforeProbeHookForTests);
    harness.timeline.push("start-R1-capability");
    const r1Promise = runWithUserStorage(IDENTITY, () => refreshDreaminaCapabilities({
      probe: async () => snapshotA("A-inflight"),
    })).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    await firstReached;
    harness.timeline.push("R1-paused-in-A-capability");
    const migrated = await migrateAToBAndRelease(harness);
    let bProbeRan = false;
    harness.timeline.push("start-R2-capability");
    const r2Promise = runWithUserStorage(IDENTITY, () => refreshDreaminaCapabilities({
      probe: async () => {
        bProbeRan = true;
        harness.timeline.push("B-probe-ran");
        return snapshotA("B-current");
      },
    })).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    const waited = Date.now();
    while (Date.now() - waited < 800 && !bProbeRan) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(bProbeRan, true, "B 请求不得 join 或复用旧 A 的 inFlight Promise");
    assert.ok(harness.timeline.includes("B-probe-ran"));
    harness.timeline.push("release-R1");
    releaseFirst();
    const [r1, r2] = await Promise.all([r1Promise, r2Promise]);
    harness.timeline.push("both-finished");
    if (r1.ok === false) {
      assert.equal(isDreaminaEnablementStaleError(r1.error), true, JSON.stringify(r1));
    } else {
      assert.notEqual(r1.value.snapshot?.version, "B-current");
    }
    assert.equal(r2.ok, true, JSON.stringify(r2));
    if (r2.ok) assert.equal(r2.value.snapshot?.version, "B-current");
    const cache = readDreaminaCapabilityCache();
    assert.notEqual(cache.snapshot?.version, "A-inflight", "旧 A 完成不得重新填充 B 当前缓存");
    assert.equal(cache.snapshot?.version, "B-current");
    assert.equal(commandLines(harness.logFile).length, migrated.logAfterR2);
    void migrated.epochB;
    void migrated.revisionB;
  });
});
