/**
 * Round17 RED：失败登录必须恢复旧 ProfileSync 绑定，A 的设置不得写入 B 远端。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import { ProfileSync, type ProfileRemote, type ProfileSnapshot } from "../../src/tianjiang/sync/profile-sync";
import {
  bindAccountProfileSync,
  notifyAccountSettingsMutated,
} from "../../src/tianjiang/sync/profile-settings-adapter";
import { enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  activateUserDatabase,
  accountDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

class MemoryRemote implements ProfileRemote {
  label: string;
  current: ProfileSnapshot = { version: 1, entries: {} };
  commits: ProfileSnapshot["entries"][] = [];
  constructor(label: string) {
    this.label = label;
  }
  async getMetadata() {
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }
  async getCurrent() {
    return structuredClone(this.current);
  }
  async commit(_base: number, entries: ProfileSnapshot["entries"]) {
    this.commits.push(structuredClone(entries));
    this.current = { version: this.current.version + 1, entries: structuredClone(entries) };
    return structuredClone(this.current);
  }
}

test("绑定切换到 B 后若失败必须恢复 A，A 再保存只进入 A 远端", async () => {
  const root = createUniqueWorktreeRoot("r17-bind-iso");
  const originalCwd = process.cwd();
  const identityA = { issuer: "https://api.j11.com.cn", userId: 1731 };
  const remoteA = new MemoryRemote("A");
  const remoteB = new MemoryRemote("B");
  const key = crypto.randomBytes(32);
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityA);
    await runWithUserStorage(identityA, async () => {
      const storeA = new ProfileStore(root, "123e4567-e89b-42d3-a456-426614174081", new ProfileCrypto("123e4567-e89b-42d3-a456-426614174081", key));
      const syncA = new ProfileSync(storeA, remoteA, () => 0);
      bindAccountProfileSync(syncA);
      await accountDatabase()("o_setting").insert({ key: "language", value: "zh-CN" }).catch(async () => {
        await accountDatabase()("o_setting").where({ key: "language" }).update({ value: "zh-CN" });
      });
      await notifyAccountSettingsMutated();
      await syncA.flush();
      const before = remoteA.commits.length;

      const storeB = new ProfileStore(root, "223e4567-e89b-42d3-a456-426614174082", new ProfileCrypto("223e4567-e89b-42d3-a456-426614174082", crypto.randomBytes(32)));
      const syncB = new ProfileSync(storeB, remoteB, () => 0);
      bindAccountProfileSync(syncB);
      // 模拟登录 B 失败后生产必须恢复 A 绑定。当前实现若未恢复，后续 notify 会写到 B。
      const { restoreAccountSyncBindings } = await import("../../src/tianjiang/sync/profile-settings-adapter");
      assert.equal(typeof restoreAccountSyncBindings, "function", "必须提供可测试的绑定恢复入口");
      restoreAccountSyncBindings!(syncA);

      enterUserStorage(identityA);
      await accountDatabase()("o_setting").where({ key: "language" }).update({ value: "en" });
      await notifyAccountSettingsMutated();
      await syncA.flush();
      assert.ok(remoteA.commits.length > before, "失败恢复后 A 必须仍能同步");
      assert.equal(remoteB.commits.length, 0, `失败登录不得把 A 的设置写入 B 远端，B commits=${remoteB.commits.length}`);
      const last = remoteA.commits.at(-1) ?? {};
      assert.match((last.language?.value ?? ""), /en/, `A 远端必须更新 language，实际=${last.language?.value}`);
      storeA.close();
      storeB.close();
    });
  } finally {
    bindAccountProfileSync(null);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
