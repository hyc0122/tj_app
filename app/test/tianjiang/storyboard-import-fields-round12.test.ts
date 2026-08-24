/**
 * Task 6–7 RED：导入必须单事务写入全部字段并匹配资产，错误整批零写入。
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

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9501 };
const PROJECT = "11111111-1111-4111-a111-111111111111";
const SOURCE = "22222222-2222-4222-a222-222222222222";
const ASSET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function csvGood(): string {
  return [
    "脚本,画面描述,图片提示词,视频提示词,负向提示词,时长毫秒,角色,场景,道具,素材,音频",
    "雨巷开场,近景,胶片颗粒,缓慢推进,低质量,4000,角色甲,,,,",
  ].join("\n");
}

function csvUnknownAsset(): string {
  return [
    "脚本,画面描述,图片提示词,视频提示词,负向提示词,时长毫秒,角色,场景,道具,素材,音频",
    "第二镜,远景,日光,固定,模糊,2000,不存在的角色,,,,",
  ].join("\n");
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
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: response.status, body };
}

test("CSV 导入必须写入提示词/时长并按名称绑定资产；未知资产跳过绑定不阻断", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-import-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: 41, name: "导入项目", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      await initializeWorkspaceProject(SOURCE, {
        id: 42, name: "来源", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      await runWithProjectStorage(SOURCE, async () => {
        await activeDb("o_assets").insert({
          id: 1, name: "角色甲", type: "role", describe: "", assetUuid: ASSET, projectId: 42,
        });
      });
      syncCoordinator.listProjects = () => [
        {
          projectUuid: PROJECT, name: "导入项目", kind: "personal", ownerUserId: IDENTITY.userId,
          role: "owner", myRole: "owner", currentVersion: 1, syncState: "synced",
          lastSyncedAt: null, updatedAt: "2026-08-13T00:00:00Z", lockStatus: "none",
          lockHolderName: "", openMode: "editable", businessType: "storyboard",
          assetSourceProjectUuid: SOURCE,
        },
        {
          projectUuid: SOURCE, name: "来源", kind: "personal", ownerUserId: IDENTITY.userId,
          role: "owner", myRole: "owner", currentVersion: 1, syncState: "synced",
          lastSyncedAt: null, updatedAt: "2026-08-13T00:00:00Z", lockStatus: "none",
          lockHolderName: "", openMode: "editable", businessType: "storyboard",
        },
      ] as any;
      const app = express();
      app.use(express.json({ limit: "4mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "alice" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      const { default: storyboardHttp } = await import("../../src/routes/tianjiang/storyboard-http");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      app.use("/api/tianjiang/storyboard", storyboardHttp);
      const { server, port } = await listen(app);
      const base = `http://127.0.0.1:${port}/api/tianjiang/storyboard/${PROJECT}`;
      try {
        const goodB64 = Buffer.from(csvGood(), "utf8").toString("base64");
        const preview = await jsonRequest(`${base}/import/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ format: "csv", contentBase64: goodB64 }),
        });
        assert.equal(preview.status, 200);
        const commit = await jsonRequest(`${base}/import/commit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            format: "csv",
            contentBase64: goodB64,
            previewDigest: preview.body.data.digest,
            mode: "append",
          }),
        });
        assert.equal(commit.status, 200, `合法导入应为 200，实际 ${commit.status} ${JSON.stringify(commit.body)}`);
        const shots = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardShot").select());
        assert.equal(shots.length, 1);
        assert.equal(shots[0].imagePrompt, "胶片颗粒");
        assert.equal(shots[0].videoPrompt, "缓慢推进");
        assert.equal(shots[0].durationMs, 4000);
        const binds = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardShotAsset").select());
        assert.equal(binds.length, 1);
        assert.equal(binds[0].assetUuid, ASSET);

        const badB64 = Buffer.from(csvUnknownAsset(), "utf8").toString("base64");
        const badPreview = await jsonRequest(`${base}/import/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ format: "csv", contentBase64: badB64 }),
        });
        const badCommit = await jsonRequest(`${base}/import/commit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            format: "csv",
            contentBase64: badB64,
            previewDigest: badPreview.body.data.digest,
            mode: "append",
          }),
        });
        assert.equal(badCommit.status, 200, `未匹配不得阻断导入，实际 ${badCommit.status} ${JSON.stringify(badCommit.body)}`);
        assert.ok(Number(badCommit.body?.data?.unmatchedCount ?? 0) >= 1);
        const after = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardShot").select());
        assert.equal(after.length, 2, "未匹配资产仍应写入分镜");
        const afterBinds = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardShotAsset").select());
        assert.equal(afterBinds.length, 1, "未知资产不得新建绑定");
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
});
