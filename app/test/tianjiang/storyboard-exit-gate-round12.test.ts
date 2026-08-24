/**
 * Task 11 RED：退出/切号必须暂停新 claim、等待 submit 临界区，中央失败恢复队列。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  activateUserDatabase,
  accountDb,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
  db as activeDb,
} from "../../src/utils/db";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { insertDreaminaDispatch } from "../../src/tianjiang/model-providers/dreamina-cli/task-store";
import {
  readDreaminaCliSettings,
  writeDreaminaCliSettings,
} from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import {
  pauseGenerationRuntime,
  registerGenerationRuntimeParticipant,
  resumeGenerationRuntime,
} from "../../src/tianjiang/tasks/generation-runtime-participants";
import { getStableDeviceUUID } from "../../src/tianjiang/auth/device";
import getPath from "../../src/utils/getPath";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9804 };
const PROJECT = "11111111-1111-4111-a111-111111111111";
const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");

async function withAccount<T>(run: () => Promise<T>): Promise<T> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-exit-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalScenario = process.env.DREAMINA_FAKE_SCENARIO;
  const originalLog = process.env.DREAMINA_FAKE_LOG;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_FAKE_SCENARIO = "immediate";
  process.env.DREAMINA_FAKE_LOG = path.join(root, "cli.log");
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  try {
    return await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 94,
        name: "退出门",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await writeDreaminaCliSettings({ executablePath: FAKE_CLI, maxConcurrency: 1, pauseNewClaims: false });
      return run();
    });
  } finally {
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
    else process.env.DREAMINA_FAKE_SCENARIO = originalScenario;
    if (originalLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = originalLog;
    delete process.env.DREAMINA_TEST_EXECUTABLE;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test("生产退出准备必须暂停新 claim，tick 不得再提交", async () => {
  await withAccount(async () => {
    const shot = await new StoryboardService(PROJECT).insertShot({ afterShotUuid: null, sourceText: "退出" });
    const taskUuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const now = Date.now();
    await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").insert({
      taskUuid,
      shotUuid: shot.shotUuid,
      parentTaskUuid: null,
      originDeviceUuid: getStableDeviceUUID(getPath()),
      mediaType: "image",
      providerId: "dreamina-cli",
      providerTaskId: null,
      providerSessionId: null,
      mode: "text2image",
      modelName: "dreamina-cli:text2image",
      parametersJson: JSON.stringify({ prompt: "exit" }),
      requestDigest: "c".repeat(64),
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
    await insertDreaminaDispatch({
      taskUuid,
      projectUuid: PROJECT,
      originDeviceUuid: getStableDeviceUUID(getPath()),
      mediaType: "image",
      modelName: "dreamina-cli:text2image",
      mode: "text2image",
      projectConcurrencyLimit: 1,
      modelConcurrencyLimit: 1,
      createdAt: now,
    });
    await pauseGenerationRuntime();
    const settings = await readDreaminaCliSettings();
    assert.equal(settings.pauseNewClaims, true, "退出门必须把 pauseNewClaims 置为 true");
    const { tickDreaminaScheduler } = await import("../../src/tianjiang/model-providers/dreamina-cli/scheduler");
    const claimed = await tickDreaminaScheduler();
    assert.deepEqual(claimed.claimed, [], `暂停后不得领取，实际 ${JSON.stringify(claimed)}`);
    const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
    assert.equal(String(dispatch?.queueState), "queued");
    assert.equal(Number(dispatch?.slotHeld), 0);
  });
});

test("退出门必须等待 claiming/not_sent 离开临界区后再返回", async () => {
  await withAccount(async () => {
    const taskUuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await insertDreaminaDispatch({
      taskUuid,
      projectUuid: PROJECT,
      originDeviceUuid: getStableDeviceUUID(getPath()),
      mediaType: "image",
      modelName: "dreamina-cli:text2image",
      mode: "text2image",
      projectConcurrencyLimit: 1,
      modelConcurrencyLimit: 1,
      createdAt: Date.now(),
    });
    await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
      queueState: "claiming",
      providerState: "not_sent",
      slotHeld: 1,
      leaseOwner: "test-lease",
      updatedAt: Date.now(),
    });
    await pauseGenerationRuntime();
    const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
    assert.ok(dispatch);
    assert.notEqual(String(dispatch.queueState), "claiming", "临界区必须先落成耐久态");
    assert.equal(Number(dispatch.slotHeld), 0);
    assert.ok(["queued", "terminal"].includes(String(dispatch.queueState)));
  });
});

test("中央失败必须恢复队列，不得保持暂停", async () => {
  await withAccount(async () => {
    let resumed = 0;
    registerGenerationRuntimeParticipant({
      async pauseNewWorkAndDrainCriticalSection() {
        await writeDreaminaCliSettings({ pauseNewClaims: true });
      },
      async resume() {
        resumed += 1;
        await writeDreaminaCliSettings({ pauseNewClaims: false });
      },
      async stop() {
        return undefined;
      },
    });
    const originalClose = (syncCoordinator as unknown as { closeAll: (options?: { requireCentralSuccess?: boolean }) => Promise<void> }).closeAll;
    (syncCoordinator as unknown as { closeAll: (options?: { requireCentralSuccess?: boolean }) => Promise<void> }).closeAll = async () => {
      throw Object.assign(new Error("中央同步未成功，已取消关闭/退出/切换账号"), { code: "CENTRAL_SYNC_FAILED" });
    };
    try {
      let failed = false;
      try {
        await syncCoordinator.prepareExplicitLogout();
      } catch (error) {
        failed = /中央|取消/.test(error instanceof Error ? error.message : String(error));
        if (!failed) throw error;
      }
      assert.equal(failed, true, "中央失败必须抛出取消退出");
      assert.equal(resumed, 1, `中央失败后必须调用 resume，实际 ${resumed}`);
      const settings = await readDreaminaCliSettings();
      assert.equal(settings.pauseNewClaims, false, "中央失败后必须恢复队列领取");
    } finally {
      (syncCoordinator as unknown as { closeAll: typeof originalClose }).closeAll = originalClose;
      await resumeGenerationRuntime();
    }
  });
});
