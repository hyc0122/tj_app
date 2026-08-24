/**
 * Task 8 RED：普通供应商不得进入即梦队列；预览必须使用持久化设置。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import express from "express";

import {
  activateUserDatabase,
  accountDb,
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
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9601 };
const PROJECT = "11111111-1111-4111-a111-111111111111";

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

test("vendor 模型不得写入即梦 dispatch，预览必须合并已保存设置", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-vendor-${Date.now()}`);
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
        id: 51, name: "生成项目", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT, name: "生成项目", kind: "personal", ownerUserId: IDENTITY.userId,
        role: "owner", myRole: "owner", currentVersion: 1, syncState: "synced",
        lastSyncedAt: null, updatedAt: "2026-08-13T00:00:00Z", lockStatus: "none",
        lockHolderName: "", openMode: "editable", businessType: "storyboard",
      }] as any;
      const shot = await new StoryboardService(PROJECT).insertShot({
        afterShotUuid: null,
        sourceText: "雨巷",
        imagePrompt: "近景",
      });
      await new StoryboardService(PROJECT).saveSettings({ globalImagePrompt: "全局风格X" });
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "alice" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      const base = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard`;
      try {
        const preview = await jsonRequest(`${base}/generate/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mediaType: "image",
            providerModel: "vendor:demo",
            shotUuid: shot.shotUuid,
          }),
        });
        assert.equal(preview.status, 200);
        assert.match(String(preview.body?.data?.prompt ?? ""), /全局风格X/);
        assert.match(String(preview.body?.data?.prompt ?? ""), /近景|雨巷/);

        const vendorGen = await jsonRequest(`${base}/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            shotUuid: shot.shotUuid,
            mediaType: "image",
            providerModel: "vendor:demo",
            mode: "text2image",
          }),
        });
        const dispatches = await accountDb("o_dreaminaCliDispatch").select("taskUuid");
        assert.equal(dispatches.length, 0, `普通供应商不得入即梦队列，实际 ${dispatches.length} 条，生成状态 ${vendorGen.status}`);
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
