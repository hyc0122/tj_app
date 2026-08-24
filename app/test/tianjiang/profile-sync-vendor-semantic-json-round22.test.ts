/**
 * Round22 RED：同一逻辑 vendor 的双表示必须按语义比较，而不是未规范化 JSON.stringify。
 * 生产入口：applyLiveAccountSettings。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
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

const identity = { issuer: "https://api.j11.com.cn", userId: 2203 };

function sha16(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

test("对象键顺序相反但语义相同必须合并；数组顺序或值不同必须失败关闭", async () => {
  const root = createUniqueWorktreeRoot("r22-semantic");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const id = "semanticVendor";
  const itemKey = `vendorItem.${sha16(id)}`;
  const legacyKey = `vendor.${id}`;
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      const left = JSON.stringify({
        id,
        inputValues: { region: "us", apiKey: "sk-sem" },
        models: [{ name: "m", modelName: "m", type: "text", think: false }],
        enable: 1,
      });
      const right = JSON.stringify({
        enable: 1,
        models: [{ think: false, type: "text", modelName: "m", name: "m" }],
        inputValues: { apiKey: "sk-sem", region: "us" },
        id,
      });
      assert.notEqual(left, right, "两份 JSON 文本必须不同，才能证明不是靠字面量相等");
      await adapter.applyLiveAccountSettings({
        [itemKey]: left,
        [legacyKey]: right,
      });
      const row = await accountDatabase()("o_vendorConfig").where({ id }).first();
      assert.ok(row, "语义相同的双表示必须合并成功");
      const inputs = JSON.parse(String(row.inputValues ?? "{}")) as { apiKey?: string; region?: string };
      assert.equal(inputs.apiKey, "sk-sem");
      assert.equal(inputs.region, "us");

      const arrayOrderA = JSON.stringify({
        id,
        inputValues: {},
        models: [{ name: "a" }, { name: "b" }],
        enable: 1,
      });
      const arrayOrderB = JSON.stringify({
        id,
        inputValues: {},
        models: [{ name: "b" }, { name: "a" }],
        enable: 1,
      });
      await assert.rejects(
        () => adapter.applyLiveAccountSettings({
          [itemKey]: arrayOrderA,
          [legacyKey]: arrayOrderB,
        }),
        /冲突|双表示|拒绝/i,
        "数组顺序不同必须 fail-closed",
      );

      const enableA = JSON.stringify({
        id,
        inputValues: { apiKey: "sk-sem" },
        models: [],
        enable: 1,
      });
      const enableB = JSON.stringify({
        id,
        inputValues: { apiKey: "sk-sem" },
        models: [],
        enable: 0,
      });
      await assert.rejects(
        () => adapter.applyLiveAccountSettings({
          [itemKey]: enableA,
          [legacyKey]: enableB,
        }),
        /冲突|双表示|拒绝/i,
        "enable 不同必须 fail-closed",
      );
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
