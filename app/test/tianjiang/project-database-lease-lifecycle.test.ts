/**
 * 真实 open→close×20、后台任务期间切换项目、任务完成后句柄归零、
 * 快速关闭并重开同一 UUID、scheduler 异步运行期间句柄不提前释放。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  acquireProjectDatabaseLease,
  activateUserDatabase,
  databaseRuntimeSnapshot,
  destroyAllDatabaseHandles,
  pauseGenerationTaskRecovery,
  projectDatabaseLeaseSnapshot,
  releaseProjectDatabaseLease,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { stopProcessBackgroundTaskSupervisor } from "../../src/tianjiang/tasks/background-task-supervisor";
import { runWithUserStorage, userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";
import { initializeWorkspaceProject } from "../../src/utils/db";

function shortFixtureRoot(label: string): string {
  const root = path.join(process.cwd(), "..", ".tmp", `${label}-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

const ISSUER = "https://api.j11.com.cn";
const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa20";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb20";

test("真实 open→close 20 次后项目句柄归零", async () => {
  const root = shortFixtureRoot("lease20");
  const originalCwd = process.cwd();
  const identity = { issuer: ISSUER, userId: 8820 };
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      for (let index = 0; index < 20; index += 1) {
        await initializeWorkspaceProject(UUID_A, {
          id: 20,
          name: `switch-${index}`,
          projectType: "storyboard",
          userId: identity.userId,
        });
        assert.ok(databaseRuntimeSnapshot().projectHandleCount >= 1);
        await releaseProjectDatabaseLease(UUID_A, "ui");
      }
      assert.equal(databaseRuntimeSnapshot().projectHandleCount, 0, "20 次 open/close 后句柄必须归零");
      assert.deepEqual(projectDatabaseLeaseSnapshot(UUID_A), { ui: 0, supervisor: 0, scheduler: 0 });
      const { ProjectRuntimeActivationGate } = await import("../../src/tianjiang/runtime/project-runtime-activation");
      const gate = new ProjectRuntimeActivationGate();
      for (let index = 0; index < 20; index += 1) {
        const token = gate.issueOpenGeneration(UUID_A);
        gate.releaseAfterClose(UUID_A);
        void token;
      }
      assert.equal(gate.snapshot().generations, 0);
      assert.equal(gate.snapshot().tails, 0);
    });
  } finally {
    await pauseGenerationTaskRecovery().catch(() => undefined);
    await stopProcessBackgroundTaskSupervisor().catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
  }
});

test("后台任务运行期间切换项目不得拆掉任务项目句柄；完成后归零", async () => {
  const root = shortFixtureRoot("leasesw");
  const originalCwd = process.cwd();
  const identity = { issuer: ISSUER, userId: 8821 };
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      await acquireProjectDatabaseLease(UUID_A, "ui");
      await acquireProjectDatabaseLease(UUID_A, "supervisor");
      await releaseProjectDatabaseLease(UUID_A, "ui");
      await acquireProjectDatabaseLease(UUID_B, "ui");
      assert.equal(databaseRuntimeSnapshot().projectHandleCount, 2, "切换后任务项目仍应由监督器 lease 持有");
      assert.equal(projectDatabaseLeaseSnapshot(UUID_A).supervisor, 1);
      assert.equal(projectDatabaseLeaseSnapshot(UUID_A).ui, 0);
      await releaseProjectDatabaseLease(UUID_A, "supervisor");
      assert.equal(projectDatabaseLeaseSnapshot(UUID_A).supervisor, 0);
      assert.equal(databaseRuntimeSnapshot().projectHandleCount, 1, "任务完成后只剩新活动项目");
      await releaseProjectDatabaseLease(UUID_B, "ui");
      assert.equal(databaseRuntimeSnapshot().projectHandleCount, 0);
    });
  } finally {
    await pauseGenerationTaskRecovery().catch(() => undefined);
    await stopProcessBackgroundTaskSupervisor().catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
  }
});

test("快速关闭并重开同一 UUID：旧 close 不得拆掉新 UI lease", async () => {
  const root = shortFixtureRoot("leasefast");
  const originalCwd = process.cwd();
  const identity = { issuer: ISSUER, userId: 8822 };
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      await acquireProjectDatabaseLease(UUID_A, "ui");
      const closing = releaseProjectDatabaseLease(UUID_A, "ui");
      await acquireProjectDatabaseLease(UUID_A, "ui");
      await closing;
      assert.equal(projectDatabaseLeaseSnapshot(UUID_A).ui, 1, "重开后的 UI lease 必须保留");
      assert.equal(databaseRuntimeSnapshot().projectHandleCount, 1);
      await releaseProjectDatabaseLease(UUID_A, "ui");
      assert.equal(databaseRuntimeSnapshot().projectHandleCount, 0);
    });
  } finally {
    await pauseGenerationTaskRecovery().catch(() => undefined);
    await stopProcessBackgroundTaskSupervisor().catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
  }
});

test("scheduler 异步运行期间句柄不得提前释放", async () => {
  const root = shortFixtureRoot("leasesched");
  const originalCwd = process.cwd();
  const identity = { issuer: ISSUER, userId: 8823 };
  void userStorageSegment(identity);
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      await acquireProjectDatabaseLease(UUID_A, "scheduler");
      let settle!: () => void;
      const running = new Promise<void>((resolve) => { settle = resolve; });
      const held = (async () => {
        await running;
        await releaseProjectDatabaseLease(UUID_A, "scheduler");
      })();
      assert.equal(databaseRuntimeSnapshot().projectHandleCount, 1);
      assert.equal(projectDatabaseLeaseSnapshot(UUID_A).scheduler, 1);
      settle();
      await held;
      assert.equal(databaseRuntimeSnapshot().projectHandleCount, 0, "scheduler Promise settled 后才能销毁句柄");
    });
  } finally {
    await pauseGenerationTaskRecovery().catch(() => undefined);
    await stopProcessBackgroundTaskSupervisor().catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
  }
});
