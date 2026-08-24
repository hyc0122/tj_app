/**
 * Round27 P1：付费重试必须同时验证账号终态和项目失败态，禁止从活动/未知/排队状态分叉新任务。
 * 测试只绑定仓库内 fake CLI，并清空 PATH，任何拒绝场景都必须零 CLI、零新增任务。
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
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { enqueueAsyncMediaTasks } from "../../src/tianjiang/model-providers/async-generation-service";
import { stopDreaminaSchedulerLoop } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import { writeReadyDreaminaTestCapability } from "./helpers/dreamina-capability";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9787 };
const PROJECT_UUID = "87878787-8787-4787-a787-878787878787";
const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null };
}

test("retry 只允许 terminal/failed/slot0/ready1 与项目 failed 一致的父任务", async () => {
  const root = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    ".tmp",
    `r27-rg-${process.pid}-${crypto.randomUUID()}`,
  );
  const previousCwd = process.cwd();
  const previousListProjects = syncCoordinator.listProjects.bind(syncCoordinator);
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    DREAMINA_TEST_EXECUTABLE: process.env.DREAMINA_TEST_EXECUTABLE,
    DREAMINA_FAKE_LOG: process.env.DREAMINA_FAKE_LOG,
    PATH: process.env.PATH,
  };
  const fakeLog = path.join(root, "fake-cli.log");
  let server: http.Server | undefined;

  fs.mkdirSync(root, { recursive: true });
  const cleanupRoot = fs.realpathSync.native(root);
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = "storyboard-dreamina-retry-state-gate-round27";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.DREAMINA_FAKE_LOG = fakeLog;
  // 中文注释：绝对 fake 配置之外主动断开 PATH，防止任何默认命令名误触真实 CLI。
  process.env.PATH = path.join(root, "deny-path-fallback");
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);

  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 2787,
        name: "Round27 retry state gate",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await writeDreaminaCliSettings({
        executablePath: FAKE_CLI,
        maxConcurrency: 1,
        pauseNewClaims: true,
      });
      writeReadyDreaminaTestCapability();
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT_UUID,
        name: "Round27 retry state gate",
        kind: "personal",
        ownerUserId: IDENTITY.userId,
        myRole: "owner",
        openMode: "editable",
        businessType: "storyboard",
      }] as never;

      const storyboard = new StoryboardService(PROJECT_UUID);
      await storyboard.saveSettings({
        globalImagePrompt: "晨雾中的山谷",
        resolution: "2K",
      });
      const shot = await storyboard.insertShot({
        afterShotUuid: null,
        sourceText: "晨雾中的山谷",
      });
      const [parent] = await enqueueAsyncMediaTasks({
        projectUuid: PROJECT_UUID,
        clientOperationId: crypto.randomUUID(),
        paidBatchConfirmed: false,
        items: [{
          shotUuid: shot.shotUuid,
          mediaType: "image",
          providerModel: "dreamina-cli:text2image",
          mode: "text2image",
        }],
      });
      assert.ok(parent?.taskUuid);
      const parentTaskUuid = parent.taskUuid;

      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        enterUserStorage(IDENTITY);
        next();
      });
      const { default: retryRouter } = await import("../../src/routes/task/dreaminaQueue/retry");
      app.use("/api/task/dreaminaQueue/retry", retryRouter);
      const listening = await listen(app);
      server = listening.server;
      const retryUrl = `http://127.0.0.1:${listening.port}/api/task/dreaminaQueue/retry`;

      const counts = async () => ({
        dispatch: Number((await accountDb("o_dreaminaCliDispatch")
          .count<{ total: number }>("taskUuid as total").first())?.total ?? 0),
        project: Number((await runWithProjectStorage(PROJECT_UUID, () =>
          activeDb("o_storyboardGenerationTask")
            .count<{ total: number }>("taskUuid as total").first()))?.total ?? 0),
        operations: Number((await runWithProjectStorage(PROJECT_UUID, () =>
          activeDb("o_storyboardGenerationOperation")
            .count<{ total: number }>("clientOperationId as total").first()))?.total ?? 0),
      });
      const setParent = async (input: {
        queueState: string;
        providerState: string;
        slotHeld: number;
        dispatchReady: number;
        projectStatus: string;
      }) => {
        await accountDb("o_dreaminaCliDispatch").where({ taskUuid: parentTaskUuid }).update({
          queueState: input.queueState,
          providerState: input.providerState,
          slotHeld: input.slotHeld,
          dispatchReady: input.dispatchReady,
        });
        await runWithProjectStorage(PROJECT_UUID, () =>
          activeDb("o_storyboardGenerationTask").where({ taskUuid: parentTaskUuid }).update({
            status: input.projectStatus,
          }));
      };
      const assertRejectedWithoutFork = async (state: Parameters<typeof setParent>[0]) => {
        await setParent(state);
        const before = await counts();
        const response = await postJson(retryUrl, {
          taskUuid: parentTaskUuid,
          clientOperationId: crypto.randomUUID(),
        });
        assert.equal(response.status, 400, JSON.stringify({ state, response }));
        assert.deepEqual(await counts(), before, JSON.stringify(state));
      };

      for (const state of [
        {
          queueState: "queued",
          providerState: "not_sent",
          slotHeld: 0,
          dispatchReady: 1,
          projectStatus: "failed_retryable",
        },
        {
          queueState: "provider_active",
          providerState: "running",
          slotHeld: 1,
          dispatchReady: 1,
          projectStatus: "failed_retryable",
        },
        {
          queueState: "provider_active",
          providerState: "unknown",
          slotHeld: 1,
          dispatchReady: 1,
          projectStatus: "failed_retryable",
        },
        {
          queueState: "terminal",
          providerState: "completed",
          slotHeld: 0,
          dispatchReady: 1,
          projectStatus: "failed_retryable",
        },
        {
          queueState: "terminal",
          providerState: "failed",
          slotHeld: 1,
          dispatchReady: 1,
          projectStatus: "failed_retryable",
        },
        {
          queueState: "terminal",
          providerState: "failed",
          slotHeld: 0,
          dispatchReady: 0,
          projectStatus: "failed_retryable",
        },
        {
          queueState: "terminal",
          providerState: "failed",
          slotHeld: 0,
          dispatchReady: 1,
          projectStatus: "submitted",
        },
        {
          queueState: "terminal",
          providerState: "failed",
          slotHeld: 0,
          dispatchReady: 1,
          projectStatus: "cancelled_local",
        },
      ]) {
        await assertRejectedWithoutFork(state);
      }

      await setParent({
        queueState: "terminal",
        providerState: "failed",
        slotHeld: 0,
        dispatchReady: 1,
        projectStatus: "failed_retryable",
      });
      const beforeValid = await counts();
      const accepted = await postJson(retryUrl, {
        taskUuid: parentTaskUuid,
        clientOperationId: crypto.randomUUID(),
      });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      const childTaskUuid = String(
        accepted.body?.data?.taskUuid
        ?? accepted.body?.data?.tasks?.[0]?.taskUuid
        ?? "",
      );
      assert.ok(childTaskUuid && childTaskUuid !== parentTaskUuid);
      const child = await runWithProjectStorage(PROJECT_UUID, () =>
        activeDb("o_storyboardGenerationTask").where({ taskUuid: childTaskUuid }).first());
      assert.equal(child?.parentTaskUuid, parentTaskUuid);
      assert.deepEqual(await counts(), {
        dispatch: beforeValid.dispatch + 1,
        project: beforeValid.project + 1,
        operations: beforeValid.operations + 1,
      });
      assert.equal(fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, "utf8").trim() : "", "");
    });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    stopDreaminaSchedulerLoop();
    syncCoordinator.listProjects = previousListProjects;
    await closeActivatedWorkspaceRuntime();
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fs.rmSync(cleanupRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch {
      // 中文注释：Windows 偶发延迟释放目录句柄时，仅保留在本工作树 .tmp。
    }
  }
});
