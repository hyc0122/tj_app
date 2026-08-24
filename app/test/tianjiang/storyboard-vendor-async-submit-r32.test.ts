/**
 * R32：普通供应商必须先耐久受理并立即返回，真实收费执行不得阻塞 HTTP 提交结果。
 * 测试使用真实项目 SQLite，只替换最终供应商执行边界，不访问外网。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  activateUserDatabase,
  databaseRuntimeSnapshot,
  db as activeDb,
  initializeWorkspaceProject,
  prepareUserDatabase,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  enqueueVendorGenerationOperation,
  executeVendorGenerationOperation,
  replayVendorGenerationOperation,
} from "../../src/tianjiang/storyboard/vendor-generation-operation";
import {
  createStoryboardGenerationPreviewDigest,
  type FinalGenerationRequest,
} from "../../src/tianjiang/storyboard/storyboard-generation-service";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import {
  currentUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import getPath from "../../src/utils/getPath";
import { getStableDeviceUUID } from "../../src/tianjiang/auth/device";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  recoverDurableVendorGenerationOperations,
  resumeVendorGenerationScheduler,
  stopVendorGenerationScheduler,
} from "../../src/tianjiang/storyboard/vendor-generation-scheduler";
import { describeStoryboardTaskCenterReason } from "../../src/tianjiang/tasks/task-center-aggregation";
import {
  closeActivatedWorkspaceRuntime,
  createUniqueWorktreeRoot,
} from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9832 };
const SECOND_IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9833 };
const PROJECT_UUID = "32323232-3232-4232-a232-323232323232";
const CLIENT_OPERATION_ID = "32323232-3232-4232-a232-323232323233";
const SCHEDULER_OPERATION_ID = "32323232-3232-4232-a232-323232323234";
const RECOVERY_OPERATION_ID = "32323232-3232-4232-a232-323232323235";
const INTERRUPTED_OPERATION_ID = "32323232-3232-4232-a232-323232323238";
const TAMPERED_OPERATION_ID = "32323232-3232-4232-a232-323232323240";
const FOREIGN_OPERATION_ID = "32323232-3232-4232-a232-323232323242";
const FOREIGN_SUBMITTING_OPERATION_ID = "32323232-3232-4232-a232-323232323249";
const MISSING_SHOT_OPERATION_ID = "32323232-3232-4232-a232-323232323244";
const ACCOUNT_SWITCH_OPERATION_ID = "32323232-3232-4232-a232-323232323248";
const ACCOUNT_RECOVERY_OPERATION_ID = "32323232-3232-4232-a232-323232323250";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("普通供应商任务中心必须显示供应商中立且安全的状态原因", () => {
  assert.equal(
    describeStoryboardTaskCenterReason("submitting", null, false, "vendor"),
    "正在向普通供应商提交任务",
  );
  assert.equal(
    describeStoryboardTaskCenterReason("completed", null, false, "vendor"),
    "普通供应商生成完成，结果已回写",
  );
  assert.equal(
    describeStoryboardTaskCenterReason("failed_fatal", "VENDOR_GENERATION_FAILED", false, "vendor"),
    "普通供应商生成失败，请检查模型配置或稍后重试",
  );
  assert.equal(
    describeStoryboardTaskCenterReason("failed_fatal", "VENDOR_PREPARE_FAILED", false, "vendor"),
    "当前视频模型配置或请求参数不可用",
  );
  assert.equal(
    describeStoryboardTaskCenterReason("failed_fatal", "VENDOR_MEDIA_STAGING_FAILED", false, "vendor"),
    "参考素材暂存失败，请检查网络或稍后重试",
  );
  assert.equal(
    describeStoryboardTaskCenterReason("failed_fatal", "VENDOR_OUTCOME_UNKNOWN", false, "vendor"),
    "供应商提交结果待确认；为避免重复扣费不会自动重提",
  );
});

async function waitForTaskStatus(expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const row = await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardGenerationTask")
      .where({ clientOperationId: CLIENT_OPERATION_ID })
      .first("status"));
    if (String(row?.status ?? "") === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`任务未在期限内进入 ${expected}`);
}

async function waitForOperationTaskStatus(clientOperationId: string, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const row = await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardGenerationTask")
      .where({ clientOperationId })
      .first("status"));
    if (String(row?.status ?? "") === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`任务未在期限内进入 ${expected}`);
}

test("普通供应商耐久受理必须在真实执行完成前返回 202/queued", async () => {
  const root = createUniqueWorktreeRoot("vendor-async-submit-r32");
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  const executeGate = deferred();
  const executeStarted = deferred();

  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = previousTestContext || "storyboard-vendor-async-submit-r32";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);

  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 3232,
        name: "R32 普通供应商异步提交",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      const service = new StoryboardService(PROJECT_UUID);
      const shot = await service.insertShot({
        afterShotUuid: null,
        imagePrompt: "雨夜码头近景",
      });

      const operationPromise = executeVendorGenerationOperation({
        projectUuid: PROJECT_UUID,
        clientOperationId: CLIENT_OPERATION_ID,
        requestIntentDigest: "a".repeat(64),
        paidBatchConfirmed: false,
        items: [{
          shotUuid: shot.shotUuid,
          mediaType: "image",
          providerModel: "vendor:fake-image",
          mode: "text2image",
          requestDigest: "b".repeat(64),
          execute: async (candidateUuid) => {
            executeStarted.resolve();
            await executeGate.promise;
            // 中文注释：最终供应商边界成功后模拟真实候选落库，保留 production 完成态校验。
            await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardCandidate").insert({
              candidateUuid,
              shotUuid: shot.shotUuid,
              mediaType: "image",
              relativePath: `files/images/storyboard/${shot.shotUuid}/fake.png`,
              selected: 1,
              createdAt: new Date().toISOString(),
            }));
          },
        }],
      });

      await executeStarted.promise;
      const early = await Promise.race([
        operationPromise.then((outcome) => ({ type: "response" as const, outcome })),
        new Promise<{ type: "timeout" }>((resolve) => {
          setTimeout(() => resolve({ type: "timeout" }), 100);
        }),
      ]);
      // 中文注释：无论 RED/GREEN 都先释放 fake，确保失败测试也能自然退出并完成数据库清理。
      executeGate.resolve();
      const settled = await operationPromise;

      assert.equal(early.type, "response", "受理响应不应等待真实供应商执行完成");
      if (early.type === "response") {
        assert.equal(early.outcome.httpStatus, 202);
        assert.deepEqual(
          early.outcome.data.tasks.map((row) => row.status),
          ["queued"],
        );
      }
      assert.equal(settled.httpStatus, 202, "受理调用的返回语义必须稳定为 202");
      await waitForTaskStatus("completed");
    });
  } finally {
    await closeActivatedWorkspaceRuntime();
    process.chdir(previousCwd);
    process.env.NODE_ENV = previousNodeEnv;
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
  }
});

test("普通供应商受理必须持久化完整最终请求并由后台调度器执行", async () => {
  const root = createUniqueWorktreeRoot("vendor-durable-scheduler-r32");
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  const executeGate = deferred();
  const executeStarted = deferred();

  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = previousTestContext || "storyboard-vendor-durable-scheduler-r32";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  const Ai = (await import("../../src/utils/ai")).default;
  const originalImage = Ai.Image;
  const originalListProjects = syncCoordinator.listProjects.bind(syncCoordinator);

  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 3233,
        name: "R32 普通供应商耐久调度",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      const service = new StoryboardService(PROJECT_UUID);
      const shot = await service.insertShot({
        afterShotUuid: null,
        imagePrompt: "雨夜码头近景",
      });
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT_UUID,
        name: "R32 普通供应商耐久调度",
        kind: "personal",
        ownerUserId: IDENTITY.userId,
        role: "owner",
        myRole: "owner",
        currentVersion: 1,
        syncState: "synced",
        lastSyncedAt: null,
        updatedAt: "2026-08-23T00:00:00Z",
        lockStatus: "none",
        lockHolderName: "",
        openMode: "editable",
        businessType: "storyboard",
      }] as ReturnType<typeof syncCoordinator.listProjects>;
      const request: FinalGenerationRequest = {
        providerModel: "vendor:fake-image",
        prompt: "雨夜码头近景",
        references: [],
        options: {
          mode: "text2image",
          aspectRatio: "16:9",
          resolution: "1K",
        },
      };
      const requestDigest = createStoryboardGenerationPreviewDigest({
        projectUuid: PROJECT_UUID,
        shotUuid: shot.shotUuid,
        mediaType: "image",
        request,
      });

      Ai.Image = ((key: `${string}:${string}`) => ({
        async prepare(input: { prompt?: string }) {
          assert.equal(key, request.providerModel);
          assert.equal(input.prompt, request.prompt);
          return {
            async stage() {
              return {
                async execute() {
                  executeStarted.resolve();
                  await executeGate.promise;
                  return {
                    async save(target: string) {
                      const context = currentUserStorage();
                      assert.ok(context, "后台执行必须恢复账号上下文");
                      const absolute = path.join(
                        projectDirectory(getPath(), PROJECT_UUID, context.segment),
                        ...target.split("/"),
                      );
                      fs.mkdirSync(path.dirname(absolute), { recursive: true });
                      fs.writeFileSync(absolute, "fake-vendor-image", "utf8");
                    },
                  };
                },
              };
            },
          };
        },
      })) as unknown as typeof Ai.Image;

      stopVendorGenerationScheduler();
      await assert.rejects(() => enqueueVendorGenerationOperation({
        projectUuid: PROJECT_UUID,
        clientOperationId: "32323232-3232-4232-a232-323232323247",
        requestIntentDigest: "9".repeat(64),
        paidBatchConfirmed: false,
        items: [{
          shotUuid: shot.shotUuid,
          mediaType: "image",
          providerModel: request.providerModel,
          mode: String(request.options.mode),
          requestDigest: createStoryboardGenerationPreviewDigest({
            projectUuid: PROJECT_UUID,
            shotUuid: shot.shotUuid,
            mediaType: "image",
            request: {
              ...request,
              options: { ...request.options, authorization: "Bearer must-not-persist" },
            },
          }),
          request: {
            ...request,
            options: { ...request.options, authorization: "Bearer must-not-persist" },
          },
        }],
      }), (error: unknown) => String((error as { code?: unknown })?.code) === "VENDOR_CLIENT_OPERATION_CONFLICT",
      "耐久 options 必须是明确白名单，禁止保存认证字段");
      const accepted = await enqueueVendorGenerationOperation({
        projectUuid: PROJECT_UUID,
        clientOperationId: SCHEDULER_OPERATION_ID,
        requestIntentDigest: "c".repeat(64),
        paidBatchConfirmed: false,
        items: [{
          shotUuid: shot.shotUuid,
          mediaType: "image",
          providerModel: request.providerModel,
          mode: String(request.options.mode),
          requestDigest,
          request,
        }],
      });
      assert.equal(accepted.httpStatus, 202);

      const persisted = await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardGenerationTask")
        .where({ clientOperationId: SCHEDULER_OPERATION_ID })
        .first("parametersJson"));
      const parameters = JSON.parse(String(persisted?.parametersJson ?? "{}"));
      assert.deepEqual(parameters.request, request, "后台恢复所需的完整最终请求必须先进入 SQLite");
      assert.equal(parameters.requestDigest, requestDigest);
      assert.doesNotMatch(JSON.stringify(parameters), /api[-_]?key|access[-_]?token|secret/i);

      await assert.rejects(
        service.deleteShots([shot.shotUuid]),
        (error: unknown) => Number((error as { status?: unknown })?.status) === 409
          && String((error as { code?: unknown })?.code) === "STORYBOARD_SHOT_GENERATION_ACTIVE",
        "queued/submitting 任务存在时不得删除镜头",
      );
      assert.ok(await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardShot")
        .where({ shotUuid: shot.shotUuid })
        .first()), "拒绝删除后镜头必须仍存在");

      resumeVendorGenerationScheduler();
      const replay = await replayVendorGenerationOperation({
        projectUuid: PROJECT_UUID,
        clientOperationId: SCHEDULER_OPERATION_ID,
        requestIntentDigest: "c".repeat(64),
      });
      assert.equal(replay?.httpStatus, 202, "同 ID 重放必须唤醒仍为 ready 的耐久任务");

      const started = await Promise.race([
        executeStarted.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      assert.equal(started, true, "同 ID 重放后后台执行器必须被重新唤醒");
      executeGate.resolve();
      await waitForOperationTaskStatus(SCHEDULER_OPERATION_ID, "completed");
      const candidate = await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardCandidate")
        .where({ candidateUuid: accepted.httpStatus === 202 ? accepted.data.tasks[0]?.taskUuid : "" })
        .first());
      assert.ok(candidate, "后台执行成功后必须安装耐久候选");
    });
  } finally {
    executeGate.resolve();
    resumeVendorGenerationScheduler();
    Ai.Image = originalImage;
    syncCoordinator.listProjects = originalListProjects;
    await closeActivatedWorkspaceRuntime();
    process.chdir(previousCwd);
    process.env.NODE_ENV = previousNodeEnv;
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
  }
});

test("账号切换必须等待旧账号普通供应商任务收敛后再关闭句柄", async () => {
  const root = createUniqueWorktreeRoot("vendor-account-switch-r32");
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  const executeGate = deferred();
  const executeStarted = deferred();

  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = previousTestContext || "storyboard-vendor-account-switch-r32";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  const Ai = (await import("../../src/utils/ai")).default;
  const originalImage = Ai.Image;
  const originalListProjects = syncCoordinator.listProjects.bind(syncCoordinator);

  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 3235,
        name: "R32 普通供应商账号切换",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      const service = new StoryboardService(PROJECT_UUID);
      const shot = await service.insertShot({ afterShotUuid: null, imagePrompt: "账号切换排空" });
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT_UUID,
        name: "R32 普通供应商账号切换",
        kind: "personal",
        ownerUserId: IDENTITY.userId,
        role: "owner",
        myRole: "owner",
        currentVersion: 1,
        syncState: "synced",
        lastSyncedAt: null,
        updatedAt: "2026-08-23T00:00:00Z",
        lockStatus: "none",
        lockHolderName: "",
        openMode: "editable",
        businessType: "storyboard",
      }] as ReturnType<typeof syncCoordinator.listProjects>;
      const request: FinalGenerationRequest = {
        providerModel: "vendor:account-switch",
        prompt: "账号切换排空",
        references: [],
        options: { mode: "text2image", aspectRatio: "16:9", resolution: "1K" },
      };
      const requestDigest = createStoryboardGenerationPreviewDigest({
        projectUuid: PROJECT_UUID,
        shotUuid: shot.shotUuid,
        mediaType: "image",
        request,
      });
      Ai.Image = (() => ({
        async prepare() {
          return {
            async stage() {
              return {
                async execute() {
                  executeStarted.resolve();
                  await executeGate.promise;
                  return {
                    async save(target: string) {
                      const context = currentUserStorage();
                      assert.ok(context);
                      const absolute = path.join(
                        projectDirectory(getPath(), PROJECT_UUID, context.segment),
                        ...target.split("/"),
                      );
                      fs.mkdirSync(path.dirname(absolute), { recursive: true });
                      fs.writeFileSync(absolute, "account-switch-result", "utf8");
                    },
                  };
                },
              };
            },
          };
        },
      })) as unknown as typeof Ai.Image;
      await enqueueVendorGenerationOperation({
        projectUuid: PROJECT_UUID,
        clientOperationId: ACCOUNT_SWITCH_OPERATION_ID,
        requestIntentDigest: "3".repeat(64),
        paidBatchConfirmed: false,
        items: [{
          shotUuid: shot.shotUuid,
          mediaType: "image",
          providerModel: request.providerModel,
          mode: "text2image",
          requestDigest,
          request,
        }],
      });
      await executeStarted.promise;

      let switched = false;
      const switching = activateUserDatabase(SECOND_IDENTITY).then(() => {
        switched = true;
      });
      const deadline = Date.now() + 3_000;
      while (!switched && databaseRuntimeSnapshot().userHandleCount < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(switched, false, "旧任务未收敛前账号切换不得完成");
      assert.ok(databaseRuntimeSnapshot().userHandleCount >= 2, "新账号句柄应已准备，阻塞点必须位于旧句柄关闭前");

      executeGate.resolve();
      await switching;
      assert.equal(switched, true);
    });
  } finally {
    executeGate.resolve();
    Ai.Image = originalImage;
    syncCoordinator.listProjects = originalListProjects;
    await closeActivatedWorkspaceRuntime();
    process.chdir(previousCwd);
    process.env.NODE_ENV = previousNodeEnv;
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
  }
});

test("切到已有 ready 任务的新账号时激活不得等待该账号供应商执行完成", async () => {
  const root = createUniqueWorktreeRoot("vendor-new-account-recovery-r32");
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  const executeGate = deferred();
  const executeStarted = deferred();

  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = previousTestContext || "storyboard-vendor-new-account-recovery-r32";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  const Ai = (await import("../../src/utils/ai")).default;
  const originalImage = Ai.Image;
  const originalListProjects = syncCoordinator.listProjects.bind(syncCoordinator);

  try {
    stopVendorGenerationScheduler();
    await prepareUserDatabase(SECOND_IDENTITY);
    await runWithUserStorage(SECOND_IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 3236,
        name: "R32 新账号 ready 恢复",
        projectType: "storyboard" as "novel",
        userId: SECOND_IDENTITY.userId,
      });
      const service = new StoryboardService(PROJECT_UUID);
      const shot = await service.insertShot({ afterShotUuid: null, imagePrompt: "新账号恢复不得阻塞激活" });
      const request: FinalGenerationRequest = {
        providerModel: "vendor:new-account-recovery",
        prompt: "新账号恢复不得阻塞激活",
        references: [],
        options: { mode: "text2image", aspectRatio: "16:9", resolution: "1K" },
      };
      const requestDigest = createStoryboardGenerationPreviewDigest({
        projectUuid: PROJECT_UUID,
        shotUuid: shot.shotUuid,
        mediaType: "image",
        request,
      });
      await enqueueVendorGenerationOperation({
        projectUuid: PROJECT_UUID,
        clientOperationId: ACCOUNT_RECOVERY_OPERATION_ID,
        requestIntentDigest: "4".repeat(64),
        paidBatchConfirmed: false,
        items: [{
          shotUuid: shot.shotUuid,
          mediaType: "image",
          providerModel: request.providerModel,
          mode: "text2image",
          requestDigest,
          request,
        }],
      });
    });
    syncCoordinator.listProjects = () => [{
      projectUuid: PROJECT_UUID,
      name: "R32 新账号 ready 恢复",
      kind: "personal",
      ownerUserId: SECOND_IDENTITY.userId,
      role: "owner",
      myRole: "owner",
      currentVersion: 1,
      syncState: "synced",
      lastSyncedAt: null,
      updatedAt: "2026-08-23T00:00:00Z",
      lockStatus: "none",
      lockHolderName: "",
      openMode: "editable",
      businessType: "storyboard",
    }] as ReturnType<typeof syncCoordinator.listProjects>;
    Ai.Image = (() => ({
      async prepare() {
        return {
          async stage() {
            return {
              async execute() {
                executeStarted.resolve();
                await executeGate.promise;
                return { async save() {} };
              },
            };
          },
        };
      },
    })) as unknown as typeof Ai.Image;

    const switching = activateUserDatabase(SECOND_IDENTITY);
    const result = await Promise.race([
      switching.then(() => "activated" as const),
      executeStarted.promise.then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "blocked-by-new-task" as const;
      }),
    ]);
    // 中文注释：新账号 ready 恢复只能在切库完成后后台启动，不能被同一次激活的 drain 反向等待。
    assert.equal(result, "activated");
    executeGate.resolve();
    await switching;
  } finally {
    executeGate.resolve();
    resumeVendorGenerationScheduler();
    Ai.Image = originalImage;
    syncCoordinator.listProjects = originalListProjects;
    await closeActivatedWorkspaceRuntime();
    process.chdir(previousCwd);
    process.env.NODE_ENV = previousNodeEnv;
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
  }
});

test("账号恢复必须扫描 ready 普通供应商任务且不得依赖原 HTTP 闭包", async () => {
  const root = createUniqueWorktreeRoot("vendor-recovery-r32");
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;

  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = previousTestContext || "storyboard-vendor-recovery-r32";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  const Ai = (await import("../../src/utils/ai")).default;
  const originalImage = Ai.Image;
  const originalListProjects = syncCoordinator.listProjects.bind(syncCoordinator);

  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 3234,
        name: "R32 普通供应商重启恢复",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      const service = new StoryboardService(PROJECT_UUID);
      const shot = await service.insertShot({
        afterShotUuid: null,
        imagePrompt: "晨雾山谷远景",
      });
      const localDeviceUuid = getStableDeviceUUID(getPath());
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT_UUID,
        name: "R32 普通供应商重启恢复",
        kind: "team",
        ownerUserId: IDENTITY.userId,
        role: "owner",
        myRole: "owner",
        currentVersion: 1,
        syncState: "synced",
        lastSyncedAt: null,
        updatedAt: "2026-08-23T00:00:00Z",
        lockStatus: "active",
        lockId: "LOCK-R32-RECOVERY",
        lockDeviceUuid: localDeviceUuid,
        fencingToken: 32,
        lockHolderName: "",
        openMode: "editable",
        businessType: "storyboard",
      }] as ReturnType<typeof syncCoordinator.listProjects>;
      const request: FinalGenerationRequest = {
        providerModel: "vendor:recovery-image",
        prompt: "晨雾山谷远景",
        references: [],
        options: {
          mode: "text2image",
          aspectRatio: "16:9",
          resolution: "1K",
        },
      };
      const requestDigest = createStoryboardGenerationPreviewDigest({
        projectUuid: PROJECT_UUID,
        shotUuid: shot.shotUuid,
        mediaType: "image",
        request,
      });
      const missingShotUuid = "32323232-3232-4232-a232-323232323246";
      const missingShotDigest = createStoryboardGenerationPreviewDigest({
        projectUuid: PROJECT_UUID,
        shotUuid: missingShotUuid,
        mediaType: "image",
        request,
      });
      const taskUuid = "32323232-3232-4232-a232-323232323236";
      const now = Date.now();
      const operationDigest = crypto.createHash("sha256").update(JSON.stringify({
        projectUuid: PROJECT_UUID,
        paidBatchConfirmed: false,
        requestDigests: [requestDigest],
      })).digest("hex");
      await runWithProjectStorage(PROJECT_UUID, () => activeDb.transaction(async (trx) => {
        await trx("o_storyboardGenerationOperation").insert({
          clientOperationId: RECOVERY_OPERATION_ID,
          operationDigest,
          requestIntentDigest: "d".repeat(64),
          itemCount: 1,
          paidBatchConfirmed: 0,
          state: "ready",
          createdAt: now,
          updatedAt: now,
        });
        await trx("o_storyboardGenerationTask").insert({
          taskUuid,
          shotUuid: shot.shotUuid,
          parentTaskUuid: null,
          originDeviceUuid: localDeviceUuid,
          mediaType: "image",
          providerId: "vendor",
          providerTaskId: null,
          providerSessionId: null,
          mode: "text2image",
          modelName: request.providerModel,
          parametersJson: JSON.stringify({ requestDigest, request }),
          requestDigest,
          status: "queued",
          paidBatchConfirmedAt: null,
          providerCompletedAt: null,
          resultLocatorDigest: null,
          progress: 0,
          errorCode: null,
          errorSummary: null,
          createdAt: now,
          updatedAt: now,
          clientOperationId: RECOVERY_OPERATION_ID,
          operationItemIndex: 0,
          enqueueReady: 1,
          projectConcurrencyLimit: null,
          modelConcurrencyLimit: null,
        });
        // 中文注释：submitting 代表进程可能已经越过收费边界，恢复时只能隔离，绝不能重发。
        await trx("o_storyboardGenerationOperation").insert({
          clientOperationId: INTERRUPTED_OPERATION_ID,
          operationDigest,
          requestIntentDigest: "e".repeat(64),
          itemCount: 1,
          paidBatchConfirmed: 0,
          state: "submitting",
          createdAt: now,
          updatedAt: now,
        });
        await trx("o_storyboardGenerationTask").insert({
          taskUuid: "32323232-3232-4232-a232-323232323239",
          shotUuid: shot.shotUuid,
          parentTaskUuid: null,
          originDeviceUuid: localDeviceUuid,
          mediaType: "image",
          providerId: "vendor",
          providerTaskId: null,
          providerSessionId: null,
          mode: "text2image",
          modelName: request.providerModel,
          parametersJson: JSON.stringify({ requestDigest, request }),
          requestDigest,
          status: "submitting",
          paidBatchConfirmedAt: null,
          providerCompletedAt: null,
          resultLocatorDigest: null,
          progress: 0,
          errorCode: null,
          errorSummary: null,
          createdAt: now,
          updatedAt: now,
          clientOperationId: INTERRUPTED_OPERATION_ID,
          operationItemIndex: 0,
          enqueueReady: 1,
          projectConcurrencyLimit: null,
          modelConcurrencyLimit: null,
        });
        // 中文注释：ready 记录即使结构完整，只要请求内容与摘要不一致，恢复也必须在收费前隔离。
        await trx("o_storyboardGenerationOperation").insert({
          clientOperationId: TAMPERED_OPERATION_ID,
          operationDigest,
          requestIntentDigest: "f".repeat(64),
          itemCount: 1,
          paidBatchConfirmed: 0,
          state: "ready",
          createdAt: now,
          updatedAt: now,
        });
        await trx("o_storyboardGenerationTask").insert({
          taskUuid: "32323232-3232-4232-a232-323232323241",
          shotUuid: shot.shotUuid,
          parentTaskUuid: null,
          originDeviceUuid: localDeviceUuid,
          mediaType: "image",
          providerId: "vendor",
          providerTaskId: null,
          providerSessionId: null,
          mode: "text2image",
          modelName: request.providerModel,
          parametersJson: JSON.stringify({
            requestDigest,
            request: { ...request, prompt: "被篡改且不得执行的提示词" },
          }),
          requestDigest,
          status: "queued",
          paidBatchConfirmedAt: null,
          providerCompletedAt: null,
          resultLocatorDigest: null,
          progress: 0,
          errorCode: null,
          errorSummary: null,
          createdAt: now,
          updatedAt: now,
          clientOperationId: TAMPERED_OPERATION_ID,
          operationItemIndex: 0,
          enqueueReady: 1,
          projectConcurrencyLimit: null,
          modelConcurrencyLimit: null,
        });
        // 中文注释：同步到另一设备的 ready 任务必须等待原设备，当前设备绝不能领取收费。
        await trx("o_storyboardGenerationOperation").insert({
          clientOperationId: FOREIGN_OPERATION_ID,
          operationDigest,
          requestIntentDigest: "1".repeat(64),
          itemCount: 1,
          paidBatchConfirmed: 0,
          state: "ready",
          createdAt: now,
          updatedAt: now,
        });
        await trx("o_storyboardGenerationTask").insert({
          taskUuid: "32323232-3232-4232-a232-323232323243",
          shotUuid: shot.shotUuid,
          parentTaskUuid: null,
          originDeviceUuid: "42424242-4242-4242-a242-424242424242",
          mediaType: "image",
          providerId: "vendor",
          providerTaskId: null,
          providerSessionId: null,
          mode: "text2image",
          modelName: request.providerModel,
          parametersJson: JSON.stringify({ requestDigest, request }),
          requestDigest,
          status: "queued",
          paidBatchConfirmedAt: null,
          providerCompletedAt: null,
          resultLocatorDigest: null,
          progress: 0,
          errorCode: null,
          errorSummary: null,
          createdAt: now,
          updatedAt: now,
          clientOperationId: FOREIGN_OPERATION_ID,
          operationItemIndex: 0,
          enqueueReady: 1,
          projectConcurrencyLimit: null,
          modelConcurrencyLimit: null,
        });
        // 中文注释：其他设备已经越过收费边界的 submitting 任务必须保持原样，当前设备不得代为隔离。
        await trx("o_storyboardGenerationOperation").insert({
          clientOperationId: FOREIGN_SUBMITTING_OPERATION_ID,
          operationDigest,
          requestIntentDigest: "5".repeat(64),
          itemCount: 1,
          paidBatchConfirmed: 0,
          state: "submitting",
          createdAt: now,
          updatedAt: now,
        });
        await trx("o_storyboardGenerationTask").insert({
          taskUuid: "32323232-3232-4232-a232-323232323251",
          shotUuid: shot.shotUuid,
          parentTaskUuid: null,
          originDeviceUuid: "42424242-4242-4242-a242-424242424242",
          mediaType: "image",
          providerId: "vendor",
          providerTaskId: null,
          providerSessionId: null,
          mode: "text2image",
          modelName: request.providerModel,
          parametersJson: JSON.stringify({ requestDigest, request }),
          requestDigest,
          status: "submitting",
          paidBatchConfirmedAt: null,
          providerCompletedAt: null,
          resultLocatorDigest: null,
          progress: 0,
          errorCode: null,
          errorSummary: null,
          createdAt: now,
          updatedAt: now,
          clientOperationId: FOREIGN_SUBMITTING_OPERATION_ID,
          operationItemIndex: 0,
          enqueueReady: 1,
          projectConcurrencyLimit: null,
          modelConcurrencyLimit: null,
        });
        // 中文注释：镜头若已被异常删除，恢复必须在调用供应商前隔离任务。
        await trx("o_storyboardGenerationOperation").insert({
          clientOperationId: MISSING_SHOT_OPERATION_ID,
          operationDigest: crypto.createHash("sha256").update(JSON.stringify({
            projectUuid: PROJECT_UUID,
            paidBatchConfirmed: false,
            requestDigests: [missingShotDigest],
          })).digest("hex"),
          requestIntentDigest: "2".repeat(64),
          itemCount: 1,
          paidBatchConfirmed: 0,
          state: "ready",
          createdAt: now,
          updatedAt: now,
        });
        await trx("o_storyboardGenerationTask").insert({
          taskUuid: "32323232-3232-4232-a232-323232323245",
          shotUuid: missingShotUuid,
          parentTaskUuid: null,
          originDeviceUuid: localDeviceUuid,
          mediaType: "image",
          providerId: "vendor",
          providerTaskId: null,
          providerSessionId: null,
          mode: "text2image",
          modelName: request.providerModel,
          parametersJson: JSON.stringify({ requestDigest: missingShotDigest, request }),
          requestDigest: missingShotDigest,
          status: "queued",
          paidBatchConfirmedAt: null,
          providerCompletedAt: null,
          resultLocatorDigest: null,
          progress: 0,
          errorCode: null,
          errorSummary: null,
          createdAt: now,
          updatedAt: now,
          clientOperationId: MISSING_SHOT_OPERATION_ID,
          operationItemIndex: 0,
          enqueueReady: 1,
          projectConcurrencyLimit: null,
          modelConcurrencyLimit: null,
        });
      }));

      let executeCount = 0;
      Ai.Image = ((key: `${string}:${string}`) => ({
        async prepare(input: { prompt?: string }) {
          assert.equal(key, request.providerModel);
          assert.equal(input.prompt, request.prompt);
          return {
            async stage() {
              return {
                async execute() {
                  executeCount += 1;
                  return {
                    async save(target: string) {
                      const context = currentUserStorage();
                      assert.ok(context, "恢复执行必须重建账号上下文");
                      const absolute = path.join(
                        projectDirectory(getPath(), PROJECT_UUID, context.segment),
                        ...target.split("/"),
                      );
                      fs.mkdirSync(path.dirname(absolute), { recursive: true });
                      fs.writeFileSync(absolute, "recovered-vendor-image", "utf8");
                    },
                  };
                },
              };
            },
          };
        },
      })) as unknown as typeof Ai.Image;

      const recovered = await recoverDurableVendorGenerationOperations();
      assert.deepEqual(recovered, { recovered: 1, quarantined: 3 });
      await waitForOperationTaskStatus(RECOVERY_OPERATION_ID, "completed");
      const candidate = await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardCandidate")
        .where({ candidateUuid: taskUuid })
        .first());
      assert.ok(candidate, "恢复任务完成后必须安装候选");
      const interrupted = await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardGenerationTask")
        .where({ clientOperationId: INTERRUPTED_OPERATION_ID })
        .first("status", "errorCode"));
      assert.deepEqual(
        { status: interrupted?.status, errorCode: interrupted?.errorCode },
        { status: "failed_fatal", errorCode: "VENDOR_OUTCOME_UNKNOWN" },
      );
      const tampered = await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardGenerationTask")
        .where({ clientOperationId: TAMPERED_OPERATION_ID })
        .first("status", "errorCode"));
      assert.deepEqual(
        { status: tampered?.status, errorCode: tampered?.errorCode },
        { status: "failed_fatal", errorCode: "VENDOR_GENERATION_RECOVERY_REQUIRED" },
      );
      const foreign = await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardGenerationTask")
        .where({ clientOperationId: FOREIGN_OPERATION_ID })
        .first("status", "errorCode"));
      assert.deepEqual(
        { status: foreign?.status, errorCode: foreign?.errorCode },
        { status: "queued", errorCode: null },
        "异源设备任务必须保持 queued 等待原设备",
      );
      const foreignSubmitting = await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardGenerationTask")
        .where({ clientOperationId: FOREIGN_SUBMITTING_OPERATION_ID })
        .first("status", "errorCode"));
      assert.deepEqual(
        { status: foreignSubmitting?.status, errorCode: foreignSubmitting?.errorCode },
        { status: "submitting", errorCode: null },
        "异源设备 submitting 必须保持原样等待原设备确认",
      );
      const missingShot = await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardGenerationTask")
        .where({ clientOperationId: MISSING_SHOT_OPERATION_ID })
        .first("status", "errorCode"));
      assert.deepEqual(
        { status: missingShot?.status, errorCode: missingShot?.errorCode },
        { status: "failed_fatal", errorCode: "VENDOR_GENERATION_RECOVERY_REQUIRED" },
      );
      assert.equal(executeCount, 1, "只有本机、镜头存在且写锁有效的任务可以调用供应商");
    });
  } finally {
    Ai.Image = originalImage;
    syncCoordinator.listProjects = originalListProjects;
    await closeActivatedWorkspaceRuntime();
    process.chdir(previousCwd);
    process.env.NODE_ENV = previousNodeEnv;
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
  }
});
