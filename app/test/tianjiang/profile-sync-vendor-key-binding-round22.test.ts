/**
 * Round22 RED：vendor.{suffix} 必须与 payload.id 绑定。
 * 生产入口：applyLiveAccountSettings。
 * 错误信息不得包含 inputValues / API Key。
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

const identity = { issuer: "https://api.j11.com.cn", userId: 2201 };

function sha16(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function vendorPayload(id: string, apiKey: string): string {
  return JSON.stringify({
    id,
    inputValues: { apiKey },
    models: [],
    enable: 1,
  });
}

async function rowOf(id: string): Promise<unknown> {
  return accountDatabase()("o_vendorConfig").where({ id }).first();
}

test("vendor.claimedId 与 payload.id 不一致必须失败关闭，两个 ID 都不得入库", async () => {
  const root = createUniqueWorktreeRoot("r22-bind-mismatch");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      await assert.rejects(
        () => adapter.applyLiveAccountSettings({
          "vendor.claimedId": vendorPayload("differentId", "sk-bind-secret-claimed"),
        }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /不匹配|供应商|id/i);
          assert.doesNotMatch(message, /sk-bind-secret-claimed|inputValues/i);
          return true;
        },
        "键与 payload.id 不一致必须失败关闭",
      );
      assert.equal(await rowOf("claimedId"), undefined, "claimedId 不得入库");
      assert.equal(await rowOf("differentId"), undefined, "differentId 不得入库");
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("vendor.partner.v2 与 payload.id=other.v2 必须失败关闭", async () => {
  const root = createUniqueWorktreeRoot("r22-bind-dotted");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      await assert.rejects(
        () => adapter.applyLiveAccountSettings({
          "vendor.partner.v2": vendorPayload("other.v2", "sk-bind-secret-dotted"),
        }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /不匹配|供应商|id/i);
          assert.doesNotMatch(message, /sk-bind-secret-dotted|inputValues/i);
          return true;
        },
      );
      assert.equal(await rowOf("partner.v2"), undefined, "partner.v2 不得入库");
      assert.equal(await rowOf("other.v2"), undefined, "other.v2 不得入库");
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("deleted.vendor.foo 携带 payload.id=bar 是畸形 tombstone，必须跳过并继续写 language", async () => {
  const root = createUniqueWorktreeRoot("r22-bind-tomb");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      await accountDatabase()("o_vendorConfig").insert({
        id: "bar",
        inputValues: JSON.stringify({ apiKey: "sk-keep-bar" }),
        models: "[]",
        enable: 1,
      });
      await adapter.applyLiveAccountSettings({
        "deleted.vendor.foo": JSON.stringify({ $tombstone: true, id: "bar" }),
        language: "en",
      });
      assert.ok(await rowOf("bar"), "畸形 tombstone 不得删掉 bar");
      assert.equal(await rowOf("foo"), undefined, "不得据此插入 foo");
      const language = await accountDatabase()("o_setting").where({ key: "language" }).first();
      assert.equal(language?.value, "en", `同批 language 必须写入，实际=${language?.value}`);
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("vendorItem token 校验与 vendor.synthetic.api_key 隔离不得削弱", async () => {
  const root = createUniqueWorktreeRoot("r22-bind-locks");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
      await assert.rejects(
        () => adapter.applyLiveAccountSettings({
          [`vendorItem.${"f".repeat(16)}`]: vendorPayload("tokenVendor", "sk-forged-token"),
        }),
        /token|摘要|不匹配|供应商/i,
      );
      assert.equal(await rowOf("tokenVendor"), undefined);

      await adapter.applyLiveAccountSettings({
        [`vendorItem.${sha16("partner.v2")}`]: vendorPayload("partner.v2", "sk-ok-dot"),
        "vendor.synthetic.api_key": "http-test-secret-value",
      });
      assert.ok(await rowOf("partner.v2"), "合法 vendorItem 往返不得削弱");
      assert.equal(await rowOf("synthetic.api_key"), undefined, "非集合键不得入库");
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
