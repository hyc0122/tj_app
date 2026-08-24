/**
 * Task 10/11 RED：submitted 必须 query 后才 terminal；自动循环；IMMEDIATE 三层限流；
 * 缺 dispatch 恢复补建；退出不得把在途 submit 重置为 queued。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import express from "express";

import {
  activateUserDatabase,
  accountDb,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
  db as activeDb,
} from "../../src/utils/db";
import {
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { hasPendingMutationJournal } from "../../src/tianjiang/runtime/legacy-mutation-journal";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { insertDreaminaDispatch } from "../../src/tianjiang/model-providers/dreamina-cli/task-store";
import { pauseGenerationRuntime } from "../../src/tianjiang/tasks/generation-runtime-participants";
import { getStableDeviceUUID } from "../../src/tianjiang/auth/device";
import getPath from "../../src/utils/getPath";
import {
  withStoryboardPreviewDigest,
  writeReadyDreaminaTestCapability,
} from "./helpers/dreamina-capability";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9901 };
const PROJECT = "11111111-1111-4111-a111-111111111111";
const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "耐久队列",
    kind: "personal",
    ownerUserId: IDENTITY.userId,
    role: "owner",
    myRole: "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-13T00:00:00Z",
    lockStatus: "none",
    lockHolderName: "",
    openMode: "editable",
    businessType: "storyboard",
  };
}

async function listen(app: express.Express) {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function jsonRequest(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: response.status, body };
}

function cliSubmits(logFile: string): string[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter((line) => line.includes("\"text2image\""));
}

function cliQueries(logFile: string): string[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter((line) => line.includes("\"query_result\""));
}

async function withDreamina<T>(
  env: Record<string, string>,
  run: (ctx: { port: number; logFile: string; shotUuid: string }) => Promise<T>,
): Promise<T> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-loop-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const originalCwd = process.cwd();
  const originals: Record<string, string | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    DREAMINA_FAKE_SCENARIO: process.env.DREAMINA_FAKE_SCENARIO,
    DREAMINA_FAKE_LOG: process.env.DREAMINA_FAKE_LOG,
    DREAMINA_FAKE_QUERY_STATUS: process.env.DREAMINA_FAKE_QUERY_STATUS,
    DREAMINA_FAKE_DELAY_MS: process.env.DREAMINA_FAKE_DELAY_MS,
    DREAMINA_TEST_EXECUTABLE: process.env.DREAMINA_TEST_EXECUTABLE,
    DREAMINA_SCHEDULER_INTERVAL_MS: process.env.DREAMINA_SCHEDULER_INTERVAL_MS,
  };
  fs.mkdirSync(root, { recursive: true });
  const logFile = path.join(root, "cli.log");
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.DREAMINA_FAKE_LOG = logFile;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  resetDatabaseRuntimeForServe();
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  await activateUserDatabase(IDENTITY);
  try {
    return await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 71,
        name: "耐久队列",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await writeDreaminaCliSettings({
        executablePath: FAKE_CLI,
        maxConcurrency: Number(env.maxConcurrency ?? 1),
        pauseNewClaims: false,
      });
      // 中文注释：队列耐久测试使用真实必需参数，避免宽松 fake 掩盖 CLI 拒绝。
      await new StoryboardService(PROJECT).saveSettings({ globalImagePrompt: "耐久队列图片生成", resolution: "2K" });
      writeReadyDreaminaTestCapability();
      syncCoordinator.listProjects = () => [catalogRow()] as any;
      const shot = await new StoryboardService(PROJECT).insertShot({ afterShotUuid: null, sourceText: "雨巷" });
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "alice" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      for (const name of ["getState", "pause", "resume", "retry", "cancelQueued"] as const) {
        const loaded = await import(`../../src/routes/task/dreaminaQueue/${name}.ts`);
        app.use(`/api/task/dreaminaQueue/${name}`, loaded.default);
      }
      const { server, port } = await listen(app);
      try {
        return await run({ port, logFile, shotUuid: shot.shotUuid });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    try {
      const { stopDreaminaSchedulerLoop } = await import("../../src/tianjiang/model-providers/dreamina-cli/scheduler");
      stopDreaminaSchedulerLoop?.();
    } catch { /* RED 前循环可能不存在 */ }
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function enqueue(port: number, shotUuid: string, extras: Record<string, unknown> = {}) {
  const generateUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`;
  const confirmed = await withStoryboardPreviewDigest(generateUrl, {
    shotUuid,
    mediaType: "image",
    providerModel: "dreamina-cli:text2image",
    mode: "text2image",
    ...extras,
  });
  return jsonRequest(
    generateUrl,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(confirmed),
    },
  );
}

test("submit_id 必须进入 provider_active 占槽，query 完成后才安装候选且只提交一次", async () => {
  await withDreamina({ DREAMINA_FAKE_SCENARIO: "submit_id", DREAMINA_FAKE_QUERY_STATUS: "running" }, async ({ port, logFile, shotUuid }) => {
    const enqueued = await enqueue(port, shotUuid);
    assert.equal(enqueued.status, 200, `入队应为 200，实际 ${enqueued.status} ${JSON.stringify(enqueued.body)}`);
    const { tickDreaminaScheduler } = await import("../../src/tianjiang/model-providers/dreamina-cli/scheduler");
    await tickDreaminaScheduler();
    const afterSubmit = await accountDb("o_dreaminaCliDispatch").first();
    assert.ok(afterSubmit, "必须已有 dispatch");
    assert.equal(String(afterSubmit.queueState), "provider_active", `submitted 必须保持 provider_active，实际 ${afterSubmit.queueState}`);
    assert.equal(Number(afterSubmit.slotHeld), 1, "query 完成前必须占槽");
    assert.notEqual(String(afterSubmit.queueState), "terminal");
    const parsed = JSON.parse(String(afterSubmit.providerResultJson ?? "{}"));
    assert.equal(
      parsed.submitId || parsed.submit_id,
      "sub-123",
      `submitId 必须落盘，dispatch=${JSON.stringify(afterSubmit)} parsed=${JSON.stringify(parsed)}`,
    );
    const candidatesAfterSubmit = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardCandidate").select());
    assert.equal(candidatesAfterSubmit.length, 0, "仅 submit 不得安装候选");
    assert.equal(cliSubmits(logFile).length, 1, `submit 必须恰好一次，实际 ${cliSubmits(logFile).length}`);

    delete process.env.DREAMINA_FAKE_QUERY_STATUS;
    await tickDreaminaScheduler();
    await tickDreaminaScheduler();
    assert.ok(cliQueries(logFile).length >= 1, `调度器必须调用 query_result，实际 log=${fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : ""}`);
    const afterQuery = await accountDb("o_dreaminaCliDispatch").first();
    assert.equal(String(afterQuery?.queueState), "terminal", `完成安装后才 terminal，实际 ${afterQuery?.queueState}`);
    assert.equal(Number(afterQuery?.slotHeld), 0);
    const candidates = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardCandidate").select());
    assert.ok(candidates.length > 0, "query 完成后必须安装候选");
    assert.equal(cliSubmits(logFile).length, 1, "query/恢复不得再次 submit");
  });
});

test("每个持久化阶段重启不得丢结果或重复提交", async () => {
  await withDreamina({ DREAMINA_FAKE_SCENARIO: "submit_id", DREAMINA_FAKE_QUERY_STATUS: "running" }, async ({ port, logFile, shotUuid }) => {
    await enqueue(port, shotUuid);
    const { tickDreaminaScheduler } = await import("../../src/tianjiang/model-providers/dreamina-cli/scheduler");
    const { recoverDreaminaSlots } = await import("../../src/tianjiang/model-providers/dreamina-cli/recovery");
    await tickDreaminaScheduler();
    await recoverDreaminaSlots();
    await recoverDreaminaSlots();
    assert.equal(cliSubmits(logFile).length, 1, `submitted 后重启不得重提，实际 ${cliSubmits(logFile).length}`);
    delete process.env.DREAMINA_FAKE_QUERY_STATUS;
    await recoverDreaminaSlots();
    await tickDreaminaScheduler();
    assert.equal(cliSubmits(logFile).length, 1);
    const candidates = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardCandidate").select());
    assert.ok(candidates.length > 0, "重启后必须恢复安装结果");
  });
});

test("enqueue 与 resume 后无需手工 tick 即自动领取下一项", async () => {
  await withDreamina({
    DREAMINA_FAKE_SCENARIO: "immediate",
    DREAMINA_SCHEDULER_INTERVAL_MS: "80",
  }, async ({ port, logFile, shotUuid }) => {
    await enqueue(port, shotUuid);
    const started = Date.now();
    let dispatch: any = null;
    while (Date.now() - started < 2500) {
      dispatch = await accountDb("o_dreaminaCliDispatch").first();
      if (dispatch && ["provider_active", "postprocessing", "terminal"].includes(String(dispatch.queueState))) break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    assert.ok(dispatch, "必须自动建立 dispatch");
    assert.notEqual(String(dispatch.queueState), "queued", `enqueue 后必须自动推进，实际 ${dispatch.queueState}`);
    assert.ok(cliSubmits(logFile).length >= 1, "自动循环必须真正 submit");

    await jsonRequest(`http://127.0.0.1:${port}/api/task/dreaminaQueue/pause`, { method: "POST" });
    const second = await enqueue(port, shotUuid);
    assert.equal(second.status, 200);
    await jsonRequest(`http://127.0.0.1:${port}/api/task/dreaminaQueue/resume`, { method: "POST" });
    const resumeStarted = Date.now();
    let queuedLeft = 99;
    while (Date.now() - resumeStarted < 2500) {
      const rows = await accountDb("o_dreaminaCliDispatch").where({ queueState: "queued" });
      queuedLeft = rows.length;
      if (queuedLeft === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    assert.equal(queuedLeft, 0, `resume 后必须自动领完 queued，剩余 ${queuedLeft}`);
  });
});

test("双 tick 并发领取时账号/项目/模型上限均生效", async () => {
  await withDreamina({ DREAMINA_FAKE_SCENARIO: "submit_id", DREAMINA_FAKE_QUERY_STATUS: "running" }, async ({ port, shotUuid }) => {
    await writeDreaminaCliSettings({ executablePath: FAKE_CLI, maxConcurrency: 3, pauseNewClaims: false });
    await new StoryboardService(PROJECT).saveSettings({ imageConcurrency: 2 });
    await enqueue(port, shotUuid);
    await enqueue(port, shotUuid);
    await enqueue(port, shotUuid);
    await accountDb("o_dreaminaCliDispatch").update({
      projectConcurrencyLimit: 2,
      modelConcurrencyLimit: 1,
    });
    const { tickDreaminaScheduler } = await import("../../src/tianjiang/model-providers/dreamina-cli/scheduler");
    await Promise.all([tickDreaminaScheduler(), tickDreaminaScheduler()]);
    const held = await accountDb("o_dreaminaCliDispatch").where({ slotHeld: 1 });
    const claimed = await accountDb("o_dreaminaCliDispatch").whereNot({ queueState: "queued" });
    assert.equal(held.length, 1, `账号3/项目2/模型1 时最大占槽必须为 1，实际 ${held.length}`);
    assert.equal(claimed.length, 1, `双连接并发领取不得越过模型上限，实际 claimed=${claimed.length}`);

    await new StoryboardService(PROJECT).saveSettings({ imageConcurrency: 3 });
    await accountDb("o_dreaminaCliDispatch").where({ queueState: "queued" }).update({
      modelConcurrencyLimit: 3,
    });
    await tickDreaminaScheduler();
    const heldAfter = await accountDb("o_dreaminaCliDispatch").where({ slotHeld: 1 });
    assert.ok(heldAfter.length >= 2, `修改项目/模型限制后未领取任务必须使用新限制，实际 ${heldAfter.length}`);
  });
});

test("dispatch 插入失败后启动恢复必须幂等补回且不重提", async () => {
  await withDreamina({ DREAMINA_FAKE_SCENARIO: "submit_id", DREAMINA_FAKE_QUERY_STATUS: "running" }, async ({ logFile, shotUuid }) => {
    const now = Date.now();
    const taskUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").insert({
      taskUuid,
      shotUuid,
      parentTaskUuid: null,
      originDeviceUuid: getStableDeviceUUID(getPath()),
      mediaType: "image",
      providerId: "dreamina-cli",
      providerTaskId: null,
      providerSessionId: null,
      mode: "text2image",
      modelName: "dreamina-cli:text2image",
      parametersJson: JSON.stringify({ prompt: "补建" }),
      requestDigest: "d".repeat(64),
      status: "queued",
      paidBatchConfirmedAt: null,
      providerCompletedAt: null,
      resultLocatorDigest: null,
      progress: 0,
      errorCode: null,
      errorSummary: null,
      createdAt: now,
      updatedAt: now,
    }));
    const before = await accountDb("o_dreaminaCliDispatch").where({ taskUuid });
    assert.equal(before.length, 0, "夹具不得预先写入 dispatch");
    const { recoverDreaminaSlots } = await import("../../src/tianjiang/model-providers/dreamina-cli/recovery");
    await recoverDreaminaSlots();
    await recoverDreaminaSlots();
    const after = await accountDb("o_dreaminaCliDispatch").where({ taskUuid });
    assert.equal(after.length, 1, `恢复器必须幂等补建 dispatch，实际 ${after.length}`);
    assert.equal(cliSubmits(logFile).filter((line) => line.includes("补建") || line.includes("text2image")).length <= 1, true);
  });
});

test("延迟 submit 期间退出不得把在途任务重置为 queued 后重复提交", async () => {
  await withDreamina({
    DREAMINA_FAKE_SCENARIO: "delay_submit",
    DREAMINA_FAKE_DELAY_MS: "1200",
    DREAMINA_FAKE_QUERY_STATUS: "running",
  }, async ({ port, logFile, shotUuid }) => {
    await enqueue(port, shotUuid);
    const { tickDreaminaScheduler } = await import("../../src/tianjiang/model-providers/dreamina-cli/scheduler");
    const ticking = tickDreaminaScheduler();
    const waitStart = Date.now();
    while (Date.now() - waitStart < 800 && cliSubmits(logFile).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await pauseGenerationRuntime();
    const mid = await accountDb("o_dreaminaCliDispatch").first();
    assert.ok(mid);
    assert.notEqual(String(mid.queueState), "queued", `在途 submit 不得被重置为 queued，实际 ${mid.queueState}`);
    await ticking;
    await tickDreaminaScheduler();
    assert.equal(cliSubmits(logFile).length, 1, `退出后不得二次提交，实际 ${cliSubmits(logFile).length} log=${fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : ""}`);
  });
});

test("retry/cancel/resume 必须同步账号库、项目任务和 mutation journal", async () => {
  await withDreamina({ DREAMINA_FAKE_SCENARIO: "submit_id" }, async ({ port, shotUuid }) => {
    const queued = await enqueue(port, shotUuid);
    assert.equal(queued.status, 200);
    const taskUuid = String(queued.body?.data?.[0]?.taskUuid ?? "");
    assert.ok(taskUuid);
    const cancelled = await jsonRequest(`http://127.0.0.1:${port}/api/task/dreaminaQueue/cancelQueued`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskUuid }),
    });
    assert.equal(cancelled.status, 200, `取消应为 200，实际 ${cancelled.status}`);
    const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
    assert.equal(String(dispatch?.queueState), "terminal");
    const project = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
    assert.equal(String(project?.status), "cancelled_local", `项目任务必须 cancelled_local，实际 ${project?.status}`);
    const journalAfterCancel = await runWithProjectStorage(PROJECT, () => hasPendingMutationJournal(activeDb as any));
    assert.equal(journalAfterCancel, true, "取消必须写 mutation journal");

    await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
      queueState: "terminal",
      providerState: "failed",
      slotHeld: 0,
    });
    await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardGenerationTask").where({ taskUuid }).update({ status: "failed_fatal" }));
    const retried = await jsonRequest(`http://127.0.0.1:${port}/api/task/dreaminaQueue/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskUuid,
        clientOperationId: "64646464-6464-4464-a464-646464646464",
      }),
    });
    assert.equal(retried.status, 200, `重试应为 200，实际 ${retried.status} ${JSON.stringify(retried.body)}`);
    const childUuid = String(retried.body?.data?.taskUuid ?? retried.body?.taskUuid ?? "");
    assert.ok(childUuid && childUuid !== taskUuid, "重试必须创建新 taskUuid");
    const child = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardGenerationTask").where({ taskUuid: childUuid }).first());
    assert.ok(child, "重试必须写入项目任务");
    assert.equal(String(child.parentTaskUuid), taskUuid);
    const childDispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: childUuid }).first();
    assert.ok(childDispatch, "重试必须写入账号 dispatch");
    const journalAfterRetry = await runWithProjectStorage(PROJECT, () => hasPendingMutationJournal(activeDb as any));
    assert.equal(journalAfterRetry, true, "重试必须写 mutation journal");
  });
});
