/**
 * Round20 RED：远端 commit 已成功但响应丢失时，重启后不得再次 commit。
 * 生产入口：ProfileSync.flush()。禁止把「commit 后未清 pending」旧测试当证据。
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

const userUUID = "123e4567-e89b-42d3-a456-426614174201";

class DropAfterCommitRemote implements ProfileRemote {
  current: ProfileSnapshot = { version: 1, entries: {} };
  commitCalls = 0;
  dropNextResponse = false;

  async getMetadata() {
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }

  async getCurrent(): Promise<ProfileSnapshot> {
    return structuredClone(this.current);
  }

  async commit(baseVersion: number, entries: ProfileSnapshot["entries"]): Promise<ProfileSnapshot> {
    this.commitCalls += 1;
    if (baseVersion !== this.current.version) {
      throw new Error(`个人配置基础版本已过期 base=${baseVersion} current=${this.current.version}`);
    }
    this.current = { version: baseVersion + 1, entries: structuredClone(entries) };
    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      // 中文注释：远端已落盘，仅响应丢失。
      throw new Error("连接已断开");
    }
    return structuredClone(this.current);
  }
}

test("远端 commit 成功但响应丢失后，重启 flush 不得再次提升版本", async () => {
  const root = createUniqueWorktreeRoot("r20-commit-loss");
  const dataKey = crypto.randomBytes(32);
  const remote = new DropAfterCommitRemote();
  const firstStore = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, dataKey));
  const firstSync = new ProfileSync(firstStore, remote, () => 0);

  firstSync.setPersistent("language", "en", false);
  remote.dropNextResponse = true;
  await assert.rejects(() => firstSync.flush(), /连接已断开/);
  assert.equal(remote.commitCalls, 1, `第一次必须已经 commit，实际=${remote.commitCalls}`);
  assert.equal(remote.current.version, 2, `远端必须已到 version 2，实际=${remote.current.version}`);
  assert.ok(firstStore.hasPendingMutations(), "响应丢失后本地 pending 必须仍在");
  firstStore.close();

  const restarted = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, dataKey));
  const secondSync = new ProfileSync(restarted, remote, () => 0);
  await secondSync.flush();

  assert.equal(
    remote.commitCalls,
    1,
    `重启后不得再次 commit，commitCalls=${remote.commitCalls} version=${remote.current.version}`,
  );
  assert.equal(remote.current.version, 2, `远端 version 不得再次提升，实际=${remote.current.version}`);
  assert.equal(secondSync.status().state, "synced");
  assert.equal(restarted.hasPendingMutations(), false, "确认远端已包含同一 pending 后必须清 pending");
  assert.equal(restarted.get("language"), "en");
  restarted.close();
});
