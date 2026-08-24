import assert from "node:assert/strict";
import test from "node:test";

import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { createUniqueWorktreeRoot, closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import { readDreaminaRuntimeState, writeDreaminaRuntimeState } from "../../src/tianjiang/model-providers/dreamina-cli/runtime-state-store";

test("重启后续办只检测状态，不重复执行安装", async () => {
  const root = createUniqueWorktreeRoot("dreamina-wsl-resume-r14");
  const originalCwd = process.cwd();
  const identity = { issuer: "https://api.j11.com.cn", userId: 1011 };
  const commands: string[][] = [];
  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      await writeDreaminaRuntimeState({ pendingOperation: "feature_install" });
      const manager = await import("../../src/tianjiang/model-providers/dreamina-cli/wsl-manager");
      manager.bindWslExecutor(async (file: string, args: string[]) => {
        commands.push([file, ...args]);
        return { stdout: "Default Version: 2", stderr: "", exitCode: 0 };
      });
      const resumed = await manager.continueWslInstall();
      assert.equal(resumed.repeatedInstall, false, "续办不得重复执行安装");
      assert.ok(commands.every((item) => !item.includes("--install")));
      const runtime = await readDreaminaRuntimeState();
      assert.ok(["none", "feature_install", "distribution_install", "cli_install"].includes(runtime.pendingOperation));
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
