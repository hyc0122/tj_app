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
import { createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const userUUID = "323e4567-e89b-42d3-a456-426614174000";

class MetadataAwareRemote implements ProfileRemote {
  current: ProfileSnapshot = {
    version: 4,
    entries: { theme: { value: "plain:dark", sensitive: false } },
  };
  getCurrentCalls = 0;
  getMetadataCalls = 0;
  commits = 0;

  async getMetadata(): Promise<{ version: number; etag: string }> {
    this.getMetadataCalls += 1;
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }

  async getCurrent(): Promise<ProfileSnapshot> {
    this.getCurrentCalls += 1;
    return structuredClone(this.current);
  }

  async commit(baseVersion: number, entries: ProfileSnapshot["entries"]): Promise<ProfileSnapshot> {
    this.commits += 1;
    this.current = { version: baseVersion + 1, entries: structuredClone(entries) };
    return structuredClone(this.current);
  }
}

test("版本相同且无 pending 时只查 metadata，完整快照下载次数必须为 0", async () => {
  const root = createUniqueWorktreeRoot("profile-metadata-unchanged");
  const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
  store.set("theme", "dark", false);
  store.applyStoredSnapshot(store.exportStoredSnapshot(), 4);
  const remote = new MetadataAwareRemote();
  const sync = new ProfileSync(store, remote, () => 0);

  // 生产入口：登录校准。版本已对齐且没有待提交键。
  await sync.login();

  assert.equal(
    remote.getCurrentCalls,
    0,
    `完整快照下载次数为 ${remote.getCurrentCalls} 而期望 0`,
  );
  assert.equal(remote.getMetadataCalls, 1, "版本对齐时必须走轻量 metadata");
  assert.equal(remote.commits, 0);
  assert.equal(store.get("theme"), "dark");

  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("中央 adapter 的 ProfileRemote 必须暴露 getMetadata 生产入口", async () => {
  const { CentralRuntimeAdapter } = await import("../../src/tianjiang/runtime/central-runtime-adapter");
  const adapter = Object.create(CentralRuntimeAdapter.prototype) as {
    profileRemote: () => ProfileRemote;
    forward?: unknown;
  };
  // 只探测生产对象形状，不发真实中央请求。
  assert.equal(typeof adapter.profileRemote, "function");
  const created = CentralRuntimeAdapter.prototype.profileRemote.call({
    session: { user: { id: 1 } },
    deviceUuid: "00000000-0000-4000-8000-000000000001",
    forward: async () => {
      throw new Error("测试不得发起真实中央请求");
    },
  });
  assert.equal(
    typeof created.getMetadata,
    "function",
    "ProfileRemote 没有 metadata",
  );
});
