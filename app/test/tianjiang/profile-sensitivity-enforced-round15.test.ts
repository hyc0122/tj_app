/**
 * Round15 RED：敏感度只能由注册表决定，客户端 sensitive=false 不得把 provider 写成明文。
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
import { createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const userUUID = "123e4567-e89b-42d3-a456-426614174016";

class MemoryRemote implements ProfileRemote {
  current: ProfileSnapshot = { version: 1, entries: {} };

  async getMetadata() {
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }

  async getCurrent(): Promise<ProfileSnapshot> {
    return structuredClone(this.current);
  }

  async commit(_base: number, entries: ProfileSnapshot["entries"]): Promise<ProfileSnapshot> {
    this.current = { version: this.current.version + 1, entries: structuredClone(entries) };
    return structuredClone(this.current);
  }
}

test("provider 键即使用户提交 sensitive=false 也必须加密，不得继续上传旧明文", async () => {
  const root = createUniqueWorktreeRoot("profile-sensitivity");
  const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
  const remote = new MemoryRemote();
  const sync = new ProfileSync(store, remote, () => 0);
  await sync.login();

  sync.setPersistent("provider.audit-secret", "SECRET_VALUE", false);
  const stored = store.exportStoredSnapshot()["provider.audit-secret"];
  assert.ok(stored, "登记的 provider 键必须进入快照");
  assert.equal(stored.sensitive, true, `provider 必须按注册表加密，实际=${JSON.stringify({
    sensitive: stored.sensitive,
    prefix: stored.value.slice(0, 16),
  })}`);
  assert.match(stored.value, /^tj-profile:v1:/, "密文必须是 tj-profile:v1 前缀，禁止 plain:");
  assert.equal(stored.value.includes("SECRET_VALUE"), false, "导出快照不得包含明文密钥");

  store.set("vendor.tianjiang", "plain:OLD_SECRET", false);
  let rejected = false;
  try {
    await sync.flush();
  } catch {
    rejected = true;
  }
  if (!rejected) {
    const uploaded = remote.current.entries["vendor.tianjiang"];
    assert.equal(
      Boolean(uploaded?.value.startsWith("plain:")),
      false,
      "旧明文 vendor 不得继续上传",
    );
    if (uploaded) assert.equal(uploaded.sensitive, true);
  }

  const theme = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
  const syncTheme = new ProfileSync(theme, remote, () => 0);
  syncTheme.setPersistent("theme", "dark", true);
  const themeEntry = theme.exportStoredSnapshot().theme;
  assert.equal(themeEntry?.sensitive, false, "普通键仍必须按 plain 保存");
  assert.match(themeEntry?.value ?? "", /^plain:/);
  theme.close();
  store.close();
});

test("远端快照篡改敏感度必须失败关闭且不得标记 synced", async () => {
  const root = createUniqueWorktreeRoot("profile-tamper-sensitivity");
  const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
  const remote = new MemoryRemote();
  remote.current = {
    version: 4,
    entries: {
      "vendor.evil": { value: "plain:STOLEN", sensitive: false },
    },
  };
  const sync = new ProfileSync(store, remote, () => 0);
  const result = await sync.reconcile("login");
  assert.equal(result.state, "failed", `篡改敏感度必须失败，实际=${result.state}`);
  assert.equal(sync.status().state, "failed");
  assert.notEqual(sync.status().state, "synced");
  store.close();
});
