/**
 * R13 RED：截图对应的即梦 auto 预览必须走真实 Express+SQLite，且零 CLI/入队。
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
  db as activeDb,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import getPath from "../../src/utils/getPath";
import { currentUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  invalidateDreaminaCapabilityCache,
  writeDreaminaCapabilityCache,
} from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import {
  DREAMINA_MODES,
  DREAMINA_VIDEO_MODELS,
  type DreaminaCapabilitySnapshot,
  type DreaminaMode,
} from "../../src/tianjiang/model-providers/dreamina-cli/contracts";
import { writeReadyDreaminaTestCapability } from "./helpers/dreamina-capability";
import { stopDreaminaSchedulerLoop } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import crypto from "node:crypto";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9913 };
const PROJECT = "d1111111-1111-4111-a111-111111111111";
const ROLE = "d1111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SCENE = "d1111111-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const TOOL = "d1111111-cccc-4ccc-8ccc-ccccccccccc1";

const IMPORTED_PROMPT = [
  "景别时长：约12秒",
  "场景：吉庆阁码头（白天）",
  "人物：黄晚棠、村民",
  "环境描述：河堤、石阶、身体壮硕、声音洪亮。衬托：空船停靠、村姑。",
  "分镜：黄晚棠从人群中挤到前面，所有议论都朝他来的方向聚拢。",
].join("\n");

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R13",
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

const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");

const MODE_FIELDS: Record<DreaminaMode, readonly string[]> = {
  text2image: ["--prompt", "--ratio", "--resolution_type", "--model_version"],
  image2image: ["--prompt", "--images", "--ratio", "--resolution_type"],
  text2video: ["--prompt", "--duration", "--ratio", "--video_resolution", "--model_version"],
  image2video: ["--prompt", "--image", "--duration", "--video_resolution", "--model_version"],
  frames2video: ["--prompt", "--first", "--last", "--duration", "--video_resolution", "--model_version"],
  multiframe2video: ["--prompt", "--images", "--duration", "--video_resolution", "--model_version"],
  multimodal2video: [
    "--prompt", "--image", "--video", "--audio",
    "--duration", "--ratio", "--video_resolution", "--model_version",
  ],
};

function frontendPreviewBody(shotUuid: string) {
  // 与 Web buildGenerationPreviewBody 对齐：auto + 9:16 + 15s + 720p。
  return {
    shotUuid,
    mediaType: "video",
    providerModel: "dreamina-cli:seedance2.0fast",
    mode: "auto",
    settings: { aspectRatio: "9:16", durationMs: 15_000, resolution: "720p" },
    shot: {
      visualDescription: "",
      videoPrompt: IMPORTED_PROMPT,
      negativePrompt: "",
      durationMs: 15_000,
      aspectRatio: "9:16",
    },
  };
}

test("截图条件预览必须 200 且零 CLI/任务/候选，并返回显式模式", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `r13-preview-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  // 中文注释：截图现场是非付费预览，禁止先写 CLI 能力缓存来掩盖合同错层。
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: 913, name: "R13 预览", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow()] as any;
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({
        globalVideoPrompt: "",
        aspectRatio: "9:16",
        durationMs: 5000,
        resolution: "",
      });
      const created = await service.insertShot({
        afterShotUuid: null,
        sourceText: IMPORTED_PROMPT,
        videoPrompt: IMPORTED_PROMPT,
        durationMs: 15_000,
      });
      await service.updateShot(created.shotUuid, { aspectRatio: "9:16" });
      const context = currentUserStorage();
      assert.ok(context);
      const projectRoot = projectDirectory(getPath(), PROJECT, context.segment);
      const files = {
        role: "files/images/role-22.png",
        scene: "files/images/scene-22.png",
        tool: "files/images/tool-2.png",
      };
      await runWithProjectStorage(PROJECT, async () => {
        for (const [index, [type, relativePath, uuid, name]] of [
          [1, files.role, ROLE, "22"],
          [2, files.scene, SCENE, "22"],
          [3, files.tool, TOOL, "2"],
        ].entries()) {
          const absolute = path.join(projectRoot, ...String(relativePath).split("/"));
          fs.mkdirSync(path.dirname(absolute), { recursive: true });
          fs.writeFileSync(absolute, `asset-${type}`);
          await activeDb("o_image").insert({
            id: 300 + index, filePath: relativePath, type, assetsId: 200 + index, state: "完成",
          });
          await activeDb("o_assets").insert({
            id: 200 + index, name, type, describe: "", imageId: 300 + index, assetUuid: uuid, projectId: 913,
          });
        }
      });
      await service.bindAsset(created.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: ROLE, assetType: "role", relationRole: "appear",
      });
      await service.bindAsset(created.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: SCENE, assetType: "scene", relationRole: "appear",
      });
      await service.bindAsset(created.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: TOOL, assetType: "tool", relationRole: "appear",
      });

      const app = express();
      app.use(express.json({ limit: "4mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r13" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      try {
        const url = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate/preview`;
        const preview = await jsonRequest(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(frontendPreviewBody(created.shotUuid)),
        });
        const serialized = JSON.stringify(preview.body);
        assert.equal(
          preview.status,
          200,
          `截图条件预览必须成功，实际 ${preview.status} code=${String(preview.body?.code ?? "")} message=${String(preview.body?.message ?? "")}`,
        );
        assert.match(String(preview.body?.data?.previewDigest ?? ""), /^[0-9a-f]{64}$/);
        assert.equal(preview.body?.data?.providerModel, "dreamina-cli:seedance2.0fast");
        assert.match(String(preview.body?.data?.prompt ?? ""), /吉庆阁码头/);
        assert.equal(Number(preview.body?.data?.options?.durationMs), 15_000);
        assert.equal(String(preview.body?.data?.options?.aspectRatio), "9:16");
        assert.match(String(preview.body?.data?.options?.mode ?? ""), /image2video|multiframe2video|multimodal2video/);
        assert.equal(/SELECT |INSERT |C:\\\\|at\s+\S+\.ts/i.test(serialized), false);
        const tasks = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").select());
        const candidates = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardCandidate").select());
        assert.equal(tasks.length, 0, "预览不得写入 generation task");
        assert.equal(candidates.length, 0, "预览不得写入候选");
        const dispatches = await accountDb("o_dreaminaCliDispatch").select().catch(() => []);
        assert.equal(dispatches.length, 0, "预览不得写入即梦调度");
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

async function countWrites(cliLog: string) {
  const operations = await runWithProjectStorage(PROJECT, async () => {
    if (!await activeDb.schema.hasTable("o_storyboardGenerationOperation")) return [];
    return activeDb("o_storyboardGenerationOperation").select();
  });
  const tasks = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").select());
  const dispatches = await accountDb("o_dreaminaCliDispatch").select().catch(() => []);
  const cliInvocations = fs.existsSync(cliLog)
    ? fs.readFileSync(cliLog, "utf8").trim().split(/\r?\n/).filter(Boolean).length
    : 0;
  return {
    operations: operations.length,
    tasks: tasks.length,
    dispatches: dispatches.length,
    cli: cliInvocations,
  };
}

function writeDisabledTargetModeCapability(disabledMode: DreaminaMode): void {
  const snapshot: DreaminaCapabilitySnapshot = {
    installed: true,
    version: "r13-disabled",
    probedAt: Date.now(),
    loggedIn: true,
    modes: Object.fromEntries(DREAMINA_MODES.map((mode) => [mode, {
      enabled: mode !== disabledMode,
      fields: MODE_FIELDS[mode],
    }])) as DreaminaCapabilitySnapshot["modes"],
    capabilities: DREAMINA_MODES.filter((mode) => mode !== disabledMode),
    videoModels: [...DREAMINA_VIDEO_MODELS],
  };
  writeDreaminaCapabilityCache({ state: "ready", snapshot, checkedAt: Date.now() });
}

async function withGenerationRuntime(
  name: string,
  run: (input: { port: number; shotUuid: string; cliLog: string }) => Promise<void>,
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  const cliLog = path.join(root, "dreamina-cli-never-called.log");
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_FAKE_LOG = cliLog;
  resetDatabaseRuntimeForServe();
  invalidateDreaminaCapabilityCache();
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: 913, name: "R13 预览", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow()] as any;
      stopDreaminaSchedulerLoop();
      await accountDb("o_dreaminaCliSettings").where({ id: 1 }).update({
        executablePath: FAKE_CLI,
        pauseNewClaims: 1,
      });
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({
        globalVideoPrompt: "",
        aspectRatio: "9:16",
        durationMs: 5000,
        resolution: "720p",
      });
      const created = await service.insertShot({
        afterShotUuid: null,
        sourceText: IMPORTED_PROMPT,
        videoPrompt: IMPORTED_PROMPT,
        durationMs: 15_000,
      });
      await service.updateShot(created.shotUuid, { aspectRatio: "9:16" });
      const context = currentUserStorage();
      assert.ok(context);
      const projectRoot = projectDirectory(getPath(), PROJECT, context.segment);
      const files = {
        role: "files/images/role-22.png",
        scene: "files/images/scene-22.png",
        tool: "files/images/tool-2.png",
      };
      await runWithProjectStorage(PROJECT, async () => {
        for (const [index, [type, relativePath, uuid, name]] of [
          [1, files.role, ROLE, "22"],
          [2, files.scene, SCENE, "22"],
          [3, files.tool, TOOL, "2"],
        ].entries()) {
          const absolute = path.join(projectRoot, ...String(relativePath).split("/"));
          fs.mkdirSync(path.dirname(absolute), { recursive: true });
          fs.writeFileSync(absolute, `asset-${type}`);
          await activeDb("o_image").insert({
            id: 300 + index, filePath: relativePath, type, assetsId: 200 + index, state: "完成",
          });
          await activeDb("o_assets").insert({
            id: 200 + index, name, type, describe: "", imageId: 300 + index, assetUuid: uuid, projectId: 913,
          });
        }
      });
      await service.bindAsset(created.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: ROLE, assetType: "role", relationRole: "appear",
      });
      await service.bindAsset(created.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: SCENE, assetType: "scene", relationRole: "appear",
      });
      await service.bindAsset(created.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: TOOL, assetType: "tool", relationRole: "appear",
      });
      const app = express();
      app.use(express.json({ limit: "4mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r13" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      try {
        await run({ port, shotUuid: created.shotUuid, cliLog });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    stopDreaminaSchedulerLoop();
    invalidateDreaminaCapabilityCache();
    delete process.env.DREAMINA_FAKE_LOG;
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test("无能力缓存时 preview=200 且零写入，正式提交必须失败关闭", async () => {
  await withGenerationRuntime("r13-no-cache-execute", async ({ port, shotUuid, cliLog }) => {
    invalidateDreaminaCapabilityCache();
    delete process.env.DREAMINA_TEST_EXECUTABLE;
    await accountDb("o_dreaminaCliSettings").where({ id: 1 }).update({
      executablePath: path.join(process.cwd(), "missing-dreamina-cli"),
    });
    const previewUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate/preview`;
    const generateUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`;
    const preview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(frontendPreviewBody(shotUuid)),
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.match(String(preview.body?.data?.previewDigest ?? ""), /^[0-9a-f]{64}$/);
    assert.deepEqual(await countWrites(cliLog), { operations: 0, tasks: 0, dispatches: 0, cli: 0 });

    const generate = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: preview.body.data.options.mode,
        durationMs: 15_000,
        aspectRatio: "9:16",
        expectedPreviewDigest: preview.body.data.previewDigest,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.ok(generate.status >= 400, `无能力缓存正式提交必须失败，实际 ${generate.status} ${JSON.stringify(generate.body)}`);
    assert.deepEqual(await countWrites(cliLog), { operations: 0, tasks: 0, dispatches: 0, cli: 0 });
  });
});

test("能力缓存 ready 但目标模式 disabled 时正式提交零写入", async () => {
  await withGenerationRuntime("r13-disabled-mode", async ({ port, shotUuid, cliLog }) => {
    writeReadyDreaminaTestCapability();
    const previewUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate/preview`;
    const generateUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`;
    const preview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(frontendPreviewBody(shotUuid)),
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const targetMode = String(preview.body.data.options.mode);
    writeDisabledTargetModeCapability(targetMode as DreaminaMode);
    const generate = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: targetMode,
        durationMs: 15_000,
        aspectRatio: "9:16",
        expectedPreviewDigest: preview.body.data.previewDigest,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.ok(generate.status >= 400, `目标模式 disabled 必须失败，实际 ${generate.status} ${JSON.stringify(generate.body)}`);
    assert.deepEqual(await countWrites(cliLog), { operations: 0, tasks: 0, dispatches: 0, cli: 0 });
  });
});

test("能力缓存 ready 且支持时正式提交维持既有入队合同", async () => {
  await withGenerationRuntime("r13-ready-enqueue", async ({ port, shotUuid, cliLog }) => {
    writeReadyDreaminaTestCapability();
    const previewUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate/preview`;
    const generateUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`;
    const preview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(frontendPreviewBody(shotUuid)),
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const generate = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: preview.body.data.options.mode,
        durationMs: 15_000,
        aspectRatio: "9:16",
        expectedPreviewDigest: preview.body.data.previewDigest,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.equal(generate.status, 200, JSON.stringify(generate.body));
    const writes = await countWrites(cliLog);
    assert.ok(writes.tasks >= 1, "ready 且支持时必须写入任务");
    assert.ok(writes.dispatches >= 1, "ready 且支持时必须写入调度");
    assert.equal(writes.cli, 0, "暂停领取时不得拉起 fake CLI");
  });
});
