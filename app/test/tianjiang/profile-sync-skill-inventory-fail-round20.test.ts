/**
 * Round20 RED：Skill 盘点失败不得被当成用户删除。
 * 生产入口：captureSkillFiles → recordLiveSettingsToProfile → forgetMissingCollectionKeys。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
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
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  closeActivatedWorkspaceRuntime,
  createUniqueWorktreeRoot,
} from "./helpers/worktree-runtime";

const userUUID = "123e4567-e89b-42d3-a456-426614174203";
const identity = { issuer: "https://api.j11.com.cn", userId: 2003 };

class MemoryRemote implements ProfileRemote {
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

test("Skill 盘点失败必须向上失败，且不得生成 skill tombstone", async () => {
  const root = createUniqueWorktreeRoot("r20-skill-inventory");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  const originalReaddir = fs.readdirSync;
  const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");

  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
      const sync = new ProfileSync(store, new MemoryRemote(), () => 0, { account: identity });
      adapter.bindAccountSyncBindings(sync);
      store.set("skill.customuser", JSON.stringify({
        path: "user/custom.md",
        fileName: "custom.md",
        content: "hello",
        kind: "custom",
        sha256: "abc",
      }), false);

      (fs as typeof fs & { readdirSync: typeof fs.readdirSync }).readdirSync = ((dir: fs.PathLike, options?: unknown) => {
        if (String(dir).toLowerCase().includes("skill")) {
          throw new Error("注入：Skills readdir 失败");
        }
        return (originalReaddir as Function).call(fs, dir, options);
      }) as typeof fs.readdirSync;

      let thrown: unknown;
      try {
        await adapter.recordLiveSettingsToProfile(sync);
      } catch (error) {
        thrown = error;
      }

      const pending = store.listPendingMutations();
      const skillPending = pending.filter((item) =>
        item.key.startsWith("skill.") || item.key.startsWith("deleted.skill."));
      const failureReported = sync.status().state === "failed" || Boolean(thrown);
      const destructiveDelete = skillPending.some((item) =>
        item.op === "delete" || item.key.startsWith("deleted.skill."));

      const pendingLabel = skillPending.map((item) => `${item.op}:${item.key}`).join(",") || "(none)";
      assert.equal(
        failureReported && !destructiveDelete && skillPending.length === 0,
        true,
        `failureReported=${failureReported} destructiveDelete=${destructiveDelete} pending=${pendingLabel} state=${sync.status().state} thrown=${thrown instanceof Error ? thrown.message : String(thrown ?? "")}`,
      );
      store.close();
    });
  } finally {
    (fs as typeof fs & { readdirSync: typeof fs.readdirSync }).readdirSync = originalReaddir;
    adapter.bindAccountSyncBindings(null);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
