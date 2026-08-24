/**
 * P1 RED：共享资产必须支持在来源项目中新建，并以上传图片的受保护封面刷新。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import express from "express";

import {
  activateUserDatabase,
  db as activeDb,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9829 };
const CONSUMER = "11111111-1111-4111-a111-111111111111";
const SOURCE = "22222222-2222-4222-a222-222222222222";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000a49444154789c6360000002000100ffff03000006000557bf2cd40000000049454e44ae426082",
  "hex",
);

function catalogRow(projectUuid: string, assetSourceProjectUuid?: string, role = "owner") {
  return {
    projectUuid,
    name: projectUuid.slice(0, 8),
    kind: "personal",
    ownerUserId: IDENTITY.userId,
    role,
    myRole: role,
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-15T00:00:00Z",
    lockStatus: "none",
    lockHolderName: "",
    openMode: role === "viewer" ? "readonly" : "editable",
    businessType: "storyboard",
    assetSourceProjectUuid,
  };
}

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function createRuntimeApp(): Promise<{ server: http.Server; port: number }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    enterUserStorage(IDENTITY);
    (req as { centralSession?: unknown }).centralSession = {
      id: "asset-create-session",
      serverUrl: IDENTITY.issuer,
      token: "test-token",
      expiresAt: Date.now() + 60_000,
      user: { id: IDENTITY.userId, username: "alice", nickname: "alice" },
      validatedAt: Date.now(),
    };
    next();
  });
  const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
  app.use("/api/tianjiang/runtime", runtimeRouter);
  return listen(app);
}

test("来源项目可写时必须能新建资产并上传受保护封面，非法文件不得泄露路径", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `asset-create-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);

  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(CONSUMER, {
        id: 81,
        name: "consumer",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await initializeWorkspaceProject(SOURCE, {
        id: 82,
        name: "source",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [
        catalogRow(CONSUMER, SOURCE),
        catalogRow(SOURCE),
      ] as any;

      const { server, port } = await createRuntimeApp();
      const base = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${CONSUMER}/storyboard/assets`;
      try {
        const created = await fetch(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "role", name: " 林夏 ", describe: "女主角" }),
        });
        assert.notEqual(created.status, 404, "新建资产路由必须存在");
        const createdBody = await created.json() as { data?: Record<string, unknown>; message?: string };
        assert.equal(created.status, 200, `新建资产失败: ${JSON.stringify(createdBody)}`);
        const asset = createdBody.data ?? {};
        assert.match(String(asset.assetUuid ?? ""), /^[0-9a-f-]{36}$/i);
        assert.equal(asset.name, "林夏");
        assert.equal(asset.type, "role");
        assert.equal(asset.sourceProjectUuid, SOURCE);
        assert.equal(asset.imageId, undefined);
        assert.equal(asset.filePath, undefined);
        const serializedCreate = JSON.stringify(createdBody);
        assert.equal(serializedCreate.includes("C:"), false);
        assert.equal(serializedCreate.includes("imageId"), false);

        await runWithProjectStorage(SOURCE, async () => {
          const row = await activeDb("o_assets").where({ assetUuid: asset.assetUuid }).first();
          assert.ok(row, "资产必须写入来源项目");
          assert.equal(row.name, "林夏");
        });

        const form = new FormData();
        form.append("file", new Blob([PNG_BYTES], { type: "image/png" }), "cover.png");
        const uploaded = await fetch(`${base}/${asset.assetUuid}/image`, {
          method: "POST",
          body: form,
        });
        assert.notEqual(uploaded.status, 404, "资产图片上传路由必须存在");
        const uploadedBody = await uploaded.json() as { data?: Record<string, unknown>; message?: string };
        assert.equal(uploaded.status, 200, `上传失败: ${JSON.stringify(uploadedBody)}`);
        const coverUrl = String(uploadedBody.data?.coverUrl ?? "");
        assert.match(coverUrl, new RegExp(`/api/tianjiang/runtime/projects/${SOURCE}/files/images/`));
        assert.equal(JSON.stringify(uploadedBody).includes("filePath"), false);
        assert.equal(JSON.stringify(uploadedBody).includes("imageId"), false);

        const listed = await fetch(base);
        assert.equal(listed.status, 200);
        const listBody = await listed.json() as { data?: { assets?: Array<Record<string, unknown>> } };
        const listedAsset = (listBody.data?.assets ?? []).find((item) => item.assetUuid === asset.assetUuid);
        assert.equal(listedAsset?.coverUrl, coverUrl);

        const cover = await fetch(`http://127.0.0.1:${port}${coverUrl}`);
        assert.equal(cover.status, 200);
        assert.equal(cover.headers.get("content-type"), "image/png");

        const rejected = await fetch(`${base}/${asset.assetUuid}/image`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            file: "data:image/png;base64,aaaa",
            path: "C:\\\\Users\\\\alice\\\\secret.png",
          }),
        });
        assert.notEqual(rejected.status, 200, "禁止用任意 JSON/base64 绕过 multipart");
        const rejectedText = await rejected.text();
        assert.equal(rejectedText.includes("C:\\\\Users"), false, "拒绝响应不得泄露盘符路径");

        const spoofed = new FormData();
        spoofed.append("file", new Blob([Buffer.from("not-an-image")], { type: "image/png" }), "x.png");
        const spoofedResponse = await fetch(`${base}/${asset.assetUuid}/image`, {
          method: "POST",
          body: spoofed,
        });
        assert.notEqual(spoofedResponse.status, 200, "伪造 MIME 必须拒绝");
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
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 测试清理失败不覆盖主断言 */ }
    void currentUserStorage;
  }
});

test("只读消费项目不得新建资产", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `asset-create-ro-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);

  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(CONSUMER, {
        id: 91,
        name: "consumer-ro",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow(CONSUMER, undefined, "viewer")] as any;
      const { server, port } = await createRuntimeApp();
      try {
        const created = await fetch(
          `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${CONSUMER}/storyboard/assets`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "scene", name: "剧院" }),
          },
        );
        assert.ok([403, 400].includes(created.status), `只读新建应被拒绝: ${created.status}`);
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
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 测试清理失败不覆盖主断言 */ }
  }
});
