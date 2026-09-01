/**
 * 测试夹具：工作树内唯一目录 + 先停运行时再删目录。
 * 禁止共用 sb-type-t1 / amrs-als 等固定名，禁止用系统 Temp 当共享根。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  destroyAllDatabaseHandles,
  pauseGenerationTaskRecovery,
} from "../../../src/utils/db";

const WORKTREE_GATE_TMP = path.resolve(__dirname, "..", "..", "..", "..", ".tmp", "gate");

/** 在工作树 .tmp/gate 下创建本次测试独占目录。 */
export function createUniqueWorktreeRoot(label: string): string {
  fs.mkdirSync(WORKTREE_GATE_TMP, { recursive: true });
  // 中文注释：Windows better-sqlite3 仍受传统路径长度影响；夹具名必须给项目 UUID 与 project.sqlite 留足空间。
  const safeLabel = label.replace(/[^a-z0-9-]/gi, "-").slice(0, 16) || "fixture";
  const root = path.join(
    WORKTREE_GATE_TMP,
    `${safeLabel}-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
  );
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * 先停即梦调度/恢复器，再关闭全部 SQLite/Knex。
 * 必须在 rmSync 夹具目录之前 await。
 */
/** 为需要回写真实账号库的 ProfileSync.login 提供 ALS + db2。 */
export async function runWithTemporaryAccount<T>(
  label: string,
  run: () => Promise<T>,
  userId = 7601,
): Promise<T> {
  const { activateUserDatabase, resetDatabaseRuntimeForServe } = await import("../../../src/utils/db");
  const { runWithUserStorage } = await import("../../../src/tianjiang/runtime/user-storage-context");
  const root = createUniqueWorktreeRoot(label);
  const originalCwd = process.cwd();
  const identity = { issuer: "https://api.j11.com.cn", userId };
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    return await runWithUserStorage(identity, run);
  } finally {
    await closeActivatedWorkspaceRuntime();
    process.chdir(originalCwd);
  }
}

export async function closeActivatedWorkspaceRuntime(): Promise<void> {
  try {
    const { stopDreaminaSchedulerLoop, drainDreaminaSubmitCriticalSection } = await import(
      "../../../src/tianjiang/model-providers/dreamina-cli/scheduler"
    );
    stopDreaminaSchedulerLoop();
    await drainDreaminaSubmitCriticalSection();
  } catch {
    // 本测试未加载调度器。
  }
  // 只暂停并排空恢复器，禁止 beginDatabaseShutdown，以免并行文件无法再建句柄。
  await pauseGenerationTaskRecovery();
  await destroyAllDatabaseHandles();
}
