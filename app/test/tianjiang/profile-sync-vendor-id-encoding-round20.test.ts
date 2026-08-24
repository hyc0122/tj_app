/**
 * Round20 RED：UI 合法供应商 ID（含点号）不得被 apply 静默跳过。
 * 生产入口：applyLiveAccountSettings / captureLiveAccountSettings。
 * vendor.synthetic.api_key 不得插入供应商表。
 */
import assert from "node:assert/strict";
import test from "node:test";

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

const identity = { issuer: "https://api.j11.com.cn", userId: 2007 };

test("含点号、短横线、下划线的合法供应商 ID 必须往返，非集合键不得入库", async () => {
  const root = createUniqueWorktreeRoot("r20-vendor-id");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      await adapter.applyLiveAccountSettings({
        "vendor.partner.v2": JSON.stringify({
          id: "partner.v2",
          inputValues: { apiKey: "sk-dot" },
          models: [],
          enable: 1,
        }),
        "vendor.my-vendor": JSON.stringify({
          id: "my-vendor",
          inputValues: { apiKey: "sk-hyphen" },
          models: [],
          enable: 1,
        }),
        "vendor.my_vendor": JSON.stringify({
          id: "my_vendor",
          inputValues: { apiKey: "sk-under" },
          models: [],
          enable: 1,
        }),
        "vendor.synthetic.api_key": "http-test-secret-value",
      });

      const dotted = await accountDatabase()("o_vendorConfig").where({ id: "partner.v2" }).first();
      const hyphen = await accountDatabase()("o_vendorConfig").where({ id: "my-vendor" }).first();
      const under = await accountDatabase()("o_vendorConfig").where({ id: "my_vendor" }).first();
      const bogus = await accountDatabase()("o_vendorConfig").where({ id: "synthetic.api_key" }).first();
      assert.ok(dotted, "partner.v2 必须写入 o_vendorConfig");
      assert.ok(hyphen, "my-vendor 必须写入 o_vendorConfig");
      assert.ok(under, "my_vendor 必须写入 o_vendorConfig");
      assert.equal(bogus, undefined, "vendor.synthetic.api_key 不得插入供应商表");

      const captured = await adapter.captureLiveAccountSettings();
      const dottedKeys = Object.keys(captured).filter((key) => key.includes("partner") || captured[key]?.includes("partner.v2"));
      assert.ok(
        dottedKeys.length > 0,
        `capture 必须能往返 partner.v2，keys=${Object.keys(captured).filter((key) => key.startsWith("vendor")).join(",")}`,
      );
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
