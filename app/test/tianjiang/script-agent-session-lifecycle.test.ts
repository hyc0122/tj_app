/**
 * 生命周期：空 Cookie 握手不得清空同步运行时，closeProject 后仍可 listProjects。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { createShutdownPhaseState } from "../../src/tianjiang/runtime/sync-coordinator";
import type { CentralSession } from "../../src/tianjiang/auth/central-session";

function installSession(session: CentralSession) {
  const internals = syncCoordinator as unknown as Record<string, unknown>;
  Object.assign(internals, {
    session,
    remote: {
      listProjects: async () => [],
    },
    online: true,
    deviceActive: true,
    catalog: new Map([
      [
        "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        {
          projectUuid: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
          name: "项目A",
          kind: "personal",
          ownerUserId: session.user.id,
          role: "owner",
          myRole: "owner",
          currentVersion: 1,
          syncState: "synced",
          lastSyncedAt: null,
          updatedAt: new Date().toISOString(),
          lockStatus: "none",
          lockHolderName: "",
          openMode: "editable",
          businessType: "script",
        },
      ],
    ]),
    projects: new Map(),
    localProjectIds: new Map([["aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", 1001]]),
    shutdownState: createShutdownPhaseState(),
    shutdownRequested: false,
  });
}

test("登录态下 onSessionInvalid(\"\") 后仍能 listProjects，不出现登录初始化错误", async () => {
  const session: CentralSession = {
    id: "lifecycle-session",
    serverUrl: "https://api.j11.com.cn",
    token: "t",
    expiresAt: Date.now() + 60_000,
    user: { id: 8801, username: "life", nickname: "L" },
    validatedAt: Date.now(),
  };
  installSession(session);

  // 模拟剧本 Agent 缺 Cookie 曾调用的空失效
  await syncCoordinator.onSessionInvalid("");
  await syncCoordinator.onSessionInvalid("unknown-old-socket");

  const list = syncCoordinator.listProjects(session);
  assert.ok(Array.isArray(list));
  assert.equal(list.length, 1);
  assert.equal(list[0]?.projectUuid, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
});

test("匹配会话失效后 listProjects 才抛登录初始化错误", async () => {
  const session: CentralSession = {
    id: "lifecycle-session-2",
    serverUrl: "https://api.j11.com.cn",
    token: "t",
    expiresAt: Date.now() + 60_000,
    user: { id: 8802, username: "life2", nickname: "L2" },
    validatedAt: Date.now(),
  };
  installSession(session);
  await syncCoordinator.onSessionInvalid(session.id);
  assert.throws(
    () => syncCoordinator.listProjects(session),
    (err: unknown) =>
      err instanceof Error && err.message.includes("同步运行时尚未完成登录初始化"),
  );
});
