/**
 * Round27 RED：单项和批量生成必须保留页面提交的画幅/时长覆盖值，非法覆盖不得静默入队。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import {
  activateUserDatabase,
  db as activeDb,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import {
  withStoryboardBatchPreviewDigests,
  withStoryboardPreviewDigest,
  writeReadyDreaminaTestCapability,
} from "./helpers/dreamina-capability";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9728 };
const PROJECT_UUID = "28282828-2828-4828-a828-282828282828";

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function jsonRequest(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

test("生产生成入口必须安全传递单项与批量画幅时长覆盖", async () => {
  const root = path.resolve(
    process.cwd(),
    "..",
    ".local",
    "t",
    `generation-overrides-${process.pid}-${crypto.randomUUID()}`,
  );
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  const originalListProjects = syncCoordinator.listProjects.bind(syncCoordinator);
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = previousTestContext || "storyboard-generation-overrides-round27";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  writeReadyDreaminaTestCapability();

  let server: http.Server | undefined;
  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 2728,
        name: "Round27 生成覆盖值",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT_UUID,
        name: "Round27 生成覆盖值",
        kind: "personal",
        ownerUserId: IDENTITY.userId,
        myRole: "owner",
        openMode: "editable",
      }] as any;

      const service = new StoryboardService(PROJECT_UUID);
      // 中文注释：覆盖值用例先满足真实 CLI 的必填提示词与分辨率合同，再验证单项和批量覆盖。
      await service.saveSettings({
        globalVideoPrompt: "生成覆盖值视频提示词",
        resolution: "720p",
      });
      const shot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "城市夜景",
      });
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "round27" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const listening = await listen(app);
      server = listening.server;
      const url = `http://127.0.0.1:${listening.port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/storyboard/generate`;

      const singleBody = await withStoryboardPreviewDigest(url, {
        shotUuid: shot.shotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "text2video",
        durationMs: 9_000,
        aspectRatio: "9:16",
        paidBatchConfirmed: false,
      });
      const single = await jsonRequest(url, singleBody);
      const batchItems = await withStoryboardBatchPreviewDigests(url, [
          {
            shotUuid: shot.shotUuid,
            mediaType: "video",
            providerModel: "dreamina-cli:seedance2.0mini",
            mode: "text2video",
            durationMs: 4_000,
            aspectRatio: "1:1",
          },
          {
            shotUuid: shot.shotUuid,
            mediaType: "video",
            providerModel: "dreamina-cli:seedance2.0_vip",
            mode: "text2video",
            durationMs: 12_000,
            aspectRatio: "16:9",
          },
        ]);
      const batch = await jsonRequest(url, {
        items: batchItems,
        paidBatchConfirmed: true,
        clientOperationId: crypto.randomUUID(),
      });
      const beforeInvalid = await runWithProjectStorage(PROJECT_UUID, () =>
        activeDb("o_storyboardGenerationTask").count<{ total: number }>("taskUuid as total").first());
      const invalid = await jsonRequest(url, {
        shotUuid: shot.shotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "text2video",
        durationMs: "9000",
        aspectRatio: "../9:16",
        paidBatchConfirmed: false,
      });
      const afterInvalid = await runWithProjectStorage(PROJECT_UUID, () =>
        activeDb("o_storyboardGenerationTask").count<{ total: number }>("taskUuid as total").first());

      assert.equal(single.status, 200, JSON.stringify(single.body));
      assert.equal(batch.status, 200, JSON.stringify(batch.body));
      const taskUuids = [
        String(single.body?.data?.[0]?.taskUuid ?? ""),
        ...((batch.body?.data ?? []) as Array<{ taskUuid?: unknown }>).map((item) => String(item.taskUuid ?? "")),
      ];
      const rows = await runWithProjectStorage(PROJECT_UUID, () =>
        activeDb("o_storyboardGenerationTask").whereIn("taskUuid", taskUuids).select());
      const optionsByModel = new Map(rows.map((row) => [
        String(row.modelName),
        (JSON.parse(String(row.parametersJson)) as { options: Record<string, unknown> }).options,
      ]));
      assert.deepEqual(optionsByModel.get("dreamina-cli:seedance2.0fast"), {
        aspectRatio: "9:16",
        resolution: "720p",
        durationMs: 9_000,
        mode: "text2video",
      });
      assert.equal(optionsByModel.get("dreamina-cli:seedance2.0mini")?.aspectRatio, "1:1");
      assert.equal(optionsByModel.get("dreamina-cli:seedance2.0mini")?.durationMs, 4_000);
      assert.equal(optionsByModel.get("dreamina-cli:seedance2.0_vip")?.aspectRatio, "16:9");
      assert.equal(optionsByModel.get("dreamina-cli:seedance2.0_vip")?.durationMs, 12_000);
      assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
      assert.equal(Number(afterInvalid?.total ?? 0), Number(beforeInvalid?.total ?? 0));
    });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    syncCoordinator.listProjects = originalListProjects;
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime());
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放时保留在当前 worktree 的 .local/t，禁止跨目录清理。
    }
  }
});
