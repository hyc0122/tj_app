/**
 * Round10c：退出/切号必须处理未打开项目的持久同步事实。
 *
 * 这些事实可能只存在于 sidecar、journal 或 Team receipt 中；如果协调器只遍历
 * projects map，就会出现“项目名称已在云端、正文或媒体仍留在本机”却允许退出的假成功。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { CentralSession } from "../../src/tianjiang/auth/central-session";
import { CentralAuthGateway } from "../../src/tianjiang/auth/central-session";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";
import {
  hasPendingLegacyMutationIntent,
  recordPendingLegacyMutationIntent,
} from "../../src/tianjiang/runtime/pending-legacy-mutation-intent";
import { SyncCoordinator } from "../../src/tianjiang/runtime/sync-coordinator";
import { writeTeamCheckpointReceipt } from "../../src/tianjiang/runtime/team-checkpoint-receipt";
import { userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";
import { SyncQueue } from "../../src/tianjiang/sync/queue";

function tempRoot(name: string): string {
  const root = path.join(
    process.cwd(),
    "..",
    ".tmp",
    `strict-unopened-${name}-${process.pid}-${Date.now()}`,
  );
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function session(userId: number): CentralSession {
  return {
    id: `strict-unopened-${userId}`,
    serverUrl: "https://api.j11.com.cn",
    token: "test-only-token",
    expiresAt: Date.now() + 120_000,
    validatedAt: Date.now(),
    user: { id: userId, username: `strict-${userId}`, nickname: "" },
  };
}

function coordinatorWithCatalog(
  dataRoot: string,
  activeSession: CentralSession,
  projectUuid: string,
  kind: "personal" | "team",
): SyncCoordinator {
  const coordinator = new SyncCoordinator(
    dataRoot,
    new CentralAuthGateway(),
    new MemoryCredentialStore(),
  );
  Object.assign(coordinator as unknown as Record<string, unknown>, {
    session: activeSession,
    // 中文注释：显式退出入口要求已完成中央运行时初始化；本测试在 openProject 前主动失败，
    // 不会调用 remote，因此最小对象即可把断言推进到待同步项目发现阶段。
    remote: {},
    online: true,
    deviceActive: true,
    catalog: new Map([
      [projectUuid, {
        projectUuid,
        kind,
        name: `${kind}-pending`,
        role: "owner",
        latestVersion: 1,
      }],
    ]),
  });
  return coordinator;
}

function installExpectedOpenFailure(
  coordinator: SyncCoordinator,
  expectedProjectUuid: string,
): () => number {
  let openCalls = 0;
  Object.assign(coordinator as unknown as Record<string, unknown>, {
    openProject: async (_session: CentralSession | undefined, projectUuid: string) => {
      openCalls += 1;
      assert.equal(projectUuid, expectedProjectUuid);
      throw Object.assign(new Error("EXPECTED_PENDING_PROJECT_OPEN"), {
        code: "EXPECTED_PENDING_PROJECT_OPEN",
      });
    },
  });
  return () => openCalls;
}

test("RED：普通退出必须重开未打开的 Personal sidecar，禁止只入队后放行", async () => {
  const dataRoot = tempRoot("personal-app-quit");
  const activeSession = session(81001);
  const projectUuid = "10101010-1010-4010-8010-101010101010";
  try {
    recordPendingLegacyMutationIntent({
      dataRoot,
      userSegment: userStorageSegment({
        issuer: activeSession.serverUrl,
        userId: activeSession.user.id,
      }),
      projectUuid,
      kind: "personal",
      source: "round10c",
    });
    const coordinator = coordinatorWithCatalog(
      dataRoot,
      activeSession,
      projectUuid,
      "personal",
    );
    const openCalls = installExpectedOpenFailure(coordinator, projectUuid);

    await assert.rejects(
      () => coordinator.commitProjectClosesForOrdinaryShutdown(),
      /EXPECTED_PENDING_PROJECT_OPEN/,
    );
    assert.equal(openCalls(), 1, "必须先走生产 openProject，再进入现有中央成功关闭门");
    assert.equal(
      (coordinator as unknown as { shutdownState: { projectsClosed: boolean } })
        .shutdownState.projectsClosed,
      false,
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("RED：显式退出/切号必须重开未打开的 Personal journal/sidecar", async () => {
  const dataRoot = tempRoot("personal-account-switch");
  const activeSession = session(81002);
  const projectUuid = "20202020-2020-4020-8020-202020202020";
  try {
    recordPendingLegacyMutationIntent({
      dataRoot,
      userSegment: userStorageSegment({
        issuer: activeSession.serverUrl,
        userId: activeSession.user.id,
      }),
      projectUuid,
      kind: "personal",
      source: "round10c",
    });
    const coordinator = coordinatorWithCatalog(
      dataRoot,
      activeSession,
      projectUuid,
      "personal",
    );
    const openCalls = installExpectedOpenFailure(coordinator, projectUuid);

    await assert.rejects(
      () => coordinator.prepareExplicitLogout(activeSession),
      /EXPECTED_PENDING_PROJECT_OPEN/,
    );
    assert.equal(openCalls(), 1);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("RED：Team checkpoint receipt 是唯一事实时也必须重开，禁止静默退出", async () => {
  const dataRoot = tempRoot("team-checkpoint-app-quit");
  const activeSession = session(81003);
  const projectUuid = "30303030-3030-4030-8030-303030303030";
  try {
    const userSegment = userStorageSegment({
      issuer: activeSession.serverUrl,
      userId: activeSession.user.id,
    });
    writeTeamCheckpointReceipt(dataRoot, userSegment, {
      projectUuid,
      lockId: "round10c-lock",
      fencingToken: 7,
      phase: "published_pending_finalize",
      baseVersion: 1,
      expectedVersion: 2,
      capturedMutationGeneration: 1,
      objects: [],
    });
    const coordinator = coordinatorWithCatalog(
      dataRoot,
      activeSession,
      projectUuid,
      "team",
    );
    const openCalls = installExpectedOpenFailure(coordinator, projectUuid);

    await assert.rejects(
      () => coordinator.commitProjectClosesForOrdinaryShutdown(),
      /EXPECTED_PENDING_PROJECT_OPEN/,
    );
    assert.equal(openCalls(), 1, "checkpoint receipt 不得因项目未在 map 中而被漏掉");
    assert.equal(
      (coordinator as unknown as { shutdownState: { projectsClosed: boolean } })
        .shutdownState.projectsClosed,
      false,
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("GREEN：切号会等待未打开 Personal 重开并完成中央 settle 后再返回", async () => {
  const dataRoot = tempRoot("personal-account-switch-success");
  const activeSession = session(81004);
  const projectUuid = "40404040-4040-4040-8040-404040404040";
  try {
    recordPendingLegacyMutationIntent({
      dataRoot,
      userSegment: userStorageSegment({
        issuer: activeSession.serverUrl,
        userId: activeSession.user.id,
      }),
      projectUuid,
      kind: "personal",
      source: "round10c",
    });
    const coordinator = coordinatorWithCatalog(
      dataRoot,
      activeSession,
      projectUuid,
      "personal",
    );
    const internals = coordinator as unknown as Record<string, any>;
    let openCalls = 0;
    let settleCalls = 0;
    internals.openProject = async () => {
      openCalls += 1;
      internals.projects.set(projectUuid, {
        kind: "personal",
        local: { dirty: true, close() {} },
        sync: {},
      });
      return {};
    };
    internals.settlePersonalProjectClose = async (
      settledUuid: string,
    ) => {
      settleCalls += 1;
      assert.equal(settledUuid, projectUuid);
      internals.projects.delete(projectUuid);
      return {
        allowAccountSwitch: true,
        allowSafeQuit: true,
        disposed: true,
        state: "synced",
      };
    };

    await coordinator.prepareExplicitLogout(activeSession);
    assert.equal(openCalls, 1);
    assert.equal(settleCalls, 1);
    assert.equal(internals.projects.size, 0);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("GREEN：普通退出会等待 receipt-only Team 重开、中央关闭和本地释放", async () => {
  const dataRoot = tempRoot("team-checkpoint-app-quit-success");
  const activeSession = session(81005);
  const projectUuid = "50505050-5050-4050-8050-505050505050";
  try {
    const userSegment = userStorageSegment({
      issuer: activeSession.serverUrl,
      userId: activeSession.user.id,
    });
    writeTeamCheckpointReceipt(dataRoot, userSegment, {
      projectUuid,
      lockId: "round10c-success-lock",
      fencingToken: 9,
      phase: "published_pending_finalize",
      baseVersion: 1,
      expectedVersion: 2,
      capturedMutationGeneration: 1,
      objects: [],
    });
    const coordinator = coordinatorWithCatalog(
      dataRoot,
      activeSession,
      projectUuid,
      "team",
    );
    const internals = coordinator as unknown as Record<string, any>;
    let openCalls = 0;
    let centralCloseCalls = 0;
    let localCloseCalls = 0;
    internals.openProject = async () => {
      openCalls += 1;
      internals.projects.set(projectUuid, {
        kind: "team",
        local: {
          dirty: true,
          close() {
            localCloseCalls += 1;
          },
        },
        sync: {},
      });
      return {};
    };
    internals.prepareTeamCloseForCentralSuccess = async (
      closedUuid: string,
    ) => {
      centralCloseCalls += 1;
      assert.equal(closedUuid, projectUuid);
    };

    await coordinator.commitProjectClosesForOrdinaryShutdown();
    assert.equal(openCalls, 1);
    assert.equal(centralCloseCalls, 1);
    assert.equal(localCloseCalls, 1);
    assert.equal(internals.projects.size, 0);
    assert.equal(internals.shutdownState.projectsClosed, true);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("RED：queue-only Personal 重开前必须先落 sidecar，禁止远端 install 覆盖本地", async () => {
  const dataRoot = tempRoot("personal-queue-only-protect");
  const activeSession = session(81006);
  const projectUuid = "60606060-6060-4060-8060-606060606060";
  const userSegment = userStorageSegment({
    issuer: activeSession.serverUrl,
    userId: activeSession.user.id,
  });
  const queuePath = path.join(
    dataRoot,
    "runtime-users",
    userSegment,
    "sync-queue.sqlite",
  );
  let queue: SyncQueue | undefined;
  try {
    queue = new SyncQueue(queuePath);
    queue.ensureUploadQueued(projectUuid, activeSession.expiresAt);
    queue.close();
    queue = undefined;

    assert.equal(
      hasPendingLegacyMutationIntent(dataRoot, userSegment, projectUuid),
      false,
      "夹具必须真实复现只有 queue、没有 sidecar 的旧状态",
    );
    const coordinator = coordinatorWithCatalog(
      dataRoot,
      activeSession,
      projectUuid,
      "personal",
    );
    let openCalls = 0;
    Object.assign(coordinator as unknown as Record<string, unknown>, {
      openProject: async () => {
        openCalls += 1;
        assert.equal(
          hasPendingLegacyMutationIntent(dataRoot, userSegment, projectUuid),
          true,
          "调用生产 openProject 前必须先把 queue-only 事实升级为下载保护 sidecar",
        );
        throw new Error("EXPECTED_QUEUE_ONLY_OPEN");
      },
    });

    await assert.rejects(
      () => coordinator.commitProjectClosesForOrdinaryShutdown(),
      /EXPECTED_QUEUE_ONLY_OPEN/,
    );
    assert.equal(openCalls, 1);
  } finally {
    queue?.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("RED：损坏的正式 mutation sidecar 必须阻断严格退出，禁止静默跳过", async () => {
  const dataRoot = tempRoot("corrupt-sidecar-fail-closed");
  const activeSession = session(81007);
  const projectUuid = "70707070-7070-4070-8070-707070707070";
  const userSegment = userStorageSegment({
    issuer: activeSession.serverUrl,
    userId: activeSession.user.id,
  });
  try {
    const intentDir = path.join(
      dataRoot,
      "runtime-users",
      userSegment,
      "pending-legacy-mutations",
    );
    fs.mkdirSync(intentDir, { recursive: true });
    fs.writeFileSync(path.join(intentDir, `${projectUuid}.json`), "{not-json", "utf8");

    const coordinator = coordinatorWithCatalog(
      dataRoot,
      activeSession,
      projectUuid,
      "personal",
    );
    let openCalls = 0;
    Object.assign(coordinator as unknown as Record<string, unknown>, {
      openProject: async () => {
        openCalls += 1;
        return {};
      },
    });

    await assert.rejects(
      () => coordinator.commitProjectClosesForOrdinaryShutdown(),
      /pending mutation intent 损坏/,
    );
    assert.equal(openCalls, 0, "损坏事实必须在任何下载/重开动作前阻断");
    assert.equal(
      (coordinator as unknown as { shutdownState: { projectsClosed: boolean } })
        .shutdownState.projectsClosed,
      false,
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
