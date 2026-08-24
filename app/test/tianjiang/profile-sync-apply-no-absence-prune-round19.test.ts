/**
 * Round19 自审 RED：applyLive 不得再用「快照缺键」剪掉未 tombstone 的供应商。
 * 生产入口：setPersistent(vendor.*) + flush → applyLiveAccountSettings。
 * 复现 runtime-http 写 vendor.synthetic.api_key 后 tianjiang 404。
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

const userUUID = "123e4567-e89b-42d3-a456-426614174192";
const identity = { issuer: "https://api.j11.com.cn", userId: 1912 };

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

test("flush 非规范 vendor.synthetic.api_key 不得剪掉种子 tianjiang", async () => {
  const root = createUniqueWorktreeRoot("apply-no-absence-prune");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";

  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await prepareUserDatabase(identity);
    const remote = new RecordingRemote();
    const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
    const sync = new ProfileSync(store, remote, () => 0, { account: identity });

    const before = await runWithUserStorage(identity, () =>
      accountDatabase()("o_vendorConfig").where({ id: "tianjiang" }).first());
    assert.ok(before, "种子账号必须有 tianjiang");

    sync.setPersistent("vendor.synthetic.api_key", "http-test-secret-value", true);
    await sync.flush();
    assert.equal(sync.status().state, "synced", `flush 必须成功，实际=${sync.status().state}`);

    const after = await runWithUserStorage(identity, () =>
      accountDatabase()("o_vendorConfig").where({ id: "tianjiang" }).first());
    assert.ok(after, "非规范 vendor.* 键不得把 tianjiang 当缺席删除");
    const bogus = await runWithUserStorage(identity, () =>
      accountDatabase()("o_vendorConfig").where({ id: "synthetic.api_key" }).first());
    assert.equal(bogus, undefined, "不得把 vendor.synthetic.api_key 插入成供应商行");
    store.close();
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
