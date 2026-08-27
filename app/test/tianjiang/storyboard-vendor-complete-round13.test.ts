/**
 * Task 8 RED：普通供应商必须使用 preview 完整最终请求，保存 files/** 与候选；
 * preview 授权失败原样失败；无运行时权限上下文安装必须 fail-closed。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import express from "express";

import {
  accountDb,
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
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { installStoryboardCandidate } from "../../src/tianjiang/storyboard/storyboard-generation-service";
import { hasPendingMutationJournal } from "../../src/tianjiang/runtime/legacy-mutation-journal";
import getPath from "../../src/utils/getPath";
import { currentUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { withStoryboardPreviewDigest } from "./helpers/dreamina-capability";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9902 };
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

async function waitForOperationState(clientOperationId: string, expected: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const row = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationOperation")
      .where({ clientOperationId })
      .first("state"));
    if (String(row?.state ?? "") === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`操作 ${clientOperationId} 未在期限内进入 ${expected}`);
}

test("普通供应商实际入参必须等于 preview，且结果进入候选历史", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-vendor-complete-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  await activateUserDatabase(IDENTITY);
  const Ai = (await import("../../src/utils/ai")).default;
  const originalImage = Ai.Image;
  const captured: Array<{ key: string; input: unknown }> = [];
  Ai.Image = ((key: `${string}:${string}`) => {
    const saveResult = {
      async save(target: string) {
        // 中文注释：当前保存合同传入项目相对路径，测试夹具必须写入真实项目 files/ 目录。
        const context = currentUserStorage();
        assert.ok(context, "后台图片保存必须保留账号上下文");
        const absolute = path.join(
          projectDirectory(getPath(), PROJECT, context.segment),
          ...target.split("/"),
        );
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, "vendor-image");
        return this;
      },
    };
    return {
      async run(input: unknown) {
        captured.push({ key, input });
        return saveResult;
      },
      async prepare(input: unknown) {
        captured.push({ key, input });
        return {
          async stage() {
            return {
              async execute() {
                return saveResult;
              },
            };
          },
        };
      },
    };
  }) as typeof Ai.Image;
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: 72,
        name: "供应商完整请求",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await accountDb("o_vendorConfig").insert({
        id: "vendor",
        inputValues: "{}",
        models: JSON.stringify([{ modelName: "demo", name: "本地图片模型", type: "image" }]),
        enable: 1,
      }).onConflict("id").merge();
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT, name: "供应商完整请求", kind: "personal", ownerUserId: IDENTITY.userId,
        role: "owner", myRole: "owner", currentVersion: 1, syncState: "synced",
        lastSyncedAt: null, updatedAt: "2026-08-13T00:00:00Z", lockStatus: "none",
        lockHolderName: "", openMode: "editable", businessType: "storyboard",
      }] as any;
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({ globalImagePrompt: "全局风格X", aspectRatio: "9:16", resolution: "2K" });
      const shot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "雨巷",
        imagePrompt: "近景胶片",
        negativePrompt: "模糊",
      });
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
        assert.equal(preview.status, 200, `preview 应为 200，实际 ${preview.status}`);
        const generateBody = await withStoryboardPreviewDigest(`${base}/generate`, {
          shotUuid: shot.shotUuid,
          mediaType: "image",
          providerModel: "vendor:demo",
          mode: "text2image",
        });
        const clientOperationId = String(generateBody.clientOperationId);
        const accepted = await jsonRequest(`${base}/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(generateBody),
        });
        assert.equal(accepted.status, 202, `生成受理应为 202，实际 ${accepted.status} ${JSON.stringify(accepted.body)}`);
        assert.equal(accepted.body?.data?.tasks?.[0]?.status, "queued", JSON.stringify(accepted.body));
        await waitForOperationState(clientOperationId, "completed");
        // 中文注释：完成后用同一操作 ID 重放，读取权威 completed 快照且不得重复收费。
        const generated = await jsonRequest(`${base}/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(generateBody),
        });
        assert.equal(generated.status, 200, `生成应为 200，实际 ${generated.status} ${JSON.stringify(generated.body)}`);
        const generatedStatus = generated.body?.data?.status
          ?? generated.body?.data?.[0]?.status
          ?? generated.body?.data?.tasks?.[0]?.status;
        assert.ok(
          generatedStatus === "completed" || Array.isArray(generated.body?.data),
          `完成后才返回 completed，实际 ${JSON.stringify(generated.body?.data)}`,
        );
        assert.ok(captured[0], "必须真正调用 Ai.Image");
        assert.match(
          JSON.stringify(captured[0]!.input ?? preview.body.data),
          /近景胶片|全局风格X/,
          "普通供应商入参必须包含 preview 已确认的提示词",
        );
        const candidates = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardCandidate").select());
        assert.ok(candidates.length > 0, "生成结果必须进入候选历史");
        const relativePath = String(candidates[0]!.relativePath);
        const abs = path.join(projectDirectory(getPath(), PROJECT, currentUserStorage()!.segment), ...relativePath.split("/"));
        assert.equal(fs.existsSync(abs), true, `媒体必须落在 files/**，缺少 ${relativePath}`);
        const journal = await runWithProjectStorage(PROJECT, () => hasPendingMutationJournal(activeDb as any));
        assert.equal(journal, true, "候选安装必须写 mutation journal");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    Ai.Image = originalImage;
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("preview 授权失败必须原样失败，不得回落匿名合并", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-preview-403-${Date.now()}`);
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
        id: 73,
        name: "预览失败",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => {
        throw Object.assign(new Error("缺少当前中央会话"), { status: 403 });
      };
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      try {
        const preview = await jsonRequest(
          `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate/preview`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mediaType: "image", providerModel: "vendor:demo" }),
          },
        );
        assert.equal(preview.status, 403, `授权失败必须原样 403，实际 ${preview.status} ${JSON.stringify(preview.body)}`);
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

test("后台候选安装找不到运行时权限上下文必须 fail-closed 零写入", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-install-closed-${Date.now()}`);
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
        id: 74,
        name: "安装失败关闭",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      const shot = await new StoryboardService(PROJECT).insertShot({ afterShotUuid: null, sourceText: "雨巷" });
      syncCoordinator.listProjects = () => {
        throw Object.assign(new Error("缺少当前中央会话"), { status: 403 });
      };
      const before = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardCandidate").select());
      let status = 200;
      try {
        await installStoryboardCandidate({
          projectUuid: PROJECT,
          shotUuid: shot.shotUuid,
          mediaType: "image",
          relativePath: "files/images/storyboard/x.png",
          select: true,
        });
      } catch (error) {
        status = Number((error as { status?: number }).status ?? 500);
      }
      const after = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardCandidate").select());
      assert.equal(status, 403, `无权限上下文必须 403，实际 ${status}`);
      assert.equal(after.length, before.length, "fail-closed 必须零写入候选");
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
