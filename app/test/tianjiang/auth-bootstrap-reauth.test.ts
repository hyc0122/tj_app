import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthCredentialStore,
} from "../../src/tianjiang/auth/auth-credential-store";
import {
  bootstrapAuthState,
  REAUTH_REQUIRED_MESSAGE,
} from "../../src/tianjiang/auth/auth-bootstrap";
import {
  MemoryCentralSessionStore,
  type CentralSession,
} from "../../src/tianjiang/auth/central-session";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";

test("auth:active-username 不可解密时进入 reauth_required 并保留 device/profile 键", async () => {
  const memory = new MemoryCredentialStore();
  const credentialStore = new AuthCredentialStore(memory);
  credentialStore.saveAfterLogin("alice", "SecurePass123!", {
    serverUrl: "https://api.j11.com.cn",
    token: "token",
    expiresAt: Date.now() + 60_000,
    user: { id: 7, username: "alice", nickname: "Alice" },
  });
  memory.set("device-recovery-private:dev-1", "PRIVATE");
  memory.set("profile-key:user-1", "PROFILE");
  memory.markUndecryptable("auth:active-username");

  const result = await bootstrapAuthState({
    credentialStore,
    sessionStore: new MemoryCentralSessionStore(),
    gateway: { validate: async (s: CentralSession) => s } as any,
    readCookieSessionId: () => "",
    onLogin: async () => ({ keyServiceDegraded: false }),
    activateUserDatabase: async () => undefined,
  });

  assert.equal(result.mode, "reauth_required");
  assert.equal(result.message, REAUTH_REQUIRED_MESSAGE);
  assert.equal(result.password, undefined);
  // 不得删除 device/profile
  assert.equal(memory.getCiphertext("device-recovery-private:dev-1"), "PRIVATE");
  assert.equal(memory.getCiphertext("profile-key:user-1"), "PROFILE");
  assert.doesNotMatch(JSON.stringify(result), /decryptString|safeStorage/i);
});

test("session 密文不可解密时 reauth_required 且不 silent none", async () => {
  const memory = new MemoryCredentialStore();
  const credentialStore = new AuthCredentialStore(memory);
  credentialStore.saveAfterLogin("bob", "OtherPass99!", {
    serverUrl: "https://api.j11.com.cn",
    token: "tok",
    expiresAt: Date.now() + 60_000,
    user: { id: 8, username: "bob", nickname: "Bob" },
  });
  memory.markUndecryptable("auth:session:bob");

  const result = await bootstrapAuthState({
    credentialStore,
    sessionStore: new MemoryCentralSessionStore(),
    gateway: { validate: async (s: CentralSession) => s } as any,
    readCookieSessionId: () => "",
    onLogin: async () => ({ keyServiceDegraded: false }),
    activateUserDatabase: async () => undefined,
  });

  assert.equal(result.mode, "reauth_required");
  assert.match(result.message ?? "", /重新输入账号密码|无法解密/);
  assert.notEqual(result.mode, "none");
});
