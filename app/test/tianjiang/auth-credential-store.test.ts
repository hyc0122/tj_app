import assert from "node:assert/strict";
import test from "node:test";

import { AuthCredentialStore } from "../../src/tianjiang/auth/auth-credential-store";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";

test("safeStorage 等价存储：加密保存、读取、按账号隔离与清除", () => {
  const memory = new MemoryCredentialStore();
  const store = new AuthCredentialStore(memory);
  const session = {
    serverUrl: "https://api.j11.com.cn",
    token: "business-jwt-secret",
    expiresAt: Date.now() + 60_000,
    user: { id: 7, username: "alice", nickname: "Alice" },
  };

  store.saveAfterLogin("Alice", "SecurePass123!", session);

  assert.deepEqual(store.getSavedCredentials(), {
    username: "alice",
    password: "SecurePass123!",
  });
  assert.equal(store.getSession()?.token, "business-jwt-secret");
  assert.equal(store.getPassword("bob"), undefined);
  assert.equal(store.getSession("bob"), null);

  // 另一账号写入后互不影响。
  store.saveAfterLogin("bob", "OtherPass99", {
    ...session,
    token: "bob-token",
    user: { id: 8, username: "bob", nickname: "Bob" },
  });
  assert.equal(store.getPassword("alice"), "SecurePass123!");
  assert.equal(store.getSession("alice")?.token, "business-jwt-secret");
  assert.equal(store.getActiveUsername(), "bob");

  // 退出只清 token，保留账号密码。
  store.clearSessionOnly();
  assert.equal(store.getSession(), null);
  assert.deepEqual(store.getSavedCredentials(), {
    username: "bob",
    password: "OtherPass99",
  });

  // 清除已保存账号：token、用户名、密码全清。
  store.clearAllSavedAccounts();
  assert.equal(store.getSavedCredentials(), null);
  assert.equal(store.getSession(), null);
  assert.equal(store.getActiveUsername(), undefined);
});

test("过期 token 判定与网络错误不得误删凭据的存储契约", () => {
  const store = new AuthCredentialStore(new MemoryCredentialStore());
  store.saveAfterLogin("alice", "SecurePass123!", {
    serverUrl: "https://api.j11.com.cn",
    token: "expired-token",
    expiresAt: Date.now() - 1_000,
    user: { id: 7, username: "alice", nickname: "Alice" },
  });
  const session = store.getSession();
  assert.ok(session);
  assert.equal(store.isSessionExpired(session), true);

  // 网络暂时失败时调用方不得调用 clear；此处验证 clear 未发生时凭据仍在。
  assert.deepEqual(store.getSavedCredentials(), {
    username: "alice",
    password: "SecurePass123!",
  });
  assert.equal(store.getSession()?.token, "expired-token");
});

test("密码与 token 不得以明文键名落入普通 JSON 日志字段约定", () => {
  const memory = new MemoryCredentialStore();
  const store = new AuthCredentialStore(memory);
  store.saveAfterLogin("alice", "SecurePass123!", {
    serverUrl: "https://api.j11.com.cn",
    token: "business-jwt-secret",
    expiresAt: Date.now() + 60_000,
    user: { id: 7, username: "alice", nickname: "Alice" },
  });
  // Memory 层键名只允许 auth: 前缀隔离，禁止 password/token 裸键。
  assert.equal(memory.get("password"), undefined);
  assert.equal(memory.get("token"), undefined);
  assert.ok(memory.get("auth:password:alice"));
  assert.ok(memory.get("auth:session:alice"));
});

test("个人中心修改用户名或密码后必须迁移安全凭据且删除旧账号键", () => {
  const memory = new MemoryCredentialStore();
  const store = new AuthCredentialStore(memory);
  store.saveAfterLogin("creator", "SecurePass123!", {
    serverUrl: "https://api.j11.com.cn",
    token: "old-token",
    expiresAt: Date.now() + 60_000,
    user: { id: 7, username: "creator", nickname: "创作者" },
  });

  store.updateAfterProfileChange("creator", {
    serverUrl: "https://api.j11.com.cn",
    token: "profile-token",
    expiresAt: Date.now() + 120_000,
    user: { id: 7, username: "creator_new", nickname: "新昵称" },
  });
  assert.deepEqual(store.getSavedCredentials(), {
    username: "creator_new",
    password: "SecurePass123!",
  });
  assert.equal(store.getSession()?.token, "profile-token");
  assert.equal(memory.has("auth:password:creator"), false);
  assert.equal(memory.has("auth:session:creator"), false);

  store.updateAfterPasswordChange("creator_new", "NewSecure456!", {
    serverUrl: "https://api.j11.com.cn",
    token: "password-token",
    expiresAt: Date.now() + 180_000,
    user: { id: 7, username: "creator_new", nickname: "新昵称" },
  });
  assert.deepEqual(store.getSavedCredentials(), {
    username: "creator_new",
    password: "NewSecure456!",
  });
  assert.equal(store.getSession()?.token, "password-token");
});

test("个人中心多键迁移失败时 active、密码和会话必须全部保持旧快照", () => {
  class FailingBatchStore extends MemoryCredentialStore {
    failBatch = false;

    override applyBatch(input: { set: Record<string, string>; delete: string[] }): void {
      if (this.failBatch) throw new Error("injected batch failure");
      super.applyBatch(input);
    }
  }

  const memory = new FailingBatchStore();
  const store = new AuthCredentialStore(memory);
  store.saveAfterLogin("creator", "SecurePass123!", {
    serverUrl: "https://api.j11.com.cn",
    token: "old-token",
    expiresAt: Date.now() + 60_000,
    user: { id: 7, username: "creator", nickname: "创作者" },
  });
  memory.failBatch = true;

  assert.throws(() => store.updateAfterProfileChange("creator", {
    serverUrl: "https://api.j11.com.cn",
    token: "new-token",
    expiresAt: Date.now() + 120_000,
    user: { id: 7, username: "creator_new", nickname: "新昵称" },
  }), /injected batch failure/);
  assert.equal(store.getActiveUsername(), "creator");
  assert.equal(store.getPassword("creator"), "SecurePass123!");
  assert.equal(store.getSession("creator")?.token, "old-token");
  assert.equal(memory.has("auth:password:creator_new"), false);
  assert.equal(memory.has("auth:session:creator_new"), false);
});
