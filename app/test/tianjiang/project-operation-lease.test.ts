/**
 * 跨项目 prepare 必须 acquire/release；覆盖命中、未命中与异常分支。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  activateUserDatabase,
  databaseRuntimeSnapshot,
  destroyAllDatabaseHandles,
  pauseGenerationTaskRecovery,
  releaseProjectDatabaseLease,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { stopProcessBackgroundTaskSupervisor } from "../../src/tianjiang/tasks/background-task-supervisor";
import { projectOperationPort } from "../../src/tianjiang/runtime/project-operation-port";
import { resolveWorkbenchProjectUuid } from "../../src/tianjiang/workbench/dreamina-workbench-enqueue";
import { runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { initializeWorkspaceProject } from "../../src/utils/db";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";

const ISSUER = "https://api.j11.com.cn";
const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa81";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb81";

function shortRoot(label: string): string {
  const root = path.join(process.cwd(), "..", ".tmp", `${label}-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

test("project-operation-port 命中路径结束后句柄归零，异常也释放 lease", async () => {
  const root = shortRoot("op-lease");
  const original = process.cwd();
  const identity = { issuer: ISSUER, userId: 8881 };
  const session = { serverUrl: ISSUER, user: { id: 8881 } };
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  syncCoordinator.listProjects = (() => [
    { projectUuid: UUID_A, kind: "personal", myRole: "owner", openMode: "editable" },
    { projectUuid: UUID_B, kind: "personal", myRole: "owner", openMode: "editable" },
  ]) as typeof syncCoordinator.listProjects;
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      await initializeWorkspaceProject(UUID_A, {
        id: 81, name: "A", projectType: "storyboard", userId: 8881,
      });
      await initializeWorkspaceProject(UUID_B, {
        id: 82, name: "B", projectType: "storyboard", userId: 8881,
      });
      await projectOperationPort.withProjects(
        session as never,
        [UUID_A, UUID_B],
        new Map([[UUID_A, "read"], [UUID_B, "read"]]),
        async () => "ok",
      );
      await assert.rejects(
        () => projectOperationPort.withProjects(
          session as never,
          [UUID_A, UUID_B],
          new Map([[UUID_A, "read"], [UUID_B, "read"]]),
          async () => {
            throw new Error("boom");
          },
        ),
        /boom/,
      );
      await releaseProjectDatabaseLease(UUID_A, "ui");
      await releaseProjectDatabaseLease(UUID_B, "ui");
    });
    assert.equal(databaseRuntimeSnapshot().projectHandleCount, 0);
  } finally {
    syncCoordinator.listProjects = originalList;
    await pauseGenerationTaskRecovery().catch(() => undefined);
    await stopProcessBackgroundTaskSupervisor().catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(original);
  }
});

test("dreamina-workbench-enqueue 命中当前项目、扫描命中与异常未命中都释放句柄", async () => {
  const root = shortRoot("enq-lease");
  const original = process.cwd();
  const identity = { issuer: ISSUER, userId: 8882 };
  const session = { serverUrl: ISSUER, user: { id: 8882 } };
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  syncCoordinator.listProjects = (() => [
    { projectUuid: UUID_A, kind: "personal", myRole: "owner", openMode: "editable" },
    { projectUuid: UUID_B, kind: "personal", myRole: "owner", openMode: "editable" },
  ]) as typeof syncCoordinator.listProjects;
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      await initializeWorkspaceProject(UUID_A, {
        id: 91, name: "A", projectType: "storyboard", userId: 8882,
      });
      const hit = await resolveWorkbenchProjectUuid(91, session);
      assert.equal(hit, UUID_A);
      await assert.rejects(() => resolveWorkbenchProjectUuid(404, session), /不存在/);
      await releaseProjectDatabaseLease(UUID_A, "ui");
    });
    assert.equal(databaseRuntimeSnapshot().projectHandleCount, 0);
  } finally {
    syncCoordinator.listProjects = originalList;
    await pauseGenerationTaskRecovery().catch(() => undefined);
    await stopProcessBackgroundTaskSupervisor().catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(original);
  }
});
