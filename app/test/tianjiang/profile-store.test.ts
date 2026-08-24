import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { ProfileCrypto, wrapUserDataKey, unwrapUserDataKey } from "../../src/tianjiang/crypto/profile-crypto";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";

test("个人敏感配置使用用户绑定的 AES-256-GCM 密文且用户间不可互解", () => {
  const dataKey = Buffer.alloc(32, 7);
  const userA = new ProfileCrypto("018f3d6e-2d9e-7b6c-8a9b-1234567890ab", dataKey);
  const userB = new ProfileCrypto("018f3d6e-2d9e-7b6c-8a9b-1234567890ac", dataKey);
  const encrypted = userA.encrypt("model-key-plaintext");
  assert.match(encrypted, /^tj-profile:v1:/);
  assert.equal(userA.decrypt(encrypted), "model-key-plaintext");
  assert.throws(() => userB.decrypt(encrypted), /个人配置密文认证失败/);
});

test("用户数据密钥由平台包装密钥包裹且不依赖登录密码", () => {
  const platformKey = Buffer.alloc(32, 3);
  const dataKey = Buffer.alloc(32, 9);
  const userUUID = "018f3d6e-2d9e-7b6c-8a9b-1234567890ab";
  const wrapped = wrapUserDataKey(userUUID, dataKey, platformKey);
  assert.doesNotMatch(wrapped, new RegExp(dataKey.toString("hex")));
  assert.deepEqual(unwrapUserDataKey(userUUID, wrapped, platformKey), dataKey);

  const credentials = new MemoryCredentialStore();
  credentials.set(`profile-key:${userUUID}`, wrapped);
  // 密码重置不会参与数据密钥推导，凭据中的包裹材料仍可正常解开。
  assert.deepEqual(unwrapUserDataKey(userUUID, credentials.get(`profile-key:${userUUID}`)!, platformKey), dataKey);
});

test("profile.sqlite 按用户隔离且磁盘中不存在测试模型密钥明文", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-profile-"));
  const userA = "018f3d6e-2d9e-7b6c-8a9b-1234567890ab";
  const userB = "018f3d6e-2d9e-7b6c-8a9b-1234567890ac";
  const secret = "model-key-test-value-should-not-leak";
  const storeA = new ProfileStore(root, userA, new ProfileCrypto(userA, Buffer.alloc(32, 1)));
  const storeB = new ProfileStore(root, userB, new ProfileCrypto(userB, Buffer.alloc(32, 2)));
  try {
    storeA.set("model.openai.apiKey", secret, true);
    storeA.set("theme.mode", "dark", false);
    assert.equal(storeA.get("model.openai.apiKey"), secret);
    assert.equal(storeA.get("theme.mode"), "dark");
    assert.equal(storeB.get("model.openai.apiKey"), undefined);
    assert.notEqual(storeA.databasePath, storeB.databasePath);
    assert.doesNotMatch(fs.readFileSync(storeA.databasePath).toString("latin1"), new RegExp(secret));
    assert.deepEqual(storeA.listKeys().sort(), ["model.openai.apiKey", "theme.mode"]);
  } finally {
    storeA.close();
    storeB.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ProfileStore 初始化中途失败必须关闭已经打开的 SQLite 句柄", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-profile-constructor-failure-"));
  const userUUID = "018f3d6e-2d9e-7b6c-8a9b-1234567890ad";
  const userDirectory = path.join(root, "users", userUUID);
  const databasePath = path.join(userDirectory, "profile.sqlite");
  fs.mkdirSync(userDirectory, { recursive: true });

  // 预置不兼容的元数据表，让构造器在 SQLite 已打开且 WAL 已设置后执行 INSERT 失败。
  const seed = new Database(databasePath);
  seed.exec("CREATE TABLE profile_meta (broken_column TEXT)");
  seed.close();

  try {
    assert.throws(
      () => new ProfileStore(root, userUUID, new ProfileCrypto(userUUID, Buffer.alloc(32, 3))),
      /meta_key|column/i,
    );

    let deletionError = "";
    try {
      fs.rmSync(root, { recursive: true });
    } catch (error) {
      deletionError = (error as NodeJS.ErrnoException).code ?? String(error);
    }
    assert.equal(deletionError, "", "构造失败后不得残留阻止目录删除的 SQLite 句柄");
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // RED 阶段的泄漏句柄会阻止 Windows 清理；进程退出后由测试临时目录统一回收。
    }
  }
});
