import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";
import {
  openUserSyncQueue,
  SyncCoordinator,
} from "../../src/tianjiang/runtime/sync-coordinator";
import { userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";

const projectUuid = "29292929-2929-4929-8929-292929292929";

test("登录页缓存仍为在线但关闭时断网，必须先耐久排队再安全退出", async () => {
  const dataRoot = fs.mkdtempSync(path.join(process.cwd(), "..", ".tmp", "offline-app-quit-"));
  const issuer = "https://api.example.invalid";
  const userId = 29001;
  const expiresAt = Date.now() + 60_000;
  let localCloseCalls = 0;
  let terminalDisposeCalls = 0;
  let rollbackCalls = 0;

  const coordinator = new SyncCoordinator(
    dataRoot,
    { forwardBusinessRequest: async () => ({}) } as never,
    new MemoryCredentialStore(),
  );
  const internals = coordinator as unknown as Record<string, unknown>;

  // 中文注释：真实问题发生在登录页：运行时仍缓存 online=true，
  // 但项目 close 已从中央请求得到 offline_pending；普通应用退出必须以真实 close 结果为准。
  internals.session = undefined;
  internals.online = true;
  internals.offlineCache = {
    issuer,
    userId,
    grant: {
      grantId: "offline-app-quit-round29",
      userId,
      deviceUuid: "device-round29",
      expiresAt: new Date(expiresAt).toISOString(),
      revokedAt: null,
    },
    catalog: [],
  };
  internals.catalog = new Map([
    [projectUuid, {
      projectUuid,
      name: "离线待同步分镜",
      kind: "personal",
      ownerUserId: userId,
      role: "owner",
      myRole: "owner",
      currentVersion: 1,
      syncState: "synced",
      lastSyncedAt: null,
      updatedAt: "",
      lockStatus: "none",
      lockHolderName: "",
      openMode: "editable",
      businessType: "storyboard",
    }],
  ]);
  internals.projects = new Map([
    [projectUuid, {
      kind: "personal",
      local: {
        dirty: true,
        close() {
          localCloseCalls += 1;
        },
      },
      sync: {
        close: async () => ({ state: "offline_pending" as const }),
        rollbackCloseAttempt() {
          rollbackCalls += 1;
        },
        commitTerminalDispose() {
          terminalDisposeCalls += 1;
        },
      },
    }],
  ]);

  try {
    await coordinator.commitProjectClosesForOrdinaryShutdown();

    const queue = openUserSyncQueue(dataRoot, { issuer, userId });
    try {
      const pendingIds = queue.listPendingIds();
      assert.equal(pendingIds.length, 1, "退出前必须落下唯一待同步任务");
      const task = queue.get(pendingIds[0]!);
      assert.equal(task?.projectUUID, projectUuid);
      assert.equal(task?.type, "upload");
      assert.equal(task?.sessionExpiresAt, expiresAt);
    } finally {
      queue.close();
    }

    assert.equal(localCloseCalls, 1, "耐久排队成功后才允许关闭本地句柄");
    assert.equal(terminalDisposeCalls, 1);
    assert.equal(rollbackCalls, 0);
    assert.equal(
      (internals.projects as Map<string, unknown>).size,
      0,
      "安全交接后必须移除运行时，允许应用退出",
    );
    assert.equal(
      (internals.shutdownState as { projectsClosed: boolean }).projectsClosed,
      true,
    );
  } finally {
    try {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    } catch {
      // Windows 上 SQLite 句柄若仍在释放中，交给测试临时目录后续清理。
    }
  }
});
