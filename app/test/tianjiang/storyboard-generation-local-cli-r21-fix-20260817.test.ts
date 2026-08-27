/**
 * R21-fix RED：启动检测按用户隔离并持久化；即梦 enabled 服务端门禁；
 * 供应商按 mediaType 消费合同；内联素材必须流式校验身份和文件头 MIME。
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
import { invalidateDreaminaCapabilityCache } from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import {
  ensureDreaminaStartupStatusCheck,
  resetDreaminaStartupStatusCheckForTests,
} from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import { readDreaminaRuntimeState } from "../../src/tianjiang/model-providers/dreamina-cli/runtime-state-store";
import { readDreaminaCliSettings, writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { stopDreaminaSchedulerLoop, tickDreaminaScheduler } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { hashFileStreaming } from "../../src/tianjiang/media/project-file-inventory";
import {
  configureModelMediaResolver,
  prepareModelMediaReferences,
} from "../../src/tianjiang/media/model-media-reference";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { resolveVendorMediaCapability } from "../../src/tianjiang/storyboard/vendor-media-capability";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import { writeReadyDreaminaTestCapability } from "./helpers/dreamina-capability";
import getPath from "../../src/utils/getPath";

const USER_A = { issuer: "https://api.j11.com.cn", userId: 2101 };
const USER_B = { issuer: "https://api.j11.com.cn", userId: 2102 };
const PROJECT = "b0212121-2121-4121-a021-212121212121";
const ROLE = "b0212121-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const AUDIO = "b0212121-cccc-4ccc-8ccc-ccccccccccc1";
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");

function jpegBytes(): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
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

function pngBytes(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R21-fix",
    kind: "personal",
    ownerUserId: USER_A.userId,
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

function vendorSource(id: string): string {
  return `
const vendor = {
  id: ${JSON.stringify(id)},
  version: "2.0",
  name: ${JSON.stringify(id)},
  author: "r21-fix",
  inputs: [],
  inputValues: {},
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
    firstShot: string;
    boundShot: string;
    generateUrl: string;
    previewUrl: string;
    projectRoot: string;
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
  await activateUserDatabase(USER_A);
  try {
    await runWithUserStorage(USER_A, async () => {
      enterUserStorage(USER_A);
      await initializeWorkspaceProject(PROJECT, {
        id: 2101,
        name: "R21-fix",
        projectType: "storyboard" as "novel",
        userId: USER_A.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow()] as never;
      stopDreaminaSchedulerLoop();
      writeReadyDreaminaTestCapability();
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
      const writeRel = (relative: string, bytes: Buffer | string) => {
        const absolute = path.join(projectRoot, ...relative.split("/"));
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, bytes);
      };
      writeRel("files/images/role-r21.jpg", jpegBytes());
      writeRel("files/audios/r21-voice.wav", wavBytes());
      await runWithProjectStorage(PROJECT, async () => {
        await activeDb("o_image").insert([
          { id: 1, filePath: "files/images/role-r21.jpg", type: "image", assetsId: 1, state: "已完成" },
          { id: 2, filePath: "files/audios/r21-voice.wav", type: "audio", assetsId: 2, state: "已完成" },
        ]);
        await activeDb("o_assets").insert([
          { id: 1, name: "甲", type: "role", describe: "", imageId: 1, assetUuid: ROLE, projectId: 2101 },
          { id: 2, name: "旁白", type: "audio", describe: "", imageId: 2, assetUuid: AUDIO, projectId: 2101 },
        ]);
        await activeDb("o_assetsRole2Audio").insert({ assetsRoleId: 1, assetsAudioId: 2 });
      });
      await service.bindAsset(bound.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: ROLE, assetType: "role", relationRole: "appear",
      });
      const app = express();
      app.use(express.json({ limit: "2mb" }));
      app.use((_req, _res, next) => {
        enterUserStorage(USER_A);
        (_req as { centralSession?: unknown }).centralSession = {
          serverUrl: USER_A.issuer,
          user: { id: USER_A.userId, username: "r21-fix" },
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
          firstShot: first.shotUuid,
          boundShot: bound.shotUuid,
          generateUrl,
          previewUrl: `${generateUrl}/preview`,
          projectRoot,
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    stopDreaminaSchedulerLoop();
    invalidateDreaminaCapabilityCache();
    syncCoordinator.listProjects = originalList;
    await runWithUserStorage(USER_A, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test("启动检测必须写入当前账号库，第二用户不得复用第一用户缓存", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `r21-fix-startup-${process.pid}-${crypto.randomUUID()}`);
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousExec = process.env.DREAMINA_TEST_EXECUTABLE;
  const previousLog = process.env.DREAMINA_FAKE_LOG;
  const logFile = path.join(root, "cli.jsonl");
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.DREAMINA_FAKE_LOG = logFile;
  resetDatabaseRuntimeForServe();
  resetDreaminaStartupStatusCheckForTests();
  try {
    await activateUserDatabase(USER_A);
    const persistedA = await runWithUserStorage(USER_A, async () => {
      const probed = await ensureDreaminaStartupStatusCheck();
      const settings = await readDreaminaCliSettings();
      const runtime = await readDreaminaRuntimeState();
      return { probed, settings, runtime, segment: currentUserStorage()?.segment };
    });
    assert.equal((persistedA.settings as { enabled?: boolean }).enabled, true);
    assert.ok(path.isAbsolute(String(persistedA.settings.executablePath)));
    assert.equal(path.normalize(String(persistedA.settings.executablePath)), path.normalize(FAKE_CLI));
    assert.equal(persistedA.runtime.account.state, "logged_in");
    assert.equal(persistedA.runtime.executablePath && path.normalize(persistedA.runtime.executablePath), path.normalize(FAKE_CLI));

    await activateUserDatabase(USER_B);
    const isolatedB = await runWithUserStorage(USER_B, async () => {
      const settings = await readDreaminaCliSettings();
      const runtime = await readDreaminaRuntimeState();
      return { settings, runtime, segment: currentUserStorage()?.segment };
    });
    assert.notEqual(isolatedB.segment, persistedA.segment);
    assert.notEqual(path.normalize(String(isolatedB.settings.executablePath ?? "")), path.normalize(FAKE_CLI));
    assert.notEqual(isolatedB.runtime.account.state, "logged_in");

    await activateUserDatabase(USER_B);
    await runWithUserStorage(USER_B, () => ensureDreaminaStartupStatusCheck());
    const afterB = await runWithUserStorage(USER_B, async () => ({
      settings: await readDreaminaCliSettings(),
      runtime: await readDreaminaRuntimeState(),
    }));
    assert.equal(path.normalize(String(afterB.settings.executablePath)), path.normalize(FAKE_CLI));
    assert.equal(afterB.runtime.account.state, "logged_in");

    await activateUserDatabase(USER_A);
    await runWithUserStorage(USER_A, async () => {
      await accountDatabase()("o_dreaminaCliSettings").where({ id: 1 }).update({ executablePath: null });
      await ensureDreaminaStartupStatusCheck();
      const settings = await readDreaminaCliSettings();
      assert.equal(path.normalize(String(settings.executablePath)), path.normalize(FAKE_CLI));
    });

    const lines = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line) as { args: string[] })
      : [];
    const commands = lines.map((line) => line.args[0]);
    assert.equal(commands.includes("login"), false);
    assert.equal(commands.some((item) => String(item).endsWith("2video") || String(item).endsWith("2image")), false);
    assert.ok(commands.includes("user_credit"));
  } finally {
    resetDreaminaStartupStatusCheckForTests();
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousExec === undefined) delete process.env.DREAMINA_TEST_EXECUTABLE;
    else process.env.DREAMINA_TEST_EXECUTABLE = previousExec;
    if (previousLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = previousLog;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("关闭即梦后必须服务端 fail-closed，不得探测或入队，重开后只做非付费检测", async () => {
  await withRuntime("r21-fix-disabled", async ({ firstShot, generateUrl, previewUrl }) => {
    process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
    const logFile = path.resolve(process.cwd(), `r21-fix-disabled-${crypto.randomUUID()}.jsonl`);
    process.env.DREAMINA_FAKE_LOG = logFile;
    await writeDreaminaCliSettings({ enabled: false } as { pauseNewClaims?: boolean });
    const stored = await readDreaminaCliSettings() as { enabled?: boolean };
    assert.equal(stored.enabled, false);

    resetDreaminaStartupStatusCheckForTests();
    await ensureDreaminaStartupStatusCheck();
    const payload = {
      shotUuid: firstShot,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "text2video",
      durationMs: 5000,
      aspectRatio: "9:16",
    };
    const preview = await postJson(previewUrl, payload);
    const generated = await postJson(generateUrl, {
      ...payload,
      expectedPreviewDigest: preview.body?.data?.previewDigest ?? "0".repeat(64),
      clientOperationId: crypto.randomUUID(),
    });
    assert.equal(preview.status, 400, JSON.stringify(preview.body));
    assert.equal(preview.body?.code, "DREAMINA_CLI_DISABLED");
    assert.equal(generated.status, 400, JSON.stringify(generated.body));
    assert.equal(generated.body?.code, "DREAMINA_CLI_DISABLED");
    assert.equal(await countRows("o_storyboardGenerationOperation"), 0);
    assert.equal(await countRows("o_storyboardGenerationTask"), 0);
    assert.equal(await countRows("o_dreaminaCliDispatch"), 0);
    await tickDreaminaScheduler();
    const disabledLog = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8")
      : "";
    assert.equal(disabledLog.includes("login"), false);
    assert.equal(/text2video|image2video/.test(disabledLog), false);

    fs.writeFileSync(logFile, "");
    await writeDreaminaCliSettings({ enabled: true } as { pauseNewClaims?: boolean });
    resetDreaminaStartupStatusCheckForTests();
    await ensureDreaminaStartupStatusCheck();
    const reopened = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line) as { args: string[] })
      : [];
    const commands = reopened.map((line) => line.args[0]);
    assert.ok(commands.includes("version") || commands.includes("-h"));
    assert.ok(commands.includes("user_credit"));
    assert.equal(commands.includes("login"), false);
  });
});

test("grsai/klingai/vidu/minimax 对不支持的引用必须入队后收敛失败", async () => {
  await withRuntime("r21-fix-vendor-types", async ({ boundShot, generateUrl, previewUrl }) => {
    const matrix = ["grsai", "klingai", "vidu", "minimax"] as const;
    for (const id of matrix) {
      const imageCap = resolveVendorMediaCapability(id, "image");
      const audioCap = resolveVendorMediaCapability(id, "audio");
      const videoCap = resolveVendorMediaCapability(id, "video");
      assert.notEqual(imageCap.form, "none", `${id} image`);
      assert.equal(audioCap.form, "none", `${id} audio`);
      assert.equal(videoCap.form, "none", `${id} video`);
      u.vendor.writeCode(id, vendorSource(id));
      const models = JSON.stringify([{ modelName: "video", name: `${id} 测试视频模型`, type: "video" }]);
      await accountDatabase()("o_vendorConfig").insert({
        id, inputValues: "{}", models, enable: 1,
      }).onConflict("id").merge({ inputValues: "{}", models, enable: 1 });
      const body = {
        shotUuid: boundShot,
        mediaType: "video",
        providerModel: `${id}:video`,
        mode: "auto",
        durationMs: 5000,
        aspectRatio: "9:16",
      };
      const preview = await postJson(previewUrl, body);
      assert.equal(preview.status, 200, `${id} ${JSON.stringify(preview.body)}`);
      const clientOperationId = crypto.randomUUID();
      const generated = await postJson(generateUrl, {
        ...body,
        expectedPreviewDigest: preview.body?.data?.previewDigest,
        clientOperationId,
      });
      assert.equal(generated.status, 202, `${id} ${JSON.stringify(generated.body)}`);
      assert.equal(generated.body?.data?.clientOperationId, clientOperationId, id);
      assert.equal(generated.body?.data?.tasks?.[0]?.status, "queued", id);
      const failedTask = await waitForTaskState(clientOperationId, "failed_fatal");
      // 中文注释：供应商引用适配属于后台阶段，HTTP 提交只确认耐久写入，不同步返回运行态错误。
      assert.deepEqual(failedTask, {
        status: "failed_fatal",
        errorCode: "VENDOR_GENERATION_FAILED",
        errorSummary: "普通供应商生成失败，请检查模型配置或稍后重试",
      }, id);
      assert.equal(await countRows("o_storyboardGenerationOperation"), matrix.indexOf(id) + 1, id);
      assert.equal(await countRows("o_storyboardGenerationTask"), matrix.indexOf(id) + 1, id);
      assert.equal(await countRows("o_dreaminaCliDispatch"), 0, id);
    }
  });
});

test("内联 JPG/WAV 必须使用文件头 MIME；替换文件或错误摘要必须零写入失败", async () => {
  await withRuntime("r21-fix-inline-identity", async ({ boundShot, generateUrl, previewUrl, projectRoot }) => {
    const jpgPath = path.join(projectRoot, "files", "images", "role-r21.jpg");
    const digest = hashFileStreaming(jpgPath);
    const inlined = await prepareModelMediaReferences([{
      type: "image" as const,
      media: {
        projectUuid: PROJECT,
        relativePath: "files/images/role-r21.jpg",
        md5: digest.md5,
        size: digest.size,
      },
    }], { supportsUrl: false, supportsInline: true });
    assert.match(inlined[0].base64, /^data:image\/jpeg;base64,/);
    assert.doesNotMatch(inlined[0].base64, /image\/png/);

    const wavDigest = hashFileStreaming(path.join(projectRoot, "files", "audios", "r21-voice.wav"));
    const wav = await prepareModelMediaReferences([{
      type: "audio" as const,
      media: {
        projectUuid: PROJECT,
        relativePath: "files/audios/r21-voice.wav",
        md5: wavDigest.md5,
        size: wavDigest.size,
      },
    }], { supportsUrl: false, supportsInline: true });
    assert.match(wav[0].base64, /^data:audio\/(wav|x-wav);base64,/);
    assert.doesNotMatch(wav[0].base64, /audio\/mpeg/);

    await assert.rejects(
      () => prepareModelMediaReferences([{
        type: "image" as const,
        media: {
          projectUuid: PROJECT,
          relativePath: "files/images/role-r21.jpg",
          md5: "c".repeat(32),
          size: digest.size,
        },
      }], { supportsUrl: false, supportsInline: true }),
    );

    u.vendor.writeCode("klingai", vendorSource("klingai"));
    const klingModels = JSON.stringify([
      { modelName: "video", name: "Kling 测试视频模型", type: "video" },
    ]);
    await accountDatabase()("o_vendorConfig").insert({
      id: "klingai", inputValues: "{}", models: klingModels, enable: 1,
    }).onConflict("id").merge({ inputValues: "{}", models: klingModels, enable: 1 });
    await runWithProjectStorage(PROJECT, async () => {
      await activeDb("o_assetsRole2Audio").del();
    });
    const body = {
      shotUuid: boundShot,
      mediaType: "video",
      providerModel: "klingai:video",
      mode: "auto",
      durationMs: 5000,
      aspectRatio: "9:16",
    };
    const preview = await postJson(previewUrl, body);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    fs.writeFileSync(jpgPath, pngBytes());
    const generated = await postJson(generateUrl, {
      ...body,
      expectedPreviewDigest: preview.body?.data?.previewDigest,
      clientOperationId: crypto.randomUUID(),
    });
    assert.ok(generated.status === 400 || generated.status === 409, JSON.stringify(generated.body));
    assert.ok(
      generated.body?.code === "STORYBOARD_REFERENCE_IDENTITY_MISMATCH"
      || generated.body?.code === "STORYBOARD_PREVIEW_STALE",
      JSON.stringify(generated.body),
    );
    assert.notEqual(generated.body?.code, "VENDOR_MEDIA_STAGING_FAILED");
    assert.equal(await countRows("o_storyboardGenerationOperation"), 0);
    assert.equal(await countRows("o_storyboardGenerationTask"), 0);
    assert.equal(await countRows("o_dreaminaCliDispatch"), 0);
  });
});
