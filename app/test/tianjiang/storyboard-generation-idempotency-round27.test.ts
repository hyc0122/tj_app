/**
 * Round27 P1 RED：一次用户确认动作必须用 clientOperationId 在跨库入队、重试和恢复中保持幂等。
 * 测试只写本地 SQLite，调度保持暂停，禁止触发真实生成或收费调用。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import {
  accountDb,
  accountDatabase,
  activateUserDatabase,
  db as activeDb,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { recoverDreaminaSlots } from "../../src/tianjiang/model-providers/dreamina-cli/recovery";
import {
  claimNextDreaminaDispatch,
  insertDreaminaDispatch,
} from "../../src/tianjiang/model-providers/dreamina-cli/task-store";
import {
  drainDreaminaSubmitCriticalSection,
  stopDreaminaSchedulerLoop,
  tickDreaminaScheduler,
} from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import {
  enqueueAsyncMediaTasks,
  replayAcceptedDreaminaEnqueue,
  resumeDreaminaEnqueueOperation,
} from "../../src/tianjiang/model-providers/async-generation-service";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import {
  withStoryboardPreviewDigest,
  writeReadyDreaminaTestCapability,
} from "./helpers/dreamina-capability";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9731 };
const PROJECT_UUID = "31313131-3131-4131-a131-313131313131";
const OTHER_PROJECT_UUID = "32323232-3232-4232-a232-323232323232";
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
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function responseTaskUuids(body: any): string[] {
  const rows: any[] = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.data?.tasks)
      ? body.data.tasks
      : [body?.data];
  return rows.map((row) => String(row?.taskUuid ?? ""));
}

test("真实 HTTP 生成入队必须按 clientOperationId 幂等并可前滚恢复", async (t) => {
  const root = path.resolve(
    process.cwd(),
    "..",
    ".local",
    "t",
    `generation-idempotency-${process.pid}-${crypto.randomUUID()}`,
  );
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  const previousQueryStatus = process.env.DREAMINA_FAKE_QUERY_STATUS;
  const originalListProjects = syncCoordinator.listProjects.bind(syncCoordinator);
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = previousTestContext || "storyboard-generation-idempotency-round27";
  process.env.DREAMINA_FAKE_QUERY_STATUS = "running";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  writeReadyDreaminaTestCapability();

  let server: http.Server | undefined;
  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 2731,
        name: "Round27 生成入队幂等",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await initializeWorkspaceProject(OTHER_PROJECT_UUID, {
        id: 2732,
        name: "Round27 另一个项目",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      // 中文注释：暂停领取，只验证入队协议，避免 fake 调度异步改变断言状态。
      await accountDb("o_dreaminaCliSettings").where({ id: 1 }).update({
        executablePath: FAKE_CLI,
        pauseNewClaims: 1,
      });
      syncCoordinator.listProjects = () => [
        {
          projectUuid: PROJECT_UUID,
          name: "Round27 生成入队幂等",
          kind: "personal",
          ownerUserId: IDENTITY.userId,
          myRole: "owner",
          openMode: "editable",
        },
        {
          projectUuid: OTHER_PROJECT_UUID,
          name: "Round27 另一个项目",
          kind: "personal",
          ownerUserId: IDENTITY.userId,
          myRole: "owner",
          openMode: "editable",
        },
      ] as any;

      const service = new StoryboardService(PROJECT_UUID);
      const otherService = new StoryboardService(OTHER_PROJECT_UUID);
      // 中文注释：幂等夹具必须先满足真实 CLI 提示词合同，避免把预检失败误当成幂等结果。
      await service.saveSettings({
        globalImagePrompt: "幂等分镜图片生成",
        globalVideoPrompt: "幂等分镜视频生成",
        resolution: "720p",
      });
      await otherService.saveSettings({
        globalImagePrompt: "另一个项目图片生成",
        globalVideoPrompt: "另一个项目视频生成",
        resolution: "720p",
      });
      const shot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "夜色中的城市天际线",
      });
      const otherShot = await otherService.insertShot({
        afterShotUuid: null,
        sourceText: "同账号另一个项目的海边日出",
      });
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "round27-idempotency" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { default: retryRouter } = await import("../../src/routes/task/dreaminaQueue/retry");
      const { default: cancelQueuedRouter } = await import("../../src/routes/task/dreaminaQueue/cancelQueued");
      app.use("/api/task/dreaminaQueue/retry", retryRouter);
      app.use("/api/task/dreaminaQueue/cancelQueued", cancelQueuedRouter);
      const listening = await listen(app);
      server = listening.server;
      const url = `http://127.0.0.1:${listening.port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/storyboard/generate`;
      const otherUrl = `http://127.0.0.1:${listening.port}/api/tianjiang/runtime/projects/${OTHER_PROJECT_UUID}/storyboard/generate`;

      const cleanQueue = async () => {
        await accountDb("o_dreaminaCliDispatch").delete();
        await runWithProjectStorage(PROJECT_UUID, async () => {
          await activeDb("o_storyboardGenerationTask").delete();
          if (await activeDb.schema.hasTable("o_storyboardGenerationOperation")) {
            await activeDb("o_storyboardGenerationOperation").delete();
          }
        });
        await runWithProjectStorage(OTHER_PROJECT_UUID, async () => {
          await activeDb("o_storyboardGenerationTask").delete();
          if (await activeDb.schema.hasTable("o_storyboardGenerationOperation")) {
            await activeDb("o_storyboardGenerationOperation").delete();
          }
        });
      };
      const markRetryableParent = async (taskUuid: string) => {
        // 中文注释：重试夹具必须同时提交账号收费终态和项目失败镜像，禁止只改项目库绕过真实状态门。
        await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
          queueState: "terminal",
          providerState: "failed",
          slotHeld: 0,
          dispatchReady: 1,
          leaseOwner: null,
          leaseExpiresAt: null,
          providerTerminalAt: Date.now(),
        });
        await runWithProjectStorage(PROJECT_UUID, () =>
          activeDb("o_storyboardGenerationTask").where({ taskUuid }).update({ status: "failed_retryable" }));
      };
      const buildConfirmedBody = async (durationMs = 9_000) => withStoryboardPreviewDigest(url, {
        shotUuid: shot.shotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "text2video",
        durationMs,
        aspectRatio: "9:16",
        paidBatchConfirmed: false,
      });
      const buildConfirmedBatch = async () => {
        const items = [];
        for (const providerModel of [
          "dreamina-cli:seedance2.0fast",
          "dreamina-cli:seedance2.0mini",
        ]) {
          items.push(await withStoryboardPreviewDigest(url, {
            shotUuid: shot.shotUuid,
            mediaType: "video",
            providerModel,
            mode: "text2video",
            durationMs: 9_000,
            aspectRatio: "9:16",
          }));
        }
        return items;
      };
      const counts = async () => ({
        project: (await runWithProjectStorage(PROJECT_UUID, () =>
          activeDb("o_storyboardGenerationTask").count<{ total: number }>("taskUuid as total").first()))?.total ?? 0,
        dispatch: (await accountDb("o_dreaminaCliDispatch")
          .count<{ total: number }>("taskUuid as total").first())?.total ?? 0,
      });

      await t.test("同一操作的并发 POST 与响应丢失重试只能返回原任务集合", async () => {
        const clientOperationId = "41414141-4141-4141-a141-414141414141";
        try {
          const body = { ...(await buildConfirmedBody()), clientOperationId };
          const [left, right] = await Promise.all([postJson(url, body), postJson(url, body)]);
          assert.equal(left.status, 200, JSON.stringify(left.body));
          assert.equal(right.status, 200, JSON.stringify(right.body));
          assert.deepEqual(responseTaskUuids(left.body), responseTaskUuids(right.body));
          assert.equal(left.body?.data?.[0]?.clientOperationId, clientOperationId);
          assert.equal(right.body?.data?.[0]?.clientOperationId, clientOperationId);
          const uppercaseRetry = await postJson(url, {
            ...body,
            clientOperationId: clientOperationId.toUpperCase(),
          });
          assert.equal(uppercaseRetry.status, 200, JSON.stringify(uppercaseRetry.body));
          assert.deepEqual(responseTaskUuids(uppercaseRetry.body), responseTaskUuids(left.body));
          assert.equal(uppercaseRetry.body?.data?.[0]?.clientOperationId, clientOperationId);
          assert.deepEqual(await counts(), { project: 1, dispatch: 1 });

          // 中文注释：模拟首次 200 响应在网络中丢失，客户端用同一操作 ID 再发一次。
          const retry = await postJson(url, body);
          assert.equal(retry.status, 200, JSON.stringify(retry.body));
          assert.deepEqual(responseTaskUuids(retry.body), responseTaskUuids(left.body));
          assert.deepEqual(await counts(), { project: 1, dispatch: 1 });
        } finally {
          await cleanQueue();
        }
      });

      await t.test("同一操作 ID 内容变化必须 409，新操作 ID 即使预览相同也必须新建", async () => {
        const firstOperationId = "42424242-4242-4242-a242-424242424242";
        const secondOperationId = "43434343-4343-4343-a343-434343434343";
        try {
          const original = await buildConfirmedBody();
          const first = await postJson(url, { ...original, clientOperationId: firstOperationId });
          const explicitNewAction = await postJson(url, { ...original, clientOperationId: secondOperationId });
          assert.equal(first.status, 200, JSON.stringify(first.body));
          assert.equal(explicitNewAction.status, 200, JSON.stringify(explicitNewAction.body));
          assert.notDeepEqual(responseTaskUuids(first.body), responseTaskUuids(explicitNewAction.body));

          const changed = await buildConfirmedBody(10_000);
          const conflict = await postJson(url, { ...changed, clientOperationId: firstOperationId });
          assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
          const paidFlagConflict = await postJson(url, {
            ...original,
            paidBatchConfirmed: true,
            clientOperationId: firstOperationId,
          });
          assert.equal(paidFlagConflict.status, 409, JSON.stringify(paidFlagConflict.body));
          assert.deepEqual(await counts(), { project: 2, dispatch: 2 });
        } finally {
          await cleanQueue();
        }
      });

      await t.test("已受理操作在分镜变化后原样重放仍必须返回原任务", async () => {
        const clientOperationId = "68686868-6868-4868-a868-686868686868";
        try {
          const body = { ...(await buildConfirmedBody()), clientOperationId };
          const first = await postJson(url, body);
          assert.equal(first.status, 200, JSON.stringify(first.body));
          await new StoryboardService(PROJECT_UUID).updateShot(shot.shotUuid, {
            videoPrompt: "分镜提示词已在首次受理后改变，网络重放不得重新预检",
          });
          const replay = await postJson(url, body);
          assert.equal(replay.status, 200, JSON.stringify(replay.body));
          assert.deepEqual(responseTaskUuids(replay.body), responseTaskUuids(first.body));
        } finally {
          await new StoryboardService(PROJECT_UUID).updateShot(shot.shotUuid, { videoPrompt: null });
          await cleanQueue();
        }
      });

      await t.test("同账号不同项目复用同一操作 ID 必须各自建立独立任务", async () => {
        const clientOperationId = "53535353-5353-4353-a353-535353535353";
        try {
          const firstBody = { ...(await buildConfirmedBody()), clientOperationId };
          const otherBody = {
            ...(await withStoryboardPreviewDigest(otherUrl, {
              shotUuid: otherShot.shotUuid,
              mediaType: "video",
              providerModel: "dreamina-cli:seedance2.0fast",
              mode: "text2video",
              durationMs: 9_000,
              aspectRatio: "9:16",
              paidBatchConfirmed: false,
            })),
            clientOperationId,
          };
          const first = await postJson(url, firstBody);
          const second = await postJson(otherUrl, otherBody);
          assert.equal(first.status, 200, JSON.stringify(first.body));
          assert.equal(second.status, 200, JSON.stringify(second.body));
          assert.notDeepEqual(responseTaskUuids(first.body), responseTaskUuids(second.body));
          const projected = await accountDb("o_dreaminaCliDispatch")
            .where({ clientOperationId })
            .orderBy("projectUuid")
            .select("projectUuid", "taskUuid");
          assert.deepEqual(projected.map((row) => String(row.projectUuid)), [PROJECT_UUID, OTHER_PROJECT_UUID]);
        } finally {
          await cleanQueue();
        }
      });

      await t.test("两项批次的并发重试必须保留原任务集合和顺序，交换 items 必须 409", async () => {
        const clientOperationId = "45454545-4545-4545-a545-454545454545";
        try {
          const items = await buildConfirmedBatch();
          const body = { items, paidBatchConfirmed: true, clientOperationId };
          const [left, right] = await Promise.all([postJson(url, body), postJson(url, body)]);
          assert.equal(left.status, 200, JSON.stringify(left.body));
          assert.equal(right.status, 200, JSON.stringify(right.body));
          const expected = responseTaskUuids(left.body);
          assert.equal(expected.length, 2);
          assert.deepEqual(responseTaskUuids(right.body), expected);
          assert.deepEqual(await counts(), { project: 2, dispatch: 2 });

          const retry = await postJson(url, body);
          assert.deepEqual(responseTaskUuids(retry.body), expected);
          const swapped = await postJson(url, {
            items: [...items].reverse(),
            paidBatchConfirmed: true,
            clientOperationId,
          });
          assert.equal(swapped.status, 409, JSON.stringify(swapped.body));
          assert.deepEqual(await counts(), { project: 2, dispatch: 2 });
        } finally {
          await cleanQueue();
        }
      });

      await t.test("账号投影失败且删除补偿失败后，启动恢复和 HTTP 重试必须复用原 taskUuid", async () => {
        const clientOperationId = "44444444-4444-4444-a444-444444444444";
        try {
          await accountDb.raw(`
            CREATE TRIGGER r27_fail_idempotency_dispatch
            BEFORE INSERT ON o_dreaminaCliDispatch
            BEGIN SELECT RAISE(ABORT, 'round27 injected account projection failure'); END
          `);
          await runWithProjectStorage(PROJECT_UUID, () => activeDb.raw(`
            CREATE TRIGGER r27_fail_idempotency_compensation
            BEFORE DELETE ON o_storyboardGenerationTask
            BEGIN SELECT RAISE(ABORT, 'round27 injected compensation failure'); END
          `));
          const body = { ...(await buildConfirmedBody()), clientOperationId };
          const failed = await postJson(url, body);
          assert.equal(failed.status, 202, JSON.stringify(failed.body));
          assert.equal(failed.body?.code, "DREAMINA_ENQUEUE_RECOVERING");
          assert.doesNotMatch(String(failed.body?.message ?? ""), /insert into|夜色|parametersJson/i);
          const stranded = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").select("taskUuid").first());
          assert.ok(stranded?.taskUuid, "项目库先提交后必须存在可恢复的原任务");
          assert.equal(failed.body?.data?.clientOperationId, clientOperationId);
          assert.deepEqual(responseTaskUuids(failed.body), [String(stranded.taskUuid)]);
          assert.deepEqual(await counts(), { project: 1, dispatch: 0 });

          await accountDb.raw("DROP TRIGGER r27_fail_idempotency_dispatch");
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb.raw("DROP TRIGGER r27_fail_idempotency_compensation"));
          await recoverDreaminaSlots();
          const recoveredDispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: stranded.taskUuid }).first();
          assert.ok(recoveredDispatch, "启动恢复必须前滚补齐同一个 taskUuid 的账号投影");

          const retry = await postJson(url, body);
          assert.equal(retry.status, 200, JSON.stringify(retry.body));
          assert.deepEqual(responseTaskUuids(retry.body), [String(stranded.taskUuid)]);
          assert.equal(retry.body?.data?.[0]?.clientOperationId, clientOperationId);
          assert.deepEqual(await counts(), { project: 1, dispatch: 1 });
        } finally {
          await accountDb.raw("DROP TRIGGER IF EXISTS r27_fail_idempotency_dispatch");
          await runWithProjectStorage(PROJECT_UUID, async () => {
            await activeDb.raw("DROP TRIGGER IF EXISTS r27_fail_idempotency_compensation");
          });
          await cleanQueue();
        }
      });

      await t.test("账号投影持续失败时同 ID 重放仍返回同一安全 202", async () => {
        const clientOperationId = "33333333-3333-4333-a333-333333333333";
        try {
          // 中文注释：触发器在两次 HTTP 请求期间持续存在，稳定复现已受理 operation 重放时的投影失败。
          await accountDb.raw(`
            CREATE TRIGGER r27_fail_replay_projection
            BEFORE INSERT ON o_dreaminaCliDispatch
            BEGIN SELECT RAISE(ABORT, 'round27 injected replay projection failure with secret prompt'); END
          `);
          const body = { ...(await buildConfirmedBody()), clientOperationId };
          const first = await postJson(url, body);
          assert.equal(first.status, 202, JSON.stringify(first.body));
          assert.equal(first.body?.code, "DREAMINA_ENQUEUE_RECOVERING");
          assert.equal(first.body?.data?.clientOperationId, clientOperationId);
          assert.doesNotMatch(
            JSON.stringify(first.body),
            /insert into|sqlite|round27 injected|secret prompt|夜色|parametersJson/i,
          );

          const beforeReplay = await runWithProjectStorage(PROJECT_UUID, async () => ({
            operations: Number((await activeDb("o_storyboardGenerationOperation")
              .count<{ total: number }>("clientOperationId as total").first())?.total ?? 0),
            tasks: Number((await activeDb("o_storyboardGenerationTask")
              .count<{ total: number }>("taskUuid as total").first())?.total ?? 0),
          }));
          const beforeDispatch = Number((await accountDb("o_dreaminaCliDispatch")
            .count<{ total: number }>("taskUuid as total").first())?.total ?? 0);

          // 中文注释：模拟首次 202 响应丢失；同一请求再次到达时，禁止退化为通用错误或新建收费任务。
          const replay = await postJson(url, body);
          assert.equal(replay.status, 202, JSON.stringify(replay.body));
          assert.equal(replay.body?.code, "DREAMINA_ENQUEUE_RECOVERING");
          assert.equal(replay.body?.data?.clientOperationId, clientOperationId);
          assert.deepEqual(replay.body?.data?.tasks, first.body?.data?.tasks);
          assert.deepEqual(responseTaskUuids(replay.body), responseTaskUuids(first.body));
          assert.doesNotMatch(
            JSON.stringify(replay.body),
            /insert into|sqlite|round27 injected|secret prompt|夜色|parametersJson/i,
          );

          const afterReplay = await runWithProjectStorage(PROJECT_UUID, async () => ({
            operations: Number((await activeDb("o_storyboardGenerationOperation")
              .count<{ total: number }>("clientOperationId as total").first())?.total ?? 0),
            tasks: Number((await activeDb("o_storyboardGenerationTask")
              .count<{ total: number }>("taskUuid as total").first())?.total ?? 0),
          }));
          const afterDispatch = Number((await accountDb("o_dreaminaCliDispatch")
            .count<{ total: number }>("taskUuid as total").first())?.total ?? 0);
          assert.deepEqual(beforeReplay, { operations: 1, tasks: 1 });
          assert.deepEqual(afterReplay, beforeReplay);
          assert.equal(beforeDispatch, 0);
          assert.equal(afterDispatch, beforeDispatch);
        } finally {
          await accountDb.raw("DROP TRIGGER IF EXISTS r27_fail_replay_projection");
          await cleanQueue();
        }
      });

      await t.test("preparing 操作遇到既有投影身份冲突必须 409", async () => {
        const clientOperationId = "34343434-3434-4434-a434-343434343434";
        try {
          await accountDb.raw(`
            CREATE TRIGGER r27_fail_preparing_identity_projection
            BEFORE INSERT ON o_dreaminaCliDispatch
            BEGIN SELECT RAISE(ABORT, 'round27 injected preparing projection failure'); END
          `);
          const body = { ...(await buildConfirmedBody()), clientOperationId };
          const accepted = await postJson(url, body);
          assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
          const [taskUuid] = responseTaskUuids(accepted.body);
          const projectTask = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
          assert.ok(projectTask, "首次 202 后必须保留 preparing operation 的原任务");

          await accountDb.raw("DROP TRIGGER r27_fail_preparing_identity_projection");
          await insertDreaminaDispatch({
            taskUuid,
            projectUuid: PROJECT_UUID,
            originDeviceUuid: String(projectTask.originDeviceUuid),
            mediaType: projectTask.mediaType === "video" ? "video" : "image",
            modelName: String(projectTask.modelName),
            mode: String(projectTask.mode),
            projectConcurrencyLimit: Number(projectTask.projectConcurrencyLimit),
            modelConcurrencyLimit: Number(projectTask.modelConcurrencyLimit),
            createdAt: Number(projectTask.createdAt),
            clientOperationId,
            operationItemIndex: Number(projectTask.operationItemIndex),
            dispatchReady: false,
          });
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
            modelName: "dreamina-cli:seedance2.0mini",
          });

          const before = await counts();
          const conflict = await postJson(url, body);
          assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
          assert.equal(conflict.body?.code, "DREAMINA_CLIENT_OPERATION_CONFLICT");
          assert.doesNotMatch(JSON.stringify(conflict.body), /insert into|sqlite|parametersJson|夜色/i);
          assert.deepEqual(await counts(), before);
        } finally {
          await accountDb.raw("DROP TRIGGER IF EXISTS r27_fail_preparing_identity_projection");
          await cleanQueue();
        }
      });

      await t.test("两项账号投影未 ready 时整批不可领取，启动恢复后仍返回原有序集合", async () => {
        const clientOperationId = "46464646-4646-4646-a646-464646464646";
        try {
          await accountDb.raw(`
            CREATE TRIGGER r27_fail_dispatch_ready
            BEFORE UPDATE OF dispatchReady ON o_dreaminaCliDispatch
            WHEN NEW.dispatchReady = 1
            BEGIN SELECT RAISE(ABORT, 'round27 injected ready failure'); END
          `);
          const items = await buildConfirmedBatch();
          const body = { items, paidBatchConfirmed: true, clientOperationId };
          const failed = await postJson(url, body);
          assert.equal(failed.status, 202, JSON.stringify(failed.body));
          assert.equal(failed.body?.code, "DREAMINA_ENQUEUE_RECOVERING");
          const originalRows = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask")
              .orderBy("operationItemIndex")
              .select("taskUuid", "operationItemIndex", "enqueueReady"));
          assert.equal(failed.body?.data?.clientOperationId, clientOperationId);
          assert.deepEqual(responseTaskUuids(failed.body), originalRows.map((row) => String(row.taskUuid)));
          const preparedDispatch = await accountDb("o_dreaminaCliDispatch")
            .orderBy("operationItemIndex")
            .select("taskUuid", "operationItemIndex", "dispatchReady", "originDeviceUuid");
          assert.equal(originalRows.length, 2);
          assert.deepEqual(preparedDispatch.map((row) => Number(row.dispatchReady)), [0, 0]);
          const claimedBeforeReady = await claimNextDreaminaDispatch({
            currentDeviceUuid: String(preparedDispatch[0]?.originDeviceUuid ?? ""),
            accountLimit: 8,
            leaseOwner: "round27-ready-check",
          });
          assert.equal(claimedBeforeReady, null, "未 ready 的半批次不得被领取");

          await accountDb.raw("DROP TRIGGER r27_fail_dispatch_ready");
          await recoverDreaminaSlots();
          const recovered = await accountDb("o_dreaminaCliDispatch")
            .orderBy("operationItemIndex")
            .select("taskUuid", "dispatchReady", "originDeviceUuid");
          assert.deepEqual(recovered.map((row) => Number(row.dispatchReady)), [1, 1]);
          const retry = await postJson(url, body);
          assert.equal(retry.status, 200, JSON.stringify(retry.body));
          assert.deepEqual(responseTaskUuids(retry.body), originalRows.map((row) => String(row.taskUuid)));
          assert.deepEqual(await counts(), { project: 2, dispatch: 2 });
        } finally {
          await accountDb.raw("DROP TRIGGER IF EXISTS r27_fail_dispatch_ready");
          await cleanQueue();
        }
      });

      await t.test("同一操作的账号投影身份被篡改时必须 409，禁止覆盖或重复入队", async () => {
        const clientOperationId = "49494949-4949-4949-a949-494949494949";
        try {
          const body = { ...(await buildConfirmedBody()), clientOperationId };
          const first = await postJson(url, body);
          assert.equal(first.status, 200, JSON.stringify(first.body));
          const taskUuid = responseTaskUuids(first.body)[0]!;
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
            modelName: "dreamina-cli:seedance2.0mini",
          });
          const conflict = await postJson(url, body);
          assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
          assert.equal(conflict.body?.code, "DREAMINA_CLIENT_OPERATION_CONFLICT");
          assert.deepEqual(await counts(), { project: 1, dispatch: 1 });
        } finally {
          await cleanQueue();
        }
      });

      await t.test("ready 批次只丢一个账号投影时必须补齐原集合，不能永久卡在恢复中", async () => {
        const clientOperationId = "51515151-5151-4151-a151-515151515151";
        try {
          const items = await buildConfirmedBatch();
          const body = { items, paidBatchConfirmed: true, clientOperationId };
          const first = await postJson(url, body);
          assert.equal(first.status, 200, JSON.stringify(first.body));
          const expected = responseTaskUuids(first.body);
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid: expected[1] }).delete();
          await recoverDreaminaSlots();
          const recovered = await accountDb("o_dreaminaCliDispatch")
            .where({ projectUuid: PROJECT_UUID, clientOperationId })
            .orderBy("operationItemIndex")
            .select("taskUuid", "dispatchReady");
          assert.deepEqual(recovered.map((row) => String(row.taskUuid)), expected);
          assert.deepEqual(recovered.map((row) => Number(row.dispatchReady)), [1, 1]);
        } finally {
          await cleanQueue();
        }
      });

      await t.test("调度刷新账号投影并发上限后同 ID 重试仍必须返回原任务", async () => {
        const clientOperationId = "52525252-5252-4252-a252-525252525252";
        try {
          const body = { ...(await buildConfirmedBody()), clientOperationId };
          const first = await postJson(url, body);
          assert.equal(first.status, 200, JSON.stringify(first.body));
          const taskUuid = responseTaskUuids(first.body)[0]!;
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
            projectConcurrencyLimit: 99,
          });
          const retry = await postJson(url, body);
          assert.equal(retry.status, 200, JSON.stringify(retry.body));
          assert.deepEqual(responseTaskUuids(retry.body), [taskUuid]);
        } finally {
          await cleanQueue();
        }
      });

      await t.test("付费任务重试必须按客户端操作 ID 幂等，且父任务变化必须 409", async () => {
        const retryOperationId = "55555555-5555-4555-a555-555555555555";
        try {
          const parentBody = {
            ...(await buildConfirmedBody()),
            clientOperationId: "56565656-5656-4656-a656-565656565656",
          };
          const parentResponse = await postJson(url, parentBody);
          assert.equal(parentResponse.status, 200, JSON.stringify(parentResponse.body));
          const parentTaskUuid = responseTaskUuids(parentResponse.body)[0]!;
          await markRetryableParent(parentTaskUuid);

          const retryUrl = `http://127.0.0.1:${listening.port}/api/task/dreaminaQueue/retry`;
          const retryBody = { taskUuid: parentTaskUuid, clientOperationId: retryOperationId };
          // 中文注释：模拟首次成功响应丢失；网络层必须原样重放同一个操作 ID。
          const first = await postJson(retryUrl, retryBody);
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid: parentTaskUuid }).update({ status: "completed" }));
          const replay = await postJson(retryUrl, retryBody);
          assert.equal(first.status, 200, JSON.stringify(first.body));
          assert.equal(replay.status, 200, JSON.stringify(replay.body));
          assert.deepEqual(responseTaskUuids(replay.body), responseTaskUuids(first.body));

          const otherParentBody = {
            ...(await buildConfirmedBody(10_000)),
            clientOperationId: "57575757-5757-4757-a757-575757575757",
          };
          const otherParent = await postJson(url, otherParentBody);
          assert.equal(otherParent.status, 200, JSON.stringify(otherParent.body));
          const otherParentTaskUuid = responseTaskUuids(otherParent.body)[0]!;
          await markRetryableParent(otherParentTaskUuid);
          const conflict = await postJson(retryUrl, {
            taskUuid: otherParentTaskUuid,
            clientOperationId: retryOperationId,
          });
          assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
        } finally {
          await cleanQueue();
        }
      });

      await t.test("重试任务项目库提交后账号投影失败必须 202，并以前滚恢复复用原子任务", async () => {
        const retryOperationId = "58585858-5858-4858-a858-585858585858";
        try {
          const parentResponse = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: "59595959-5959-4959-a959-595959595959",
          });
          assert.equal(parentResponse.status, 200, JSON.stringify(parentResponse.body));
          const parentTaskUuid = responseTaskUuids(parentResponse.body)[0]!;
          await markRetryableParent(parentTaskUuid);
          await accountDb.raw(`
            CREATE TRIGGER r27_fail_retry_projection
            BEFORE INSERT ON o_dreaminaCliDispatch
            WHEN NEW.taskUuid <> '${parentTaskUuid}'
            BEGIN SELECT RAISE(ABORT, 'round27 retry projection failure'); END
          `);
          const retryUrl = `http://127.0.0.1:${listening.port}/api/task/dreaminaQueue/retry`;
          const accepted = await postJson(retryUrl, {
            taskUuid: parentTaskUuid,
            clientOperationId: retryOperationId,
          });
          assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
          const acceptedTaskUuid = responseTaskUuids(accepted.body)[0]!;
          assert.ok(acceptedTaskUuid);
          const durableChild = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ parentTaskUuid }).whereNot({ taskUuid: parentTaskUuid }).first());
          assert.equal(String(durableChild?.taskUuid ?? ""), acceptedTaskUuid);

          await accountDb.raw("DROP TRIGGER r27_fail_retry_projection");
          await recoverDreaminaSlots();
          const replay = await postJson(retryUrl, {
            taskUuid: parentTaskUuid,
            clientOperationId: retryOperationId,
          });
          assert.equal(replay.status, 200, JSON.stringify(replay.body));
          assert.deepEqual(responseTaskUuids(replay.body), [acceptedTaskUuid]);
        } finally {
          await accountDb.raw("DROP TRIGGER IF EXISTS r27_fail_retry_projection");
          await cleanQueue();
        }
      });

      await t.test("旧版 submitting 任务即使缺 submitId 也必须恢复为 unknown 占槽而非重新收费", async () => {
        try {
          const created = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: "62626262-6262-4262-a262-626262626262",
          });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          const taskUuid = responseTaskUuids(created.body)[0]!;
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).delete();
          await runWithProjectStorage(PROJECT_UUID, async () => {
            // 中文注释：模拟旧版本在真实 submit 已开始、但 submitId 尚未落盘时崩溃的存量记录。
            await activeDb("o_storyboardGenerationTask").where({ taskUuid }).update({
              clientOperationId: null,
              operationItemIndex: null,
              status: "submitting",
              providerTaskId: null,
            });
            await activeDb("o_storyboardGenerationOperation")
              .where({ clientOperationId: "62626262-6262-4262-a262-626262626262" })
              .delete();
          });
          await recoverDreaminaSlots();
          const restored = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          assert.deepEqual({
            queueState: restored?.queueState,
            providerState: restored?.providerState,
            slotHeld: Number(restored?.slotHeld ?? -1),
          }, {
            queueState: "provider_active",
            providerState: "unknown",
            slotHeld: 1,
          });
        } finally {
          await cleanQueue();
        }
      });

      await t.test("启动恢复只统计本轮真实修改，不得把历史 ready operation 重复计数", async () => {
        try {
          const created = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: "63636363-6363-4363-a363-636363636363",
          });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          const taskUuid = responseTaskUuids(created.body)[0]!;
          const untouched = await recoverDreaminaSlots();
          assert.equal(untouched.recovered, 0);

          await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({ dispatchReady: 0 });
          const repaired = await recoverDreaminaSlots();
          assert.equal(repaired.recovered, 1);
          const repeated = await recoverDreaminaSlots();
          assert.equal(repeated.recovered, 0);
        } finally {
          await cleanQueue();
        }
      });

      await t.test("启动恢复不得把全部历史任务和账号投影逐行物化到 Node", async () => {
        const projectQueries: string[] = [];
        const accountQueries: string[] = [];
        const originalWarn = console.warn;
        const collectProject = (query: { sql?: string }) => projectQueries.push(String(query.sql ?? ""));
        const collectAccount = (query: { sql?: string }) => accountQueries.push(String(query.sql ?? ""));
        try {
          const created = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: "67676767-6767-4767-a767-676767676767",
          });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          const origin = await accountDb("o_dreaminaCliDispatch").first("originDeviceUuid");
          const now = Date.now();
          // 中文注释：候选数故意跨过单页；最后一页也必须被扫描隔离，不能只加 LIMIT 后饿死。
          await accountDb("o_dreaminaCliDispatch").insert(Array.from({ length: 140 }, (_, index) => ({
            taskUuid: crypto.randomUUID(),
            projectUuid: PROJECT_UUID,
            originDeviceUuid: String(origin?.originDeviceUuid ?? ""),
            mediaType: "video",
            providerId: "dreamina-cli",
            modelName: "dreamina-cli:seedance2.0fast",
            mode: index === 139 ? "forged-last-page" : "text2video",
            projectConcurrencyLimit: 1,
            modelConcurrencyLimit: 1,
            queueState: "queued",
            providerState: "not_sent",
            slotHeld: 0,
            notificationsMuted: 0,
            clientOperationId: crypto.randomUUID(),
            operationItemIndex: 0,
            dispatchReady: 1,
            createdAt: now + index,
            updatedAt: now + index,
          })));
          await runWithProjectStorage(PROJECT_UUID, () => activeDb.on("query", collectProject));
          accountDb.on("query", collectAccount);
          console.warn = () => undefined;
          await recoverDreaminaSlots();
          const remainingFakeReady = await accountDb("o_dreaminaCliDispatch")
            .where({ projectUuid: PROJECT_UUID, dispatchReady: 1 })
            .whereNot({ clientOperationId: "67676767-6767-4767-a767-676767676767" })
            .count({ count: "taskUuid" })
            .first();
          assert.equal(Number(remainingFakeReady?.count ?? 0), 0);
        } finally {
          console.warn = originalWarn;
          await runWithProjectStorage(PROJECT_UUID, () => activeDb.off("query", collectProject));
          accountDb.off("query", collectAccount);
          await cleanQueue();
        }
        const projectFullRows = projectQueries.filter((sql) =>
          /select [`"]taskUuid[`"].*o_storyboardGenerationTask/i.test(sql)
          && /clientOperationId[`"]? is not null/i.test(sql));
        const accountFullRows = accountQueries.filter((sql) =>
          /select [`"]taskUuid[`"].*o_dreaminaCliDispatch/i.test(sql)
          && /clientOperationId[`"]? is not null/i.test(sql));
        // 中文注释：恢复可读取“待领取候选”的有界明细，但禁止物化全部历史 operation 任务。
        assert.equal(projectFullRows.every((sql) => /where [`"]taskUuid[`"] in/i.test(sql)), true,
          JSON.stringify(projectFullRows));
        assert.equal(accountFullRows.every((sql) =>
          /queueState/i.test(sql) && /providerState/i.test(sql) && /dispatchReady/i.test(sql) && /limit/i.test(sql)), true,
        JSON.stringify(accountFullRows));
        assert.ok(accountFullRows.length >= 2, `必须跨页扫描，实际查询=${JSON.stringify(accountFullRows)}`);
      });

      await t.test("启动恢复必须隔离身份漂移的待收费账号投影，禁止调度领取", async () => {
        try {
          const created = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: "69696969-6969-4969-a969-696969696969",
          });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          const taskUuid = responseTaskUuids(created.body)[0]!;
          const before = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({ mode: "forged-mode" });
          // 中文注释：即使恢复扫描尚未运行，账号库本地身份摘要也必须在领取事务中阻断收费。
          const racedClaim = await claimNextDreaminaDispatch({
            currentDeviceUuid: String(before?.originDeviceUuid ?? ""),
            accountLimit: 1,
            leaseOwner: "round27-quarantine-race",
          });
          assert.equal(racedClaim, null);
          const raceBlocked = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          assert.equal(String(raceBlocked?.queueState), "queued");
          assert.equal(Number(raceBlocked?.slotHeld), 0);
          assert.equal(Number(raceBlocked?.dispatchReady), 0);
          await recoverDreaminaSlots();
          const quarantined = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          assert.equal(Number(quarantined?.dispatchReady), 0);
          const claimed = await claimNextDreaminaDispatch({
            currentDeviceUuid: String(before?.originDeviceUuid ?? ""),
            accountLimit: 1,
            leaseOwner: "round27-quarantine",
          });
          assert.equal(claimed, null);
        } finally {
          await cleanQueue();
        }
      });

      await t.test("恢复安全查询异常时账号激活不得唤醒领取或提交", async () => {
        const logFile = path.join(root, "recovery-fail-submit.log");
        const previousInterval = process.env.DREAMINA_SCHEDULER_INTERVAL_MS;
        const previousScenario = process.env.DREAMINA_FAKE_SCENARIO;
        const previousLog = process.env.DREAMINA_FAKE_LOG;
        let renamed = false;
        try {
          const created = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: "73737373-7373-4373-a373-737373737373",
          });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          const taskUuid = responseTaskUuids(created.body)[0]!;
          await accountDb("o_dreaminaCliSettings").where({ id: 1 }).update({
            executablePath: FAKE_CLI,
            pauseNewClaims: 0,
          });
          process.env.DREAMINA_SCHEDULER_INTERVAL_MS = "20";
          process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
          process.env.DREAMINA_FAKE_LOG = logFile;
          await runWithProjectStorage(PROJECT_UUID, async () => {
            await activeDb.schema.renameTable("o_storyboardGenerationTask", "o_storyboardGenerationTask_hidden");
            renamed = true;
          });
          // 中文注释：账号激活会捕获恢复错误；此后仍禁止 wake/tick 把未完成安全扫描的任务领走。
          await activateUserDatabase(IDENTITY);
          await new Promise((resolve) => setTimeout(resolve, 180));
          const row = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          assert.equal(String(row?.queueState), "queued");
          assert.equal(Number(row?.slotHeld), 0);
          const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
          assert.equal(log.trim(), "", `恢复失败后不得调用CLI，实际=${log}`);
        } finally {
          stopDreaminaSchedulerLoop();
          if (renamed) {
            await runWithProjectStorage(PROJECT_UUID, () =>
              activeDb.schema.renameTable("o_storyboardGenerationTask_hidden", "o_storyboardGenerationTask"));
          }
          if (previousInterval === undefined) delete process.env.DREAMINA_SCHEDULER_INTERVAL_MS;
          else process.env.DREAMINA_SCHEDULER_INTERVAL_MS = previousInterval;
          if (previousScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
          else process.env.DREAMINA_FAKE_SCENARIO = previousScenario;
          if (previousLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
          else process.env.DREAMINA_FAKE_LOG = previousLog;
          await accountDb("o_dreaminaCliSettings").where({ id: 1 }).update({ pauseNewClaims: 1 });
          await cleanQueue();
        }
      });

      await t.test("账号摘要合法但项目任务漂移时调度预检必须隔离且零 CLI", async () => {
        const logFile = path.join(root, "project-drift-submit.log");
        const previousScenario = process.env.DREAMINA_FAKE_SCENARIO;
        const previousLog = process.env.DREAMINA_FAKE_LOG;
        try {
          const created = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: "74747474-7474-4474-a474-747474747474",
          });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          const taskUuid = responseTaskUuids(created.body)[0]!;
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).update({ mode: "forged-project-mode" }));
          process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
          process.env.DREAMINA_FAKE_LOG = logFile;
          await accountDb("o_dreaminaCliSettings").where({ id: 1 }).update({
            executablePath: FAKE_CLI,
            pauseNewClaims: 0,
          });
          await tickDreaminaScheduler();
          const row = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
          assert.equal(log.trim(), "", `项目身份漂移不得调用CLI，实际=${log}`);
          assert.equal(Number(row?.dispatchReady), 0);
          assert.equal(Number(row?.slotHeld), 0);
        } finally {
          if (previousScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
          else process.env.DREAMINA_FAKE_SCENARIO = previousScenario;
          if (previousLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
          else process.env.DREAMINA_FAKE_LOG = previousLog;
          await accountDb("o_dreaminaCliSettings").where({ id: 1 }).update({ pauseNewClaims: 1 });
          await cleanQueue();
        }
      });

      await t.test("领取后账号 projectUuid 漂移时 submit 前复验必须隔离且零 CLI", async () => {
        const logFile = path.join(root, "claimed-project-drift-submit.log");
        const previousScenario = process.env.DREAMINA_FAKE_SCENARIO;
        const previousLog = process.env.DREAMINA_FAKE_LOG;
        let triggerCreated = false;
        try {
          const created = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: "77777777-7777-4777-a777-777777777777",
          });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          const taskUuid = responseTaskUuids(created.body)[0]!;
          await accountDb.raw(`
            CREATE TRIGGER r27_drift_project_after_claim
            AFTER UPDATE OF queueState ON o_dreaminaCliDispatch
            WHEN NEW.taskUuid = '${taskUuid}' AND NEW.queueState = 'claiming'
            BEGIN
              UPDATE o_dreaminaCliDispatch
              SET projectUuid = '${OTHER_PROJECT_UUID}'
              WHERE taskUuid = '${taskUuid}';
            END
          `);
          triggerCreated = true;
          process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
          process.env.DREAMINA_FAKE_LOG = logFile;
          await accountDb("o_dreaminaCliSettings").where({ id: 1 }).update({
            executablePath: FAKE_CLI,
            pauseNewClaims: 0,
          });
          await tickDreaminaScheduler();
          const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
          const row = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          assert.equal(log.trim(), "", `projectUuid 漂移不得调用CLI，实际=${log}`);
          assert.equal(Number(row?.dispatchReady), 0);
          assert.equal(Number(row?.slotHeld), 0);
        } finally {
          if (triggerCreated) await accountDb.raw("DROP TRIGGER IF EXISTS r27_drift_project_after_claim");
          if (previousScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
          else process.env.DREAMINA_FAKE_SCENARIO = previousScenario;
          if (previousLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
          else process.env.DREAMINA_FAKE_LOG = previousLog;
          await accountDb("o_dreaminaCliSettings").where({ id: 1 }).update({ pauseNewClaims: 1 });
          await cleanQueue();
        }
      });

      await t.test("活跃领取被恢复重排队后旧执行流不得与新 lease 双重调用 CLI", async () => {
        const logFile = path.join(root, "claim-token-race-submit.log");
        const previousScenario = process.env.DREAMINA_FAKE_SCENARIO;
        const previousDelay = process.env.DREAMINA_FAKE_DELAY_MS;
        const previousLog = process.env.DREAMINA_FAKE_LOG;
        let triggerCreated = false;
        try {
          const created = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: "78787878-7878-4878-a878-787878787878",
          });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          const taskUuid = responseTaskUuids(created.body)[0]!;
          // 中文注释：精确模拟恢复线程在 submitStarted 前把活跃领取重排队，第二个 tick 会获得新 lease。
          await accountDb.raw(`
            CREATE TRIGGER r27_requeue_active_claim
            AFTER UPDATE OF queueState ON o_dreaminaCliDispatch
            WHEN NEW.taskUuid = '${taskUuid}'
              AND NEW.queueState = 'claiming'
              AND instr(COALESCE(OLD.providerResultJson, ''), 'redRequeued') = 0
            BEGIN
              UPDATE o_dreaminaCliDispatch
              SET queueState = 'queued', slotHeld = 0, leaseOwner = NULL,
                  providerResultJson = '{"redRequeued":true}'
              WHERE taskUuid = '${taskUuid}';
            END
          `);
          triggerCreated = true;
          process.env.DREAMINA_FAKE_SCENARIO = "delay_submit";
          process.env.DREAMINA_FAKE_DELAY_MS = "120";
          process.env.DREAMINA_FAKE_LOG = logFile;
          await accountDb("o_dreaminaCliSettings").where({ id: 1 }).update({
            executablePath: FAKE_CLI,
            maxConcurrency: 2,
            pauseNewClaims: 0,
          });
          const oldLeaseWork = tickDreaminaScheduler();
          const replacementLeaseWork = tickDreaminaScheduler();
          let replacementSettled = false;
          void replacementLeaseWork.finally(() => {
            replacementSettled = true;
          });
          await oldLeaseWork;
          // 中文注释：旧 lease 退出后，关闭门仍必须能看见并等待正在真实 submit 的 replacement lease。
          await drainDreaminaSubmitCriticalSection();
          assert.equal(replacementSettled, true, "退出门不得因旧 lease 的 finally 误删新提交 Promise");
          await replacementLeaseWork;
          const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
          const submits = log.split(/\r?\n/).filter((line) => /text2video|image2video|frames2video|text2image|image2image/.test(line));
          assert.equal(submits.length, 1, `同一任务只能调用一次CLI，实际=${log}`);
        } finally {
          stopDreaminaSchedulerLoop();
          if (triggerCreated) await accountDb.raw("DROP TRIGGER IF EXISTS r27_requeue_active_claim");
          if (previousScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
          else process.env.DREAMINA_FAKE_SCENARIO = previousScenario;
          if (previousDelay === undefined) delete process.env.DREAMINA_FAKE_DELAY_MS;
          else process.env.DREAMINA_FAKE_DELAY_MS = previousDelay;
          if (previousLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
          else process.env.DREAMINA_FAKE_LOG = previousLog;
          await accountDb("o_dreaminaCliSettings").where({ id: 1 }).update({ pauseNewClaims: 1 });
          await cleanQueue();
        }
      });

      await t.test("恢复旧快照不得覆盖刚写入 submitStarted 的同一 lease", async () => {
        const leaseOwner = "round27-stale-recovery-lease";
        let listenerInstalled = false;
        let injected = false;
        const knex = accountDatabase() as typeof accountDb & {
          client: { config: { connection: { filename: string } } };
          on: (event: string, listener: (response: unknown, query: { sql?: string }) => void) => void;
          off: (event: string, listener: (response: unknown, query: { sql?: string }) => void) => void;
        };
        let taskUuid = "";
        const injectSubmitFence = (response: unknown, query: { sql?: string }) => {
          if (injected || !taskUuid || !String(query?.sql ?? "").includes("slotHeld")) return;
          if (!Array.isArray(response) || !response.some((row: any) => String(row?.taskUuid) === taskUuid)) return;
          // 中文注释：在恢复读完旧 marker、执行 UPDATE 之前，用独立连接模拟旧 worker 的 token CAS 胜出。
          const sqlite = new Database(String(knex.client.config.connection.filename));
          try {
            sqlite.prepare(`
              UPDATE o_dreaminaCliDispatch
              SET providerResultJson = ?, updatedAt = ?
              WHERE taskUuid = ? AND queueState = 'claiming' AND providerState = 'not_sent'
                AND slotHeld = 1 AND leaseOwner = ?
            `).run(JSON.stringify({ submitStarted: true }), Date.now(), taskUuid, leaseOwner);
            injected = true;
          } finally {
            sqlite.close();
          }
        };
        try {
          const created = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: "79797979-7979-4979-a979-797979797979",
          });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          taskUuid = responseTaskUuids(created.body)[0]!;
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
            queueState: "claiming",
            providerState: "not_sent",
            slotHeld: 1,
            leaseOwner,
            leaseExpiresAt: Date.now() + 30_000,
            providerResultJson: JSON.stringify({}),
          });
          knex.on("query-response", injectSubmitFence);
          listenerInstalled = true;
          await recoverDreaminaSlots();
          const row = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          assert.equal(injected, true, "必须命中恢复读取后的并发 submit fence");
          assert.equal(String(row?.queueState), "claiming");
          assert.equal(Number(row?.slotHeld), 1);
          assert.equal(String(row?.leaseOwner), leaseOwner);
          assert.equal(JSON.parse(String(row?.providerResultJson ?? "{}")).submitStarted, true);
        } finally {
          if (listenerInstalled) knex.off("query-response", injectSubmitFence);
          await cleanQueue();
        }
      });

      await t.test("旧 lease 的预检失败不得覆盖新 lease 的 submit fence", async () => {
        const replacementLease = "round27-replacement-lease";
        const logFile = path.join(root, "stale-preflight-submit.log");
        const previousLog = process.env.DREAMINA_FAKE_LOG;
        let listenerInstalled = false;
        let replaced = false;
        let taskUuid = "";
        const accountKnex = accountDatabase();
        const accountFilename = String((accountKnex.client.config.connection as { filename: string }).filename);
        const replaceLeaseAfterTaskRead = (response: unknown, query: { sql?: string; bindings?: unknown[] }) => {
          if (replaced || !taskUuid || !String(query?.sql ?? "").includes("o_storyboardGenerationTask")) return;
          if (!Array.isArray(query?.bindings) || !query.bindings.some((value) => String(value) === taskUuid)) return;
          if (!response || String((response as any).taskUuid ?? "") !== taskUuid) return;
          // 中文注释：旧 worker 已读完身份后，让恢复/新 tick 赢得新 lease 并先写 submitStarted。
          const sqlite = new Database(accountFilename);
          try {
            sqlite.prepare(`
              UPDATE o_dreaminaCliDispatch
              SET queueState = 'claiming', providerState = 'not_sent', slotHeld = 1,
                  leaseOwner = ?, providerResultJson = ?, updatedAt = ?
              WHERE taskUuid = ?
            `).run(replacementLease, JSON.stringify({ submitStarted: true }), Date.now(), taskUuid);
            replaced = true;
          } finally {
            sqlite.close();
          }
        };
        try {
          const created = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: "80808080-8080-4080-a080-808080808080",
          });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          taskUuid = responseTaskUuids(created.body)[0]!;
          await runWithProjectStorage(PROJECT_UUID, async () => {
            const row = await activeDb("o_storyboardGenerationTask").where({ taskUuid }).first();
            const parameters = JSON.parse(String(row?.parametersJson ?? "{}"));
            parameters.capabilityFields = ["invalid-field"];
            await activeDb("o_storyboardGenerationTask").where({ taskUuid }).update({
              parametersJson: JSON.stringify(parameters),
            });
            (activeDb as any).on("query-response", replaceLeaseAfterTaskRead);
            listenerInstalled = true;
          });
          process.env.DREAMINA_FAKE_LOG = logFile;
          await accountDb("o_dreaminaCliSettings").where({ id: 1 }).update({
            executablePath: FAKE_CLI,
            pauseNewClaims: 0,
          });
          await tickDreaminaScheduler();
          const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          const projectTask = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
          const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
          assert.equal(replaced, true, "必须在旧 worker 预检失败前换入新 lease");
          assert.equal(String(dispatch?.queueState), "claiming");
          assert.equal(String(dispatch?.providerState), "not_sent");
          assert.equal(Number(dispatch?.slotHeld), 1);
          assert.equal(String(dispatch?.leaseOwner), replacementLease);
          assert.equal(JSON.parse(String(dispatch?.providerResultJson ?? "{}")).submitStarted, true);
          assert.equal(String(projectTask?.status), "queued");
          assert.equal(log.trim(), "", `旧 lease 预检失败不得调用CLI，实际=${log}`);
        } finally {
          if (listenerInstalled) {
            await runWithProjectStorage(PROJECT_UUID, () =>
              (activeDb as any).off("query-response", replaceLeaseAfterTaskRead));
          }
          stopDreaminaSchedulerLoop();
          if (previousLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
          else process.env.DREAMINA_FAKE_LOG = previousLog;
          await accountDb("o_dreaminaCliSettings").where({ id: 1 }).update({ pauseNewClaims: 1 });
          await cleanQueue();
        }
      });

      await t.test("取消账号提交后项目镜像失败必须由启动恢复前滚 cancelled_local", async () => {
        let triggerCreated = false;
        try {
          const created = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: "70707070-7070-4070-a070-707070707070",
          });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          const taskUuid = responseTaskUuids(created.body)[0]!;
          await runWithProjectStorage(PROJECT_UUID, async () => {
            await activeDb.raw(`
              CREATE TRIGGER r27_fail_cancel_mirror
              BEFORE UPDATE OF status ON o_storyboardGenerationTask
              WHEN NEW.status = 'cancelled_local'
              BEGIN SELECT RAISE(ABORT, 'round27 cancel mirror failure'); END
            `);
            triggerCreated = true;
          });
          const cancelled = await postJson(
            `http://127.0.0.1:${listening.port}/api/task/dreaminaQueue/cancelQueued`,
            { taskUuid },
          );
          assert.notEqual(cancelled.status, 200, JSON.stringify(cancelled.body));
          const pending = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          assert.equal(JSON.parse(String(pending?.providerResultJson ?? "{}")).localCancelPending, true);
          await runWithProjectStorage(PROJECT_UUID, async () => {
            await activeDb.raw("DROP TRIGGER r27_fail_cancel_mirror");
            triggerCreated = false;
          });
          await recoverDreaminaSlots();
          const projectTask = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
          const settled = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          assert.equal(String(projectTask?.status), "cancelled_local");
          assert.notEqual(JSON.parse(String(settled?.providerResultJson ?? "{}")).localCancelPending, true);
        } finally {
          if (triggerCreated) {
            await runWithProjectStorage(PROJECT_UUID, () =>
              activeDb.raw("DROP TRIGGER IF EXISTS r27_fail_cancel_mirror"));
          }
          await cleanQueue();
        }
      });

      await t.test("取消项目任务缺失时不得假成功或清除耐久镜像标记", async () => {
        try {
          const created = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: "71717171-7171-4171-a171-717171717171",
          });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          const taskUuid = responseTaskUuids(created.body)[0]!;
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).delete());
          const cancelled = await postJson(
            `http://127.0.0.1:${listening.port}/api/task/dreaminaQueue/cancelQueued`,
            { taskUuid },
          );
          assert.notEqual(cancelled.status, 200, JSON.stringify(cancelled.body));
          const pending = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          assert.equal(JSON.parse(String(pending?.providerResultJson ?? "{}")).localCancelPending, true);
        } finally {
          await cleanQueue();
        }
      });

      await t.test("损坏的多项未确认 operation 与非 UUID 重放必须 fail-closed", async () => {
        try {
          const items = await buildConfirmedBatch();
          const clientOperationId = "72727272-7272-4272-a272-727272727272";
          const created = await postJson(url, { items, paidBatchConfirmed: true, clientOperationId });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          const digests = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask")
              .where({ clientOperationId })
              .orderBy("operationItemIndex")
              .pluck("requestDigest"));
          const forgedDigest = crypto.createHash("sha256").update(JSON.stringify({
            projectUuid: PROJECT_UUID,
            paidBatchConfirmed: false,
            itemDigests: digests.map(String),
          })).digest("hex");
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationOperation").where({ clientOperationId }).update({
              paidBatchConfirmed: 0,
              operationDigest: forgedDigest,
            }));
          await assert.rejects(
            resumeDreaminaEnqueueOperation({ projectUuid: PROJECT_UUID, clientOperationId }),
            /批次|确认|完整|损坏/,
          );
          await assert.rejects(
            replayAcceptedDreaminaEnqueue({
              projectUuid: PROJECT_UUID,
              clientOperationId: "not-a-uuid",
              requestIntentDigest: "a".repeat(64),
            }),
            /操作 ID|UUID|无效/,
          );
          await assert.rejects(
            resumeDreaminaEnqueueOperation({
              projectUuid: PROJECT_UUID,
              clientOperationId: "not-a-uuid",
            }),
            (error: any) => error?.code === "DREAMINA_CLIENT_OPERATION_ID_INVALID",
          );
        } finally {
          await cleanQueue();
        }
      });

      await t.test("超过 SQLite 安全批量上限必须在 HTTP 和服务层零持久拒绝", async () => {
        try {
          const oversizedItems = Array.from({ length: 257 }, () => ({
            shotUuid: shot.shotUuid,
            mediaType: "video",
            providerModel: "dreamina-cli:seedance2.0fast",
            mode: "text2video",
            durationMs: 9_000,
            aspectRatio: "9:16",
            expectedPreviewDigest: "a".repeat(64),
          }));
          const response = await postJson(url, {
            items: oversizedItems,
            paidBatchConfirmed: true,
            clientOperationId: "75757575-7575-4575-a575-757575757575",
          });
          assert.equal(response.status, 400, JSON.stringify(response.body));
          assert.equal(response.body?.code, "DREAMINA_BATCH_LIMIT_EXCEEDED");
          await assert.rejects(
            enqueueAsyncMediaTasks({
              projectUuid: PROJECT_UUID,
              clientOperationId: "76767676-7676-4676-a676-767676767676",
              paidBatchConfirmed: true,
              items: Array.from({ length: 257 }, () => ({
                shotUuid: shot.shotUuid,
                mediaType: "video" as const,
                providerModel: "dreamina-cli:seedance2.0fast",
                mode: "text2video",
              })),
            }),
            (error: any) => error?.code === "DREAMINA_BATCH_LIMIT_EXCEEDED",
          );
          assert.deepEqual(await counts(), { project: 0, dispatch: 0 });
        } finally {
          await cleanQueue();
        }
      });

      await t.test("重试入口的底层数据库异常不得把 SQL 或本机路径回显给客户端", async () => {
        let renamed = false;
        try {
          const created = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: "65656565-6565-4565-a565-656565656565",
          });
          assert.equal(created.status, 200, JSON.stringify(created.body));
          const taskUuid = responseTaskUuids(created.body)[0]!;
          await markRetryableParent(taskUuid);
          await runWithProjectStorage(PROJECT_UUID, async () => {
            await activeDb.schema.renameTable("o_storyboardGenerationTask", "o_storyboardGenerationTask_hidden");
            renamed = true;
          });
          const failed = await postJson(
            `http://127.0.0.1:${listening.port}/api/task/dreaminaQueue/retry`,
            { taskUuid, clientOperationId: "66666666-6666-4666-a666-666666666666" },
          );
          assert.equal(failed.status, 500, JSON.stringify(failed.body));
          assert.equal(failed.body?.message, "重试失败，请稍后再试");
          assert.doesNotMatch(JSON.stringify(failed.body), /select |sqlite|project\.sqlite|o_storyboardGenerationTask_hidden/i);
        } finally {
          if (renamed) {
            await runWithProjectStorage(PROJECT_UUID, async () => {
              await activeDb.schema.renameTable("o_storyboardGenerationTask_hidden", "o_storyboardGenerationTask");
            });
          }
          await cleanQueue();
        }
      });

      await t.test("dispatchReady=0 的恢复占位不得被取消或创建重试收费任务", async () => {
        const clientOperationId = "54545454-5454-4454-a454-545454545454";
        try {
          const body = { ...(await buildConfirmedBody()), clientOperationId };
          const first = await postJson(url, body);
          assert.equal(first.status, 200, JSON.stringify(first.body));
          const taskUuid = responseTaskUuids(first.body)[0]!;
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
            dispatchReady: 0,
            queueState: "queued",
            providerState: "not_sent",
          });
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).update({ status: "failed_retryable" }));
          const retry = await postJson(
            `http://127.0.0.1:${listening.port}/api/task/dreaminaQueue/retry`,
            { taskUuid },
          );
          const cancel = await postJson(
            `http://127.0.0.1:${listening.port}/api/task/dreaminaQueue/cancelQueued`,
            { taskUuid },
          );
          assert.equal(retry.status, 400, JSON.stringify(retry.body));
          assert.equal(cancel.status, 400, JSON.stringify(cancel.body));
          assert.deepEqual(await counts(), { project: 1, dispatch: 1 });
        } finally {
          await cleanQueue();
        }
      });

      await t.test("ready operation 缺投影时必须按 provider 状态恢复，禁止 submitted 任务重排队", async () => {
        try {
          const submittedOperationId = "47474747-4747-4747-a747-474747474747";
          const submitted = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: submittedOperationId,
          });
          assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
          const submittedTaskUuid = responseTaskUuids(submitted.body)[0]!;
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid: submittedTaskUuid }).update({
              status: "submitted",
              providerTaskId: "sub-round27-idempotent",
            }));
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid: submittedTaskUuid }).delete();
          await recoverDreaminaSlots();
          const restoredSubmitted = await accountDb("o_dreaminaCliDispatch")
            .where({ taskUuid: submittedTaskUuid })
            .first();
          const restoredResult = JSON.parse(String(restoredSubmitted?.providerResultJson ?? "{}"));
          assert.deepEqual({
            queueState: restoredSubmitted?.queueState,
            providerState: restoredSubmitted?.providerState,
            slotHeld: Number(restoredSubmitted?.slotHeld ?? -1),
            submitId: restoredResult.submitId,
          }, {
            queueState: "provider_active",
            providerState: "running",
            slotHeld: 1,
            submitId: "sub-round27-idempotent",
          });

          const ambiguousOperationId = "48484848-4848-4848-a848-484848484848";
          const ambiguous = await postJson(url, {
            ...(await buildConfirmedBody()),
            clientOperationId: ambiguousOperationId,
          });
          assert.equal(ambiguous.status, 200, JSON.stringify(ambiguous.body));
          const ambiguousTaskUuid = responseTaskUuids(ambiguous.body)[0]!;
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid: ambiguousTaskUuid }).update({
              status: "submitting",
              providerTaskId: null,
            }));
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid: ambiguousTaskUuid }).delete();
          await recoverDreaminaSlots();
          const restoredAmbiguous = await accountDb("o_dreaminaCliDispatch")
            .where({ taskUuid: ambiguousTaskUuid })
            .first();
          assert.deepEqual({
            queueState: restoredAmbiguous?.queueState,
            providerState: restoredAmbiguous?.providerState,
            slotHeld: Number(restoredAmbiguous?.slotHeld ?? -1),
          }, {
            queueState: "provider_active",
            providerState: "unknown",
            slotHeld: 1,
          });

          const failedOperationId = "50505050-5050-4050-a050-505050505050";
          const failedBody = {
            ...(await buildConfirmedBody()),
            clientOperationId: failedOperationId,
          };
          const failed = await postJson(url, failedBody);
          assert.equal(failed.status, 200, JSON.stringify(failed.body));
          const failedTaskUuid = responseTaskUuids(failed.body)[0]!;
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid: failedTaskUuid }).update({
              status: "failed_retryable",
              providerTaskId: "sub-round27-failed",
            }));
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid: failedTaskUuid }).delete();
          await recoverDreaminaSlots();
          const restoredFailed = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: failedTaskUuid }).first();
          assert.deepEqual({
            queueState: restoredFailed?.queueState,
            providerState: restoredFailed?.providerState,
            slotHeld: Number(restoredFailed?.slotHeld ?? -1),
          }, {
            queueState: "terminal",
            providerState: "failed",
            slotHeld: 0,
          });
          const failedRetry = await postJson(url, failedBody);
          assert.equal(failedRetry.status, 200, JSON.stringify(failedRetry.body));
          assert.equal(failedRetry.body?.data?.[0]?.status, "failed_retryable");
          assert.deepEqual(responseTaskUuids(failedRetry.body), [failedTaskUuid]);

          for (const [index, terminalStatus] of ["cancelled_local", "postprocess_failed_fatal"].entries()) {
            const operationId = index === 0
              ? "60606060-6060-4060-a060-606060606060"
              : "61616161-6161-4161-a161-616161616161";
            const terminalBody = { ...(await buildConfirmedBody()), clientOperationId: operationId };
            const created = await postJson(url, terminalBody);
            assert.equal(created.status, 200, JSON.stringify(created.body));
            const taskUuid = responseTaskUuids(created.body)[0]!;
            await runWithProjectStorage(PROJECT_UUID, () =>
              activeDb("o_storyboardGenerationTask").where({ taskUuid }).update({ status: terminalStatus }));
            const replay = await postJson(url, terminalBody);
            assert.equal(replay.status, 200, JSON.stringify(replay.body));
            assert.equal(replay.body?.data?.[0]?.status, terminalStatus);
          }
        } finally {
          await cleanQueue();
        }
      });
    });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    syncCoordinator.listProjects = originalListProjects;
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime());
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
    if (previousQueryStatus === undefined) delete process.env.DREAMINA_FAKE_QUERY_STATUS;
    else process.env.DREAMINA_FAKE_QUERY_STATUS = previousQueryStatus;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放时保留在当前 worktree 的 .local/t，禁止跨目录清理。
    }
  }
});
