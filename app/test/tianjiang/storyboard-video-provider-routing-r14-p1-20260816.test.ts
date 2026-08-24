/**
 * R14 RED：普通供应商与即梦必须按 providerModel 走现有统一 /generate 接口，
 * auto 必须在引用解析后变成显式模式；禁止静态预览能力进入正式收费链。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import express from "express";

import {
  activateUserDatabase,
  accountDb,
  db as activeDb,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import Ai from "../../src/utils/ai";
import getPath from "../../src/utils/getPath";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import {
  invalidateDreaminaCapabilityCache,
} from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import { writeReadyDreaminaTestCapability } from "./helpers/dreamina-capability";
import { stopDreaminaSchedulerLoop } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 1414 };
const PROJECT = "e1414141-1414-4141-a141-141414141141";
const ROLE = "e1414141-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
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

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R14",
    kind: "personal",
    ownerUserId: IDENTITY.userId,
    role: "owner",
    myRole: "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-16T00:00:00Z",
    lockStatus: "none",
    lockHolderName: "",
    openMode: "editable",
    businessType: "storyboard",
  };
}

async function countWrites(cliLog: string) {
  const operations = await runWithProjectStorage(PROJECT, async () => {
    if (!await activeDb.schema.hasTable("o_storyboardGenerationOperation")) return [];
    return activeDb("o_storyboardGenerationOperation").select();
  });
  const tasks = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").select());
  const candidates = await runWithProjectStorage(PROJECT, async () => {
    if (!await activeDb.schema.hasTable("o_storyboardCandidate")) return [];
    return activeDb("o_storyboardCandidate").select();
  });
  const dispatches = await accountDb("o_dreaminaCliDispatch").select().catch(() => []);
  const cliInvocations = fs.existsSync(cliLog)
    ? fs.readFileSync(cliLog, "utf8").trim().split(/\r?\n/).filter(Boolean).length
    : 0;
  return {
    operations: operations.length,
    tasks: tasks.length,
    candidates: candidates.length,
    dispatches: dispatches.length,
    cli: cliInvocations,
  };
}

async function withRoutingRuntime(
  name: string,
  run: (input: {
    port: number;
    textShotUuid: string;
    imageShotUuid: string;
    cliLog: string;
    paidInvocations: string[];
  }) => Promise<void>,
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  const originalImage = Ai.Image;
  const originalVideo = Ai.Video;
  const cliLog = path.join(root, "dreamina-cli-never-called.log");
  const paidInvocations: string[] = [];
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_FAKE_LOG = cliLog;
  resetDatabaseRuntimeForServe();
  invalidateDreaminaCapabilityCache();
  await activateUserDatabase(IDENTITY);
  Ai.Image = ((key: `${string}:${string}`) => ({
    async prepare() {
      throw new Error("R14 图片供应商不得被视频路由调用");
    },
    async run() {
      throw new Error("R14 图片供应商不得被视频路由调用");
    },
  })) as unknown as typeof Ai.Image;
  Ai.Video = ((key: `${string}:${string}`) => {
    const handle = {
      async execute() {
        paidInvocations.push(key);
        return {
          async save(target: string) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, "r14-vendor-video");
            return this;
          },
        };
      },
    };
    return {
      async prepare() {
        return { stage: async () => handle };
      },
      async run() {
        return handle.execute();
      },
    };
  }) as unknown as typeof Ai.Video;
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: 1414, name: "R14 路由", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow()] as any;
      stopDreaminaSchedulerLoop();
      await accountDb("o_dreaminaCliSettings").where({ id: 1 }).update({
        executablePath: FAKE_CLI,
        pauseNewClaims: 1,
      });
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({
        globalVideoPrompt: "统一动态",
        aspectRatio: "9:16",
        durationMs: 5000,
        resolution: "720p",
      });
      const textShot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "远景码头",
        videoPrompt: "缓慢推镜",
        durationMs: 5000,
      });
      const imageShot = await service.insertShot({
        afterShotUuid: textShot.shotUuid,
        sourceText: "角色近景",
        videoPrompt: "稳定跟拍",
        durationMs: 5000,
      });
      const context = currentUserStorage();
      assert.ok(context);
      const projectRoot = projectDirectory(getPath(), PROJECT, context.segment);
      const relativePath = "files/images/role-r14.png";
      const absolute = path.join(projectRoot, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, "r14-role");
      await runWithProjectStorage(PROJECT, async () => {
        await activeDb("o_image").insert({
          id: 501, filePath: relativePath, type: 1, assetsId: 401, state: "完成",
        });
        await activeDb("o_assets").insert({
          id: 401, name: "角色", type: "role", describe: "", imageId: 501, assetUuid: ROLE, projectId: 1414,
        });
      });
      await service.bindAsset(imageShot.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: ROLE, assetType: "role", relationRole: "appear",
      });
      const app = express();
      app.use(express.json({ limit: "4mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r14" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      try {
        await run({
          port,
          textShotUuid: textShot.shotUuid,
          imageShotUuid: imageShot.shotUuid,
          cliLog,
          paidInvocations,
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    stopDreaminaSchedulerLoop();
    invalidateDreaminaCapabilityCache();
    Ai.Image = originalImage;
    Ai.Video = originalVideo;
    delete process.env.DREAMINA_FAKE_LOG;
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function previewUrl(port: number) {
  return `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate/preview`;
}

function generateUrl(port: number) {
  return `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`;
}

test("普通供应商 preview 成功时不得写入 Dreamina 或执行 vendor", async () => {
  await withRoutingRuntime("r14-vendor-preview", async ({ port, textShotUuid, cliLog, paidInvocations }) => {
    const preview = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: textShotUuid,
        mediaType: "video",
        providerModel: "vendor-alpha:kling-v1",
        mode: "auto",
        durationMs: 5_000,
        aspectRatio: "9:16",
      }),
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body?.data?.providerModel, "vendor-alpha:kling-v1");
    assert.equal(preview.body?.data?.options?.mode, "text2video");
    assert.deepEqual(await countWrites(cliLog), {
      operations: 0, tasks: 0, candidates: 0, dispatches: 0, cli: 0,
    });
    assert.deepEqual(paidInvocations, []);
  });
});

test("普通供应商正式提交只走 fake Ai.Video，并保留 previewDigest 与 clientOperationId", async () => {
  await withRoutingRuntime("r14-vendor-generate", async ({ port, textShotUuid, cliLog, paidInvocations }) => {
    const clientOperationId = crypto.randomUUID();
    const preview = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: textShotUuid,
        mediaType: "video",
        providerModel: "vendor-alpha:kling-v1",
        mode: "auto",
        durationMs: 5_000,
        aspectRatio: "9:16",
      }),
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const generate = await jsonRequest(generateUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: textShotUuid,
        mediaType: "video",
        providerModel: "vendor-alpha:kling-v1",
        mode: preview.body.data.options.mode,
        durationMs: 5_000,
        aspectRatio: "9:16",
        expectedPreviewDigest: preview.body.data.previewDigest,
        clientOperationId,
      }),
    });
    assert.ok(generate.status === 200 || generate.status === 202, JSON.stringify(generate.body));
    assert.equal(generate.body?.data?.[0]?.clientOperationId, clientOperationId);
    const writes = await countWrites(cliLog);
    assert.equal(writes.dispatches, 0, "普通供应商不得创建 Dreamina dispatch");
    assert.equal(writes.cli, 0, "普通供应商不得启动 dreamina CLI");
    assert.ok(writes.tasks >= 1, "正式提交必须写入供应商任务");
    assert.deepEqual(paidInvocations, ["vendor-alpha:kling-v1"]);
  });
});

test("即梦模型不得误走普通供应商 Ai.Video", async () => {
  await withRoutingRuntime("r14-dreamina-generate", async ({ port, textShotUuid, cliLog, paidInvocations }) => {
    writeReadyDreaminaTestCapability();
    const clientOperationId = crypto.randomUUID();
    const preview = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: textShotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "auto",
        durationMs: 5_000,
        aspectRatio: "9:16",
      }),
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const generate = await jsonRequest(generateUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: textShotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: preview.body.data.options.mode,
        durationMs: 5_000,
        aspectRatio: "9:16",
        expectedPreviewDigest: preview.body.data.previewDigest,
        clientOperationId,
      }),
    });
    assert.equal(generate.status, 200, JSON.stringify(generate.body));
    const writes = await countWrites(cliLog);
    assert.ok(writes.dispatches >= 1, "即梦正式提交必须写入 dispatch");
    assert.equal(writes.cli, 0, "暂停领取时不得拉起 fake CLI");
    assert.deepEqual(paidInvocations, []);
  });
});

test("普通供应商 auto 必须按引用解析成显式模式", async () => {
  await withRoutingRuntime("r14-vendor-auto-mode", async ({ port, textShotUuid, imageShotUuid, cliLog, paidInvocations }) => {
    const empty = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: textShotUuid,
        mediaType: "video",
        providerModel: "vendor-beta:gen3-turbo",
        mode: "auto",
        durationMs: 5_000,
        aspectRatio: "9:16",
      }),
    });
    const single = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: imageShotUuid,
        mediaType: "video",
        providerModel: "vendor-beta:gen3-turbo",
        mode: "auto",
        durationMs: 5_000,
        aspectRatio: "9:16",
      }),
    });
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(empty.body?.data?.options?.mode, "text2video");
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body?.data?.options?.mode, "image2video");
    assert.deepEqual(await countWrites(cliLog), {
      operations: 0, tasks: 0, candidates: 0, dispatches: 0, cli: 0,
    });
    assert.deepEqual(paidInvocations, []);
  });
});

test("不支持的引用形态必须在 preview 阶段失败且零副作用", async () => {
  await withRoutingRuntime("r14-vendor-unsupported", async ({ port, textShotUuid, cliLog, paidInvocations }) => {
    const preview = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: textShotUuid,
        mediaType: "video",
        providerModel: "vendor-alpha:kling-v1",
        mode: "not-a-real-mode",
        durationMs: 5_000,
        aspectRatio: "9:16",
      }),
    });
    assert.ok(preview.status >= 400, JSON.stringify(preview.body));
    assert.deepEqual(await countWrites(cliLog), {
      operations: 0, tasks: 0, candidates: 0, dispatches: 0, cli: 0,
    });
    assert.deepEqual(paidInvocations, []);
  });
});
