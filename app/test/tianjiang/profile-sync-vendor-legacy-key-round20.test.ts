/**
 * Round20/21：无点号安全 ID 的权威键是 vendor.{id}，禁止再并发生成 vendorItem 双键。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  activateUserDatabase,
  accountDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  closeActivatedWorkspaceRuntime,
  createUniqueWorktreeRoot,
} from "./helpers/worktree-runtime";

const identity = { issuer: "https://api.j11.com.cn", userId: 2010 };

test("capture 无点号供应商时必须只保留 vendor.{id} 权威键", async () => {
  const root = createUniqueWorktreeRoot("r20-vendor-legacy");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      await accountDatabase()("o_vendorConfig").insert({
        id: "aOnly",
        inputValues: JSON.stringify({ apiKey: "sk" }),
        models: "[]",
        enable: 1,
      });
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      const captured = await adapter.captureLiveAccountSettings();
      assert.ok(captured["vendor.aOnly"], `无点号 ID 必须仍有 vendor.aOnly，keys=${Object.keys(captured).filter((key) => key.includes("endor") || key.includes("aOnly")).join(",")}`);
      assert.equal(
        Object.keys(captured).filter((key) => key.startsWith("vendorItem.")).length,
        0,
        "安全 ID 不得再并发生成 vendorItem 双键",
      );
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
