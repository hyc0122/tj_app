/**
 * Round20 RED：applyLive 同批第一条写 Markdown、第二条非法路径失败时，
 * 数据库回滚后不得留下第一条半写文件。
 * 生产入口：applyLiveAccountSettings()。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { resolveAccountModelPromptFile } from "../../src/tianjiang/prompts/account-model-prompt";
import { runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  accountDatabase,
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  closeActivatedWorkspaceRuntime,
  createUniqueWorktreeRoot,
} from "./helpers/worktree-runtime";

const identity = { issuer: "https://api.j11.com.cn", userId: 2004 };

test("同批 apply 第二条非法路径失败后，第一条 Markdown 与数据库必须一起回滚", async () => {
  const root = createUniqueWorktreeRoot("r20-apply-atomic");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      const goodRel = "video/round20-good.md";
      const goodFile = resolveAccountModelPromptFile({ relativePath: goodRel });
      assert.equal(fs.existsSync(goodFile), false, "开始前不得已有目标文件");

      let thrown: unknown;
      try {
        await adapter.applyLiveAccountSettings({
          "model.tianjiang.good": JSON.stringify({
            vendorId: "tianjiang",
            model: "round20-good",
            path: goodRel,
            fileName: "round20-good.md",
            content: "first-ok",
          }),
          "model.tianjiang.bad": JSON.stringify({
            vendorId: "tianjiang",
            model: "round20-bad",
            path: "../escape.md",
            fileName: "escape.md",
            content: "should-not-write",
          }),
        });
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, "第二条非法路径必须使 apply 失败");
      const row = await accountDatabase()("o_modelPrompt").where({
        vendorId: "tianjiang",
        model: "round20-good",
      }).first();
      assert.equal(row, undefined, "数据库第一条映射必须回滚");
      assert.equal(
        fs.existsSync(goodFile),
        false,
        `失败后不得留下第一条半写 Markdown：${goodFile}`,
      );
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
