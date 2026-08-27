/**
 * R22 RED：四个已确认 P1。
 * P1-1 设置页 logged_in 后生成不得因另一套 capability cache 报 CLI 不可用。
 * P1-2 项目视频模型 + 角色/场景/道具/音频不得把不支持伪装成暂存失败。
 * P1-4 抽屉 Seedream 4.5 必须按真实阶段失败，图片记录不得永久生成中。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import u from "../../src/utils";
import {
  accountDatabase,
  activateUserDatabase,
  db as activeDb,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  prepareProjectDatabase,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  invalidateDreaminaCapabilityCache,
  readDreaminaCapabilityCache,
} from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import { resetDreaminaStartupStatusCheckForTests } from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import { stopDreaminaSchedulerLoop } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import {
  configureModelMediaResolver,
} from "../../src/tianjiang/media/model-media-reference";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import getPath from "../../src/utils/getPath";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2201 };
const PROJECT = "b0222121-2121-4121-a021-212121212121";
const ROLE = "b0222121-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SCENE = "b0222121-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const TOOL = "b0222121-cccc-4ccc-8ccc-ccccccccccc1";
const AUDIO = "b0222121-dddd-4ddd-8ddd-ddddddddddd1";
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");
const SEEDREAM_45 = "volcengine:doubao-seedream-4-5-251128";
const PROJECT_VIDEO = "volcengine:doubao-seedance-2-0-260128";

function pngBytes(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

function wavBytes(): Buffer {
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(8000, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(0, 40);
  return buf;
}

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R22",
    kind: "personal",
    ownerUserId: IDENTITY.userId,
    role: "owner",
    myRole: "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-17T00:00:00Z",
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

async function jsonRequest(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function payloadOf(body: any): any {
  return body?.data ?? body;
}

function commandLog(logFile: string): string[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8")
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { args: string[] }).args[0]);
}

function leakFree(serialized: string): void {
  assert.equal(/[A-Za-z]:\\/.test(serialized), false);
  assert.equal(serialized.includes("sk-"), false);
  assert.equal(serialized.includes("SELECT "), false);
  assert.equal(serialized.toLowerCase().includes("cookie"), false);
}

async function countRows(table: string): Promise<number> {
  return runWithProjectStorage(PROJECT, async () => {
    if (!await activeDb.schema.hasTable(table)) return 0;
    return (await activeDb(table).select()).length;
  });
}

async function waitForTaskState(
  clientOperationId: string,
  expected: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const row = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask")
      .where({ clientOperationId })
      .first("status", "errorCode", "errorSummary"));
    if (String(row?.status ?? "") === expected) return row as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`任务 ${clientOperationId} 未在期限内进入 ${expected}`);
}

function vendorStub(id: string, extra = ""): string {
  return `
const vendor = {
  id: ${JSON.stringify(id)},
  version: "2.0",
  name: ${JSON.stringify(id)},
  author: "r22",
  inputs: [],
  inputValues: {},
  ${extra}
  models: [{
    name: "video",
    modelName: "video",
    type: "video",
    mode: ["text", "singleImage", ["imageReference:9", "audioReference:3"]],
    audio: "optional",
    durationResolutionMap: [{ duration: [5], resolution: ["720p"] }],
  }, {
    name: "Seedream-4.5",
    modelName: "doubao-seedream-4-5-251128",
    type: "image",
    mode: ["text", "singleImage", "multiReference"],
  }],
};
async function videoRequest() { return ${JSON.stringify(`data:video/mp4;base64,${fs.readFileSync(path.resolve(__dirname, "fixtures/minimal-adoptable.mp4")).toString("base64")}`)}; }
async function imageRequest() { return "data:image/png;base64,AAAA"; }
exports.vendor = vendor;
exports.videoRequest = videoRequest;
exports.imageRequest = imageRequest;
export {};
`;
}

async function withRuntime(
  name: string,
  run: (input: {
    boundShot: string;
    generateUrl: string;
    previewUrl: string;
    statusUrl: string;
    generateAssetsUrl: string;
    logFile: string;
  }) => Promise<void>,
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${process.pid}-${crypto.randomUUID()}`);
  const logFile = path.join(root, "cli.jsonl");
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousExec = process.env.DREAMINA_TEST_EXECUTABLE;
  const previousLog = process.env.DREAMINA_FAKE_LOG;
  const previousScenario = process.env.DREAMINA_FAKE_SCENARIO;
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.DREAMINA_FAKE_LOG = logFile;
  delete process.env.DREAMINA_FAKE_SCENARIO;
  resetDatabaseRuntimeForServe();
  resetDreaminaStartupStatusCheckForTests();
  invalidateDreaminaCapabilityCache();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 2201,
        name: "R22",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow()] as never;
      stopDreaminaSchedulerLoop();
      await writeDreaminaCliSettings({ enabled: true, executablePath: FAKE_CLI });
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({
        resolution: "720p",
        aspectRatio: "9:16",
        durationMs: 5000,
        videoModel: PROJECT_VIDEO,
      });
      const first = await service.insertShot({
        afterShotUuid: null,
        sourceText: "角色近景",
        videoPrompt: "跟拍",
        durationMs: 5000,
      });
      const context = currentUserStorage();
      assert.ok(context);
      const projectRoot = projectDirectory(getPath(), PROJECT, context.segment);
      const writeRel = (relative: string, bytes: Buffer) => {
        const absolute = path.join(projectRoot, ...relative.split("/"));
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, bytes);
      };
      writeRel("files/images/role-r22.png", pngBytes());
      writeRel("files/images/scene-r22.png", pngBytes());
      writeRel("files/images/tool-r22.png", pngBytes());
      writeRel("files/audios/r22-voice.wav", wavBytes());
      await runWithProjectStorage(PROJECT, async () => {
        await activeDb("o_image").insert([
          { id: 1, filePath: "files/images/role-r22.png", type: "image", assetsId: 1, state: "已完成" },
          { id: 2, filePath: "files/images/scene-r22.png", type: "image", assetsId: 2, state: "已完成" },
          { id: 3, filePath: "files/images/tool-r22.png", type: "image", assetsId: 3, state: "已完成" },
          { id: 4, filePath: "files/audios/r22-voice.wav", type: "audio", assetsId: 4, state: "已完成" },
        ]);
        await activeDb("o_assets").insert([
          { id: 1, name: "甲", type: "role", describe: "", imageId: 1, assetUuid: ROLE, projectId: 2201 },
          { id: 2, name: "客栈", type: "scene", describe: "", imageId: 2, assetUuid: SCENE, projectId: 2201 },
          { id: 3, name: "剑", type: "tool", describe: "", imageId: 3, assetUuid: TOOL, projectId: 2201 },
          { id: 4, name: "旁白", type: "audio", describe: "", imageId: 4, assetUuid: AUDIO, projectId: 2201 },
        ]);
        await activeDb("o_assetsRole2Audio").insert({ assetsRoleId: 1, assetsAudioId: 4 });
      });
      await service.bindAsset(first.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: ROLE, assetType: "role", relationRole: "appear",
      });
      await service.bindAsset(first.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: SCENE, assetType: "scene", relationRole: "appear",
      });
      await service.bindAsset(first.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: TOOL, assetType: "tool", relationRole: "appear",
      });
      const app = express();
      app.use(express.json({ limit: "2mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r22" },
        };
        if (String(req.originalUrl ?? req.url).includes("assetsGenerate")) {
          return runWithProjectStorage(PROJECT, () => next());
        }
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      const statusRoute = (await import("../../src/routes/setting/dreaminaCli/getStatus")).default;
      const generateAssets = (await import("../../src/routes/assetsGenerate/generateAssets")).default;
      app.use("/api/tianjiang/runtime", runtimeRouter);
      app.use("/api/setting/dreaminaCli/getStatus", statusRoute);
      app.use("/api/assetsGenerate/generateAssets", generateAssets);
      await prepareProjectDatabase(PROJECT);
      const { server, port } = await listen(app);
      try {
        await run({
          boundShot: first.shotUuid,
          generateUrl: `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`,
          previewUrl: `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate/preview`,
          statusUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/getStatus`,
          generateAssetsUrl: `http://127.0.0.1:${port}/api/assetsGenerate/generateAssets`,
          logFile,
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    configureModelMediaResolver(undefined);
    stopDreaminaSchedulerLoop();
    resetDreaminaStartupStatusCheckForTests();
    invalidateDreaminaCapabilityCache();
    syncCoordinator.listProjects = originalList;
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousExec === undefined) delete process.env.DREAMINA_TEST_EXECUTABLE;
    else process.env.DREAMINA_TEST_EXECUTABLE = previousExec;
    if (previousLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = previousLog;
    if (previousScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
    else process.env.DREAMINA_FAKE_SCENARIO = previousScenario;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test("P1-1 getStatus 与耐久提交解耦，提交不得等待当前 CLI 能力探测", async () => {
  await withRuntime("r22-p1-dreamina-cache", async ({ boundShot, generateUrl, previewUrl, statusUrl, logFile }) => {
    let vendorStageCalls = 0;
    configureModelMediaResolver({
      signObject: async () => {
        vendorStageCalls += 1;
        throw new Error("Dreamina 不得调用普通供应商签名器");
      },
      stageLocalPath: async () => {
        vendorStageCalls += 1;
        throw new Error("Dreamina 不得调用普通供应商暂存器");
      },
    });
    fs.writeFileSync(logFile, "");
    const status = await jsonRequest(statusUrl);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    const payload = payloadOf(status.body);
    assert.equal(payload.install?.state, "installed", JSON.stringify(payload));
    assert.equal(payload.account?.state, "logged_in", JSON.stringify(payload));
    assert.equal(payload.account?.verified, true, JSON.stringify(payload));
    const cachedBefore = readDreaminaCapabilityCache();
    assert.notEqual(cachedBefore.state === "ready" && cachedBefore.snapshot?.loggedIn === true, true);

    const dreaminaBody = {
      shotUuid: boundShot,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0",
      mode: "auto",
      durationMs: 5000,
      aspectRatio: "9:16",
    };
    const preview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dreaminaBody),
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body?.data?.routeKind, "dreamina-cli", JSON.stringify(preview.body));

    const routeMismatch = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...dreaminaBody,
        routeKind: "vendor",
        expectedPreviewDigest: preview.body?.data?.previewDigest,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.equal(routeMismatch.status, 409, JSON.stringify(routeMismatch.body));
    assert.equal(routeMismatch.body?.code, "STORYBOARD_GENERATION_ROUTE_MISMATCH", JSON.stringify(routeMismatch.body));
    assert.equal(await countRows("o_storyboardGenerationOperation"), 0);
    assert.equal(await countRows("o_storyboardGenerationTask"), 0);
    assert.equal(await countRows("o_dreaminaCliDispatch"), 0);

    const generatedOperationId = crypto.randomUUID();
    const generated = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...dreaminaBody,
        expectedPreviewDigest: preview.body?.data?.previewDigest,
        clientOperationId: generatedOperationId,
      }),
    });
    leakFree(JSON.stringify(generated.body));
    assert.notEqual(generated.body?.code, "STORYBOARD_DREAMINA_CLI_UNAVAILABLE", JSON.stringify(generated.body));
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    assert.equal(generated.body?.data?.[0]?.status, "queued", JSON.stringify(generated.body));
    assert.equal(generated.body?.data?.[0]?.clientOperationId, generatedOperationId, JSON.stringify(generated.body));
    // 中文注释：即梦引用由本地 CLI 消费，普通供应商 resolver 即使被配置也必须保持零调用。
    assert.equal(vendorStageCalls, 0);
    const cachedAfter = readDreaminaCapabilityCache();
    // 中文注释：HTTP 提交只使用已发布能力合同，不得为了响应而刷新当前 CLI 能力缓存。
    assert.equal(cachedAfter.state, "not_checked", JSON.stringify(cachedAfter));
    const commands = commandLog(logFile);
    const rawLines = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").trim().split(/\n/).filter(Boolean).map((line) =>
        JSON.parse(line) as { args: string[] })
      : [];
    assert.ok(commands.includes("version") || commands.includes("-h"), JSON.stringify(commands));
    assert.ok(commands.includes("user_credit"), JSON.stringify(commands));
    assert.equal(commands.includes("login"), false, JSON.stringify(commands));
    for (const line of rawLines) {
      const head = String(line.args[0] ?? "");
      if (head.endsWith("2video") || head.endsWith("2image")) {
        assert.ok(line.args.includes("-h") || line.args.includes("--help"), JSON.stringify(line.args));
      }
    }

    fs.writeFileSync(logFile, "");
    await writeDreaminaCliSettings({ enabled: false });
    resetDreaminaStartupStatusCheckForTests();
    const disabled = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...dreaminaBody,
        expectedPreviewDigest: "0".repeat(64),
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.equal(disabled.body?.code, "DREAMINA_CLI_DISABLED");
    assert.deepEqual(commandLog(logFile), []);

    await writeDreaminaCliSettings({ enabled: true, executablePath: FAKE_CLI });
    resetDreaminaStartupStatusCheckForTests();
    invalidateDreaminaCapabilityCache();
    process.env.DREAMINA_FAKE_SCENARIO = "not_logged_in";
    fs.writeFileSync(logFile, "");
    const loggedOutOperationId = crypto.randomUUID();
    const loggedOut = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...dreaminaBody,
        expectedPreviewDigest: preview.body?.data?.previewDigest,
        clientOperationId: loggedOutOperationId,
      }),
    });
    assert.equal(loggedOut.status, 200, JSON.stringify(loggedOut.body));
    assert.equal(loggedOut.body?.code, 0, JSON.stringify(loggedOut.body));
    assert.equal(loggedOut.body?.data?.[0]?.status, "queued", JSON.stringify(loggedOut.body));
    assert.equal(loggedOut.body?.data?.[0]?.clientOperationId, loggedOutOperationId, JSON.stringify(loggedOut.body));
    assert.notEqual(loggedOut.body?.code, "STORYBOARD_DREAMINA_CLI_UNAVAILABLE");
    assert.equal(commandLog(logFile).includes("login"), false);
  });
});

test("P1-2 项目视频模型混合参考必须入队后按后台阶段收敛失败", async () => {
  await withRuntime("r22-p1-vendor-stage", async ({ boundShot, generateUrl, previewUrl }) => {
    const unsupported = "grsai";
    u.vendor.writeCode(unsupported, vendorStub(unsupported));
    const unsupportedModels = JSON.stringify([
      { modelName: "video", name: "不支持引用的视频模型", type: "video" },
    ]);
    await accountDatabase()("o_vendorConfig").insert({
      id: unsupported, inputValues: "{}", models: unsupportedModels, enable: 1,
    }).onConflict("id").merge({ inputValues: "{}", models: unsupportedModels, enable: 1 });
    let staged = 0;
    configureModelMediaResolver({
      signObject: async () => {
        staged += 1;
        throw new Error("E:\\secret\\oss sk-live SELECT cookie");
      },
      stageLocalPath: async () => {
        staged += 1;
        throw new Error("E:\\secret\\oss sk-live SELECT cookie");
      },
    });
    const unsupportedBody = {
      shotUuid: boundShot,
      mediaType: "video",
      providerModel: `${unsupported}:video`,
      mode: "auto",
      durationMs: 5000,
      aspectRatio: "9:16",
    };
    const unsupportedPreview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(unsupportedBody),
    });
    assert.equal(unsupportedPreview.status, 200, JSON.stringify(unsupportedPreview.body));
    const unsupportedOperationId = crypto.randomUUID();
    const unsupportedGen = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...unsupportedBody,
        expectedPreviewDigest: unsupportedPreview.body?.data?.previewDigest,
        clientOperationId: unsupportedOperationId,
      }),
    });
    leakFree(JSON.stringify(unsupportedGen.body));
    assert.equal(unsupportedGen.status, 202, JSON.stringify(unsupportedGen.body));
    assert.equal(unsupportedGen.body?.data?.tasks?.[0]?.status, "queued");
    const unsupportedTask = await waitForTaskState(unsupportedOperationId, "failed_fatal");
    assert.equal(unsupportedTask.errorCode, "VENDOR_GENERATION_FAILED");
    assert.equal(staged, 0, "不支持的参考不得进入暂存");
    assert.equal(await countRows("o_storyboardGenerationOperation"), 1);
    assert.equal(await countRows("o_storyboardGenerationTask"), 1);
    assert.equal(await countRows("o_dreaminaCliDispatch"), 0);

    const volc = "volcengine";
    // 中文注释：使用受版本控制的供应商模板，避免干净 Runner 依赖被 gitignore 的构建生成文件。
    const realVolc = path.resolve(__dirname, "../../src/provider-templates/volcengine.ts.template");
    u.vendor.writeCode(volc, fs.readFileSync(realVolc, "utf8"));
    const volcModels = JSON.stringify([
      { modelName: "doubao-seedance-2-0-260128", name: "Seedance-2.0", type: "video" },
    ]);
    await accountDatabase()("o_vendorConfig").insert({
      id: volc, inputValues: "{}", models: volcModels, enable: 1,
    }).onConflict("id").merge({ inputValues: "{}", models: volcModels, enable: 1 });
    staged = 0;
    configureModelMediaResolver({
      stageLocalPath: async () => {
        staged += 1;
        throw Object.assign(new Error("createUploadSession failed E:\\\\db\\\\app.sqlite"), {
          code: "VENDOR_STAGING_UPLOAD_SESSION",
        });
      },
    });
    const urlBody = {
      shotUuid: boundShot,
      mediaType: "video",
      providerModel: PROJECT_VIDEO,
      mode: "auto",
      durationMs: 5000,
      aspectRatio: "9:16",
    };
    const urlPreview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(urlBody),
    });
    assert.equal(urlPreview.status, 200, JSON.stringify(urlPreview.body));
    const urlOperationId = crypto.randomUUID();
    const urlGen = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...urlBody,
        expectedPreviewDigest: urlPreview.body?.data?.previewDigest,
        clientOperationId: urlOperationId,
      }),
    });
    leakFree(JSON.stringify(urlGen.body));
    assert.equal(urlGen.status, 202, JSON.stringify(urlGen.body));
    assert.equal(urlGen.body?.data?.tasks?.[0]?.status, "queued");
    const urlTask = await waitForTaskState(urlOperationId, "failed_fatal");
    assert.equal(urlTask.errorCode, "VENDOR_MEDIA_STAGING_FAILED", JSON.stringify(urlTask));
    assert.ok(staged >= 1);
    assert.equal(await countRows("o_storyboardGenerationOperation"), 2);
    assert.equal(await countRows("o_storyboardGenerationTask"), 2);
    assert.equal(await countRows("o_dreaminaCliDispatch"), 0);
  });
});

test("P1-4 Seedream 4.5 图片生成必须按阶段失败并落生成失败", async () => {
  await withRuntime("r22-p1-seedream", async ({ generateAssetsUrl }) => {
    u.vendor.writeCode("volcengine", vendorStub("volcengine"));
    const seedreamModels = JSON.stringify([
      { modelName: "doubao-seedream-4-5-251128", name: "Seedream-4.5", type: "image" },
    ]);
    await accountDatabase()("o_vendorConfig").insert({
      id: "volcengine", inputValues: "{}", models: seedreamModels, enable: 1,
    }).onConflict("id").merge({ inputValues: "{}", models: seedreamModels, enable: 1 });
    const captured: string[] = [];
    const originalImage = u.Ai.Image;
    u.Ai.Image = ((key: `${string}:${string}`) => {
      captured.push(key);
      return {
        async run() {
          throw Object.assign(new Error("E:\\\\app\\\\db.sqlite sk-live cookie SELECT 1"), {
            code: "RAW",
          });
        },
        async save() { return this; },
      };
    }) as unknown as typeof u.Ai.Image;
    try {
      const created = await jsonRequest(generateAssetsUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: 2201,
          model: SEEDREAM_45,
          resolution: "2K",
          id: 3,
          type: "tool",
          name: "剑",
          prompt: "一把古剑",
          base64: "",
        }),
      });
      leakFree(JSON.stringify(created.body));
      assert.equal(captured[0], SEEDREAM_45, JSON.stringify(captured));
      assert.equal(created.status, 400, JSON.stringify(created.body));
      assert.equal(created.body?.message, "普通供应商生成失败，请检查模型配置或稍后重试");
      assert.equal(created.body?.data?.code, "VENDOR_GENERATION_FAILED");
      const image = await runWithProjectStorage(PROJECT, () =>
        activeDb("o_image").where({ assetsId: 3 }).orderBy("id", "desc").first());
      assert.equal(image?.state, "生成失败", JSON.stringify(image));
      assert.notEqual(image?.state, "生成中");
      assert.equal(String(image?.errorReason ?? "").includes("E:"), false);
    } finally {
      u.Ai.Image = originalImage;
    }
  });
});
