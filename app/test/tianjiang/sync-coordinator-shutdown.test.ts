import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ShutdownGate } from "../../src/tianjiang/runtime/shutdown-gate";
import {
  CentralAuthGateway,
  createTestOnlyLoopbackPolicy,
  type CentralSession,
} from "../../src/tianjiang/auth/central-session";
import { KeyServiceUnavailableError } from "../../src/tianjiang/auth/key-service-error";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";
import { UserKeyRecoveryClient } from "../../src/tianjiang/crypto/user-key-recovery";
import {
  closeRuntimeProjects,
  createShutdownPhaseState,
  executeRetryableShutdownPhases,
  SyncCoordinator,
} from "../../src/tianjiang/runtime/sync-coordinator";

test("协调器发布失败保留打开项目，ShutdownGate 第二次请求会再次发布", async () => {
  let publishAttempts = 0;
  let localCloseCount = 0;
  const projects = new Map<string, any>([[
    "team-project",
    {
      kind: "team",
      sync: {
        close: async () => {
          publishAttempts += 1;
          if (publishAttempts === 1) throw new Error("publish failed");
        },
      },
      local: {
        close: () => {
          localCloseCount += 1;
        },
      },
    },
  ]]);
  const events: string[] = [];
  const gate = new ShutdownGate({
    closeRuntime: () => closeRuntimeProjects(projects),
    quit: () => events.push("quit"),
    relaunch: () => events.push("relaunch"),
    onFailure: async () => {
      events.push("failure");
    },
  });

  await gate.request(false);
  assert.equal(publishAttempts, 1);
  assert.equal(projects.has("team-project"), true);
  assert.equal(localCloseCount, 0);
  assert.deepEqual(events, ["failure"]);

  await gate.request(false);
  assert.equal(publishAttempts, 2);
  assert.equal(projects.size, 0);
  assert.equal(localCloseCount, 1);
  assert.deepEqual(events, ["failure", "quit"]);
});

test("协调器中段失败重试时跳过已完成的 profile flush，并继续剩余阶段", async () => {
  const state = createShutdownPhaseState();
  const events: string[] = [];
  let projectAttempts = 0;
  const actions = {
    stopKeyRetry: () => { events.push("timer:stopped"); },
    flushProfile: async () => { events.push("profile:flushed"); },
    closeProjects: async () => {
      projectAttempts += 1;
      events.push(`projects:${projectAttempts}`);
      if (projectAttempts === 1) throw new Error("project publish failed");
    },
    closeProfileStore: () => { events.push("profile:closed"); },
    clearProfileKey: () => { events.push("key:cleared"); },
  };

  await assert.rejects(
    () => executeRetryableShutdownPhases(state, actions),
    /project publish failed/,
  );
  await executeRetryableShutdownPhases(state, actions);

  assert.deepEqual(events, [
    "timer:stopped",
    "profile:flushed",
    "projects:1",
    "projects:2",
    "profile:closed",
    "key:cleared",
  ]);
  assert.equal(state.complete, true);
});

test("shutdown 必须禁止重新调度并等待已在途 profile key recovery", async () => {
  const dataRoot = path.resolve(process.cwd(), "..", ".tmp", "profile-key-recovery-shutdown");
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  const session: CentralSession = {
    id: "profile-key-shutdown",
    serverUrl: "https://api.j11.com.cn",
    token: "test-only-token",
    expiresAt: Date.now() + 60_000,
    validatedAt: Date.now(),
    user: { id: 9001, username: "shutdown-user", nickname: "" },
  };
  const coordinator = new SyncCoordinator(
    dataRoot,
    new CentralAuthGateway(),
    new MemoryCredentialStore(),
  );
  Object.assign(coordinator as unknown as Record<string, unknown>, {
    session,
    remote: {},
    online: true,
    deviceActive: true,
    profileFailure: {
      code: "KEY_SERVICE_UNAVAILABLE",
      message: "个人密钥服务暂不可用，恢复后将自动重试",
      retryable: true,
    },
    keyRetryUserUuid: "11111111-1111-4111-a111-111111111111",
  });

  const originalLoadOrRecover = UserKeyRecoveryClient.prototype.loadOrRecover;
  const barrier = deferred();
  const started = deferred();
  let attempts = 0;
  let recovery: Promise<unknown> | undefined;
  let shutdown: Promise<void> | undefined;
  try {
    UserKeyRecoveryClient.prototype.loadOrRecover = async () => {
      attempts += 1;
      started.resolve();
      await barrier.promise;
      throw new KeyServiceUnavailableError();
    };
    recovery = coordinator.retryProfileSync(session);
    await started.promise;
    let shutdownSettled = false;
    shutdown = coordinator.shutdown().then(() => { shutdownSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(shutdownSettled, false, "在途密钥恢复结束前 shutdown 不得完成");

    barrier.resolve();
    await Promise.all([recovery, shutdown]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1, "shutdown 开始后不得重新调度密钥恢复");
    assert.deepEqual(coordinator.backgroundWorkSnapshot(), {
      acceptingKeyRecovery: false,
      keyRecoveryInFlight: false,
      keyRetryTimerActive: false,
    });
  } finally {
    barrier.resolve();
    UserKeyRecoveryClient.prototype.loadOrRecover = originalLoadOrRecover;
    await Promise.allSettled([recovery, shutdown].filter((item): item is Promise<unknown> => Boolean(item)));
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("profile key recovery 登录失败必须关闭局部 SQLite 并清零未接管密钥", async () => {
  const dataRoot = path.resolve(process.cwd(), "..", ".tmp", "profile-key-recovery-owned-resources");
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  const session = createSession("owned-resource-session", 9101, "owned-resource-user");
  const recoveredKey = Buffer.alloc(32, 0x5a);
  const coordinator = new SyncCoordinator(
    dataRoot,
    new CentralAuthGateway(),
    new MemoryCredentialStore(),
    {
      createKeyRecoveryClient: () => ({
        deviceIdentity: () => ({ publicKey: "unused", publicFingerprint: "unused" }),
        loadOrRecover: async () => recoveredKey,
      }),
    },
  );
  Object.assign(coordinator as unknown as Record<string, unknown>, {
    session,
    remote: {
      profileRemote: () => ({
        getCurrent: async () => { throw new Error("synthetic profile login failure"); },
        commit: async () => { throw new Error("unexpected profile commit"); },
      }),
    },
    online: true,
    deviceActive: true,
    profileFailure: {
      code: "KEY_SERVICE_UNAVAILABLE",
      message: "个人密钥服务暂不可用，恢复后将自动重试",
      retryable: true,
    },
    keyRetryUserUuid: "22222222-2222-4222-a222-222222222222",
  });

  try {
    const status = await coordinator.retryProfileSync(session);
    assert.equal(status.failureCode, "KEY_RECOVERY_FAILED");
    await coordinator.shutdown();

    let deletionError = "";
    try {
      fs.rmSync(dataRoot, { recursive: true });
    } catch (error) {
      deletionError = (error as NodeJS.ErrnoException).code ?? String(error);
    }
    assert.deepEqual({
      keyCleared: recoveredKey.every((byte) => byte === 0),
      deletionError,
      background: coordinator.backgroundWorkSnapshot(),
    }, {
      keyCleared: true,
      deletionError: "",
      background: {
        acceptingKeyRecovery: false,
        keyRecoveryInFlight: false,
        keyRetryTimerActive: false,
      },
    });
  } finally {
    await coordinator.shutdown().catch(() => undefined);
    try {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    } catch {
      // RED 阶段可能仍持有 SQLite 句柄；测试进程退出后由下一轮开头清理。
    }
  }
});

test("新账号登录失败必须恢复旧账号尚未执行的有界 key retry", async () => {
  const fixture = createAccountSwitchFixture("retry-rollback");
  try {
    const degraded = await fixture.coordinator.onLogin(fixture.oldSession);
    assert.equal(degraded.keyServiceDegraded, true);
    const before = retrySemanticSnapshot(fixture.coordinator);
    assert.equal(before.keyRetryTimerActive, true);
    assert.ok(before.keyRetryUserUuid);

    await assert.rejects(
      () => fixture.coordinator.onLogin(fixture.newSession),
      /synthetic account switch failure/,
    );

    assert.deepEqual(retrySemanticSnapshot(fixture.coordinator), before);
    assert.deepEqual(fixture.coordinator.listProjects(fixture.oldSession), []);
  } finally {
    fixture.releaseFailedLogin();
    await fixture.coordinator.shutdown().catch(() => undefined);
    try {
      fs.rmSync(fixture.dataRoot, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  }
});

test("账号切换必须把旧 key recovery inFlight 转换为下一轮有界重试", async () => {
  const fixture = createAccountSwitchFixture("retry-in-flight-rollback", {
    oldRetryMode: "block-on-retry",
  });
  let recovery: Promise<unknown> | undefined;
  try {
    const degraded = await fixture.coordinator.onLogin(fixture.oldSession);
    assert.equal(degraded.keyServiceDegraded, true);
    const before = retrySemanticSnapshot(fixture.coordinator);
    assert.equal(before.keyRetryCount, 1);
    assert.equal(before.keyRetryTimerActive, true);

    recovery = fixture.coordinator.retryProfileSync(fixture.oldSession);
    await fixture.oldRecoveryStarted.promise;
    const switching = fixture.coordinator.onLogin(fixture.newSession);
    const switchingRejected = assert.rejects(switching, /synthetic account switch failure/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(retrySemanticSnapshot(fixture.coordinator), {
      acceptingKeyRecovery: false,
      keyRecoveryInFlight: true,
      keyRetryTimerActive: false,
      keyRetryCount: 1,
      keyRetryUserUuid: before.keyRetryUserUuid,
    });

    fixture.releaseOldRecovery();
    await recovery;
    await switchingRejected;
    assert.deepEqual(retrySemanticSnapshot(fixture.coordinator), {
      acceptingKeyRecovery: true,
      keyRecoveryInFlight: false,
      keyRetryTimerActive: true,
      keyRetryCount: 2,
      keyRetryUserUuid: before.keyRetryUserUuid,
    });
  } finally {
    fixture.releaseOldRecovery();
    fixture.releaseFailedLogin();
    await Promise.allSettled([recovery].filter((item): item is Promise<unknown> => Boolean(item)));
    await fixture.coordinator.shutdown().catch(() => undefined);
    fs.rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("账号切换失败晚于 shutdown 时不得重新开放或调度 key recovery", async () => {
  const fixture = createAccountSwitchFixture("retry-shutdown-race");
  try {
    const degraded = await fixture.coordinator.onLogin(fixture.oldSession);
    assert.equal(degraded.keyServiceDegraded, true);
    assert.equal(fixture.coordinator.backgroundWorkSnapshot().keyRetryTimerActive, true);

    fixture.blockFailedLogin();
    const switching = fixture.coordinator.onLogin(fixture.newSession);
    const switchingRejected = assert.rejects(switching, /synthetic account switch failure/);
    await fixture.failedLoginStarted.promise;
    // 先唤醒失败登录、同一调用栈内再声明 shutdown，确保登录 continuation 先进入微任务队列。
    fixture.releaseFailedLogin();
    const shutdown = fixture.coordinator.shutdown();
    await switchingRejected;
    await shutdown;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(fixture.coordinator.backgroundWorkSnapshot(), {
      acceptingKeyRecovery: false,
      keyRecoveryInFlight: false,
      keyRetryTimerActive: false,
    });
  } finally {
    fixture.releaseFailedLogin();
    await fixture.coordinator.shutdown().catch(() => undefined);
    try {
      fs.rmSync(fixture.dataRoot, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  }
});

test("shutdown 必须等待失败中的健康账号切换，且不得恢复已关闭的旧 store/key", async () => {
  const fixture = createAccountSwitchFixture("healthy-switch-shutdown", {
    oldKeyAvailable: true,
  });
  const internals = fixture.coordinator as unknown as Record<string, unknown>;
  try {
    const loggedIn = await fixture.coordinator.onLogin(fixture.oldSession);
    assert.equal(loggedIn.keyServiceDegraded, false);
    assert.ok(internals.profileStore);
    assert.equal(internals.profileKey, fixture.oldKey);

    fixture.blockFailedLogin();
    const switching = fixture.coordinator.onLogin(fixture.newSession);
    const switchingRejected = assert.rejects(switching, /synthetic account switch failure/);
    await fixture.failedLoginStarted.promise;
    let shutdownSettled = false;
    const shutdown = fixture.coordinator.shutdown().then(() => { shutdownSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(shutdownSettled, false, "在途账号切换结束前 shutdown 不得完成");

    fixture.releaseFailedLogin();
    await switchingRejected;
    await shutdown;
    assert.equal(internals.profileStore, undefined);
    assert.equal(internals.profileKey, undefined);
    assert.equal(fixture.oldKey.every((byte) => byte === 0), true);
    assert.deepEqual(fixture.coordinator.backgroundWorkSnapshot(), {
      acceptingKeyRecovery: false,
      keyRecoveryInFlight: false,
      keyRetryTimerActive: false,
    });
  } finally {
    fixture.releaseFailedLogin();
    await fixture.coordinator.shutdown().catch(() => undefined);
    try {
      fs.rmSync(fixture.dataRoot, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  }
});

test("成功的新账号登录晚于 shutdown 意图时不得接管新 store/key", async () => {
  const fixture = createAccountSwitchFixture("successful-switch-shutdown", {
    oldKeyAvailable: true,
    newLoginMode: "success",
  });
  const internals = fixture.coordinator as unknown as Record<string, unknown>;
  try {
    await fixture.coordinator.onLogin(fixture.oldSession);
    fixture.blockFailedLogin();
    const switching = fixture.coordinator.onLogin(fixture.newSession);
    const switchingOutcome = switching.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    await fixture.failedLoginStarted.promise;
    let shutdownSettled = false;
    const shutdown = fixture.coordinator.shutdown().then(() => { shutdownSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(shutdownSettled, false, "关闭意图必须先阻止新登录提交资源");

    fixture.releaseFailedLogin();
    const outcome = await switchingOutcome;
    assert.ok(outcome.error instanceof Error);
    assert.match(outcome.error.message, /正在关闭/);
    await shutdown;
    assert.equal(internals.profileStore, undefined);
    assert.equal(internals.profileKey, undefined);
    assert.equal(fixture.oldKey.every((byte) => byte === 0), true);
    assert.equal(fixture.newKey.every((byte) => byte === 0), true);
    assert.deepEqual(fixture.coordinator.backgroundWorkSnapshot(), {
      acceptingKeyRecovery: false,
      keyRecoveryInFlight: false,
      keyRetryTimerActive: false,
    });
  } finally {
    fixture.releaseFailedLogin();
    await fixture.coordinator.shutdown().catch(() => undefined);
    try {
      fs.rmSync(fixture.dataRoot, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  }
});

function createSession(id: string, userId: number, username: string): CentralSession {
  return {
    id,
    serverUrl: "https://api.j11.com.cn",
    token: `${id}-token`,
    expiresAt: Date.now() + 60_000,
    validatedAt: Date.now(),
    user: { id: userId, username, nickname: "" },
  };
}

function createAccountSwitchFixture(
  name: string,
  options: {
    oldKeyAvailable?: boolean;
    newLoginMode?: "fail" | "success";
    oldRetryMode?: "block-on-retry";
  } = {},
): {
  coordinator: SyncCoordinator;
  dataRoot: string;
  oldSession: CentralSession;
  newSession: CentralSession;
  oldKey: Buffer;
  newKey: Buffer;
  failedLoginStarted: ReturnType<typeof deferred>;
  oldRecoveryStarted: ReturnType<typeof deferred>;
  blockFailedLogin(): void;
  releaseFailedLogin(): void;
  releaseOldRecovery(): void;
} {
  const dataRoot = path.resolve(process.cwd(), "..", ".tmp", name);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  const serverUrl = "http://127.0.0.1:43191";
  const oldSession: CentralSession = {
    ...createSession(`${name}-old`, 9201, "old-user"),
    serverUrl,
    token: "old-token",
  };
  const newSession: CentralSession = {
    ...createSession(`${name}-new`, 9202, "new-user"),
    serverUrl,
    token: "new-token",
  };
  const failedLoginStarted = deferred();
  const failedLoginBarrier = deferred();
  const oldRecoveryStarted = deferred();
  const oldRecoveryBarrier = deferred();
  const oldKey = Buffer.alloc(32, 0x31);
  const newKey = Buffer.alloc(32, 0x32);
  let shouldBlockFailedLogin = false;
  let oldRecoveryAttempts = 0;
  const gateway = new CentralAuthGateway(async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    const token = new Headers(init?.headers).get("x-token") ?? "";
    if (token === "new-token" && pathname.endsWith("/devices/register")) {
      failedLoginStarted.resolve();
      if (shouldBlockFailedLogin) await failedLoginBarrier.promise;
      if (options.newLoginMode !== "success") {
        return jsonResponse({ code: 503, msg: "synthetic account switch failure" }, 503);
      }
    }
    if (pathname.endsWith("/devices/register")) {
      return jsonResponse({ code: 0, data: {} });
    }
    if (pathname.endsWith("/offline-grants")) {
      const userId = token === "new-token" ? newSession.user.id : oldSession.user.id;
      return jsonResponse({
        code: 0,
        data: {
          grantId: "33333333-3333-4333-a333-333333333333",
          userId,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          revokedAt: null,
        },
      });
    }
    if (pathname.endsWith("/profile/versions/metadata")) {
      return jsonResponse({ code: 0, data: { version: 0, etag: "profile-v0" } });
    }
    if (pathname.endsWith("/profile/versions/latest")) {
      return jsonResponse({ code: 0, data: { version: 0, snapshot: { schemaVersion: 1, entries: {} } } });
    }
    if (pathname.endsWith("/profile/versions")) {
      return jsonResponse({
        code: 0,
        data: { version: 1, snapshot: { schemaVersion: 1, entries: {} } },
      });
    }
    if (pathname.endsWith("/projects")) {
      return jsonResponse({ code: 0, data: { projects: [] } });
    }
    return jsonResponse({ code: 404, msg: `unexpected path: ${pathname}` }, 404);
  }, createTestOnlyLoopbackPolicy(serverUrl));
  const coordinator = new SyncCoordinator(
    dataRoot,
    gateway,
    new MemoryCredentialStore(),
    {
      createKeyRecoveryClient: (_gateway, session) => ({
        deviceIdentity: () => ({ publicKey: "test-public-key", publicFingerprint: "test-fingerprint" }),
        loadOrRecover: async () => {
          if (session.user.id === oldSession.user.id) {
            oldRecoveryAttempts += 1;
            if (options.oldRetryMode === "block-on-retry" && oldRecoveryAttempts > 1) {
              oldRecoveryStarted.resolve();
              await oldRecoveryBarrier.promise;
              throw new KeyServiceUnavailableError();
            }
            if (!options.oldKeyAvailable) throw new KeyServiceUnavailableError();
            return oldKey;
          }
          return newKey;
        },
      }),
    },
  );
  return {
    coordinator,
    dataRoot,
    oldSession,
    newSession,
    oldKey,
    newKey,
    failedLoginStarted,
    oldRecoveryStarted,
    blockFailedLogin: () => { shouldBlockFailedLogin = true; },
    releaseFailedLogin: () => failedLoginBarrier.resolve(),
    releaseOldRecovery: () => oldRecoveryBarrier.resolve(),
  };
}

function retrySemanticSnapshot(coordinator: SyncCoordinator): Record<string, unknown> {
  const internals = coordinator as unknown as Record<string, unknown>;
  return {
    ...coordinator.backgroundWorkSnapshot(),
    keyRetryCount: internals.keyRetryCount,
    keyRetryUserUuid: internals.keyRetryUserUuid,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": "sync-coordinator-test",
    },
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}
