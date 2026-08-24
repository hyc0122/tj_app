import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import {
  ProfileConflictError,
  ProfileSync,
  type ProfileRemote,
  type ProfileSnapshot,
} from "../../src/tianjiang/sync/profile-sync";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const userUUID = "123e4567-e89b-42d3-a456-426614174000";

class FakeProfileRemote implements ProfileRemote {
  current: ProfileSnapshot = { version: 1, entries: {} };
  history: ProfileSnapshot[] = [];
  commits: Array<{ baseVersion: number; entries: ProfileSnapshot["entries"] }> = [];
  conflictOnce = false;

  async getMetadata() {
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }

  async getCurrent(): Promise<ProfileSnapshot> {
    return structuredClone(this.current);
  }

  async commit(baseVersion: number, entries: ProfileSnapshot["entries"]): Promise<ProfileSnapshot> {
    this.commits.push({ baseVersion, entries: structuredClone(entries) });
    if (this.conflictOnce) {
      this.conflictOnce = false;
      this.history.unshift(structuredClone(this.current));
      this.current = {
        version: this.current.version + 1,
        entries: { ...this.current.entries, language: { value: "plain:zh-CN", sensitive: false } },
      };
      throw new ProfileConflictError();
    }
    if (baseVersion !== this.current.version) throw new ProfileConflictError();
    this.history.unshift(structuredClone(this.current));
    this.current = { version: baseVersion + 1, entries: structuredClone(entries) };
    return structuredClone(this.current);
  }
}

test("登录新设备立即恢复个人配置且用户数据互不混用", async () => {
  await runWithTemporaryAccount("profile-sync-restore", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-profile-sync-"));
    const dataKey = crypto.randomBytes(32);
    const cryptoForUser = new ProfileCrypto(userUUID, dataKey);
    const sourceStore = new ProfileStore(root, userUUID, cryptoForUser);
    sourceStore.set("provider.main", "provider-value-for-test", true);
    sourceStore.set("theme", "dark", false);
    const remote = new FakeProfileRemote();
    remote.current = { version: 3, entries: sourceStore.exportStoredSnapshot() };
    sourceStore.close();

    const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tj-profile-fresh-"));
    const freshStore = new ProfileStore(freshRoot, userUUID, cryptoForUser);
    const sync = new ProfileSync(freshStore, remote);
    await sync.login();
    assert.equal(freshStore.get("provider.main"), "provider-value-for-test");
    assert.equal(freshStore.get("theme"), "dark");
    assert.equal(freshStore.getProfileVersion(), 3);
    freshStore.close();

    const otherUser = "223e4567-e89b-42d3-a456-426614174000";
    const otherStore = new ProfileStore(freshRoot, otherUser, new ProfileCrypto(otherUser, crypto.randomBytes(32)));
    assert.equal(otherStore.get("theme"), undefined);
    otherStore.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(freshRoot, { recursive: true, force: true });
  });
});

test("持久配置五秒防抖，冲突后按稳定键合并且敏感项只上传密文", async () => {
  await runWithTemporaryAccount("profile-sync-merge", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-profile-merge-"));
  const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
  const remote = new FakeProfileRemote();
  remote.current = {
    version: 5,
    entries: {
      theme: { value: "plain:light", sensitive: false },
      language: { value: "plain:en-US", sensitive: false },
    },
  };
  const timers: Array<{ delay: number; run: () => void }> = [];
  const sync = new ProfileSync(store, remote, (run, delay) => {
    timers.push({ delay, run });
    return timers.length;
  });
  await sync.login();
  sync.setPersistent("theme", "dark", false);
  sync.setPersistent("provider.main", "provider-value-for-test", true);
  assert.equal(timers.at(-1)?.delay, 5_000);

  remote.conflictOnce = true;
  await sync.flush();
  assert.equal(remote.current.version, 7);
  assert.equal(remote.current.entries.theme.value, "plain:dark");
  assert.equal(remote.current.entries.language.value, "plain:zh-CN");
  const sensitive = remote.current.entries["provider.main"];
  assert.equal(sensitive.sensitive, true);
  assert.match(sensitive.value, /^tj-profile:v1:/);
  assert.equal(JSON.stringify(remote.commits).includes("provider-value-for-test"), false);
  assert.equal(remote.history.some((item) => item.entries.theme?.value === "plain:light"), true);
  assert.equal(sync.status().state, "synced");
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
  });
});
