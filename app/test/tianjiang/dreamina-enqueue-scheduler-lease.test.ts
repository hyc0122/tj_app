/**
 * Dreamina 从已确定 projectUuid 到入队完成必须持有 scheduler lease，
 * 所有成功/失败/早退路径 finally 释放；enqueue 挂起期间并发 close 不得拆掉该 lease。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  activateUserDatabase,
  databaseRuntimeSnapshot,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  prepareProjectDatabase,
  projectDatabaseLeaseSnapshot,
  releaseProjectDatabaseLease,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { acquireProjectDatabaseLease } from "../../src/utils/db";
import { invalidateDreaminaCapabilityCache } from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import { resetDreaminaStartupStatusCheckForTests } from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import {
  resetDreaminaSchedulerWakeCountForTests,
  stopDreaminaSchedulerLoop,
} from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { writeProjectFileAtomic } from "../../src/tianjiang/media/project-file-store";
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
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 8843 };
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa43";
const PROJECT_ID = 8843;
const SCRIPT_ID = 19;
const TRACK_ID = 71;
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");
const REFERENCE_PATH = "files/images/workbench/lease.png";

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

function workbenchItem() {
  return {
    projectId: PROJECT_ID,
    scriptId: SCRIPT_ID,
    trackId: TRACK_ID,
    prompt: "lease hold",
    model: "dreamina-cli:seedance2.0fast",
    mode: "singleImage",
    resolution: "720p",
    duration: 5,
    audio: false,
    uploadData: [{ id: 101, sources: "storyboard" }],
  };
}

async function withRuntime(run: () => Promise<void>): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `enq-lease-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const previousCwd = process.cwd();
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    DREAMINA_TEST_EXECUTABLE: process.env.DREAMINA_TEST_EXECUTABLE,
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
        name: "lease",
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
        const { db: activeDb } = await import("../../src/utils/db");
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
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test("enqueue 挂起期间并发 close 必须保留 scheduler lease，结束后释放", async () => {
  await withRuntime(async () => {
    await acquireProjectDatabaseLease(PROJECT, "ui");
    let releaseHang!: () => void;
    const hung = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    setWorkbenchAfterTaskPersistBeforeVideoHookForTests(async () => {
      entered();
      await hung;
    });
    const enqueuePromise = enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      paidBatchConfirmed: false,
      items: [workbenchItem()],
    });
    await started;
    assert.ok(projectDatabaseLeaseSnapshot(PROJECT).scheduler >= 1, "入队期间必须持有 scheduler lease");
    await releaseProjectDatabaseLease(PROJECT, "ui");
    const internal = (syncCoordinator as { closeProjectInternal?: (session: unknown, uuid: string) => Promise<unknown> })
      .closeProjectInternal;
    if (typeof internal === "function") {
      await internal({ serverUrl: IDENTITY.issuer, user: { id: IDENTITY.userId } }, PROJECT).catch(() => undefined);
    }
    assert.ok(
      projectDatabaseLeaseSnapshot(PROJECT).scheduler >= 1,
      "并发 close 不得拆掉 enqueue 持有的 scheduler lease",
    );
    assert.ok(databaseRuntimeSnapshot().projectHandleCount >= 1);
    releaseHang();
    await enqueuePromise;
    assert.equal(projectDatabaseLeaseSnapshot(PROJECT).scheduler, 0);
  });
});

test("enqueue 早退失败路径也必须释放 scheduler lease", async () => {
  await withRuntime(async () => {
    await assert.rejects(
      () => enqueueWorkbenchDreaminaVideos({
        projectUuid: PROJECT,
        paidBatchConfirmed: false,
        items: [],
      }),
      /没有可提交/,
    );
    assert.equal(projectDatabaseLeaseSnapshot(PROJECT).scheduler, 0);
  });
});
