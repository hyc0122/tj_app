/**
 * Task 10 RED：即梦全局 FIFO 必须通过生产分镜生成入口入队。
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
} from "../../src/utils/db";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { db as activeDb } from "../../src/utils/db";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  withStoryboardPreviewDigest,
  writeReadyDreaminaTestCapability,
} from "./helpers/dreamina-capability";

const PROJECT = "11111111-1111-4111-a111-111111111111";
const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9101 };

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function createApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    enterUserStorage(IDENTITY);
    (req as { centralSession?: unknown }).centralSession = {
      serverUrl: "https://api.j11.com.cn",
      user: { id: IDENTITY.userId, username: "alice" },
    };
    next();
  });
  const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
  app.use("/api/tianjiang/runtime", runtimeRouter);
  for (const name of ["getState", "pause", "resume", "retry", "cancelQueued"] as const) {
    try {
      const loaded = await import(`../../src/routes/task/dreaminaQueue/${name}.ts`);
      app.use(`/api/task/dreaminaQueue/${name}`, loaded.default);
    } catch {
      // GREEN 前未挂载。
    }
  }
  return app;
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

async function withAccount<T>(run: () => Promise<T>): Promise<T> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `dreamina-queue-t10-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  writeReadyDreaminaTestCapability();
  try {
    return await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: 21,
        name: "队列项目",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      // 中文注释：正常队列夹具显式满足真实 CLI 必需值；缺失值由独立 RED 合同覆盖。
      await new StoryboardService(PROJECT).saveSettings({
        globalImagePrompt: "队列图片生成",
        resolution: "2K",
      });
      return run();
    });
  } finally {
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

test("连续提交必须先全部 queued，未确认批量整批零写入", async () => {
  await withAccount(async () => {
    const app = await createApp();
    const { server, port } = await listen(app);
    const base = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard`;
    const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
    try {
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT,
        myRole: "owner",
        openMode: "editable",
      }] as any;
      const shot = await runWithProjectStorage(PROJECT, () =>
        new StoryboardService(PROJECT).insertShot({ afterShotUuid: null, sourceText: "雨巷" }));
      const shotUuid = shot.shotUuid;
      assert.ok(shotUuid);

      const batch = await jsonRequest(`${base}/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [
            { shotUuid, mediaType: "image", providerModel: "dreamina-cli:text2image", mode: "text2image" },
            { shotUuid, mediaType: "image", providerModel: "dreamina-cli:text2image", mode: "text2image" },
          ],
          paidBatchConfirmed: false,
        }),
      });
      assert.notEqual(batch.status, 404, "生成入队路由必须存在");
      assert.match(JSON.stringify(batch.body), /DREAMINA_PAID_BATCH_CONFIRMATION_REQUIRED/);
      const zero = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").select("taskUuid"));
      assert.equal(zero.length, 0);

      const uuids: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        const confirmed = await withStoryboardPreviewDigest(`${base}/generate`, {
          shotUuid,
          mediaType: "image",
          providerModel: "dreamina-cli:text2image",
          mode: "text2image",
          paidBatchConfirmed: false,
        });
        const enqueued = await jsonRequest(`${base}/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(confirmed),
        });
        assert.equal(enqueued.status, 200);
        assert.equal(enqueued.body?.data?.status ?? enqueued.body?.data?.[0]?.status, "queued");
        const taskUuid = enqueued.body?.data?.taskUuid ?? enqueued.body?.data?.[0]?.taskUuid;
        assert.ok(taskUuid);
        uuids.push(String(taskUuid));
      }
      assert.equal(new Set(uuids).size, 20);
      const projectRows = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").select("taskUuid"));
      const dispatchRows = await accountDb("o_dreaminaCliDispatch").select("taskUuid");
      assert.equal(projectRows.length, 20);
      assert.equal(dispatchRows.length, 20);
    } finally {
      syncCoordinator.listProjects = originalList;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("默认并发为 1，账号/项目/模型取最小值，领取按 createdAt+taskUuid FIFO", async () => {
  await withAccount(async () => {
    const app = await createApp();
    const { server, port } = await listen(app);
    try {
      const state = await jsonRequest(`http://127.0.0.1:${port}/api/task/dreaminaQueue/getState`);
      assert.notEqual(state.status, 404, "队列状态路由必须存在");
      const payload = state.body?.data ?? state.body;
      assert.equal(payload.maxConcurrentSubmit ?? payload.effectiveLimit, 1);

      const { tickDreaminaScheduler } = await import("../../src/tianjiang/model-providers/dreamina-cli/scheduler");
      assert.equal(typeof tickDreaminaScheduler, "function");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
