/**
 * Round20 RED：删除 profile_settings 原值与写入 pending journal 必须同一事务。
 * 生产入口：forgetMissingCollectionKeys → recordExplicitDelete。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import Database from "better-sqlite3";

import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import {
  ProfileSync,
  type ProfileRemote,
  type ProfileSnapshot,
} from "../../src/tianjiang/sync/profile-sync";
import { createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const userUUID = "123e4567-e89b-42d3-a456-426614174202";

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

function inspect(databasePath: string): { originalStillPresent: boolean; durableDeletePresent: boolean } {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const original = database.prepare(
      "SELECT setting_key FROM profile_settings WHERE setting_key = ?",
    ).get("vendor.keepme") as { setting_key?: string } | undefined;
    const pending = database.prepare(
      "SELECT op FROM profile_pending_mutations WHERE setting_key = ?",
    ).get("vendor.keepme") as { op?: string } | undefined;
    return {
      originalStillPresent: Boolean(original),
      durableDeletePresent: pending?.op === "delete",
    };
  } finally {
    database.close();
  }
}

test("删除原值后、写入 pending 前失败时删除意图不得永久丢失", () => {
  const root = createUniqueWorktreeRoot("r20-atomic-journal");
  const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
  const remote = new MemoryRemote();
  const sync = new ProfileSync(store, remote, () => 0);
  store.set("vendor.keepme", JSON.stringify({ inputValues: {}, models: [], enable: 1 }), true);

  const originalUpsert = store.upsertPendingMutation.bind(store);
  store.upsertPendingMutation = (mutation) => {
    if (mutation.op === "delete" && mutation.key === "vendor.keepme") {
      throw new Error("注入：profile_settings 已删、pending 尚未写入");
    }
    return originalUpsert(mutation);
  };

  let caught: unknown;
  try {
    sync.forgetMissingCollectionKeys(new Set(), ["vendor."]);
  } catch (error) {
    caught = error;
  }
  assert.match(
    caught instanceof Error ? caught.message : "",
    /注入/,
    "必须打到删除路径中的故障注入",
  );

  const after = inspect(store.databasePath);
  assert.equal(
    after.originalStillPresent || after.durableDeletePresent,
    true,
    `原值和 durable delete 至少保留一个，originalStillPresent=${after.originalStillPresent} durableDeletePresent=${after.durableDeletePresent}`,
  );
  store.close();
});
