import assert from "node:assert/strict";
import test from "node:test";

import { AuthCredentialStore } from "../../src/tianjiang/auth/auth-credential-store";
import { bootstrapAuthState } from "../../src/tianjiang/auth/auth-bootstrap";
import {
  MemoryCentralSessionStore,
  type CentralSession,
} from "../../src/tianjiang/auth/central-session";
import { CentralServiceUnavailableError } from "../../src/tianjiang/auth/central-service-error";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";

function baseDeps() {
  const credentialStore = new AuthCredentialStore(new MemoryCredentialStore());
  const sessionStore = new MemoryCentralSessionStore();
  return { credentialStore, sessionStore };
}

test("有效 token 自动登录并下发会话", async () => {
  const { credentialStore, sessionStore } = baseDeps();
  credentialStore.saveAfterLogin("alice", "SecurePass123!", {
    serverUrl: "https://api.j11.com.cn",
    token: "valid-token",
    expiresAt: Date.now() + 60_000,
    user: { id: 7, username: "alice", nickname: "Alice" },
  });

  const result = await bootstrapAuthState({
    credentialStore,
    sessionStore,
    gateway: {
      validate: async (session: CentralSession) => session,
    } as any,
    readCookieSessionId: () => "",
    onLogin: async () => ({ keyServiceDegraded: false }),
    activateUserDatabase: async () => undefined,
  });

  assert.equal(result.mode, "auto_login");
  assert.equal(result.user?.username, "alice");
  assert.ok(result.sessionCookie?.id);
  assert.ok(sessionStore.get(result.sessionCookie!.id));
});

test("过期 token 清除并回填账号密码", async () => {
  const { credentialStore, sessionStore } = baseDeps();
  credentialStore.saveAfterLogin("alice", "SecurePass123!", {
    serverUrl: "https://api.j11.com.cn",
    token: "expired-token",
    expiresAt: Date.now() - 1_000,
    user: { id: 7, username: "alice", nickname: "Alice" },
  });

  const result = await bootstrapAuthState({
    credentialStore,
    sessionStore,
    gateway: { validate: async (s: CentralSession) => s } as any,
    readCookieSessionId: () => "",
    onLogin: async () => ({ keyServiceDegraded: false }),
    activateUserDatabase: async () => undefined,
  });

  assert.equal(result.mode, "fill");
  assert.equal(result.username, "alice");
  assert.equal(result.password, "SecurePass123!");
  assert.equal(credentialStore.getSession(), null);
});

test("服务器拒绝 token 时清除 token 并回填账号密码", async () => {
  const { credentialStore, sessionStore } = baseDeps();
  credentialStore.saveAfterLogin("alice", "SecurePass123!", {
    serverUrl: "https://api.j11.com.cn",
    token: "rejected-token",
    expiresAt: Date.now() + 60_000,
    user: { id: 7, username: "alice", nickname: "Alice" },
  });

  const result = await bootstrapAuthState({
    credentialStore,
    sessionStore,
    gateway: {
      validate: async () => {
        const error = new Error("中央会话失效") as Error & { status: number };
        error.status = 401;
        throw error;
      },
    } as any,
    readCookieSessionId: () => "",
    onLogin: async () => ({ keyServiceDegraded: false }),
    activateUserDatabase: async () => undefined,
  });

  assert.equal(result.mode, "fill");
  assert.equal(result.username, "alice");
  assert.equal(result.password, "SecurePass123!");
  assert.equal(credentialStore.getSession(), null);
});

test("网络错误不误删凭据", async () => {
  const { credentialStore, sessionStore } = baseDeps();
  credentialStore.saveAfterLogin("alice", "SecurePass123!", {
    serverUrl: "https://api.j11.com.cn",
    token: "maybe-valid-token",
    expiresAt: Date.now() + 60_000,
    user: { id: 7, username: "alice", nickname: "Alice" },
  });

  const result = await bootstrapAuthState({
    credentialStore,
    sessionStore,
    gateway: {
      validate: async () => {
        throw new CentralServiceUnavailableError(new Error("fetch failed"));
      },
    } as any,
    readCookieSessionId: () => "",
    onLogin: async () => ({ keyServiceDegraded: false }),
    activateUserDatabase: async () => undefined,
  });

  assert.equal(result.mode, "offline");
  assert.equal(result.username, "alice");
  assert.equal(result.password, "SecurePass123!");
  assert.equal(credentialStore.getSession()?.token, "maybe-valid-token");
  assert.match(result.message ?? "", /网络|凭据/);
});
