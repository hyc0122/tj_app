import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CentralAuthGateway,
  type CentralSession,
} from "../../src/tianjiang/auth/central-session";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";
import { buildLocalProjectIdMap } from "../../src/tianjiang/runtime/local-project-id";
import type { RuntimeProjectCatalogItem } from "../../src/tianjiang/runtime/central-runtime-adapter";
import {
  RuntimePermissionError,
  SyncCoordinator,
} from "../../src/tianjiang/runtime/sync-coordinator";

const OLD_UUID = "11111111-1111-4111-a111-111111111111";
const NEW_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeItem(
  projectUuid: string,
  name: string,
): RuntimeProjectCatalogItem {
  return {
    projectUuid,
    name,
    kind: "personal",
    ownerUserId: 7,
    role: "owner",
    myRole: "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-03T00:00:00Z",
    lockStatus: "none",
    lockHolderName: "",
    openMode: "editable",
    businessType: "novel",
  };
}

function makeSession(): CentralSession {
  return {
    id: "sess-catalog-refresh",
    serverUrl: "https://api.j11.com.cn",
    token: "test-only-token",
    expiresAt: Date.now() + 60_000,
    validatedAt: Date.now(),
    user: { id: 7, username: "alice", nickname: "alice" },
  };
}

function tempRoot(): string {
  const root = path.resolve(process.cwd(), "..", ".tmp", `pcr-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function seedCoordinator(
  dataRoot: string,
  session: CentralSession,
  catalogItems: RuntimeProjectCatalogItem[],
  remoteCatalog: () => Promise<RuntimeProjectCatalogItem[]>,
): SyncCoordinator {
  const coordinator = new SyncCoordinator(
    dataRoot,
    new CentralAuthGateway(),
    new MemoryCredentialStore(),
  );
  Object.assign(coordinator as unknown as Record<string, unknown>, {
    session,
    remote: {
      projectCatalog: async () => remoteCatalog(),
    },
    online: true,
    deviceActive: true,
    catalog: new Map(catalogItems.map((item) => [item.projectUuid, item])),
    localProjectIds: buildLocalProjectIdMap(catalogItems.map((item) => item.projectUuid)),
  });
  return coordinator;
}

test("中央创建成功后未刷新目录时 openProject 稳定复现项目不存在", async () => {
  const dataRoot = tempRoot();
  try {
    const session = makeSession();
    const oldItem = makeItem(OLD_UUID, "登录时目录");
    const newItem = makeItem(NEW_UUID, "刚创建项目");
    // 模拟：中央已有新项目，但协调器仍持登录快照
    const coordinator = seedCoordinator(
      dataRoot,
      session,
      [oldItem],
      async () => [oldItem, newItem],
    );

    await assert.rejects(
      () => coordinator.openProject(session, NEW_UUID),
      (error: unknown) => {
        assert.ok(error instanceof RuntimePermissionError);
        assert.match(error.message, /项目不存在或不可见/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("刷新目录后新项目立即可见；刷新失败保留旧目录", async () => {
  const dataRoot = tempRoot();
  try {
    const session = makeSession();
    const oldItem = makeItem(OLD_UUID, "旧项目");
    const newItem = makeItem(NEW_UUID, "新项目");
    let failNext = false;
    const coordinator = seedCoordinator(
      dataRoot,
      session,
      [oldItem],
      async () => {
        if (failNext) throw new Error("synthetic catalog failure");
        return [oldItem, newItem];
      },
    );

    // 方法必须存在；RED 阶段因未实现而失败。
    const refreshed = await (coordinator as unknown as {
      refreshProjectCatalog: (s: CentralSession) => Promise<RuntimeProjectCatalogItem[]>;
    }).refreshProjectCatalog(session);
    assert.equal(refreshed.length, 2);
    assert.ok(refreshed.some((item) => item.projectUuid === NEW_UUID));
    assert.equal(coordinator.listProjects(session).length, 2);

    failNext = true;
    await assert.rejects(
      () => (coordinator as any).refreshProjectCatalog(session),
      /synthetic catalog failure|刷新|目录/,
    );
    // 失败不得清空旧目录
    assert.equal(coordinator.listProjects(session).length, 2);
    assert.ok(coordinator.listProjects(session).some((item) => item.projectUuid === OLD_UUID));
    assert.ok(coordinator.listProjects(session).some((item) => item.projectUuid === NEW_UUID));
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("未授权项目刷新后仍不可打开；离线禁止伪造中央刷新", async () => {
  const dataRoot = tempRoot();
  try {
    const session = makeSession();
    const own = makeItem(OLD_UUID, "本人项目");
    const coordinator = seedCoordinator(
      dataRoot,
      session,
      [own],
      async () => [own],
    );
    await (coordinator as any).refreshProjectCatalog(session);
    await assert.rejects(
      () => coordinator.openProject(session, NEW_UUID),
      /项目不存在或不可见/,
    );

    Object.assign(coordinator as unknown as Record<string, unknown>, {
      online: false,
    });
    await assert.rejects(
      () => (coordinator as any).refreshProjectCatalog(session),
      /离线|禁止|刷新/,
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
