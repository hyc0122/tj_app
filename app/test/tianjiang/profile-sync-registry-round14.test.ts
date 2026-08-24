import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import {
  ProfileSync,
  type ProfileRemote,
  type ProfileSnapshot,
} from "../../src/tianjiang/sync/profile-sync";
import { createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const userUUID = "123e4567-e89b-42d3-a456-426614174000";

class RecordingProfileRemote implements ProfileRemote {
  current: ProfileSnapshot = { version: 1, entries: {} };
  getCurrentCalls = 0;
  commits: Array<{ baseVersion: number; entries: ProfileSnapshot["entries"] }> = [];

  async getMetadata() {
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }

  async getCurrent(): Promise<ProfileSnapshot> {
    this.getCurrentCalls += 1;
    return structuredClone(this.current);
  }

  async commit(baseVersion: number, entries: ProfileSnapshot["entries"]): Promise<ProfileSnapshot> {
    this.commits.push({ baseVersion, entries: structuredClone(entries) });
    this.current = { version: baseVersion + 1, entries: structuredClone(entries) };
    return structuredClone(this.current);
  }
}

function openStore(root: string): ProfileStore {
  return new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
}

test("setPersistent 生产入口不得把未登记键送进同步快照", async () => {
  const root = createUniqueWorktreeRoot("profile-registry-unregistered");
  const store = openStore(root);
  const remote = new RecordingProfileRemote();
  const sync = new ProfileSync(store, remote, () => 0);
  await sync.login();

  // 生产写入口：登记键应可同步，未登记的 CLI/登录材料不得进入远端快照。
  sync.setPersistent("theme", "dark", false);
  let unregisteredWriteError: unknown;
  try {
    sync.setPersistent("dreamina.device-code", "device-code-must-not-sync", false);
  } catch (error) {
    unregisteredWriteError = error;
  }
  try {
    sync.setPersistent("cli.executablepath", "C:\\Users\\secret\\dreamina.exe", false);
  } catch (error) {
    unregisteredWriteError ??= error;
  }

  assert.match(
    unregisteredWriteError instanceof Error ? unregisteredWriteError.message : "",
    /PROFILE_SYNC_KEY_NOT_REGISTERED/,
    "未登记键必须在 setPersistent 失败关闭",
  );

  await sync.flush();
  const exported = store.exportStoredSnapshot();
  const committed = remote.commits.at(-1)?.entries ?? {};
  assert.equal(
    Object.hasOwn(exported, "dreamina.device-code") || Object.hasOwn(committed, "dreamina.device-code"),
    false,
    "未登记键被导出",
  );
  assert.equal(
    Object.hasOwn(exported, "cli.executablepath") || Object.hasOwn(committed, "cli.executablepath"),
    false,
    "未登记键被导出",
  );
  assert.ok(Object.hasOwn(committed, "theme"), "已登记主题键必须进入提交快照");

  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("本地库里已有的未登记键保留本机但不上传", async () => {
  const root = createUniqueWorktreeRoot("profile-registry-local-keep");
  const store = openStore(root);
  // 直接写库存模拟历史脏数据，绕过尚未存在的注册表门。
  store.set("theme", "light", false);
  store.set("wsl.distribution", "Ubuntu-22.04", false);
  store.applyStoredSnapshot(store.exportStoredSnapshot(), 2);
  const remote = new RecordingProfileRemote();
  remote.current = { version: 1, entries: {} };
  const sync = new ProfileSync(store, remote, () => 0);

  // 生产入口：本机版本更高时 login 会导出快照并提交。
  await sync.login();

  assert.equal(store.get("wsl.distribution"), "Ubuntu-22.04", "未登记键必须保留在本地库");
  const lastCommit = remote.commits.at(-1)?.entries ?? remote.current.entries;
  assert.equal(
    Object.hasOwn(lastCommit, "wsl.distribution"),
    false,
    "未登记键被导出",
  );
  assert.ok(Object.hasOwn(lastCommit, "theme"), "已登记键仍应上传");

  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});
