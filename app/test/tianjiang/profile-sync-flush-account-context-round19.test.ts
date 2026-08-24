/**
 * Round19 自审 RED：生产 ProfileSync.flush / 账号切换不得因缺少环境 ALS
 * 把已提交的远端快照标成失败，也不得把 A 的回写打进 B 的账号库。
 *
 * 生产入口：ProfileSync.setPersistent + flush（登录切换与 shutdown 都走这里）。
 * 禁止用 bindDreamina / 源码字符串 / 模块不存在绕过。
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

const userUUID = "123e4567-e89b-42d3-a456-426614174190";

class RecordingRemote implements ProfileRemote {
  current: ProfileSnapshot = { version: 1, entries: {} };
  commits: Array<{ baseVersion: number; entries: ProfileSnapshot["entries"] }> = [];

  async getMetadata() {
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }

  async getCurrent(): Promise<ProfileSnapshot> {
    return structuredClone(this.current);
  }

  async commit(baseVersion: number, entries: ProfileSnapshot["entries"]): Promise<ProfileSnapshot> {
    this.commits.push({ baseVersion, entries: structuredClone(entries) });
    this.current = { version: baseVersion + 1, entries: structuredClone(entries) };
    return structuredClone(this.current);
  }
}

function openSync(
  root: string,
  remote: RecordingRemote,
  account?: { issuer: string; userId: number },
) {
  const store = new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
  return { store, sync: new ProfileSync(store, remote, () => 0, { account }) };
}

async function readLanguage(): Promise<string | undefined> {
  const row = await accountDatabase()("o_setting").where({ key: "language" }).first();
  return row?.value == null ? undefined : String(row.value);
}

test("无环境 ALS 时 flush 必须提交登记键并标 synced，不得抛缺少中央用户存储上下文", async () => {
  const root = createUniqueWorktreeRoot("flush-no-als");
  const remote = new RecordingRemote();
  const { store, sync } = openSync(root, remote);

  sync.setPersistent("language", "en", false);
  let flushError: unknown;
  try {
    await sync.flush();
  } catch (error) {
    flushError = error;
  }

  assert.equal(
    flushError,
    undefined,
    `flush 不得因无 ALS 失败：${flushError instanceof Error ? flushError.message : String(flushError ?? "")}`,
  );
  assert.equal(sync.status().state, "synced", `flush 后状态必须 synced，实际=${sync.status().state}`);
  const committed = remote.commits.at(-1)?.entries ?? {};
  assert.ok(Object.hasOwn(committed, "language"), "登记键 language 必须进入远端提交");
  assert.equal(store.get("language"), "en");
  store.close();
});

test("绑定账号 A 的 flush 即使环境 ALS 是 B 也只能回写 A，不得污染 B", async () => {
  const root = createUniqueWorktreeRoot("flush-account-isolation");
  const originalCwd = process.cwd();
  const identityA = { issuer: "https://api.j11.com.cn", userId: 1901 };
  const identityB = { issuer: "https://api.j11.com.cn", userId: 1902 };
  process.env.NODE_ENV = "prod";

  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await prepareUserDatabase(identityA);
    await prepareUserDatabase(identityB);
    await runWithUserStorage(identityA, async () => {
      await accountDatabase()("o_setting").where({ key: "language" }).del();
      await accountDatabase()("o_setting").insert({ key: "language", value: "zh-CN" });
    });
    await runWithUserStorage(identityB, async () => {
      await accountDatabase()("o_setting").where({ key: "language" }).del();
      await accountDatabase()("o_setting").insert({ key: "language", value: "zh-CN" });
    });

    const remote = new RecordingRemote();
    const { store, sync } = openSync(root, remote, identityA);
    sync.setPersistent("language", "en", false);

    // 中文注释：模拟登录公共路径——环境 ALS 已是下一账号，仍必须 flush 上一账号。
    await runWithUserStorage(identityB, async () => {
      await sync.flush();
    });

    assert.equal(sync.status().state, "synced", `A 的 flush 必须成功，实际=${sync.status().state}`);
    const languageA = await runWithUserStorage(identityA, () => readLanguage());
    const languageB = await runWithUserStorage(identityB, () => readLanguage());
    assert.equal(languageA, "en", `A 账号库必须回写 en，实际=${languageA}`);
    assert.equal(languageB, "zh-CN", `B 账号库不得被 A 的 flush 污染，实际=${languageB}`);
    store.close();
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
