/**
 * ProjectOperationPort 释放多个 lease 时，一个失败也必须继续释放其余，最后抛出聚合或首个错误。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  pauseGenerationTaskRecovery,
  releaseProjectDatabaseLease,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  projectOperationPort,
  setProjectOperationPortLeaseReleaseForTests,
} from "../../src/tianjiang/runtime/project-operation-port";
import { runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { stopProcessBackgroundTaskSupervisor } from "../../src/tianjiang/tasks/background-task-supervisor";

const ISSUER = "https://api.j11.com.cn";
const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa81";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb81";

test("释放多个 lease 时第一个失败仍必须释放剩余 lease", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `op-agg-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const originalCwd = process.cwd();
  const identity = { issuer: ISSUER, userId: 8884 };
  const session = { serverUrl: ISSUER, user: { id: 8884 } };
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  syncCoordinator.listProjects = (() => [
    { projectUuid: UUID_A, kind: "personal", myRole: "owner", openMode: "editable" },
    { projectUuid: UUID_B, kind: "personal", myRole: "owner", openMode: "editable" },
  ]) as typeof syncCoordinator.listProjects;
  const released: string[] = [];
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      await initializeWorkspaceProject(UUID_A, {
        id: 81, name: "A", projectType: "storyboard", userId: 8884,
      });
      await initializeWorkspaceProject(UUID_B, {
        id: 82, name: "B", projectType: "storyboard", userId: 8884,
      });
      setProjectOperationPortLeaseReleaseForTests(async (projectUuid, holder) => {
        released.push(projectUuid);
        if (released.length === 1) throw new Error("first-release-failed");
        await releaseProjectDatabaseLease(projectUuid, holder);
      });
      await assert.rejects(
        () => projectOperationPort.withProjects(
          session as never,
          [UUID_A, UUID_B],
          new Map([[UUID_A, "read"], [UUID_B, "read"]]),
          async () => "ok",
        ),
        /first-release-failed|AggregateError/,
      );
      assert.equal(released.length, 2, "即使第一次释放失败也必须尝试释放剩余 lease");
      await releaseProjectDatabaseLease(UUID_A, "ui");
      await releaseProjectDatabaseLease(UUID_B, "ui");
    });
  } finally {
    setProjectOperationPortLeaseReleaseForTests(null);
    syncCoordinator.listProjects = originalList;
    await pauseGenerationTaskRecovery().catch(() => undefined);
    await stopProcessBackgroundTaskSupervisor().catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
