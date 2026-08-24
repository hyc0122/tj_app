/**
 * Task 3：普通退出持久化待同步并允许退出。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { SyncQueue } from "../../src/tianjiang/sync/queue";
import {
  PENDING_SYNC_EXIT_MESSAGE,
  classifyShutdownSyncFailure,
  extractStableErrorCode,
  preparePendingSyncForShutdown,
} from "../../src/tianjiang/sync/shutdown-policy";
import { ShutdownGate } from "../../src/tianjiang/runtime/shutdown-gate";
import {
  CentralAuthGateway,
  type CentralSession,
} from "../../src/tianjiang/auth/central-session";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";
import { SyncCoordinator } from "../../src/tianjiang/runtime/sync-coordinator";
import { recordPendingLegacyMutationIntent } from "../../src/tianjiang/runtime/pending-legacy-mutation-intent";
import { userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";

function tempRoot(name: string): string {
  const root = path.join(process.cwd(), "..", ".tmp", `pending-sync-${name}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

test("失败分类：存储未配置/网络/超时/5xx/登录失效均为可恢复", () => {
  const cases: unknown[] = [
    Object.assign(new Error("平台存储未配置"), { code: "STORAGE_NOT_CONFIGURED" }),
    Object.assign(new Error("active storage unavailable"), { code: "STORAGE_UNAVAILABLE" }),
    Object.assign(new Error("offline"), { code: "NETWORK_OFFLINE" }),
    Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("server boom"), { status: 503 }),
    Object.assign(new Error("server boom"), { status: 500 }),
    Object.assign(new Error("auth expired"), { code: "AUTH_EXPIRED" }),
    Object.assign(new Error("session expired"), { code: "SESSION_EXPIRED" }),
    new Error("fetch failed"),
  ];
  for (const error of cases) {
    assert.equal(
      classifyShutdownSyncFailure(error),
      "retryable",
      `应可恢复: ${extractStableErrorCode(error)}`,
    );
  }
  // 版本冲突单独恢复语义，不得冒充网络 retryable
  assert.equal(
    classifyShutdownSyncFailure(new Error("个人项目远端版本已前进")),
    "conflict",
  );
  // 未知/SQLite 默认 fatal
  assert.equal(
    classifyShutdownSyncFailure(Object.assign(new Error("corrupt"), { code: "SQLITE_CORRUPT" })),
    "fatal",
  );
});

test("错误码截断且不含路径、密钥、JWT 形态串", () => {
  const dirty = new Error("fail C:\\Users\\x\\secret sk-abc123token eyJhbGciOiJIUzI1NiJ9.aaa.bbb");
  const code = extractStableErrorCode(dirty);
  assert.equal(code.includes("C:"), false);
  assert.equal(code.includes("sk-"), false);
  assert.equal(code.includes("eyJ"), false);
  assert.ok(code.length <= 64);
});

test("preparePendingSync：可恢复 close 失败入队、running 回 pending、允许退出", async () => {
  const root = tempRoot("prepare");
  try {
    const dbPath = path.join(root, "sync-queue.sqlite");
    const queue = new SyncQueue(dbPath, () => 10_000);
    const projectUUID = "11111111-1111-4111-a111-111111111111";
    // 模拟退出前有一条 running
    const runningId = queue.enqueue({
      type: "upload",
      projectUUID: "22222222-2222-4222-a222-222222222222",
      sessionExpiresAt: 99_000,
    });
    queue.markRunning(runningId);

    const summary = await preparePendingSyncForShutdown(queue, {
      now: 10_000,
      sessionExpiresAt: 99_000,
      dirtyProjectUUIDs: [projectUUID],
      attemptProjectClose: async () => {
        const err = new Error("平台存储未配置");
        (err as { code?: string }).code = "STORAGE_UNAVAILABLE";
        throw err;
      },
    });

    assert.equal(summary.safeToQuit, true);
    assert.equal(summary.message, PENDING_SYNC_EXIT_MESSAGE);
    assert.ok(summary.pendingCount >= 1);
    assert.equal(queue.get(runningId)?.status, "queued");

    const claimed = queue.claimNextReady();
    assert.ok(claimed);
    assert.equal(claimed?.status, "running");
    queue.close();

    // 进程重启后队列仍在
    const reopened = new SyncQueue(dbPath, () => 10_000);
    assert.ok(reopened.countPending() >= 1);
    reopened.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("账号隔离：A 队列不能 claim B 的任务", () => {
  const root = tempRoot("isolate");
  try {
    const alicePath = path.join(root, "alice", "sync-queue.sqlite");
    const bobPath = path.join(root, "bob", "sync-queue.sqlite");
    const alice = new SyncQueue(alicePath, () => 5_000);
    const bob = new SyncQueue(bobPath, () => 5_000);
    const project = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    alice.enqueue({ type: "upload", projectUUID: project, sessionExpiresAt: 50_000 });
    assert.equal(bob.claimNextReady(), undefined);
    assert.ok(alice.claimNextReady());
    assert.equal(bob.countPending(), 0);
    alice.close();
    bob.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("指数退避：fail(retryable) 提高 next_attempt_at", () => {
  const root = tempRoot("backoff");
  try {
    let now = 1_000;
    const queue = new SyncQueue(path.join(root, "q.sqlite"), () => now);
    const id = queue.enqueue({
      type: "upload",
      projectUUID: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      sessionExpiresAt: 1_000_000,
    });
    queue.markRunning(id);
    queue.fail(id, "NETWORK", true);
    const first = queue.get(id)!;
    assert.equal(first.status, "retry_wait");
    assert.ok(first.nextAttemptAt > now);
    now = first.nextAttemptAt;
    const claimed = queue.claimNextReady();
    assert.equal(claimed?.id, id);
    queue.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("普通退出：closeRuntime 可恢复失败后仍 safeToQuit 并 quit", async () => {
  const events: string[] = [];
  const root = tempRoot("gate");
  try {
    const dbPath = path.join(root, "sync-queue.sqlite");
    const gate = new ShutdownGate({
      closeRuntime: async () => {
        events.push("close");
        const queue = new SyncQueue(dbPath, () => 20_000);
        await preparePendingSyncForShutdown(queue, {
          sessionExpiresAt: 90_000,
          dirtyProjectUUIDs: ["cccccccc-cccc-4ccc-cccc-cccccccccccc"],
          attemptProjectClose: async () => {
            throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
          },
        });
        queue.close();
      },
      relaunch: () => events.push("relaunch"),
      quit: () => events.push("quit"),
      onFailure: async () => {
        events.push("failure");
      },
    });
    await gate.request(false);
    assert.equal(gate.canQuit(), true);
    assert.deepEqual(events, ["close", "quit"]);
    // 队列持久化
    const reopened = new SyncQueue(dbPath, () => 20_000);
    assert.ok(reopened.countPending() >= 1);
    reopened.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("更新安装器保护失败仍阻断 quitAndInstall 并受控重启", async () => {
  const events: string[] = [];
  const gate = new ShutdownGate({
    closeRuntime: async () => {
      events.push("runtime:closed");
    },
    relaunch: () => events.push("relaunch"),
    quit: () => events.push("quit"),
    onFailure: async () => {
      events.push("failure");
    },
    onInstallerPreparationFailure: async () => {
      events.push("installer:failure");
    },
  });
  await assert.rejects(
    () => gate.prepareForInstaller(async () => {
      throw new Error("hash mismatch");
    }),
    /hash mismatch/,
  );
  assert.equal(gate.canQuit(), true);
  assert.deepEqual(events, [
    "runtime:closed",
    "installer:failure",
    "relaunch",
    "quit",
  ]);
});

test("ensureUploadQueued 幂等：同项目不重复活跃任务", () => {
  const root = tempRoot("idempotent");
  try {
    const queue = new SyncQueue(path.join(root, "q.sqlite"), () => 3_000);
    const project = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
    const a = queue.ensureUploadQueued(project, 30_000);
    const b = queue.ensureUploadQueued(project, 30_000);
    assert.equal(a, b);
    assert.equal(queue.countPending(), 1);
    queue.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RED：同项目活跃 upload 使用刷新后的真实会话过期时间续期", () => {
  const root = tempRoot("renew-session");
  let queue: SyncQueue | undefined;
  try {
    queue = new SyncQueue(path.join(root, "q.sqlite"), () => 3_000);
    const project = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const firstExpiry = 30_000;
    const refreshedExpiry = 90_000;
    const first = queue.ensureUploadQueued(project, firstExpiry);
    const second = queue.ensureUploadQueued(project, refreshedExpiry);

    assert.equal(second, first, "续期必须复用同一活跃任务，禁止制造重复 upload");
    assert.equal(queue.get(first)?.sessionExpiresAt, refreshedExpiry);
    assert.equal(queue.countPending(), 1);
  } finally {
    queue?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RED：已过期 upload 使用新会话原地恢复，禁止遗留重复任务", () => {
  const root = tempRoot("renew-expired-session");
  let queue: SyncQueue | undefined;
  try {
    let current = 50_000;
    queue = new SyncQueue(path.join(root, "q.sqlite"), () => current);
    const project = "efefefef-efef-4efe-8efe-efefefefefef";
    const first = queue.ensureUploadQueued(project, 49_000);
    assert.equal(queue.get(first)?.status, "session_expired");

    current = 60_000;
    const renewed = queue.ensureUploadQueued(project, 90_000);
    assert.equal(renewed, first, "新会话必须复用已过期任务，禁止制造第二条 upload");
    assert.equal(queue.get(first)?.status, "queued");
    assert.equal(queue.get(first)?.sessionExpiresAt, 90_000);
    assert.deepEqual(queue.listRecoverableUploadProjectUuids(), [project]);
  } finally {
    queue?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RED：每项目最新终态必须压制更旧 expired，不得被登录对账复活", () => {
  const root = tempRoot("latest-terminal-authority");
  let queue: SyncQueue | undefined;
  try {
    const current = 50_000;
    queue = new SyncQueue(path.join(root, "q.sqlite"), () => current);
    const completedProject = "56565656-5656-4656-8656-565656565656";
    const failedProject = "78787878-7878-4878-8878-787878787878";

    queue.enqueue({
      type: "upload",
      projectUUID: completedProject,
      sessionExpiresAt: current - 1,
    });
    const completedId = queue.enqueue({
      type: "upload",
      projectUUID: completedProject,
      sessionExpiresAt: current + 60_000,
    });
    queue.markRunning(completedId);
    queue.complete(completedId);

    queue.enqueue({
      type: "upload",
      projectUUID: failedProject,
      sessionExpiresAt: current - 1,
    });
    const failedId = queue.enqueue({
      type: "upload",
      projectUUID: failedProject,
      sessionExpiresAt: current + 60_000,
    });
    queue.markRunning(failedId);
    queue.fail(failedId, "SQLITE_CORRUPT", false);

    assert.deepEqual(
      queue.listRecoverableUploadProjectUuids(),
      [],
      "较旧 expired 不能越过较新的 completed/failed 重新进入登录续期",
    );
  } finally {
    queue?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RED：登录后按 Personal mutation fact 重建或续期待同步任务，Team 不入队", async () => {
  const dataRoot = tempRoot("login-reconcile");
  const session: CentralSession = {
    id: "pending-reconcile-session",
    serverUrl: "https://api.j11.com.cn",
    token: "test-only-token",
    expiresAt: Date.now() + 120_000,
    validatedAt: Date.now(),
    user: { id: 72001, username: "pending-reconcile", nickname: "" },
  };
  const identity = { issuer: session.serverUrl, userId: session.user.id };
  const segment = userStorageSegment(identity);
  const personalUuid = "abababab-abab-4bab-8bab-abababababab";
  const teamUuid = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
  try {
    recordPendingLegacyMutationIntent({
      dataRoot,
      userSegment: segment,
      projectUuid: personalUuid,
      kind: "personal",
      source: "test",
    });
    recordPendingLegacyMutationIntent({
      dataRoot,
      userSegment: segment,
      projectUuid: teamUuid,
      // 中文注释：模拟陈旧/异常 sidecar；当前 catalog 的 Team 身份必须拥有最终裁决权。
      kind: "personal",
      source: "test",
    });
    const coordinator = new SyncCoordinator(
      dataRoot,
      new CentralAuthGateway(),
      new MemoryCredentialStore(),
    );
    Object.assign(coordinator as unknown as Record<string, unknown>, {
      catalog: new Map([
        [personalUuid, { projectUuid: personalUuid, kind: "personal" }],
        [teamUuid, { projectUuid: teamUuid, kind: "team" }],
      ]),
    });

    const reconcile = (coordinator as unknown as {
      reconcilePendingPersonalUploads?: (nextSession: CentralSession) => Promise<void>;
    }).reconcilePendingPersonalUploads;
    assert.equal(typeof reconcile, "function", "登录后台必须提供 Personal pending-fact 对账");
    await reconcile?.call(coordinator, session);

    const queue = new SyncQueue(
      path.join(dataRoot, "runtime-users", segment, "sync-queue.sqlite"),
    );
    try {
      const personal = queue.listPendingIds().map((id) => queue.get(id));
      assert.equal(personal.length, 1);
      assert.equal(personal[0]?.projectUUID, personalUuid);
      assert.equal(personal[0]?.sessionExpiresAt, session.expiresAt);
      assert.ok(!personal.some((task) => task?.projectUUID === teamUuid));
    } finally {
      // 中文注释：RED 断言失败时也必须释放 SQLite，避免 EPERM 掩盖真实业务失败。
      queue.close();
    }
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("RED：登录对账必须续期 queue-only Personal，且不得激活 Team 任务", async () => {
  const dataRoot = tempRoot("login-reconcile-queue-only");
  const now = Date.now();
  const session: CentralSession = {
    id: "pending-reconcile-queue-only-session",
    serverUrl: "https://api.j11.com.cn",
    token: "test-only-token",
    expiresAt: now + 120_000,
    validatedAt: now,
    user: { id: 72002, username: "pending-reconcile-queue-only", nickname: "" },
  };
  const identity = { issuer: session.serverUrl, userId: session.user.id };
  const segment = userStorageSegment(identity);
  const queuePath = path.join(dataRoot, "runtime-users", segment, "sync-queue.sqlite");
  const personalUuid = "12121212-1212-4212-8212-121212121212";
  const teamUuid = "34343434-3434-4434-8434-343434343434";
  let seedQueue: SyncQueue | undefined;
  try {
    seedQueue = new SyncQueue(queuePath, () => now);
    const personalTaskId = seedQueue.enqueue({
      type: "upload",
      projectUUID: personalUuid,
      sessionExpiresAt: now - 1,
    });
    const teamTaskId = seedQueue.enqueue({
      type: "upload",
      projectUUID: teamUuid,
      sessionExpiresAt: now - 1,
    });
    seedQueue.close();
    seedQueue = undefined;

    const coordinator = new SyncCoordinator(
      dataRoot,
      new CentralAuthGateway(),
      new MemoryCredentialStore(),
    );
    Object.assign(coordinator as unknown as Record<string, unknown>, {
      catalog: new Map([
        [personalUuid, { projectUuid: personalUuid, kind: "personal" }],
        [teamUuid, { projectUuid: teamUuid, kind: "team" }],
      ]),
    });
    const reconcile = (coordinator as unknown as {
      reconcilePendingPersonalUploads: (nextSession: CentralSession) => Promise<void>;
    }).reconcilePendingPersonalUploads;
    await reconcile.call(coordinator, session);

    const queue = new SyncQueue(queuePath, () => now);
    try {
      assert.equal(queue.get(personalTaskId)?.status, "queued");
      assert.equal(queue.get(personalTaskId)?.sessionExpiresAt, session.expiresAt);
      assert.equal(queue.get(teamTaskId)?.status, "session_expired");
      assert.deepEqual(queue.listRecoverableUploadProjectUuids(), [personalUuid, teamUuid]);
    } finally {
      queue.close();
    }
  } finally {
    seedQueue?.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("RED：fatal upload 即使 sidecar 仍 pending，登录也不得自动创建兄弟任务", async () => {
  const dataRoot = tempRoot("login-reconcile-fatal-authority");
  const now = Date.now();
  const session: CentralSession = {
    id: "pending-reconcile-fatal-session",
    serverUrl: "https://api.j11.com.cn",
    token: "test-only-token",
    expiresAt: now + 120_000,
    validatedAt: now,
    user: { id: 72003, username: "pending-reconcile-fatal", nickname: "" },
  };
  const identity = { issuer: session.serverUrl, userId: session.user.id };
  const segment = userStorageSegment(identity);
  const queuePath = path.join(dataRoot, "runtime-users", segment, "sync-queue.sqlite");
  const projectUuid = "90909090-9090-4090-8090-909090909090";
  let seedQueue: SyncQueue | undefined;
  try {
    recordPendingLegacyMutationIntent({
      dataRoot,
      userSegment: segment,
      projectUuid,
      kind: "personal",
      source: "test",
    });
    seedQueue = new SyncQueue(queuePath, () => now);
    const fatalTaskId = seedQueue.enqueue({
      type: "upload",
      projectUUID: projectUuid,
      sessionExpiresAt: session.expiresAt,
    });
    seedQueue.markRunning(fatalTaskId);
    seedQueue.fail(fatalTaskId, "SQLITE_CORRUPT", false);
    seedQueue.close();
    seedQueue = undefined;

    const coordinator = new SyncCoordinator(
      dataRoot,
      new CentralAuthGateway(),
      new MemoryCredentialStore(),
    );
    Object.assign(coordinator as unknown as Record<string, unknown>, {
      catalog: new Map([
        [projectUuid, { projectUuid, kind: "personal" }],
      ]),
    });
    const reconcile = (coordinator as unknown as {
      reconcilePendingPersonalUploads: (nextSession: CentralSession) => Promise<void>;
    }).reconcilePendingPersonalUploads;
    await reconcile.call(coordinator, session);

    const queue = new SyncQueue(queuePath, () => now);
    try {
      assert.equal(queue.countPending(), 0, "fatal 任务只能由用户显式修复后重试");
    } finally {
      queue.close();
    }
  } finally {
    seedQueue?.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
