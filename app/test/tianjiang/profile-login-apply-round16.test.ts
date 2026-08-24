/**
 * Round16 RED：登录校准必须在账号库上下文中回写真实设置。
 * 缺少 ALS / 账号库时不得把 profile.sqlite 版本抬到远端并标记 synced。
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
import { enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  activateUserDatabase,
  accountDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const userUUID = "123e4567-e89b-42d3-a456-426614174061";
const identity = { issuer: "https://api.j11.com.cn", userId: 1601 };
const sharedDataKey = crypto.randomBytes(32);

class MemoryRemote implements ProfileRemote {
  current: ProfileSnapshot = { version: 1, entries: {} };
  getCurrentCalls = 0;

  async getMetadata() {
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }

  async getCurrent(): Promise<ProfileSnapshot> {
    this.getCurrentCalls += 1;
    return structuredClone(this.current);
  }

  async commit(_base: number, entries: ProfileSnapshot["entries"]): Promise<ProfileSnapshot> {
    this.current = { version: this.current.version + 1, entries: structuredClone(entries) };
    return structuredClone(this.current);
  }
}

function openSync(root: string, remote: MemoryRemote) {
  const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, sharedDataKey));
  return { store, sync: new ProfileSync(store, remote, () => 0) };
}

test("缺少账号库上下文时下载不得标记 synced，也不得抬升已应用版本", async () => {
  const rootA = createUniqueWorktreeRoot("login-apply-a");
  const rootB = createUniqueWorktreeRoot("login-apply-b");
  const originalCwd = process.cwd();
  const remote = new MemoryRemote();
  process.env.NODE_ENV = "prod";

  try {
    process.chdir(rootA);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const { store, sync } = openSync(rootA, remote);
      sync.setPersistent("theme", JSON.stringify({ mode: "dark", primaryColor: "#111111", fontSize: 16 }), false);
      sync.setPersistent("language", "en", false);
      await accountDatabase()("o_vendorConfig").where({ id: "tianjiang" }).update({
        inputValues: JSON.stringify({ apiKey: "sk-from-device-a" }),
      });
      const { notifyAccountSettingsMutated } = await import("../../src/tianjiang/sync/profile-settings-adapter");
      await notifyAccountSettingsMutated();
      await sync.flush();
      store.close();
    });
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootB);
    resetDatabaseRuntimeForServe();
    const storeB = new ProfileStore(rootB, userUUID, new ProfileCrypto(userUUID, sharedDataKey));
    const syncB = new ProfileSync(storeB, remote, () => 0);
    let loginError: unknown;
    try {
      await syncB.login();
    } catch (error) {
      loginError = error;
    }
    assert.equal(
      syncB.status().state,
      "failed",
      `缺少账号库时不得 synced，实际=${syncB.status().state} loginError=${loginError instanceof Error ? loginError.message : String(loginError ?? "")}`,
    );
    assert.notEqual(syncB.status().state, "synced");
    assert.ok(
      storeB.getProfileVersion() < remote.current.version,
      `apply 失败不得把 profile 版本抬到远端 version=${remote.current.version} local=${storeB.getProfileVersion()}`,
    );
    storeB.close();
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

test("登录在账号库上下文中校准后真实设置必须已回写", async () => {
  const rootA = createUniqueWorktreeRoot("login-apply-ok-a");
  const rootB = createUniqueWorktreeRoot("login-apply-ok-b");
  const originalCwd = process.cwd();
  const remote = new MemoryRemote();
  process.env.NODE_ENV = "prod";
  const identityB = { issuer: "https://api.j11.com.cn", userId: 1602 };

  try {
    process.chdir(rootA);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    enterUserStorage(identity);
    const { store, sync } = openSync(rootA, remote);
    await accountDatabase()("o_vendorConfig").where({ id: "tianjiang" }).update({
      inputValues: JSON.stringify({ apiKey: "sk-applied-on-login" }),
    });
    const { notifyAccountSettingsMutated, bindAccountProfileSync } = await import(
      "../../src/tianjiang/sync/profile-settings-adapter"
    );
    bindAccountProfileSync(sync);
    await notifyAccountSettingsMutated();
    await sync.flush();
    store.close();
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());

    process.chdir(rootB);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identityB);
    enterUserStorage(identityB);
    const storeB = new ProfileStore(rootB, userUUID, new ProfileCrypto(userUUID, sharedDataKey));
    const syncB = new ProfileSync(storeB, remote, () => 0);
    bindAccountProfileSync(syncB);
    await syncB.login();
    assert.notEqual(syncB.status().state, "failed");
    const row = await accountDatabase()("o_vendorConfig").where({ id: "tianjiang" }).first();
    const values = JSON.parse(String(row?.inputValues ?? "{}")) as { apiKey?: string };
    assert.equal(values.apiKey, "sk-applied-on-login", "登录校准后账号库必须已写入供应商密钥");
    storeB.close();
  } finally {
    const adapter = await import("../../src/tianjiang/sync/profile-settings-adapter");
    adapter.bindAccountProfileSync(null);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
