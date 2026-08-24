/**
 * Task 4–5 RED：双项目授权、Team 锁/fencing、依赖删除门、journal 与完整分镜 CRUD
 * 必须打到生产 HTTP，失败值是错误状态或错误合同，不是模块缺失。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import express from "express";

import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
  db as activeDb,
} from "../../src/utils/db";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { hasPendingMutationJournal } from "../../src/tianjiang/runtime/legacy-mutation-journal";
import { getStableDeviceUUID } from "../../src/tianjiang/auth/device";
import getPath from "../../src/utils/getPath";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9401 };
const CONSUMER = "11111111-1111-4111-a111-111111111111";
const SOURCE = "22222222-2222-4222-a222-222222222222";
const OTHER = "33333333-3333-4333-a333-333333333333";
const TEAM = "44444444-4444-4444-a444-444444444444";
const ASSET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function catalogRow(uuid: string, extras: Record<string, unknown> = {}) {
  return {
    projectUuid: uuid,
    name: uuid.slice(0, 8),
    kind: extras.kind ?? "personal",
    ownerUserId: IDENTITY.userId,
    role: extras.myRole ?? "owner",
    myRole: extras.myRole ?? "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-13T00:00:00Z",
    lockStatus: extras.lockStatus ?? "none",
    lockHolderName: "",
    openMode: extras.openMode ?? "editable",
    businessType: "storyboard",
    assetSourceProjectUuid: extras.assetSourceProjectUuid,
    lockId: extras.lockId,
    fencingToken: extras.fencingToken,
    lockDeviceUuid: extras.lockDeviceUuid,
  };
}

async function listen(app: express.Express) {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function jsonRequest(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function withFixture<T>(run: (ctx: {
  port: number;
  deviceUuid: string;
}) => Promise<T>): Promise<T> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-auth-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  try {
    return await runWithUserStorage(IDENTITY, async () => {
      for (const [uuid, id] of [[CONSUMER, 31], [SOURCE, 32], [OTHER, 33], [TEAM, 34]] as const) {
        await initializeWorkspaceProject(uuid, {
          id,
          name: `p-${id}`,
          projectType: "storyboard" as "novel",
          userId: IDENTITY.userId,
        });
      }
      await runWithProjectStorage(SOURCE, async () => {
        await activeDb("o_assets").insert({
          id: 1,
          name: "角色甲",
          type: "role",
          describe: "雨巷主角",
          assetUuid: ASSET,
          projectId: 32,
        });
      });
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          id: "sess",
          serverUrl: IDENTITY.issuer,
          token: "t",
          expiresAt: Date.now() + 60_000,
          user: { id: IDENTITY.userId, username: "alice", nickname: "alice" },
          validatedAt: Date.now(),
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      try {
        return await run({ port, deviceUuid: getStableDeviceUUID(getPath()) });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test("viewer 写入必须 403，且来源资产不得被改", async () => {
  await withFixture(async ({ port }) => {
    syncCoordinator.listProjects = () => [
      catalogRow(CONSUMER, { myRole: "viewer", assetSourceProjectUuid: SOURCE, openMode: "readonly" }),
      catalogRow(SOURCE, { myRole: "viewer", openMode: "readonly" }),
    ] as any;
    const before = await runWithProjectStorage(SOURCE, () => activeDb("o_assets").where({ assetUuid: ASSET }).first());
    const written = await jsonRequest(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${CONSUMER}/storyboard/assets/${ASSET}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "不该写入" }) },
    );
    assert.equal(written.status, 403, `viewer 写入状态应为 403，实际 ${written.status}`);
    const after = await runWithProjectStorage(SOURCE, () => activeDb("o_assets").where({ assetUuid: ASSET }).first());
    assert.equal(after.name, before.name);
  });
});

test("Team 写必须校验设备、锁和 fencing，缺一不可", async () => {
  await withFixture(async ({ port, deviceUuid }) => {
    syncCoordinator.listProjects = () => [
      catalogRow(TEAM, {
        kind: "team",
        myRole: "editor",
        lockStatus: "active",
        lockId: "lock-ok",
        fencingToken: 9,
        lockDeviceUuid: deviceUuid,
      }),
    ] as any;
    const missing = await jsonRequest(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${TEAM}/storyboard/shots`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ afterShotUuid: null, sourceText: "无锁" }) },
    );
    assert.equal(missing.status, 403, `缺锁写入应为 403，实际 ${missing.status} ${JSON.stringify(missing.body)}`);

    const stale = await jsonRequest(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${TEAM}/storyboard/shots`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tj-device-uuid": deviceUuid,
          "x-tj-lock-id": "lock-ok",
          "x-tj-fencing-token": "1",
        },
        body: JSON.stringify({ afterShotUuid: null, sourceText: "旧栅栏" }),
      },
    );
    assert.equal(stale.status, 403, `旧 fencing 应为 403，实际 ${stale.status}`);

    const ok = await jsonRequest(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${TEAM}/storyboard/shots`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tj-device-uuid": deviceUuid,
          "x-tj-lock-id": "lock-ok",
          "x-tj-fencing-token": "9",
        },
        body: JSON.stringify({ afterShotUuid: null, sourceText: "合法写入" }),
      },
    );
    assert.equal(ok.status, 200, `合法 Team 写入应为 200，实际 ${ok.status} ${JSON.stringify(ok.body)}`);
  });
});

test("来源资产被任一使用项目引用时删除必须 409 并返回依赖清单，且零删除", async () => {
  await withFixture(async ({ port }) => {
    syncCoordinator.listProjects = () => [
      catalogRow(CONSUMER, { assetSourceProjectUuid: SOURCE }),
      catalogRow(OTHER, { assetSourceProjectUuid: SOURCE }),
      catalogRow(SOURCE),
    ] as any;
    const shot = await runWithProjectStorage(OTHER, async () => {
      const { StoryboardService } = await import("../../src/tianjiang/storyboard/storyboard-service");
      const created = await new StoryboardService(OTHER).insertShot({ afterShotUuid: null, sourceText: "引用" });
      await new StoryboardService(OTHER).bindAsset(created.shotUuid, {
        sourceProjectUuid: SOURCE,
        assetUuid: ASSET,
        assetType: "role",
        relationRole: "appear",
      });
      return created;
    });
    const deleted = await jsonRequest(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${CONSUMER}/storyboard/assets/${ASSET}`,
      { method: "DELETE" },
    );
    assert.equal(deleted.status, 409, `跨项目引用删除应为 409，实际 ${deleted.status} ${JSON.stringify(deleted.body)}`);
    assert.ok(Array.isArray(deleted.body?.dependents));
    assert.ok(deleted.body.dependents.some((item: { shotUuid?: string }) => item.shotUuid === shot.shotUuid));
    const still = await runWithProjectStorage(SOURCE, () => activeDb("o_assets").where({ assetUuid: ASSET }).first());
    assert.ok(still, "被引用资产不得删除");
  });
});

test("写来源资产必须在来源项目写入 mutation journal", async () => {
  await withFixture(async ({ port }) => {
    syncCoordinator.listProjects = () => [
      catalogRow(CONSUMER, { assetSourceProjectUuid: SOURCE }),
      catalogRow(SOURCE),
    ] as any;
    const written = await jsonRequest(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${CONSUMER}/storyboard/assets/${ASSET}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "新角色", describe: "更新" }) },
    );
    assert.equal(written.status, 200, `有权编辑应为 200，实际 ${written.status}`);
    const pending = await runWithProjectStorage(SOURCE, () => hasPendingMutationJournal(activeDb as any));
    assert.equal(pending, true, "来源项目必须有 pending mutation journal");
  });
});

test("分镜 CRUD/重排/绑定/候选生产路由必须完整，非法重排与删除零修改", async () => {
  await withFixture(async ({ port }) => {
    syncCoordinator.listProjects = () => [catalogRow(CONSUMER)] as any;
    const base = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${CONSUMER}/storyboard`;
    const first = await jsonRequest(`${base}/shots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ afterShotUuid: null, sourceText: "一" }),
    });
    const second = await jsonRequest(`${base}/shots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ afterShotUuid: first.body.data.shotUuid, sourceText: "二" }),
    });
    const third = await jsonRequest(`${base}/shots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ afterShotUuid: second.body.data.shotUuid, sourceText: "三" }),
    });
    assert.equal(first.body.data.displayOrder, 1);
    assert.equal(second.body.data.displayOrder, 2);
    assert.equal(third.body.data.displayOrder, 3);

    const inserted = await jsonRequest(`${base}/shots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ afterShotUuid: first.body.data.shotUuid, sourceText: "插在1后" }),
    });
    assert.equal(inserted.status, 200);
    assert.equal(inserted.body.data.displayOrder, 2);
    const listed = await jsonRequest(`${base}/shots`);
    assert.deepEqual(listed.body.data.map((row: { sourceText: string }) => row.sourceText), ["一", "插在1后", "二", "三"]);

    const patched = await jsonRequest(`${base}/shots/${inserted.body.data.shotUuid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imagePrompt: "近景", visualDescription: "雨巷" }),
    });
    assert.notEqual(patched.status, 404, "更新分镜路由必须存在");
    assert.equal(patched.status, 200);
    assert.equal(patched.body.data.imagePrompt, "近景");

    const bound = await jsonRequest(`${base}/shots/${inserted.body.data.shotUuid}/bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceProjectUuid: SOURCE,
        assetUuid: ASSET,
        assetType: "role",
        relationRole: "appear",
      }),
    });
    assert.notEqual(bound.status, 404, "绑定路由必须存在");
    assert.equal(bound.status, 200);

    const dupReorder = await jsonRequest(`${base}/shots/reorder`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderedShotUuids: [
          first.body.data.shotUuid,
          first.body.data.shotUuid,
          second.body.data.shotUuid,
          third.body.data.shotUuid,
        ],
      }),
    });
    assert.notEqual(dupReorder.status, 404, "重排路由必须存在");
    assert.equal(dupReorder.status, 409);
    const afterDup = await jsonRequest(`${base}/shots`);
    assert.deepEqual(afterDup.body.data.map((row: { sourceText: string }) => row.sourceText), ["一", "插在1后", "二", "三"]);

    const badDelete = await jsonRequest(`${base}/shots`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shotUuids: ["99999999-9999-4999-a999-999999999999"] }),
    });
    assert.notEqual(badDelete.status, 404, "删除路由必须存在");
    assert.ok([400, 404].includes(badDelete.status));
    const afterBad = await jsonRequest(`${base}/shots`);
    assert.equal(afterBad.body.data.length, 4);

    const selected = await jsonRequest(
      `${base}/shots/${inserted.body.data.shotUuid}/candidates/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/select`,
      { method: "POST" },
    );
    assert.notEqual(selected.status, 404, "候选选择路由必须存在");
  });
});
