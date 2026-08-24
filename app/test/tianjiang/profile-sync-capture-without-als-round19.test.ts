/**
 * Round19 自审 RED：settings capture 定时器没有环境 ALS 时，
 * 不得把空 live 快照推断成“用户删除了全部供应商”。
 *
 * 生产入口：scheduleAccountSettingsCapture → notifyAccountSettingsMutated
 * → recordLiveSettingsToProfile → flush/applyLive。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import {
  ProfileSync,
  type ProfileRemote,
  type ProfileSnapshot,
} from "../../src/tianjiang/sync/profile-sync";
import { runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  accountDatabase,
  destroyAllDatabaseHandles,
  prepareUserDatabase,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  closeActivatedWorkspaceRuntime,
  createUniqueWorktreeRoot,
} from "./helpers/worktree-runtime";

const userUUID = "123e4567-e89b-42d3-a456-426614174191";
const identity = { issuer: "https://api.j11.com.cn", userId: 1911 };

class RecordingRemote implements ProfileRemote {
  current: ProfileSnapshot = { version: 1, entries: {} };

  async getMetadata() {
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }

  async getCurrent(): Promise<ProfileSnapshot> {
    return structuredClone(this.current);
  }

  async commit(baseVersion: number, entries: ProfileSnapshot["entries"]): Promise<ProfileSnapshot> {
    this.current = { version: baseVersion + 1, entries: structuredClone(entries) };
    return structuredClone(this.current);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("无 ALS 的 capture 定时器不得 tombstone 已有供应商，tianjiang 必须仍可更新", async () => {
  const root = createUniqueWorktreeRoot("capture-no-als");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";

  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await prepareUserDatabase(identity);
    const remote = new RecordingRemote();
    const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
    const sync = new ProfileSync(store, remote, () => 0, { account: identity });
    const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
    adapter.bindAccountSyncBindings(sync);

    await runWithUserStorage(identity, async () => {
      const row = await accountDatabase()("o_vendorConfig").where({ id: "tianjiang" }).first();
      assert.ok(row, "种子账号必须有 tianjiang 供应商");
      await adapter.notifyAccountSettingsMutated();
      await sync.flush();
    });

    // 中文注释：生产 SQL 钩子用 20ms 定时器，回调没有环境 ALS。
    adapter.scheduleAccountSettingsCapture();
    await wait(80);
    await sync.flush();

    const after = await runWithUserStorage(identity, () =>
      accountDatabase()("o_vendorConfig").where({ id: "tianjiang" }).first());
    assert.ok(after, "无 ALS capture 后 tianjiang 供应商必须仍在账号库");
    assert.equal(
      Object.keys(remote.current.entries).some((key) => key === "deleted.vendor.tianjiang"),
      false,
      "不得把空 live 写成 vendor.tianjiang 的 tombstone",
    );
    store.close();
  } finally {
    const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
    adapter.bindAccountSyncBindings(null);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
