/**
 * R21 RED：供应商参考素材能力必须分阶；即梦 preview/generate 必须共用稳定 canonical mode。
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
  writeDreaminaCapabilityCache,
} from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import {
  DREAMINA_MODES,
  DREAMINA_VIDEO_MODELS,
  type DreaminaCapabilitySnapshot,
} from "../../src/tianjiang/model-providers/dreamina-cli/contracts";
import { stopDreaminaSchedulerLoop } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { resolveDreaminaGenerationMode } from "../../src/tianjiang/storyboard/storyboard-generation-service";
import { hashFileStreaming } from "../../src/tianjiang/media/project-file-inventory";
import {
  configureModelMediaResolver,
  prepareModelMediaReferences,
} from "../../src/tianjiang/media/model-media-reference";
import {
  builtinVendorMediaCapabilityMatrix,
  resolveVendorMediaCapability,
} from "../../src/tianjiang/storyboard/vendor-media-capability";
import { VendorReferenceUnsupportedError } from "../../src/tianjiang/storyboard/vendor-generation-safety";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import getPath from "../../src/utils/getPath";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2121 };
const PROJECT = "b0212121-2121-4121-a021-212121212121";
const ROLE = "b0212121-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ROLE_TWO = "b0212121-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R21",
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

async function postJson(url: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function countRows(table: string): Promise<number> {
  return runWithProjectStorage(PROJECT, async () => {
    if (!await activeDb.schema.hasTable(table)) return 0;
    return (await activeDb(table).select()).length;
  });
}

function leakFree(serialized: string): void {
  assert.equal(/[A-Za-z]:\\/.test(serialized), false);
  assert.equal(serialized.includes("sk-"), false);
  assert.equal(serialized.includes("SELECT "), false);
  assert.equal(serialized.toLowerCase().includes("cookie"), false);
}

function writeReadyModes(overrides: Partial<Record<string, { enabled: boolean; fields: string[] }>> = {}): void {
  const modes = Object.fromEntries(DREAMINA_MODES.map((mode) => [mode, {
    enabled: true,
    fields: mode === "multiframe2video"
      ? ["--prompt", "--images", "--duration", "--video_resolution", "--model_version"]
      : ["--prompt", "--duration", "--ratio", "--video_resolution", "--model_version"],
    ...(overrides[mode] ?? {}),
  }])) as unknown as DreaminaCapabilitySnapshot["modes"];
  writeDreaminaCapabilityCache({
    state: "ready",
    snapshot: {
      installed: true,
      version: "r21",
      probedAt: Date.now(),
      loggedIn: true,
      modes,
      capabilities: [...DREAMINA_MODES],
      videoModels: [...DREAMINA_VIDEO_MODELS],
    },
    checkedAt: Date.now(),
  });
}

function vendorSource(id: string, extra: string): string {
  return `
const vendor = {
  id: ${JSON.stringify(id)},
  version: "2.0",
  name: ${JSON.stringify(id)},
  author: "r21",
  inputs: [],
  inputValues: {},
  ${extra}
  models: [{
    name: "video",
    modelName: "video",
    type: "video",
    mode: ["text", "singleImage"],
    audio: false,
    durationResolutionMap: [{ duration: [5], resolution: ["720p"] }],
  }],
};
async function videoRequest() { return ${JSON.stringify(`data:video/mp4;base64,${fs.readFileSync(path.resolve(__dirname, "fixtures/minimal-adoptable.mp4")).toString("base64")}`)}; }
exports.vendor = vendor;
exports.videoRequest = videoRequest;
export {};
`;
}

async function withRuntime(
  name: string,
  run: (input: {
    port: number;
    service: StoryboardService;
    firstShot: string;
    boundShot: string;
    generateUrl: string;
    previewUrl: string;
  }) => Promise<void>,
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${process.pid}-${crypto.randomUUID()}`);
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  invalidateDreaminaCapabilityCache();
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 2121,
        name: "R21",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow()] as never;
      stopDreaminaSchedulerLoop();
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({ resolution: "720p", aspectRatio: "9:16", durationMs: 5000 });
      const first = await service.insertShot({
        afterShotUuid: null,
        sourceText: "空镜",
        videoPrompt: "缓慢推进",
        durationMs: 5000,
      });
      const bound = await service.insertShot({
        afterShotUuid: first.shotUuid,
        sourceText: "角色近景",
        videoPrompt: "跟拍",
        durationMs: 5000,
      });
      const context = currentUserStorage();
      assert.ok(context);
      const projectRoot = projectDirectory(getPath(), PROJECT, context.segment);
      const writeRel = (relative: string, bytes: string | Buffer) => {
        const absolute = path.join(projectRoot, ...relative.split("/"));
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, bytes);
      };
      writeRel("files/images/role-r21.png", Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]));
      writeRel("files/images/role-r21-b.png", Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]));
      await runWithProjectStorage(PROJECT, async () => {
        await activeDb("o_image").insert([
          { id: 1, filePath: "files/images/role-r21.png", type: "image", assetsId: 1, state: "已完成" },
          { id: 2, filePath: "files/images/role-r21-b.png", type: "image", assetsId: 2, state: "已完成" },
        ]);
        await activeDb("o_assets").insert([
          { id: 1, name: "甲", type: "role", describe: "", imageId: 1, assetUuid: ROLE, projectId: 2121 },
          { id: 2, name: "乙", type: "role", describe: "", imageId: 2, assetUuid: ROLE_TWO, projectId: 2121 },
        ]);
      });
      await service.bindAsset(bound.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: ROLE, assetType: "role", relationRole: "appear",
      });
      await service.bindAsset(bound.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: ROLE_TWO, assetType: "role", relationRole: "appear",
      });
      const app = express();
      app.use(express.json({ limit: "2mb" }));
      app.use((_req, _res, next) => {
        enterUserStorage(IDENTITY);
        (_req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r21" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      await prepareProjectDatabase(PROJECT);
      const { server, port } = await listen(app);
      const generateUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`;
      try {
        await run({
          port,
          service,
          firstShot: first.shotUuid,
          boundShot: bound.shotUuid,
          generateUrl,
          previewUrl: `${generateUrl}/preview`,
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    stopDreaminaSchedulerLoop();
    invalidateDreaminaCapabilityCache();
    syncCoordinator.listProjects = originalList;
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test("preview 与 execute 的 auto 模式不得因 CLI 缓存是否 ready 而改变", () => {
  const twoImages = [
    { mediaType: "image" as const, relativePath: "files/images/a.png", md5: "a".repeat(32), size: 1 },
    { mediaType: "image" as const, relativePath: "files/images/b.png", md5: "b".repeat(32), size: 1 },
  ];
  invalidateDreaminaCapabilityCache();
  const previewMode = resolveDreaminaGenerationMode({
    mediaType: "video",
    requestedMode: "auto",
    references: twoImages,
    capabilityPolicy: "preview",
  });
  writeReadyModes();
  const executeMode = resolveDreaminaGenerationMode({
    mediaType: "video",
    requestedMode: "auto",
    references: twoImages,
    capabilityPolicy: "execute",
  });
  assert.equal(previewMode, executeMode);
  assert.equal(previewMode, "multiframe2video");
});

test("即梦耐久入队只消费已发布能力，不等待当前 CLI 实时探测", () => {
  invalidateDreaminaCapabilityCache();
  const mode = resolveDreaminaGenerationMode({
    mediaType: "video",
    requestedMode: "text2video",
    references: [],
    capabilityPolicy: "enqueue",
  });
  assert.equal(mode, "text2video");
});

test("内置视频供应商参考素材能力必须按适配器真实合同分阶", () => {
  const matrix = builtinVendorMediaCapabilityMatrix();
  assert.deepEqual(matrix.atlascloud, { image: "url", audio: "url", video: "url" });
  assert.deepEqual(matrix.grsai, { image: "url", audio: "none", video: "none" });
  // 中文注释：内置 tianjiang 适配器声明 sourceType=base64，不能误走中央 URL 暂存。
  assert.deepEqual(matrix.tianjiang, { image: "inline", audio: "inline", video: "inline" });
  assert.deepEqual(matrix.volcengine, { image: "url", audio: "url", video: "url" });
  assert.deepEqual(matrix.klingai, { image: "inline", audio: "none", video: "none" });
  assert.deepEqual(matrix.vidu, { image: "inline", audio: "none", video: "none" });
  assert.deepEqual(matrix.volcengineSd2, { image: "inline", audio: "inline", video: "inline" });
  assert.deepEqual(matrix.minimax, { image: "inline", audio: "none", video: "none" });
  assert.deepEqual(matrix.openai, { image: "none", audio: "none", video: "none" });
  assert.deepEqual(matrix.deepseek, { image: "none", audio: "none", video: "none" });
  assert.deepEqual(matrix.null, { image: "none", audio: "none", video: "none" });
  assert.deepEqual(resolveVendorMediaCapability("unknown-vendor", "image"), { form: "none" });
  assert.deepEqual(resolveVendorMediaCapability("unknown-vendor", "image", {
    mediaCapabilities: { image: "url" },
  }), { form: "url" });
  assert.deepEqual(resolveVendorMediaCapability("unknown-vendor", "audio", {
    mediaCapabilities: { audio: "inline" },
  }), { form: "inline" });
});

test("明确支持 URL 的供应商必须走 stub 暂存并保留全部引用", async () => {
  const first: Parameters<typeof prepareModelMediaReferences>[0] = [
    {
      type: "image",
      media: { objectKey: "projects/p/files/images/a.png", md5: "a".repeat(32), size: 4 },
    },
    {
      type: "image",
      media: { objectKey: "projects/p/files/images/b.png", md5: "b".repeat(32), size: 5 },
    },
  ];
  const staged: string[] = [];
  configureModelMediaResolver({
    signObject: async (objectKey) => {
      staged.push(objectKey);
      return `https://staging.invalid/${objectKey.split("/").pop()}`;
    },
  });
  try {
    const prepared = await prepareModelMediaReferences(first, { supportsUrl: true, supportsInline: false });
    assert.equal(prepared.length, 2);
    assert.deepEqual(prepared.map((item) => item.base64), [
      "https://staging.invalid/a.png",
      "https://staging.invalid/b.png",
    ]);
    assert.equal(staged.length, 2);
    assert.equal("media" in prepared[0], false);
    await assert.rejects(
      () => prepareModelMediaReferences(first, { supportsUrl: false, supportsInline: false }),
      (error: unknown) => error instanceof VendorReferenceUnsupportedError
        && error.code === "VENDOR_REFERENCE_UNSUPPORTED",
    );
  } finally {
    configureModelMediaResolver(undefined);
  }
});

test("不支持参考素材的供应商必须返回 VENDOR_REFERENCE_UNSUPPORTED 且零写入", async () => {
  await withRuntime("r21-vendor-unsupported", async ({ boundShot, generateUrl, previewUrl }) => {
    const vendorId = "r21nosupport";
    u.vendor.writeCode(vendorId, vendorSource(vendorId, ""));
    await accountDatabase()("o_vendorConfig").insert({
      id: vendorId,
      inputValues: "{}",
      models: "[]",
      enable: 1,
    });
    const body = {
      shotUuid: boundShot,
      mediaType: "video",
      providerModel: `${vendorId}:video`,
      mode: "auto",
      durationMs: 5000,
      aspectRatio: "9:16",
    };
    const preview = await postJson(previewUrl, body);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const generated = await postJson(generateUrl, {
      ...body,
      expectedPreviewDigest: preview.body?.data?.previewDigest,
      clientOperationId: crypto.randomUUID(),
    });
    leakFree(JSON.stringify(generated.body));
    assert.equal(generated.status, 400);
    assert.equal(generated.body?.code, "VENDOR_REFERENCE_UNSUPPORTED");
    assert.equal(generated.body?.message, "当前视频模型不支持参考素材输入");
    assert.equal(JSON.stringify(generated.body).includes("请检查网络"), false);
    assert.equal(await countRows("o_storyboardGenerationOperation"), 0);
    assert.equal(await countRows("o_storyboardGenerationTask"), 0);
    assert.equal(await countRows("o_dreaminaCliDispatch"), 0);
    assert.equal(await countRows("o_generation"), 0);
  });
});

test("tianjiang 内联适配器只在最后阶段读项目文件，绝不调用中央 URL 暂存", async () => {
  await withRuntime("r21-vendor-inline", async () => {
    const context = currentUserStorage();
    assert.ok(context);
    const absolute = path.join(
      projectDirectory(getPath(), PROJECT, context.segment),
      "files",
      "images",
      "role-r21.png",
    );
    const digest = hashFileStreaming(absolute);
    const media = {
      projectUuid: PROJECT,
      relativePath: "files/images/role-r21.png",
      md5: digest.md5,
      size: digest.size,
    };
    let staged = 0;
    configureModelMediaResolver({
      stageLocalPath: async () => {
        staged += 1;
        throw new Error("tianjiang 不应调用中央暂存");
      },
    });
    try {
      const capability = resolveVendorMediaCapability("tianjiang", "image").form;
      const inlined = await prepareModelMediaReferences(
        [{ type: "image" as const, media }],
        { supportsUrl: capability === "url", supportsInline: capability === "inline" },
      );
      assert.equal(inlined.length, 1);
      assert.match(inlined[0].base64, /^data:image\/png;base64,/);
      assert.equal("media" in inlined[0], false);
      assert.doesNotMatch(inlined[0].base64, /files\/images/);
      assert.equal(staged, 0);
      await assert.rejects(
        () => prepareModelMediaReferences(
          [{ type: "image" as const, media }],
          { supportsUrl: false, supportsInline: false },
        ),
        (error: unknown) => error instanceof VendorReferenceUnsupportedError,
      );
    } finally {
      configureModelMediaResolver(undefined);
    }
  });
});

test("即梦 preview 发布态后 execute 缓存变化，相同请求不得 PREVIEW_STALE", async () => {
  await withRuntime("r21-dreamina-canonical", async ({ boundShot, generateUrl, previewUrl }) => {
    process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
    invalidateDreaminaCapabilityCache();
    const payload = {
      shotUuid: boundShot,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "auto",
      durationMs: 5000,
      aspectRatio: "9:16",
    };
    const preview = await postJson(previewUrl, payload);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body?.data?.options?.mode, "multiframe2video");
    writeReadyModes();
    const generated = await postJson(generateUrl, {
      ...payload,
      expectedPreviewDigest: preview.body?.data?.previewDigest,
      clientOperationId: crypto.randomUUID(),
    });
    assert.notEqual(generated.body?.code, "STORYBOARD_PREVIEW_STALE", JSON.stringify(generated.body));
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    const task = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardGenerationTask").orderBy("createdAt", "desc").first());
    assert.equal(JSON.parse(String(task?.parametersJson ?? "{}")).options.mode, "multiframe2video");

    const stale = await postJson(generateUrl, {
      ...payload,
      durationMs: 6000,
      expectedPreviewDigest: preview.body?.data?.previewDigest,
      clientOperationId: crypto.randomUUID(),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body?.code, "STORYBOARD_PREVIEW_STALE");
  });
});

test("fake CLI 未登录时提交必须先耐久受理，后台再收敛运行态错误", async () => {
  await withRuntime("r21-dreamina-unavailable", async ({ firstShot, generateUrl, previewUrl }) => {
    process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
    process.env.DREAMINA_FAKE_SCENARIO = "not_logged_in";
    invalidateDreaminaCapabilityCache();
    const payload = {
      shotUuid: firstShot,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "text2video",
      durationMs: 5000,
      aspectRatio: "9:16",
    };
    const preview = await postJson(previewUrl, payload);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const generated = await postJson(generateUrl, {
      ...payload,
      expectedPreviewDigest: preview.body?.data?.previewDigest,
      clientOperationId: crypto.randomUUID(),
    });
    leakFree(JSON.stringify(generated.body));
    assert.notEqual(generated.body?.code, "STORYBOARD_PREVIEW_STALE");
    // 中文注释：HTTP 提交边界只做合同校验和耐久写入，不等待 CLI 登录/能力实时探测。
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    assert.equal(generated.body?.code, 0);
    assert.equal(await countRows("o_storyboardGenerationOperation"), 1);
    assert.equal(await countRows("o_storyboardGenerationTask"), 1);
  });
});

test("启动状态检测只跑 version/-h 与 user_credit，并发必须合并且不得 login", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `r21-cli-log-${crypto.randomUUID()}`);
  const logFile = path.join(root, "cli.jsonl");
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousExec = process.env.DREAMINA_TEST_EXECUTABLE;
  const previousLog = process.env.DREAMINA_FAKE_LOG;
  const previousScenario = process.env.DREAMINA_FAKE_SCENARIO;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.DREAMINA_FAKE_LOG = logFile;
  process.env.DREAMINA_FAKE_SCENARIO = "default";
  resetDatabaseRuntimeForServe();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      const cli = await import("../../src/tianjiang/model-providers/dreamina-cli/cli-truth");
      assert.equal(typeof (cli as { ensureDreaminaStartupStatusCheck?: unknown }).ensureDreaminaStartupStatusCheck, "function");
      const ensure = (cli as { ensureDreaminaStartupStatusCheck: () => Promise<unknown> }).ensureDreaminaStartupStatusCheck;
      const reset = (cli as { resetDreaminaStartupStatusCheckForTests?: () => void }).resetDreaminaStartupStatusCheckForTests;
      reset?.();
      await Promise.all([ensure(), ensure(), ensure()]);
    });
    const lines = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line) as { args: string[] })
      : [];
    const commands = lines.map((line) => line.args[0]);
    assert.ok(commands.includes("version") || commands.includes("-h"));
    assert.ok(commands.includes("user_credit"));
    assert.equal(commands.includes("login"), false);
    assert.equal(commands.some((item) => String(item).endsWith("2video") || String(item).endsWith("2image")), false);
    assert.ok(commands.filter((item) => item === "user_credit").length <= 1);
  } finally {
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
});
