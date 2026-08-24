/**
 * Round27 RED：普通供应商生成必须复用项目库 operation/task，形成耐久幂等合同。
 * 测试只替换最终收费边界；HTTP、项目数据库、候选安装与响应合同均走生产实现。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import Ai from "../../src/utils/ai";
import {
  accountDb,
  activateUserDatabase,
  db as activeDb,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import getPath from "../../src/utils/getPath";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import {
  closeActivatedWorkspaceRuntime,
  createUniqueWorktreeRoot,
} from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9781 };
const PROJECT_UUID = "81818181-8181-4181-a181-818181818181";

type JsonResponse = { status: number; body: any };

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function postJson(url: string, body: Record<string, unknown>): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function responseTasks(response: JsonResponse): any[] {
  if (response.status === 202) return Array.isArray(response.body?.data?.tasks) ? response.body.data.tasks : [];
  return Array.isArray(response.body?.data) ? response.body.data : [];
}

test("普通 vendor 生成必须耐久幂等、整批付费确认且不进入 Dreamina dispatch", async (t) => {
  const root = createUniqueWorktreeRoot("vendor-idempotency-round27");
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  const originalListProjects = syncCoordinator.listProjects.bind(syncCoordinator);
  const originalImage = Ai.Image;
  const originalVideo = Ai.Video;
  const originalFetch = globalThis.fetch;
  const executeByPrompt = new Map<string, number>();
  let executeTotal = 0;
  let prepareTotal = 0;
  let stageTotal = 0;
  let externalFetchAttempts = 0;
  let disconnectExecuteStartedResolve: (() => void) | undefined;
  let disconnectExecuteStarted = new Promise<void>((resolve) => {
    disconnectExecuteStartedResolve = resolve;
  });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = previousTestContext || "storyboard-vendor-idempotency-round27";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  // 中文注释：本测试模拟已启用的本地普通供应商；受理门禁必须从账号库读到同一模型目录。
  await runWithUserStorage(IDENTITY, () => accountDb("o_vendorConfig").insert({
    id: "vendor",
    inputValues: "{}",
    models: JSON.stringify([
      { modelName: "local", name: "本地图片模型", type: "image" },
      { modelName: "preflight-fails", name: "本地预检失败模型", type: "image" },
    ]),
    enable: 1,
  }).onConflict("id").merge({
    inputValues: "{}",
    models: JSON.stringify([
      { modelName: "local", name: "本地图片模型", type: "image" },
      { modelName: "preflight-fails", name: "本地预检失败模型", type: "image" },
    ]),
    enable: 1,
  }));

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== "127.0.0.1") {
      externalFetchAttempts += 1;
      throw new Error("测试禁止访问外网");
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  // 中文注释：fake 不创建 fetch/axios/SDK，也不读取 dreamina/PATH；只模拟收费执行和本地落盘。
  Ai.Image = ((key: `${string}:${string}`) => ({
    async prepare(input: { prompt?: string }) {
      prepareTotal += 1;
      const prompt = String(input.prompt ?? "");
      if (key === "vendor:preflight-fails") {
        throw new Error("preflight sk-secret C:\\private\\preflight.json");
      }
      return {
        async stage() {
          stageTotal += 1;
          if (prompt.includes("STAGE_FAIL")) {
            throw new Error("staging sk-secret https://signed.example/private.png C:\\private\\asset.png");
          }
          return {
            async execute() {
              executeTotal += 1;
              executeByPrompt.set(prompt, (executeByPrompt.get(prompt) ?? 0) + 1);
              if (prompt.includes("DISCONNECT")) {
                disconnectExecuteStartedResolve?.();
                await new Promise((resolve) => setTimeout(resolve, 80));
              }
              if (prompt.includes("CONCURRENT")) {
                await new Promise((resolve) => setTimeout(resolve, 80));
              }
              return {
                async save(target: string) {
                  const context = currentUserStorage();
                  assert.ok(context, "后台保存必须保留账号上下文");
                  const absolute = path.join(
                    projectDirectory(getPath(), PROJECT_UUID, context.segment),
                    ...target.split("/"),
                  );
                  fs.mkdirSync(path.dirname(absolute), { recursive: true });
                  fs.writeFileSync(absolute, `fake-vendor:${prompt}`, "utf8");
                },
              };
            },
          };
        },
      };
    },
  })) as unknown as typeof Ai.Image;
  Ai.Video = (() => {
    throw new Error("测试禁止进入视频 vendor 或 Dreamina CLI");
  }) as typeof Ai.Video;

  let server: http.Server | undefined;
  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 2781,
        name: "Round27 vendor 幂等",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT_UUID,
        name: "Round27 vendor 幂等",
        kind: "personal",
        ownerUserId: IDENTITY.userId,
        myRole: "owner",
        openMode: "editable",
      }] as any;

      const service = new StoryboardService(PROJECT_UUID);
      await service.saveSettings({ aspectRatio: "16:9", resolution: "1K" });
      const shotA = await service.insertShot({
        afterShotUuid: null,
        sourceText: "A",
        imagePrompt: "NORMAL_A",
      });
      const shotB = await service.insertShot({
        afterShotUuid: shotA.shotUuid,
        sourceText: "B",
        imagePrompt: "NORMAL_B",
      });
      const shotConcurrent = await service.insertShot({
        afterShotUuid: shotB.shotUuid,
        sourceText: "C",
        imagePrompt: "CONCURRENT",
      });
      const shotStageFailure = await service.insertShot({
        afterShotUuid: shotConcurrent.shotUuid,
        sourceText: "D",
        imagePrompt: "STAGE_FAIL",
      });
      const shotDisconnect = await service.insertShot({
        afterShotUuid: shotStageFailure.shotUuid,
        sourceText: "E",
        imagePrompt: "DISCONNECT",
      });

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "vendor-idempotency" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const listening = await listen(app);
      server = listening.server;
      const base = `http://127.0.0.1:${listening.port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/storyboard`;

      const itemFor = async (shotUuid: string, providerModel = "vendor:local") => {
        const preview = await postJson(`${base}/generate/preview`, {
          shotUuid,
          mediaType: "image",
          providerModel,
          mode: "text2image",
        });
        assert.equal(preview.status, 200, JSON.stringify(preview.body));
        return {
          shotUuid,
          mediaType: "image",
          providerModel,
          mode: "text2image",
          expectedPreviewDigest: String(preview.body?.data?.previewDigest ?? ""),
        };
      };
      const assertNoDreaminaDispatch = async () => {
        assert.equal(Number((await accountDb("o_dreaminaCliDispatch").count({ count: "*" }).first())?.count ?? 0), 0);
      };
      const waitForOperationState = async (clientOperationId: string, expected: string) => {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          const row = await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardGenerationOperation")
            .where({ clientOperationId })
            .first("state"));
          if (String(row?.state ?? "") === expected) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail(`operation ${clientOperationId} 未在期限内进入 ${expected}`);
      };
      const taskRowsFor = (clientOperationId: string) => runWithProjectStorage(PROJECT_UUID, () =>
        activeDb("o_storyboardGenerationTask")
          .where({ clientOperationId })
          .orderBy("operationItemIndex")
          .select());
      await accountDb.raw(`
        CREATE TRIGGER r27_vendor_forbid_dreamina_dispatch
        BEFORE INSERT ON o_dreaminaCliDispatch
        BEGIN SELECT RAISE(ABORT, 'vendor test forbids Dreamina dispatch'); END
      `);

      await t.test("单项和批量都必须带合法 UUID，批量未确认必须零执行零持久", async () => {
        const itemA = await itemFor(shotA.shotUuid);
        const itemB = await itemFor(shotB.shotUuid);
        const before = executeTotal;
        const missing = await postJson(`${base}/generate`, itemA);
        const invalid = await postJson(`${base}/generate`, { ...itemA, clientOperationId: "not-a-uuid" });
        const missingBatchId = await postJson(`${base}/generate`, {
          items: [itemA, itemB],
          paidBatchConfirmed: true,
        });
        const invalidBatchId = await postJson(`${base}/generate`, {
          items: [itemA, itemB],
          paidBatchConfirmed: true,
          clientOperationId: "invalid-batch-id",
        });
        const unpaid = await postJson(`${base}/generate`, {
          items: [itemA, itemB],
          clientOperationId: "82828282-8282-4282-a282-828282828282",
        });
        assert.deepEqual(
          [missing.status, invalid.status, missingBatchId.status, invalidBatchId.status, unpaid.status],
          [400, 400, 400, 400, 400],
        );
        assert.match(String(missingBatchId.body?.code ?? ""), /CLIENT_OPERATION_ID_INVALID/);
        assert.match(String(invalidBatchId.body?.code ?? ""), /CLIENT_OPERATION_ID_INVALID/);
        assert.equal(executeTotal, before);
        const operation = await runWithProjectStorage(PROJECT_UUID, () =>
          activeDb("o_storyboardGenerationOperation")
            .where({ clientOperationId: "82828282-8282-4282-a282-828282828282" })
            .first());
        assert.equal(operation, undefined);
        await assertNoDreaminaDispatch();
      });

      await t.test("完整批次预检或 staging 失败必须零 execute 且错误脱敏", async () => {
        const itemA = await itemFor(shotA.shotUuid);
        const preflightFailure = await itemFor(shotB.shotUuid, "vendor:preflight-fails");
        const stageFailure = await itemFor(shotStageFailure.shotUuid);
        const before = executeTotal;
        const failedPreflight = await postJson(`${base}/generate`, {
          items: [itemA, preflightFailure],
          paidBatchConfirmed: true,
          clientOperationId: "83838383-8383-4383-a383-838383838383",
        });
        const failedStage = await postJson(`${base}/generate`, {
          items: [itemA, stageFailure],
          paidBatchConfirmed: true,
          clientOperationId: "84848484-8484-4484-a484-848484848484",
        });
        assert.deepEqual([failedPreflight.status, failedStage.status], [202, 202]);
        await waitForOperationState("83838383-8383-4383-a383-838383838383", "failed_fatal");
        await waitForOperationState("84848484-8484-4484-a484-848484848484", "failed_fatal");
        assert.equal(executeTotal, before);
        const persistedFailures = [
          ...await taskRowsFor("83838383-8383-4383-a383-838383838383"),
          ...await taskRowsFor("84848484-8484-4484-a484-848484848484"),
        ];
        assert.equal(persistedFailures.every((row) => row.status === "failed_fatal"), true);
        assert.equal(persistedFailures.every((row) => row.errorCode === "VENDOR_GENERATION_FAILED"), true);
        assert.doesNotMatch(JSON.stringify(persistedFailures), /sk-secret|signed\.example|C:\\private/i);
        await assertNoDreaminaDispatch();
      });

      await t.test("同 ID 串行与响应丢失重放原 task/candidate，execute 仅一次", async () => {
        const itemA = await itemFor(shotA.shotUuid);
        const body = {
          ...itemA,
          clientOperationId: "85858585-8585-4585-a585-858585858585",
        };
        const first = await postJson(`${base}/generate`, body);
        assert.equal(first.status, 202, JSON.stringify(first.body));
        await waitForOperationState(body.clientOperationId, "completed");
        // 中文注释：忽略首响应等价于客户端收包前断线，完成后的第二次必须从项目库恢复原结果。
        const replay = await postJson(`${base}/generate`, body);
        assert.equal(replay.status, 200, JSON.stringify(replay.body));
        const tasks = responseTasks(replay);
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0]?.clientOperationId, body.clientOperationId);
        assert.match(String(tasks[0]?.taskUuid ?? ""), /^[0-9a-f-]{36}$/);
        assert.equal(tasks[0]?.candidateUuid, tasks[0]?.taskUuid);
        assert.equal(executeByPrompt.get("NORMAL_A"), 1);
        const rows = await runWithProjectStorage(PROJECT_UUID, () =>
          activeDb("o_storyboardGenerationTask").where({ clientOperationId: body.clientOperationId }).select());
        assert.equal(rows.length, 1);
        assert.equal(String(rows[0]?.status), "completed");
        await assertNoDreaminaDispatch();
      });

      await t.test("同 ID 并发请求必须共享一次执行并返回同一任务和候选", async () => {
        const item = await itemFor(shotConcurrent.shotUuid);
        const body = {
          ...item,
          clientOperationId: "86868686-8686-4686-a686-868686868686",
        };
        const before = executeByPrompt.get("CONCURRENT") ?? 0;
        const [left, right] = await Promise.all([
          postJson(`${base}/generate`, body),
          postJson(`${base}/generate`, body),
        ]);
        assert.deepEqual([left.status, right.status], [202, 202]);
        assert.equal(responseTasks(left)[0]?.taskUuid, responseTasks(right)[0]?.taskUuid);
        await waitForOperationState(body.clientOperationId, "completed");
        const replay = await postJson(`${base}/generate`, body);
        assert.equal(replay.status, 200, JSON.stringify(replay.body));
        assert.equal((executeByPrompt.get("CONCURRENT") ?? 0) - before, 1);
        assert.equal(responseTasks(replay)[0]?.candidateUuid, responseTasks(left)[0]?.taskUuid);
        await assertNoDreaminaDispatch();
      });

      await t.test("同 ID 改内容、顺序或 paid 必须 409 且不再执行", async () => {
        const itemA = await itemFor(shotA.shotUuid);
        const itemB = await itemFor(shotB.shotUuid);
        const operationId = "87878787-8787-4787-a787-878787878787";
        const acceptedBody = {
          items: [itemA, itemB],
          paidBatchConfirmed: true,
          clientOperationId: operationId,
        };
        const accepted = await postJson(`${base}/generate`, acceptedBody);
        assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
        await waitForOperationState(operationId, "completed");
        const before = executeTotal;
        const beforePrepare = prepareTotal;
        const beforeStage = stageTotal;
        const changedContent = await postJson(`${base}/generate`, {
          ...acceptedBody,
          items: [{ ...itemA, expectedPreviewDigest: "b".repeat(64) }, itemB],
        });
        const changedOrder = await postJson(`${base}/generate`, {
          ...acceptedBody,
          items: [itemB, itemA],
        });
        const changedPaid = await postJson(`${base}/generate`, {
          ...acceptedBody,
          paidBatchConfirmed: false,
        });
        assert.deepEqual([changedContent.status, changedOrder.status, changedPaid.status], [409, 409, 409]);
        assert.equal(executeTotal, before);
        assert.equal(prepareTotal, beforePrepare);
        assert.equal(stageTotal, beforeStage);
        await assertNoDreaminaDispatch();
      });

      await t.test("重启后遗留 submitting 必须返回 202 且绝不重提", async () => {
        const item = await itemFor(shotB.shotUuid);
        const clientOperationId = "88888888-8888-4888-a888-888888888888";
        const created = await postJson(`${base}/generate`, { ...item, clientOperationId });
        assert.equal(created.status, 202, JSON.stringify(created.body));
        const taskUuid = String(responseTasks(created)[0]?.taskUuid ?? "");
        await waitForOperationState(clientOperationId, "completed");
        await runWithProjectStorage(PROJECT_UUID, () => activeDb.transaction(async (trx) => {
          await trx("o_storyboardCandidate").where({ candidateUuid: taskUuid }).delete();
          await trx("o_storyboardGenerationTask").where({ taskUuid }).update({ status: "submitting", progress: 0 });
          await trx("o_storyboardGenerationOperation").where({ clientOperationId }).update({ state: "submitting" });
        }));
        const before = executeTotal;
        const ambiguous = await postJson(`${base}/generate`, { ...item, clientOperationId });
        assert.equal(ambiguous.status, 202, JSON.stringify(ambiguous.body));
        assert.equal(ambiguous.body?.data?.clientOperationId, clientOperationId);
        assert.deepEqual(responseTasks(ambiguous).map((row) => row.taskUuid), [taskUuid]);
        assert.equal(executeTotal, before);
        await assertNoDreaminaDispatch();
      });

      await t.test("另一进程赢家完成 submitting 时必须等待并重放原候选", async () => {
        const item = await itemFor(shotA.shotUuid);
        const clientOperationId = "91919191-9191-4191-a191-919191919191";
        const body = { ...item, clientOperationId };
        const created = await postJson(`${base}/generate`, body);
        assert.equal(created.status, 202, JSON.stringify(created.body));
        const taskUuid = String(responseTasks(created)[0]?.taskUuid ?? "");
        await waitForOperationState(clientOperationId, "completed");
        const candidate = await runWithProjectStorage(PROJECT_UUID, () =>
          activeDb("o_storyboardCandidate").where({ candidateUuid: taskUuid }).first());
        assert.ok(candidate);
        await runWithProjectStorage(PROJECT_UUID, () => activeDb.transaction(async (trx) => {
          await trx("o_storyboardCandidate").where({ candidateUuid: taskUuid }).delete();
          await trx("o_storyboardGenerationTask").where({ taskUuid }).update({ status: "submitting", progress: 0 });
          await trx("o_storyboardGenerationOperation").where({ clientOperationId }).update({ state: "submitting" });
        }));
        const before = executeTotal;
        const replayPromise = postJson(`${base}/generate`, body);
        setTimeout(() => {
          void runWithProjectStorage(PROJECT_UUID, () => activeDb.transaction(async (trx) => {
            await trx("o_storyboardCandidate").insert(candidate);
            await trx("o_storyboardGenerationTask").where({ taskUuid }).update({ status: "completed", progress: 100 });
            await trx("o_storyboardGenerationOperation").where({ clientOperationId }).update({ state: "completed" });
          }));
        }, 40);
        const replay = await replayPromise;
        assert.equal(replay.status, 202, JSON.stringify(replay.body));
        await waitForOperationState(clientOperationId, "completed");
        const completedReplay = await postJson(`${base}/generate`, body);
        assert.equal(completedReplay.status, 200, JSON.stringify(completedReplay.body));
        assert.equal(responseTasks(completedReplay)[0]?.candidateUuid, taskUuid);
        assert.equal(executeTotal, before);
      });

      await t.test("耐久任务或候选身份漂移必须 409，禁止伪造 completed", async () => {
        const itemA = await itemFor(shotA.shotUuid);
        const itemB = await itemFor(shotB.shotUuid);
        const digestOperationId = "92929292-9292-4292-a292-929292929292";
        const digestBody = { ...itemA, clientOperationId: digestOperationId };
        const digestCreated = await postJson(`${base}/generate`, digestBody);
        const digestTaskUuid = String(responseTasks(digestCreated)[0]?.taskUuid ?? "");
        await waitForOperationState(digestOperationId, "completed");
        await runWithProjectStorage(PROJECT_UUID, () =>
          activeDb("o_storyboardGenerationTask").where({ taskUuid: digestTaskUuid }).update({ requestDigest: "f".repeat(64) }));
        const digestReplay = await postJson(`${base}/generate`, digestBody);

        const candidateOperationId = "93939393-9393-4393-a393-939393939393";
        const candidateBody = { ...itemA, clientOperationId: candidateOperationId };
        const candidateCreated = await postJson(`${base}/generate`, candidateBody);
        const candidateTaskUuid = String(responseTasks(candidateCreated)[0]?.taskUuid ?? "");
        await waitForOperationState(candidateOperationId, "completed");
        await runWithProjectStorage(PROJECT_UUID, () =>
          activeDb("o_storyboardCandidate").where({ candidateUuid: candidateTaskUuid }).update({
            shotUuid: itemB.shotUuid,
            mediaType: "video",
          }));
        const candidateReplay = await postJson(`${base}/generate`, candidateBody);
        const requestOperationId = "96969696-9696-4696-a696-969696969696";
        const requestBody = { ...itemA, clientOperationId: requestOperationId };
        const requestCreated = await postJson(`${base}/generate`, requestBody);
        const requestTaskUuid = String(responseTasks(requestCreated)[0]?.taskUuid ?? "");
        await waitForOperationState(requestOperationId, "completed");
        await runWithProjectStorage(PROJECT_UUID, async () => {
          const row = await activeDb("o_storyboardGenerationTask")
            .where({ taskUuid: requestTaskUuid })
            .first("parametersJson");
          const parameters = JSON.parse(String(row?.parametersJson ?? "{}"));
          parameters.request.prompt = "被篡改的耐久请求";
          await activeDb("o_storyboardGenerationTask")
            .where({ taskUuid: requestTaskUuid })
            .update({ parametersJson: JSON.stringify(parameters) });
        });
        const requestReplay = await postJson(`${base}/generate`, requestBody);
        assert.deepEqual([digestReplay.status, candidateReplay.status, requestReplay.status], [409, 409, 409]);
      });

      await t.test("真实断连后的同 ID 重放必须只执行一次", async () => {
        const item = await itemFor(shotDisconnect.shotUuid);
        const clientOperationId = "94949494-9494-4494-a494-949494949494";
        const body = JSON.stringify({ ...item, clientOperationId });
        disconnectExecuteStarted = new Promise<void>((resolve) => {
          disconnectExecuteStartedResolve = resolve;
        });
        const request = http.request({
          hostname: "127.0.0.1",
          port: listening.port,
          path: `/api/tianjiang/runtime/projects/${PROJECT_UUID}/storyboard/generate`,
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        });
        request.on("error", () => undefined);
        request.end(body);
        await disconnectExecuteStarted;
        request.destroy();
        await waitForOperationState(clientOperationId, "completed");
        const replay = await postJson(`${base}/generate`, { ...item, clientOperationId });
        assert.equal(replay.status, 200, JSON.stringify(replay.body));
        assert.equal(executeByPrompt.get("DISCONNECT"), 1);
        assert.equal(responseTasks(replay)[0]?.candidateUuid, responseTasks(replay)[0]?.taskUuid);
      });

      await t.test("operation 查询异常必须固定脱敏且零执行", async () => {
        const item = await itemFor(shotB.shotUuid);
        const before = executeTotal;
        await runWithProjectStorage(PROJECT_UUID, () =>
          activeDb.schema.renameTable("o_storyboardGenerationOperation", "o_storyboardGenerationOperation_hidden"));
        try {
          const failed = await postJson(`${base}/generate`, {
            ...item,
            clientOperationId: "95959595-9595-4595-a595-959595959595",
          });
          assert.equal(failed.status, 500, JSON.stringify(failed.body));
          assert.equal(failed.body?.message, "生成操作暂时不可读取，请稍后重试");
          assert.doesNotMatch(JSON.stringify(failed.body), /select |sqlite|operation_hidden|project\.sqlite|E:\\/i);
          assert.equal(executeTotal, before);
        } finally {
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb.schema.renameTable("o_storyboardGenerationOperation_hidden", "o_storyboardGenerationOperation"));
        }
      });

      assert.equal(externalFetchAttempts, 0, "vendor fake 全程不得触发外网 fetch");
    });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    Ai.Image = originalImage;
    Ai.Video = originalVideo;
    globalThis.fetch = originalFetch;
    syncCoordinator.listProjects = originalListProjects;
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime());
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放时保留在当前 worktree 的 .local/t，禁止跨目录清理。
    }
  }
});
