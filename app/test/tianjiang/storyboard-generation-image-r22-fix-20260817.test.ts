/**
 * R22-fix RED：Codex 审计确认的三个 P1。
 * P1-1 URL 视频模型确定性 stub 必须完成暂存并进入 prepare/execute，不得 VENDOR_MEDIA_STAGING_FAILED。
 * P1-2 即梦 installed/logged_out/能力探测失败/模式不支持必须分码，禁止自动 login。
 * P1-3 抽屉模型 B 经现有假供应商必须进入执行并返回成功，不得回显 SQL/路径/堆栈。
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
  writeDreaminaCapabilityCache,
} from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import {
  DREAMINA_MODES,
  DREAMINA_VIDEO_MODELS,
  type DreaminaCapabilitySnapshot,
} from "../../src/tianjiang/model-providers/dreamina-cli/contracts";
import { resetDreaminaStartupStatusCheckForTests } from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import { stopDreaminaSchedulerLoop } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { configureModelMediaResolver } from "../../src/tianjiang/media/model-media-reference";
import { resolveVendorMediaCapability } from "../../src/tianjiang/storyboard/vendor-media-capability";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { resolveDreaminaGenerationMode } from "../../src/tianjiang/storyboard/storyboard-generation-service";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import getPath from "../../src/utils/getPath";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2211 };
const PROJECT = "b0222211-2211-4211-a211-221122112211";
const ROLE = "b0222211-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SCENE = "b0222211-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const TOOL = "b0222211-cccc-4ccc-8ccc-ccccccccccc1";
const AUDIO = "b0222211-dddd-4ddd-8ddd-ddddddddddd1";
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
    name: "R22-fix",
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
  assert.equal(/at\s+\S+\.(ts|js)/i.test(serialized), false);
}

async function countRows(table: string): Promise<number> {
  return runWithProjectStorage(PROJECT, async () => {
    if (!await activeDb.schema.hasTable(table)) return 0;
    return (await activeDb(table).select()).length;
  });
}

function vendorStub(id: string): string {
  return `
const vendor = {
  id: ${JSON.stringify(id)},
  version: "2.0",
  name: ${JSON.stringify(id)},
  author: "r22-fix",
  inputs: [],
  inputValues: {},
  models: [{
    name: "Seedance-2.0",
    modelName: "doubao-seedance-2-0-260128",
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
async function imageRequest() {
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
}
exports.vendor = vendor;
exports.videoRequest = videoRequest;
exports.imageRequest = imageRequest;
export {};
`;
}

function writeReadyModes(overrides: Partial<Record<string, { enabled: boolean; fields: string[] }>> = {}): void {
  const modes = Object.fromEntries(DREAMINA_MODES.map((mode) => [mode, {
    enabled: true,
    fields: ["--prompt", "--duration", "--ratio", "--video_resolution", "--model_version"],
    ...(overrides[mode] ?? {}),
  }])) as unknown as DreaminaCapabilitySnapshot["modes"];
  writeDreaminaCapabilityCache({
    state: "ready",
    snapshot: {
      installed: true,
      version: "r22-fix",
      probedAt: Date.now(),
      loggedIn: true,
      modes,
      capabilities: [...DREAMINA_MODES],
      videoModels: [...DREAMINA_VIDEO_MODELS],
    },
    checkedAt: Date.now(),
  });
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
        id: 2211,
        name: "R22-fix",
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
          { id: 1, name: "甲", type: "role", describe: "", imageId: 1, assetUuid: ROLE, projectId: 2211 },
          { id: 2, name: "客栈", type: "scene", describe: "", imageId: 2, assetUuid: SCENE, projectId: 2211 },
          { id: 3, name: "剑", type: "tool", describe: "", imageId: 3, assetUuid: TOOL, projectId: 2211 },
          { id: 4, name: "旁白", type: "audio", describe: "", imageId: 4, assetUuid: AUDIO, projectId: 2211 },
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
          user: { id: IDENTITY.userId, username: "r22-fix" },
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

test("P1-1 URL 项目视频模型确定性 stub 必须暂存全部引用并进入执行", async () => {
  await withRuntime("r22-fix-url-success", async ({ boundShot, generateUrl, previewUrl }) => {
    assert.equal(resolveVendorMediaCapability("volcengine", "image").form, "url");
    assert.equal(resolveVendorMediaCapability("volcengine", "audio").form, "url");
    assert.equal(resolveVendorMediaCapability("volcengine", "video").form, "url");
    u.vendor.writeCode("volcengine", vendorStub("volcengine"));
    if (!await accountDatabase()("o_vendorConfig").where({ id: "volcengine" }).first()) {
      await accountDatabase()("o_vendorConfig").insert({
        id: "volcengine", inputValues: "{}", models: "[]", enable: 1,
      });
    }
    const staged: string[] = [];
    configureModelMediaResolver({
      stageLocalPath: async (reference) => {
        staged.push(String(reference.relativePath ?? ""));
        return `https://cdn.example/staged/${String(reference.relativePath ?? "").replaceAll("/", "_")}`;
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
    const urlGen = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...urlBody,
        expectedPreviewDigest: urlPreview.body?.data?.previewDigest,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(urlGen.body));
    assert.notEqual(urlGen.body?.code, "VENDOR_MEDIA_STAGING_FAILED", JSON.stringify(urlGen.body));
    assert.equal(urlGen.status, 200, JSON.stringify(urlGen.body));
    const tasks = Array.isArray(urlGen.body?.data) ? urlGen.body.data : [];
    assert.equal(tasks[0]?.status, "completed", JSON.stringify(urlGen.body));
    assert.ok(staged.includes("files/images/role-r22.png"), JSON.stringify(staged));
    assert.ok(staged.includes("files/images/scene-r22.png"), JSON.stringify(staged));
    assert.ok(staged.includes("files/images/tool-r22.png"), JSON.stringify(staged));
    assert.ok(staged.includes("files/audios/r22-voice.wav"), JSON.stringify(staged));
    assert.equal(staged.length, 4, JSON.stringify(staged));
    assert.ok(await countRows("o_storyboardGenerationOperation") >= 1);
    assert.ok(await countRows("o_storyboardGenerationTask") >= 1);
    assert.equal(await countRows("o_dreaminaCliDispatch"), 0);
    const candidates = await countRows("o_storyboardCandidate");
    assert.ok(candidates >= 1, "成功路径必须写入候选，证明已进入既有 execute/persist");

    staged.length = 0;
    configureModelMediaResolver({
      stageLocalPath: async () => {
        staged.push("fail");
        throw Object.assign(new Error("createUploadSession failed E:\\\\db\\\\app.sqlite SELECT cookie"), {
          code: "VENDOR_STAGING_UPLOAD_SESSION",
        });
      },
    });
    const failPreview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(urlBody),
    });
    const failGen = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...urlBody,
        expectedPreviewDigest: failPreview.body?.data?.previewDigest,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(failGen.body));
    assert.equal(failGen.body?.code, "VENDOR_MEDIA_STAGING_FAILED", JSON.stringify(failGen.body));
    assert.equal(failGen.body?.message, "参考素材暂存失败，请检查网络或稍后重试");
    assert.equal(failGen.body?.stagingStep, "upload_session", JSON.stringify(failGen.body));
    assert.ok(staged.length >= 1);
    assert.equal(await countRows("o_dreaminaCliDispatch"), 0);
    const failOps = await runWithProjectStorage(PROJECT, async () =>
      (await activeDb("o_storyboardGenerationOperation").select()).filter((row) =>
        String(row.state ?? "") === "submitting"));
    assert.equal(failOps.length, 0, JSON.stringify(failOps));
  });
});

test("P1-2 已登录但能力缓存 failed 必须是 CLI_UNAVAILABLE 而不是未安装", () => {
  writeReadyModes();
  const ready = readDreaminaCapabilityCache();
  writeDreaminaCapabilityCache({
    state: "failed",
    snapshot: ready.snapshot,
    checkedAt: Date.now(),
    failureReason: "capability probe exception",
  });
  let thrown: { code?: string } | undefined;
  try {
    resolveDreaminaGenerationMode({
      mediaType: "video",
      requestedMode: "text2video",
      references: [],
      capabilityPolicy: "execute",
    });
  } catch (error) {
    thrown = error as { code?: string };
  }
  assert.equal(thrown?.code, "STORYBOARD_DREAMINA_CLI_UNAVAILABLE", JSON.stringify(thrown));
  assert.notEqual(thrown?.code, "DREAMINA_CLI_NOT_INSTALLED");
  invalidateDreaminaCapabilityCache();
});

test("P1-2 即梦安装/登录/能力探测失败/模式不支持必须分码且零授权命令", async () => {
  await withRuntime("r22-fix-dreamina-class", async ({ boundShot, generateUrl, previewUrl, statusUrl, logFile }) => {
    const dreaminaBody = {
      shotUuid: boundShot,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0",
      mode: "auto",
      durationMs: 5000,
      aspectRatio: "9:16",
    };

    const previousExec = process.env.DREAMINA_TEST_EXECUTABLE;
    delete process.env.DREAMINA_TEST_EXECUTABLE;
    await writeDreaminaCliSettings({ enabled: true, executablePath: path.join(process.cwd(), "missing-dreamina.exe") });
    resetDreaminaStartupStatusCheckForTests();
    invalidateDreaminaCapabilityCache();
    fs.writeFileSync(logFile, "");
    const missingPreview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dreaminaBody),
    });
    const missing = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...dreaminaBody,
        expectedPreviewDigest: missingPreview.body?.data?.previewDigest ?? "0".repeat(64),
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(missing.body));
    assert.equal(missing.body?.code, "DREAMINA_CLI_NOT_INSTALLED", JSON.stringify(missing.body));
    assert.notEqual(missing.body?.code, "STORYBOARD_DREAMINA_CLI_UNAVAILABLE");
    assert.equal(commandLog(logFile).includes("login"), false, JSON.stringify(commandLog(logFile)));

    process.env.DREAMINA_TEST_EXECUTABLE = previousExec ?? FAKE_CLI;
    await writeDreaminaCliSettings({ enabled: true, executablePath: FAKE_CLI });
    process.env.DREAMINA_FAKE_SCENARIO = "not_logged_in";
    resetDreaminaStartupStatusCheckForTests();
    invalidateDreaminaCapabilityCache();
    fs.writeFileSync(logFile, "");
    const loggedOutPreview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dreaminaBody),
    });
    const loggedOut = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...dreaminaBody,
        expectedPreviewDigest: loggedOutPreview.body?.data?.previewDigest ?? "0".repeat(64),
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(loggedOut.body));
    assert.equal(loggedOut.body?.code, "DREAMINA_CLI_NOT_LOGGED_IN", JSON.stringify(loggedOut.body));
    assert.notEqual(loggedOut.body?.code, "DREAMINA_CLI_NOT_INSTALLED");
    assert.equal(commandLog(logFile).includes("login"), false);

    delete process.env.DREAMINA_FAKE_SCENARIO;
    resetDreaminaStartupStatusCheckForTests();
    invalidateDreaminaCapabilityCache();
    fs.writeFileSync(logFile, "");
    const status = await jsonRequest(statusUrl);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(payloadOf(status.body).install?.state, "installed");
    assert.equal(payloadOf(status.body).account?.state, "logged_in");
    invalidateDreaminaCapabilityCache();
    process.env.DREAMINA_FAKE_SCENARIO = "not_installed";
    fs.writeFileSync(logFile, "");
    const failedPreview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dreaminaBody),
    });
    const failed = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...dreaminaBody,
        expectedPreviewDigest: failedPreview.body?.data?.previewDigest ?? "0".repeat(64),
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(failed.body));
    assert.equal(failed.body?.code, "STORYBOARD_DREAMINA_CLI_UNAVAILABLE", JSON.stringify({
      body: failed.body,
      cache: readDreaminaCapabilityCache(),
    }));
    assert.notEqual(failed.body?.code, "DREAMINA_CLI_NOT_INSTALLED");
    assert.equal(commandLog(logFile).includes("login"), false);

    delete process.env.DREAMINA_FAKE_SCENARIO;
    writeReadyModes({
      multimodal2video: { enabled: false, fields: [] },
    });
    fs.writeFileSync(logFile, "");
    const modePreview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dreaminaBody),
    });
    const unsupported = await jsonRequest(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...dreaminaBody,
        expectedPreviewDigest: modePreview.body?.data?.previewDigest ?? "0".repeat(64),
        clientOperationId: crypto.randomUUID(),
      }),
    });
    leakFree(JSON.stringify(unsupported.body));
    assert.equal(unsupported.body?.code, "STORYBOARD_DREAMINA_MODE_UNSUPPORTED", JSON.stringify(unsupported.body));
    assert.equal(commandLog(logFile).includes("login"), false);
    assert.equal(commandLog(logFile).some((item) => String(item).endsWith("2video")), false);

    await writeDreaminaCliSettings({ enabled: false });
    resetDreaminaStartupStatusCheckForTests();
    invalidateDreaminaCapabilityCache();
    fs.writeFileSync(logFile, "");
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
  });
});

test("P1-3 单项图片请求必须使用模型 B 并经假供应商返回成功", async () => {
  await withRuntime("r22-fix-image-success", async ({ generateAssetsUrl }) => {
    u.vendor.writeCode("volcengine", vendorStub("volcengine"));
    if (!await accountDatabase()("o_vendorConfig").where({ id: "volcengine" }).first()) {
      await accountDatabase()("o_vendorConfig").insert({
        id: "volcengine", inputValues: "{}", models: "[]", enable: 1,
      });
    }
    const created = await jsonRequest(generateAssetsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 2211,
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
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.notEqual(created.body?.data?.code, "VENDOR_GENERATION_FAILED");
    const image = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_image").where({ assetsId: 3 }).orderBy("id", "desc").first());
    assert.equal(image?.state, "已完成", JSON.stringify(image));
    assert.equal(String(image?.model ?? ""), "doubao-seedream-4-5-251128");
    assert.notEqual(image?.state, "生成中");
    assert.equal(String(image?.errorReason ?? "").includes("E:"), false);
  });
});
