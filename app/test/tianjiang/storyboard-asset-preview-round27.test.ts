/**
 * 共享资产安全预览 RED：列表只能返回来源项目内、files/ 下的受保护媒体 URL。
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
import getPath from "../../src/utils/getPath";
import { writeProjectFileAtomic } from "../../src/tianjiang/media/project-file-store";
import {
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9727 };
const CONSUMER = "11111111-1111-4111-a111-111111111111";
const SOURCE = "22222222-2222-4222-a222-222222222222";
const VALID_ASSET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function catalogRow(projectUuid: string, assetSourceProjectUuid?: string) {
  return {
    projectUuid,
    name: projectUuid.slice(0, 8),
    kind: "personal",
    ownerUserId: IDENTITY.userId,
    role: "owner",
    myRole: "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-15T00:00:00Z",
    lockStatus: "none",
    lockHolderName: "",
    openMode: "editable",
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

test("共享资产列表返回来源项目受保护 coverUrl，并隔离非法路径与其他项目资产", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `asset-preview-${Date.now()}`);
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
        id: 71,
        name: "consumer",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await initializeWorkspaceProject(SOURCE, {
        id: 72,
        name: "source",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });

      const segment = currentUserStorage()?.segment;
      assert.ok(segment, "测试必须处于真实账号存储上下文");
      writeProjectFileAtomic(
        getPath(),
        SOURCE,
        segment,
        "files/images/role-cover.png",
        Buffer.from("source-cover"),
      );
      writeProjectFileAtomic(
        getPath(),
        CONSUMER,
        segment,
        "files/images/consumer-only.png",
        Buffer.from("consumer-cover"),
      );

      await runWithProjectStorage(SOURCE, async () => {
        const imageRows = [
          { id: 101, assetsId: 1, filePath: "files/images/role-cover.png", state: "已完成" },
          { id: 102, assetsId: 2, filePath: "../outside.png", state: "已完成" },
          { id: 103, assetsId: 3, filePath: "C:/Users/alice/secret.png", state: "已完成" },
          { id: 104, assetsId: 4, filePath: "\\\\server\\share\\secret.png", state: "已完成" },
          { id: 105, assetsId: 5, filePath: "files\\images\\backslash.png", state: "已完成" },
          { id: 106, assetsId: 6, filePath: "files/images/control\u0001.png", state: "已完成" },
          { id: 107, assetsId: 7, filePath: "/files/images/rooted.png", state: "已完成" },
          { id: 108, assetsId: 8, filePath: "files/images/../secret.png", state: "已完成" },
        ];
        await activeDb("o_image").insert(imageRows);
        await activeDb("o_assets").insert(imageRows.map((row, index) => ({
          id: index + 1,
          assetUuid: `${String(index + 10).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
          name: index === 0 ? "林夏" : `非法路径${index}`,
          type: "role",
          describe: index === 0 ? "女主角" : "不得暴露预览",
          imageId: row.id,
          projectId: 72,
        })));
        await activeDb("o_assets").where({ id: 1 }).update({ assetUuid: VALID_ASSET });
        await activeDb("o_assets").insert({
          id: 9,
          assetUuid: "99999999-9999-4999-a999-999999999999",
          name: "无图片资产",
          type: "role",
          describe: "没有绑定图片",
          imageId: null,
          projectId: 72,
        });
      });

      // 中文注释：消费项目中的同名或其他资产不能混入来源项目资产列表。
      await runWithProjectStorage(CONSUMER, async () => {
        await activeDb("o_image").insert({
          id: 201,
          assetsId: 201,
          filePath: "files/images/consumer-only.png",
          state: "已完成",
        });
        await activeDb("o_assets").insert({
          id: 201,
          assetUuid: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          name: "消费项目私有资产",
          type: "role",
          describe: "不可见",
          imageId: 201,
          projectId: 71,
        });
      });

      syncCoordinator.listProjects = () => [
        catalogRow(CONSUMER, SOURCE),
        catalogRow(SOURCE),
      ] as any;

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          id: "asset-preview-session",
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
      const { server, port } = await listen(app);

      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${CONSUMER}/storyboard/assets`,
        );
        assert.equal(response.status, 200);
        const body = await response.json() as {
          data?: { sourceProjectUuid?: string; assets?: Array<Record<string, unknown>> };
        };
        assert.equal(body.data?.sourceProjectUuid, SOURCE);
        const assets = body.data?.assets ?? [];
        assert.equal(assets.length, 9, "列表只能读取来源项目的九条资产");
        assert.equal(assets.some((asset) => asset.name === "消费项目私有资产"), false);

        const valid = assets.find((asset) => asset.assetUuid === VALID_ASSET);
        assert.equal(
          valid?.coverUrl,
          `/api/tianjiang/runtime/projects/${SOURCE}/files/images/role-cover.png?size=20`,
          "合法图片必须转换为来源项目受保护 URL",
        );

        for (const asset of assets.filter((item) => item.assetUuid !== VALID_ASSET)) {
          assert.equal(asset.coverUrl, undefined, `非法路径资产不得返回 coverUrl：${String(asset.name)}`);
        }

        const serialized = JSON.stringify(body);
        assert.equal(serialized.includes("filePath"), false, "JSON 不得泄露数据库 filePath 字段");
        assert.equal(serialized.includes("imageId"), false, "JSON 不得泄露数据库 imageId 字段");
        assert.equal(serialized.includes("C:/Users"), false, "JSON 不得泄露本机盘符路径");
        assert.equal(serialized.includes("server\\\\share"), false, "JSON 不得泄露 UNC 路径");

        const coverResponse = await fetch(`http://127.0.0.1:${port}${String(valid?.coverUrl)}`);
        assert.equal(coverResponse.status, 200, "携带同一中央会话必须可读取受保护预览");
        assert.equal(coverResponse.headers.get("content-type"), "image/png");
        assert.equal(Buffer.from(await coverResponse.arrayBuffer()).toString(), "source-cover");
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
