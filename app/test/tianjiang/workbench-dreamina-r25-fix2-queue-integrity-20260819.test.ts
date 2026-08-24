/**
 * R25-fix2 RED：工作台耐久 operation 必须在 o_video 一一绑定后才能 ready，
 * 且同 ID 重放必须早于 CLI/引用文件等可变状态预检。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
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
import { migrateOVideoGenerationTaskUuidUnique } from "../../src/tianjiang/data/storyboard-project-migration";
import { invalidateDreaminaCapabilityCache } from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import { resetDreaminaStartupStatusCheckForTests } from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import { recoverDreaminaSlots } from "../../src/tianjiang/model-providers/dreamina-cli/recovery";
import {
  readDreaminaSchedulerWakeCountForTests,
  resetDreaminaSchedulerWakeCountForTests,
  stopDreaminaSchedulerLoop,
} from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { writeProjectFileAtomic } from "../../src/tianjiang/media/project-file-store";
import { resumeDreaminaEnqueueOperation } from "../../src/tianjiang/model-providers/async-generation-service";
import getPath from "../../src/utils/getPath";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
  userStorageSegment,
} from "../../src/tianjiang/runtime/user-storage-context";
import {
  enqueueWorkbenchDreaminaVideos,
  setWorkbenchAfterTaskPersistBeforeVideoHookForTests,
} from "../../src/tianjiang/workbench/dreamina-workbench-enqueue";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import { writeReadyDreaminaTestCapability } from "./helpers/dreamina-capability";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2522 };
const PROJECT = "b0252522-2522-4522-a522-252225222522";
const PROJECT_ID = 2522;
const SCRIPT_ID = 19;
const TRACK_ID = 71;
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");
const REFERENCE_PATH = "files/images/workbench/r25-fix2.png";

function tinyPng(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

function workbenchItem(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    scriptId: SCRIPT_ID,
    trackId: TRACK_ID,
    prompt: "R25-fix2 耐久绑定",
    model: "dreamina-cli:seedance2.0fast",
    mode: "singleImage",
    resolution: "720p",
    duration: 5,
    audio: false,
    uploadData: [{ id: 101, sources: "storyboard" }],
    ...overrides,
  };
}

async function withRuntime(name: string, run: () => Promise<void>): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${process.pid}-${crypto.randomUUID()}`);
  const previousCwd = process.cwd();
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    DREAMINA_TEST_EXECUTABLE: process.env.DREAMINA_TEST_EXECUTABLE,
    DREAMINA_FAKE_LOG: process.env.DREAMINA_FAKE_LOG,
    DREAMINA_FAKE_QUERY_STATUS: process.env.DREAMINA_FAKE_QUERY_STATUS,
  };
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  resetDatabaseRuntimeForServe();
  resetDreaminaStartupStatusCheckForTests();
  invalidateDreaminaCapabilityCache();
  stopDreaminaSchedulerLoop();
  resetDreaminaSchedulerWakeCountForTests();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: PROJECT_ID,
        name: "R25-fix2",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await prepareProjectDatabase(PROJECT);
      await writeDreaminaCliSettings({
        enabled: true,
        executablePath: FAKE_CLI,
        pauseNewClaims: true,
        maxConcurrency: 1,
      });
      writeReadyDreaminaTestCapability();
      writeProjectFileAtomic(
        getPath(),
        PROJECT,
        userStorageSegment(IDENTITY),
        REFERENCE_PATH,
        tinyPng(),
      );
      await runWithProjectStorage(PROJECT, async () => {
        await activeDb("o_storyboard").insert({
          id: 101,
          scriptId: SCRIPT_ID,
          projectId: PROJECT_ID,
          filePath: REFERENCE_PATH,
          state: "已完成",
          prompt: "测试参考图",
        });
        await activeDb("o_videoTrack").insert({
          id: TRACK_ID,
          projectId: PROJECT_ID,
          scriptId: SCRIPT_ID,
          prompt: "测试轨道",
          state: "未生成",
          duration: 5,
        });
        await run();
      });
    });
  } finally {
    setWorkbenchAfterTaskPersistBeforeVideoHookForTests(null);
    stopDreaminaSchedulerLoop();
    resetDreaminaStartupStatusCheckForTests();
    invalidateDreaminaCapabilityCache();
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 测试清理失败不覆盖主断言。 */ }
  }
}

async function createInterruptedOperation(clientOperationId: string): Promise<void> {
  setWorkbenchAfterTaskPersistBeforeVideoHookForTests(() => {
    throw Object.assign(new Error("injected before o_video"), { code: "TEST_BEFORE_O_VIDEO" });
  });
  await assert.rejects(
    () => enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId,
      paidBatchConfirmed: false,
      items: [workbenchItem()],
    }),
    (error: unknown) => (error as { code?: unknown })?.code === "TEST_BEFORE_O_VIDEO",
  );
  setWorkbenchAfterTaskPersistBeforeVideoHookForTests(null);
}

test("启动恢复不得让缺失或错误 o_video 绑定的工作台任务 ready/wake", async () => {
  await withRuntime("r25f2-recovery-binding", async () => {
    const clientOperationId = "11111111-1111-4111-a111-111111111111";
    await createInterruptedOperation(clientOperationId);
    resetDreaminaSchedulerWakeCountForTests();

    await recoverDreaminaSlots();
    const missingOperation = await activeDb("o_storyboardGenerationOperation")
      .where({ clientOperationId }).first();
    const missingTask = await activeDb("o_storyboardGenerationTask")
      .where({ clientOperationId }).first();
    const missingDispatch = await accountDb("o_dreaminaCliDispatch")
      .where({ clientOperationId }).select();
    assert.equal(missingOperation?.state, "preparing");
    assert.equal(Number(missingTask?.enqueueReady), 0);
    assert.equal(missingDispatch.some((row) => Number(row.dispatchReady) === 1), false);
    assert.equal(readDreaminaSchedulerWakeCountForTests(), 0, "缺绑定恢复不得唤醒调度器");

    // 中文注释：仅 UUID 相同不够，项目/剧本/轨道身份错误也不得通过 ready 门。
    await activeDb("o_video").insert({
      filePath: "",
      time: Date.now(),
      state: "生成中",
      scriptId: SCRIPT_ID,
      projectId: PROJECT_ID,
      videoTrackId: TRACK_ID + 1,
      generationTaskUuid: String(missingTask?.taskUuid),
    });
    await assert.rejects(
      () => resumeDreaminaEnqueueOperation({ projectUuid: PROJECT, clientOperationId }),
      (error: unknown) => (error as { code?: unknown })?.code === "WORKBENCH_VIDEO_HISTORY_MISSING",
    );
    const invalidOperation = await activeDb("o_storyboardGenerationOperation")
      .where({ clientOperationId }).first();
    assert.equal(invalidOperation?.state, "preparing");
  });
});

for (const drift of ["delete", "rebind"] as const) {
  test(`首次绑定校验后并发${drift === "delete" ? "删除" : "改绑"}不得让任务 ready/dispatchReady/wake`, async () => {
    await withRuntime(`r25f2-ready-drift-${drift}`, async () => {
      const clientOperationId = drift === "delete"
        ? "12121212-1212-4212-a212-121212121212"
        : "13131313-1313-4313-a313-131313131313";
      const created = await enqueueWorkbenchDreaminaVideos({
        projectUuid: PROJECT,
        clientOperationId,
        paidBatchConfirmed: false,
        items: [workbenchItem({ mode: "text", uploadData: [] })],
      });
      const taskUuid = String(created[0]?.taskId ?? "");
      await activeDb("o_storyboardGenerationTask").where({ clientOperationId }).update({ enqueueReady: 0 });
      await activeDb("o_storyboardGenerationOperation").where({ clientOperationId }).update({ state: "preparing" });
      await accountDb("o_dreaminaCliDispatch").where({ clientOperationId }).update({
        queueState: "terminal",
        providerState: "not_sent",
        dispatchReady: 0,
        slotHeld: 0,
      });
      const escapedTaskUuid = taskUuid.replace(/'/g, "''");
      const mutationSql = drift === "delete"
        ? `DELETE FROM o_video WHERE generationTaskUuid = '${escapedTaskUuid}';`
        : `UPDATE o_video SET videoTrackId = ${TRACK_ID + 1} WHERE generationTaskUuid = '${escapedTaskUuid}';`;
      await activeDb.raw(`
        CREATE TRIGGER r25f2_binding_drift_${drift}
        BEFORE UPDATE OF state ON o_storyboardGenerationOperation
        WHEN NEW.clientOperationId = '${clientOperationId}' AND NEW.state = 'ready'
        BEGIN
          ${mutationSql}
        END
      `);
      resetDreaminaSchedulerWakeCountForTests();

      await recoverDreaminaSlots();

      const operation = await activeDb("o_storyboardGenerationOperation").where({ clientOperationId }).first();
      const task = await activeDb("o_storyboardGenerationTask").where({ clientOperationId }).first();
      const dispatch = await accountDb("o_dreaminaCliDispatch").where({ clientOperationId }).first();
      const videos = await activeDb("o_video").where({ generationTaskUuid: taskUuid }).select();
      assert.equal(operation?.state, "preparing");
      assert.equal(Number(task?.enqueueReady), 0);
      assert.equal(Number(dispatch?.dispatchReady), 0);
      assert.equal(videos.length, 1, "失败关闭事务必须回滚并发删除/改绑，不得丢失权威历史");
      assert.equal(Number(videos[0]?.videoTrackId), TRACK_ID);
      assert.equal(readDreaminaSchedulerWakeCountForTests(), 0);
    });
  });
}

test("启动隔离的 provider_active/postprocessing 补回准确绑定后同 ID 重放必须原阶段解隔离且零 submit", async () => {
  await withRuntime("r25f2-startup-active-binding", async () => {
    await activeDb("o_videoTrack").insert({
      id: TRACK_ID + 1,
      projectId: PROJECT_ID,
      scriptId: SCRIPT_ID,
      prompt: "测试轨道2",
      state: "未生成",
      duration: 5,
    });
    const clientOperationId = "14141414-1414-4414-a414-141414141414";
    const created = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId,
      paidBatchConfirmed: true,
      items: [
        workbenchItem({ mode: "text", uploadData: [] }),
        workbenchItem({ mode: "text", uploadData: [], trackId: TRACK_ID + 1, prompt: "后处理绑定" }),
      ],
    });
    const taskUuids = created.map((item) => String(item.taskId));
    // 中文注释：模拟由旧版本或离线损坏留下的 ready 脏状态，启动门禁必须能独立发现并隔离。
    await activeDb.raw("DROP TRIGGER IF EXISTS trg_o_video_workbench_ready_delete_guard");
    await activeDb.raw("DROP TRIGGER IF EXISTS trg_o_video_workbench_ready_identity_guard");
    await activeDb("o_video").whereIn("generationTaskUuid", taskUuids).delete();
    await activeDb("o_storyboardGenerationTask").where({ taskUuid: taskUuids[0] }).update({
      status: "submitted",
      providerTaskId: "r25f2-submit-active",
    });
    await activeDb("o_storyboardGenerationTask").where({ taskUuid: taskUuids[1] }).update({
      status: "provider_completed",
      providerTaskId: "r25f2-submit-postprocess",
      providerCompletedAt: Date.now(),
    });
    await accountDb("o_dreaminaCliDispatch").where({ taskUuid: taskUuids[0] }).update({
      queueState: "provider_active",
      providerState: "running",
      slotHeld: 1,
      dispatchReady: 1,
      providerResultJson: JSON.stringify({ submitId: "r25f2-submit-active" }),
    });
    await accountDb("o_dreaminaCliDispatch").where({ taskUuid: taskUuids[1] }).update({
      queueState: "postprocessing",
      providerState: "completed",
      slotHeld: 0,
      dispatchReady: 1,
      providerResultJson: JSON.stringify({ submitId: "r25f2-submit-postprocess", files: [] }),
    });
    const fakeLog = path.join(process.cwd(), "r25f2-startup-active-cli.jsonl");
    process.env.DREAMINA_FAKE_LOG = fakeLog;
    process.env.DREAMINA_FAKE_QUERY_STATUS = "running";
    resetDreaminaSchedulerWakeCountForTests();

    await recoverDreaminaSlots();

    const dispatches = await accountDb("o_dreaminaCliDispatch")
      .where({ clientOperationId }).orderBy("operationItemIndex").select();
    assert.deepEqual(dispatches.map((row) => Number(row.dispatchReady)), [0, 0]);
    assert.deepEqual(dispatches.map((row) => String(row.queueState)), ["provider_active", "postprocessing"]);
    const isolatedCliCalls = fs.existsSync(fakeLog)
      ? fs.readFileSync(fakeLog, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      : [];
    assert.equal(isolatedCliCalls.some((entry) => entry.args?.[0] === "query_result"), false);
    assert.equal(readDreaminaSchedulerWakeCountForTests(), 0);

    const replayed = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId,
      paidBatchConfirmed: true,
      items: [
        workbenchItem({ mode: "text", uploadData: [] }),
        workbenchItem({ mode: "text", uploadData: [], trackId: TRACK_ID + 1, prompt: "后处理绑定" }),
      ],
    });
    assert.deepEqual(replayed.map((item) => item.taskId), taskUuids, "同 ID 重放必须复用原任务，不得生成第二批收费任务");
    assert.equal(replayed.every((item) => Number.isInteger(item.videoId) && item.videoId > 0), true);
    const reboundVideos = await activeDb("o_video")
      .whereIn("generationTaskUuid", taskUuids)
      .orderBy("videoTrackId")
      .select("generationTaskUuid", "projectId", "scriptId", "videoTrackId");
    assert.deepEqual(reboundVideos.map((row) => Number(row.videoTrackId)), [TRACK_ID, TRACK_ID + 1]);
    assert.equal(reboundVideos.every((row) => Number(row.projectId) === PROJECT_ID
      && Number(row.scriptId) === SCRIPT_ID), true);
    const restored = await accountDb("o_dreaminaCliDispatch")
      .where({ clientOperationId }).orderBy("operationItemIndex").select();
    assert.deepEqual(restored.map((row) => Number(row.dispatchReady)), [1, 1]);
    assert.deepEqual(restored.map((row) => String(row.queueState)), ["provider_active", "postprocessing"]);
    assert.deepEqual(restored.map((row) => String(row.providerState)), ["running", "completed"]);
    assert.deepEqual(restored.map((row) => Number(row.slotHeld)), [1, 0]);
    assert.equal(String(JSON.parse(String(restored[0]?.providerResultJson)).submitId), "r25f2-submit-active");
    assert.equal(String(JSON.parse(String(restored[1]?.providerResultJson)).submitId), "r25f2-submit-postprocess");
    assert.equal(readDreaminaSchedulerWakeCountForTests(), 0, "同 ID 重放仍保持只读 wake 语义，不重复触发调度");

    resetDreaminaSchedulerWakeCountForTests();
    await recoverDreaminaSlots();
    const continued = await accountDb("o_dreaminaCliDispatch")
      .where({ clientOperationId }).orderBy("operationItemIndex").select();
    assert.deepEqual(continued.map((row) => String(row.queueState)), ["provider_active", "postprocessing"]);
    assert.deepEqual(continued.map((row) => String(row.providerState)), ["running", "completed"]);
    const continuedCliCalls = fs.existsSync(fakeLog)
      ? fs.readFileSync(fakeLog, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      : [];
    assert.equal(continuedCliCalls.some((entry) => entry.args?.[0] === "query_result"), true,
      "解隔离后的 provider_active 必须能沿原 submitId 继续 query");
    const generationCommands = new Set([
      "text2image", "image2image", "text2video", "image2video",
      "frames2video", "multiframe2video", "multimodal2video",
    ]);
    assert.equal(continuedCliCalls.some((entry) => generationCommands.has(String(entry.args?.[0]))), false,
      "解隔离不得重新进入供应商 submit/计费边界");
  });
});

test("同 ID 重放早于 CLI/文件预检并返回原正数 videoId，冲突与非法 ID 稳定拒绝", async () => {
  await withRuntime("r25f2-early-replay", async () => {
    const clientOperationId = "22222222-2222-4222-a222-222222222222";
    await createInterruptedOperation(clientOperationId);
    const taskBefore = await activeDb("o_storyboardGenerationTask").where({ clientOperationId }).first();
    const referenceAbsolutePath = path.join(
      getPath(),
      "runtime-users",
      userStorageSegment(IDENTITY),
      "projects",
      PROJECT,
      REFERENCE_PATH,
    );
    fs.unlinkSync(referenceAbsolutePath);
    await writeDreaminaCliSettings({ enabled: false, pauseNewClaims: true });

    const replay = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId,
      paidBatchConfirmed: false,
      items: [workbenchItem()],
    });
    assert.equal(replay.length, 1);
    assert.equal(replay[0]?.taskId, taskBefore?.taskUuid);
    assert.equal(Number.isInteger(replay[0]?.videoId) && Number(replay[0]?.videoId) > 0, true);
    const bound = await activeDb("o_video").where({ generationTaskUuid: taskBefore?.taskUuid }).select();
    assert.equal(bound.length, 1, "同 ID retry 只能前滚出一个权威 o_video 绑定");
    assert.equal(Number(bound[0]?.id), replay[0]?.videoId);

    await assert.rejects(
      () => enqueueWorkbenchDreaminaVideos({
        projectUuid: PROJECT,
        clientOperationId,
        paidBatchConfirmed: false,
        items: [workbenchItem({ prompt: "同 ID 但意图变化" })],
      }),
      (error: unknown) => (error as { code?: unknown; status?: unknown })?.code === "DREAMINA_CLIENT_OPERATION_CONFLICT"
        && (error as { status?: unknown }).status === 409,
    );
    await assert.rejects(
      () => enqueueWorkbenchDreaminaVideos({
        projectUuid: PROJECT,
        clientOperationId: "not-a-uuid",
        paidBatchConfirmed: false,
        items: [workbenchItem()],
      }),
      (error: unknown) => (error as { code?: unknown; status?: unknown })?.code === "DREAMINA_CLIENT_OPERATION_ID_INVALID"
        && (error as { status?: unknown }).status === 400,
    );

    // 中文注释：只有字段真正缺省时服务端可以生成新 ID；不能把非法值当成缺省。
    await writeDreaminaCliSettings({ enabled: true, executablePath: FAKE_CLI, pauseNewClaims: true });
    writeReadyDreaminaTestCapability();
    const generated = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      paidBatchConfirmed: false,
      items: [workbenchItem({ mode: "text", uploadData: [], trackId: TRACK_ID })],
    });
    assert.equal(Number.isInteger(generated[0]?.videoId) && Number(generated[0]?.videoId) > 0, true);
    const generatedTask = await activeDb("o_storyboardGenerationTask")
      .where({ taskUuid: generated[0]?.taskId }).first();
    assert.match(String(generatedTask?.clientOperationId ?? ""), /^[0-9a-f-]{36}$/);
  });
});

test("唯一索引迁移遇旧重复绑定时保留权威行并可审计解绑冲突行", async () => {
  await withRuntime("r25f2-duplicate-migration", async () => {
    const created = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId: "33333333-3333-4333-a333-333333333333",
      paidBatchConfirmed: false,
      items: [workbenchItem({ mode: "text", uploadData: [] })],
    });
    const taskUuid = String(created[0]?.taskId ?? "");
    const authority = await activeDb("o_video").where({ generationTaskUuid: taskUuid }).first();
    await activeDb.raw("DROP INDEX IF EXISTS idx_o_video_generation_task_uuid_unique");
    const [duplicateId] = await activeDb("o_video").insert({
      filePath: "",
      time: Date.now() + 1,
      state: "生成中",
      scriptId: SCRIPT_ID,
      projectId: PROJECT_ID,
      videoTrackId: TRACK_ID + 99,
      generationTaskUuid: taskUuid,
    });

    await migrateOVideoGenerationTaskUuidUnique(activeDb);

    const rows = await activeDb("o_video").whereIn("id", [authority?.id, duplicateId]).orderBy("id");
    const kept = rows.filter((row) => row.generationTaskUuid === taskUuid);
    const quarantined = rows.find((row) => Number(row.id) === Number(duplicateId));
    assert.equal(kept.length, 1);
    assert.equal(Number(kept[0]?.id), Number(authority?.id), "匹配工作台来源身份的历史行必须保留权威绑定");
    assert.equal(quarantined?.generationTaskUuid, null);
    assert.match(String(quarantined?.errorReason ?? ""), /DREAMINA_VIDEO_BINDING_DUPLICATE/);
    await assert.rejects(
      () => activeDb("o_video").insert({
        filePath: "",
        time: Date.now() + 2,
        state: "生成中",
        scriptId: SCRIPT_ID,
        projectId: PROJECT_ID,
        videoTrackId: TRACK_ID,
        generationTaskUuid: taskUuid,
      }),
      "迁移收敛旧重复后仍必须恢复非空 generationTaskUuid 唯一约束",
    );
  });
});
