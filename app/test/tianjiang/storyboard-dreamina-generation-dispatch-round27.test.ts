/**
 * Round27 P1 RED：分镜进入即梦队列前必须把模型、模式与项目内参考素材内容身份解析成可执行合同。
 * 测试只调用 fake CLI，禁止真实收费生成。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import getPath from "../../src/utils/getPath";
import {
  accountDb,
  activateUserDatabase,
  db as activeDb,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  DREAMINA_MODES,
  DREAMINA_VIDEO_MODELS,
  type DreaminaCapabilitySnapshot,
  type DreaminaMode,
} from "../../src/tianjiang/model-providers/dreamina-cli/contracts";
import {
  invalidateDreaminaCapabilityCache,
  writeDreaminaCapabilityCache,
} from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { tickDreaminaScheduler } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { recoverDreaminaSlots } from "../../src/tianjiang/model-providers/dreamina-cli/recovery";
import { probeDreaminaCapabilities } from "../../src/tianjiang/model-providers/dreamina-cli/capability-probe";
import { enqueueAsyncMediaTasks } from "../../src/tianjiang/model-providers/async-generation-service";
import { resolveDreaminaGenerationMode } from "../../src/tianjiang/storyboard/storyboard-generation-service";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9729 };
const PROJECT_UUID = "29292929-2929-4929-a929-292929292929";
const OTHER_PROJECT_UUID = "30303030-3030-4030-a030-303030303030";
const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function capabilitySnapshot(disabled: readonly DreaminaMode[] = []): DreaminaCapabilitySnapshot {
  const disabledSet = new Set(disabled);
  const fieldsByMode: Record<DreaminaMode, readonly string[]> = {
    text2image: ["--prompt", "--ratio", "--resolution_type", "--model_version"],
    image2image: ["--prompt", "--images", "--ratio", "--resolution_type"],
    text2video: ["--prompt", "--duration", "--ratio", "--video_resolution", "--model_version"],
    image2video: ["--prompt", "--image", "--duration", "--model_version"],
    frames2video: ["--prompt", "--first", "--last", "--duration", "--video_resolution", "--model_version"],
    // 官方当前 multiframe 帮助未声明 model_version，不能假造支持能力。
    multiframe2video: ["--prompt", "--images", "--duration", "--video_resolution"],
    multimodal2video: [
      "--prompt",
      "--image",
      "--video",
      "--audio",
      "--duration",
      "--ratio",
      "--video_resolution",
      "--model_version",
    ],
  };
  const modes = Object.fromEntries(DREAMINA_MODES.map((mode) => [mode, {
    enabled: !disabledSet.has(mode),
    ...(disabledSet.has(mode) ? { disabledReason: `测试禁用 ${mode}` } : {}),
    fields: fieldsByMode[mode],
  }])) as unknown as DreaminaCapabilitySnapshot["modes"];
  return {
    installed: true,
    version: "1.4.15",
    probedAt: Date.now(),
    loggedIn: true,
    modes,
    capabilities: DREAMINA_MODES.filter((mode) => !disabledSet.has(mode)),
    videoModels: DREAMINA_VIDEO_MODELS,
  };
}

interface FakeCliCall {
  args: string[];
  referenceContents: Array<string | null>;
}

function readCliEntries(logFile: string): FakeCliCall[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeCliCall);
}

function readCliCalls(logFile: string): string[][] {
  return readCliEntries(logFile).map((entry) => entry.args);
}

function inspectCliReferenceArgument(
  argument: string | undefined,
  prefix: string,
  stagingRoot: string,
): { absolute: boolean; staged: boolean } | undefined {
  if (!argument?.startsWith(prefix)) return undefined;
  const absolutePath = argument.slice(prefix.length);
  const resolvedPath = path.resolve(absolutePath);
  const resolvedRoot = path.resolve(stagingRoot);
  return {
    absolute: path.isAbsolute(absolutePath),
    // 中文注释：真实 CLI 参数必须只拿到任务快照，不能重新打开仍可被替换的项目原路径。
    staged: resolvedPath.startsWith(`${resolvedRoot}${path.sep}`),
  };
}

function inspectCliReferenceListArgument(
  argument: string | undefined,
  prefix: string,
  stagingRoot: string,
): Array<{ absolute: boolean; staged: boolean } | undefined> {
  if (!argument?.startsWith(prefix)) return [];
  return argument.slice(prefix.length).split(",").map((absolutePath) =>
    inspectCliReferenceArgument(`${prefix}${absolutePath}`, prefix, stagingRoot));
}

function safePreviewRequest(request: Record<string, unknown>): Record<string, unknown> {
  return {
    providerModel: request.providerModel,
    prompt: request.prompt,
    options: request.options,
  };
}

test("真实 multimodal2video 帮助的重复 --image 必须被识别为可用能力", async () => {
  const previousScenario = process.env.DREAMINA_FAKE_SCENARIO;
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = "";
    process.env.DREAMINA_FAKE_SCENARIO = "official_multimodal_help";
    const snapshot = await probeDreaminaCapabilities(FAKE_CLI);
    assert.equal(snapshot.modes.multimodal2video.enabled, true);
    assert.ok(snapshot.modes.multimodal2video.fields.includes("--image"));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
    else process.env.DREAMINA_FAKE_SCENARIO = previousScenario;
  }
});

test("生产分镜调度必须在零收费入队前解析即梦模式、模型与项目参考素材", async (t) => {
  const root = path.resolve(
    process.cwd(),
    "..",
    ".local",
    "t",
    `generation-dispatch-${process.pid}-${crypto.randomUUID()}`,
  );
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  const previousScenario = process.env.DREAMINA_FAKE_SCENARIO;
  const previousQueryStatus = process.env.DREAMINA_FAKE_QUERY_STATUS;
  const previousLog = process.env.DREAMINA_FAKE_LOG;
  const previousPath = process.env.PATH;
  const originalListProjects = syncCoordinator.listProjects.bind(syncCoordinator);
  const logFile = path.join(root, "fake-cli.log");
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = previousTestContext || "storyboard-dreamina-generation-dispatch-round27";
  process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
  process.env.DREAMINA_FAKE_QUERY_STATUS = "running";
  process.env.DREAMINA_FAKE_LOG = logFile;
  // 中文注释：测试进程清空 PATH，哪怕账号配置回归也不能命中机器上的真实 CLI。
  process.env.PATH = "";
  assert.equal(path.isAbsolute(FAKE_CLI), true, "测试账号必须显式使用绝对 fake CLI，禁止 PATH 回退");
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);

  let server: http.Server | undefined;
  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 2729,
        name: "Round27 即梦最终调度",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await writeDreaminaCliSettings({ executablePath: FAKE_CLI, maxConcurrency: 1, pauseNewClaims: false });
      writeDreaminaCapabilityCache({
        state: "ready",
        snapshot: capabilitySnapshot(),
        checkedAt: Date.now(),
      });
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT_UUID,
        name: "Round27 即梦最终调度",
        kind: "personal",
        ownerUserId: IDENTITY.userId,
        myRole: "owner",
        openMode: "editable",
      }] as any;

      const service = new StoryboardService(PROJECT_UUID);
      // 中文注释：正常调度夹具先满足真实 CLI 的提示词与分辨率合同；缺失值由专门 RED 单独覆盖。
      await service.saveSettings({
        globalImagePrompt: "分镜图片生成",
        globalVideoPrompt: "分镜视频生成",
        resolution: "720p",
      });
      const noRefShot = await service.insertShot({ afterShotUuid: null, sourceText: "空镜" });
      const oneRefShot = await service.insertShot({ afterShotUuid: noRefShot.shotUuid, sourceText: "单参考" });
      const multiRefShot = await service.insertShot({ afterShotUuid: oneRefShot.shotUuid, sourceText: "多参考" });
      const mixedRefShot = await service.insertShot({ afterShotUuid: multiRefShot.shotUuid, sourceText: "混合参考" });
      const unsafeShot = await service.insertShot({ afterShotUuid: mixedRefShot.shotUuid, sourceText: "危险参考" });
      const crossProjectShot = await service.insertShot({ afterShotUuid: unsafeShot.shotUuid, sourceText: "跨项目参考" });
      const missingShot = await service.insertShot({ afterShotUuid: crossProjectShot.shotUuid, sourceText: "缺失参考" });

      const context = currentUserStorage();
      assert.ok(context, "测试必须处于账号上下文");
      const projectRoot = projectDirectory(getPath(), PROJECT_UUID, context.segment);
      const stagingRoot = path.join(getPath(), "runtime-users", context.segment, "staging");
      const files = {
        image1: "files/images/reference-1.png",
        image2: "files/images/reference-2.png",
        video1: "files/videos/reference-1.mp4",
        audio1: "files/audios/reference-1.mp3",
      } as const;
      for (const [relativePath, content] of [
        [files.image1, "image-one"],
        [files.image2, "image-two"],
        [files.video1, "video-one"],
        [files.audio1, "audio-one"],
      ] as const) {
        const absolutePath = path.join(projectRoot, ...relativePath.split("/"));
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content);
      }

      const assetRows = [
        { id: 101, imageId: 201, assetUuid: "11111111-aaaa-4111-8111-111111111111", type: "role", filePath: files.image1 },
        { id: 102, imageId: 202, assetUuid: "22222222-bbbb-4222-8222-222222222222", type: "scene", filePath: files.image2 },
        { id: 103, imageId: 203, assetUuid: "33333333-cccc-4333-8333-333333333333", type: "clip", filePath: files.video1 },
        { id: 104, imageId: 204, assetUuid: "44444444-dddd-4444-8444-444444444444", type: "role", filePath: "../outside.png" },
        { id: 105, imageId: 205, assetUuid: "55555555-eeee-4555-8555-555555555555", type: "role", filePath: "files/images/missing.png" },
        { id: 106, imageId: 206, assetUuid: "66666666-ffff-4666-8666-666666666666", type: "audio", filePath: files.audio1 },
      ];
      await runWithProjectStorage(PROJECT_UUID, async () => {
        await activeDb("o_image").insert(assetRows.map((row) => ({
          id: row.imageId,
          filePath: row.filePath,
          type: row.type,
          assetsId: row.id,
          state: "完成",
        })));
        await activeDb("o_assets").insert(assetRows.map((row) => ({
          id: row.id,
          name: `asset-${row.id}`,
          type: row.type,
          describe: "",
          imageId: row.imageId,
          assetUuid: row.assetUuid,
          projectId: 2729,
        })));
      });
      const bind = async (
        shotUuid: string,
        asset: (typeof assetRows)[number],
        sourceProjectUuid = PROJECT_UUID,
      ) => service.bindAsset(shotUuid, {
        sourceProjectUuid,
        assetUuid: asset.assetUuid,
        assetType: asset.type as "role" | "scene" | "clip" | "audio",
        relationRole: "appear",
      });
      await bind(oneRefShot.shotUuid, assetRows[0]!);
      await bind(multiRefShot.shotUuid, assetRows[0]!);
      await bind(multiRefShot.shotUuid, assetRows[1]!);
      await bind(mixedRefShot.shotUuid, assetRows[0]!);
      await bind(mixedRefShot.shotUuid, assetRows[2]!);
      await bind(mixedRefShot.shotUuid, assetRows[5]!);
      await bind(unsafeShot.shotUuid, assetRows[3]!);
      await bind(crossProjectShot.shotUuid, assetRows[0]!, OTHER_PROJECT_UUID);
      await bind(missingShot.shotUuid, assetRows[4]!);

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
      const previewUrl = `${url}/preview`;

      const cleanQueue = async () => {
        await accountDb("o_dreaminaCliDispatch").delete();
        await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardGenerationTask").delete());
      };
      const postPreviewConfirmed = async (body: Record<string, unknown>) => {
        const preview = await postJson(previewUrl, body);
        assert.equal(preview.status, 200, JSON.stringify(preview.body));
        return postJson(url, {
          ...body,
          expectedPreviewDigest: preview.body?.data?.previewDigest,
          clientOperationId: body.clientOperationId ?? crypto.randomUUID(),
        });
      };
      const enqueueAuto = (shotUuid: string, model = "seedance2.0fast") => postPreviewConfirmed({
        shotUuid,
        mediaType: "video",
        providerModel: `dreamina-cli:${model}`,
        mode: "auto",
        durationMs: 9_000,
        aspectRatio: "9:16",
        paidBatchConfirmed: false,
      });
      const queuedRows = () => runWithProjectStorage(PROJECT_UUID, () =>
        activeDb("o_storyboardGenerationTask").orderBy("createdAt").select());

      await t.test("auto 无素材必须在入队前变成 text2video", async () => {
        try {
          const response = await enqueueAuto(noRefShot.shotUuid);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          const rows = await queuedRows();
          assert.deepEqual({ status: response.status, count: rows.length, mode: rows[0]?.mode }, {
            status: 200,
            count: 1,
            mode: "text2video",
          });
        } finally {
          await cleanQueue();
        }
      });

      await t.test("即梦 200 响应必须统一为数组并逐项回显同一操作 ID", async () => {
        const singleOperationId = "71717171-7171-4171-a171-717171717171";
        const batchOperationId = "72727272-7272-4272-a272-727272727272";
        try {
          const single = await postPreviewConfirmed({
            shotUuid: noRefShot.shotUuid,
            mediaType: "video",
            providerModel: "dreamina-cli:seedance2.0fast",
            mode: "auto",
            durationMs: 9_000,
            aspectRatio: "9:16",
            clientOperationId: singleOperationId,
          });
          assert.equal(single.status, 200, JSON.stringify(single.body));
          assert.equal(Array.isArray(single.body?.data), true, JSON.stringify(single.body));
          assert.deepEqual(
            single.body.data.map((item: { clientOperationId?: unknown }) => item.clientOperationId),
            [singleOperationId],
          );
          await cleanQueue();

          const batchItems = [
            {
              shotUuid: noRefShot.shotUuid,
              mediaType: "video",
              providerModel: "dreamina-cli:seedance2.0fast",
              mode: "auto",
              durationMs: 9_000,
              aspectRatio: "9:16",
            },
            {
              shotUuid: oneRefShot.shotUuid,
              mediaType: "video",
              providerModel: "dreamina-cli:seedance2.0mini",
              mode: "auto",
              durationMs: 9_000,
              aspectRatio: "9:16",
            },
          ];
          const confirmedItems = [];
          for (const item of batchItems) {
            const preview = await postJson(previewUrl, item);
            assert.equal(preview.status, 200, JSON.stringify(preview.body));
            confirmedItems.push({ ...item, expectedPreviewDigest: preview.body.data.previewDigest });
          }
          const batch = await postJson(url, {
            items: confirmedItems,
            paidBatchConfirmed: true,
            clientOperationId: batchOperationId,
          });
          assert.equal(batch.status, 200, JSON.stringify(batch.body));
          assert.equal(Array.isArray(batch.body?.data), true, JSON.stringify(batch.body));
          assert.deepEqual(
            batch.body.data.map((item: { clientOperationId?: unknown }) => item.clientOperationId),
            [batchOperationId, batchOperationId],
          );
        } finally {
          await cleanQueue();
        }
      });

      await t.test("入队后的最终参数摘要漂移必须在 submit 前隔离且零 CLI", async () => {
        try {
          const response = await enqueueAuto(noRefShot.shotUuid);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          const taskUuid = String(response.body?.data?.[0]?.taskUuid ?? "");
          assert.ok(taskUuid);
          await runWithProjectStorage(PROJECT_UUID, async () => {
            const task = await activeDb("o_storyboardGenerationTask").where({ taskUuid }).first();
            const parameters = JSON.parse(String(task?.parametersJson ?? "{}"));
            parameters.prompt = "篡改后但仍合法的提示词";
            // 中文注释：模拟项目库最终请求被替换，但保留入队时 requestDigest，收费前必须重新核对。
            await activeDb("o_storyboardGenerationTask").where({ taskUuid }).update({
              parametersJson: JSON.stringify(parameters),
            });
          });
          fs.writeFileSync(logFile, "");
          await tickDreaminaScheduler();
          const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          assert.deepEqual({
            cliCalls: readCliCalls(logFile).length,
            queueState: dispatch?.queueState,
            providerState: dispatch?.providerState,
            slotHeld: Number(dispatch?.slotHeld ?? -1),
            dispatchReady: Number(dispatch?.dispatchReady ?? -1),
          }, {
            cliCalls: 0,
            queueState: "queued",
            providerState: "not_sent",
            slotHeld: 0,
            dispatchReady: 0,
          });
        } finally {
          await cleanQueue();
        }
      });

      await t.test("同批兄弟任务未 ready 时收费前必须整批隔离且零 CLI", async () => {
        const clientOperationId = "73737373-7373-4373-a373-737373737373";
        try {
          await writeDreaminaCliSettings({ executablePath: FAKE_CLI, maxConcurrency: 1, pauseNewClaims: true });
          const items = [
            {
              shotUuid: noRefShot.shotUuid,
              mediaType: "video",
              providerModel: "dreamina-cli:seedance2.0fast",
              mode: "auto",
              durationMs: 9_000,
              aspectRatio: "9:16",
            },
            {
              shotUuid: oneRefShot.shotUuid,
              mediaType: "video",
              providerModel: "dreamina-cli:seedance2.0mini",
              mode: "auto",
              durationMs: 9_000,
              aspectRatio: "9:16",
            },
          ];
          const confirmedItems = [];
          for (const item of items) {
            const preview = await postJson(previewUrl, item);
            assert.equal(preview.status, 200, JSON.stringify(preview.body));
            confirmedItems.push({ ...item, expectedPreviewDigest: preview.body.data.previewDigest });
          }
          const response = await postJson(url, {
            items: confirmedItems,
            paidBatchConfirmed: true,
            clientOperationId,
          });
          assert.equal(response.status, 200, JSON.stringify(response.body));
          const queuedDispatches = await accountDb("o_dreaminaCliDispatch")
            .where({ clientOperationId })
            .orderBy("createdAt", "asc")
            .orderBy("taskUuid", "asc")
            .select();
          assert.equal(queuedDispatches.length, 2);
          const targetTaskUuid = String(queuedDispatches[0]?.taskUuid ?? "");
          const siblingTaskUuid = String(queuedDispatches[1]?.taskUuid ?? "");
          // 中文注释：operation 仍标记 ready，但兄弟任务已不完整，当前项也不得进入收费边界。
          await runWithProjectStorage(PROJECT_UUID, async () => {
            await activeDb("o_storyboardGenerationTask").where({ taskUuid: siblingTaskUuid }).update({ enqueueReady: 0 });
          });
          fs.writeFileSync(logFile, "");
          await writeDreaminaCliSettings({ executablePath: FAKE_CLI, maxConcurrency: 1, pauseNewClaims: false });
          await tickDreaminaScheduler();
          const target = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: targetTaskUuid }).first();
          assert.deepEqual({
            cliCalls: readCliCalls(logFile).length,
            queueState: target?.queueState,
            providerState: target?.providerState,
            slotHeld: Number(target?.slotHeld ?? -1),
            dispatchReady: Number(target?.dispatchReady ?? -1),
          }, {
            cliCalls: 0,
            queueState: "queued",
            providerState: "not_sent",
            slotHeld: 0,
            dispatchReady: 0,
          });
        } finally {
          await writeDreaminaCliSettings({ executablePath: FAKE_CLI, maxConcurrency: 1, pauseNewClaims: false });
          await cleanQueue();
        }
      });

      await t.test("单图 auto 必须解析 image2video，并把模型与受管图片传到真实 CLI 参数", async () => {
        try {
          fs.writeFileSync(logFile, "");
          const response = await enqueueAuto(oneRefShot.shotUuid);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          const rows = await queuedRows();
          const referenceSnapshotsRoot = path.join(
            stagingRoot,
            String(rows[0]?.taskUuid ?? "missing"),
            "references",
          );
          const abandonedSnapshot = path.join(referenceSnapshotsRoot, "abandoned");
          await tickDreaminaScheduler();
          const request = rows[0]
            ? JSON.parse(String(rows[0].parametersJson)) as { references?: unknown[]; capabilityFields?: string[] }
            : {};
          const generationEntry = readCliEntries(logFile)
            .find((entry) => DREAMINA_MODES.includes(entry.args[0] as DreaminaMode));
          const generationArgs = generationEntry?.args ?? [];
          const imageArgument = generationArgs.find((item) => item.startsWith("--image="));
          assert.deepEqual({
            status: response.status,
            mode: rows[0]?.mode,
            references: request.references,
            capabilityFields: request.capabilityFields,
            command: generationArgs[0],
            model: generationArgs.find((item) => item.startsWith("--model_version=")),
            image: inspectCliReferenceArgument(imageArgument, "--image=", stagingRoot),
            referenceContents: generationEntry?.referenceContents,
            duration: generationArgs.find((item) => item.startsWith("--duration=")),
            ratio: generationArgs.find((item) => item.startsWith("--ratio=")),
            videoResolution: generationArgs.find((item) => item.startsWith("--video_resolution=")),
            leakedAuto: generationArgs.includes("auto"),
            referenceSnapshotResidue: fs.existsSync(referenceSnapshotsRoot),
          }, {
            status: 200,
            mode: "image2video",
            references: [{
              assetUuid: assetRows[0]!.assetUuid,
              relativePath: files.image1,
              mediaType: "image",
              md5: "0ba1dda1b72a37ce00f89edb426614b3",
              size: 9,
            }],
            capabilityFields: ["--prompt", "--image", "--duration", "--model_version"],
            command: "image2video",
            model: "--model_version=seedance2.0fast",
            image: { absolute: true, staged: true },
            referenceContents: ["image-one"],
            duration: "--duration=9",
            ratio: undefined,
            videoResolution: undefined,
            leakedAuto: false,
            referenceSnapshotResidue: true,
          });
          const retainedSnapshotDirectories = fs.readdirSync(referenceSnapshotsRoot);
          assert.equal(retainedSnapshotDirectories.length, 1,
            "成功提交后只能保留本任务本次随机快照目录");
          const retainedSnapshotDirectory = path.join(
            referenceSnapshotsRoot,
            retainedSnapshotDirectories[0]!,
          );
          assert.deepEqual(fs.readdirSync(retainedSnapshotDirectory), ["000.png"],
            "禁止按可变路径自动删除已交给 CLI 的完整快照");
          assert.equal(fs.readFileSync(path.join(retainedSnapshotDirectory, "000.png"), "utf8"), "image-one");
          const submittedDispatch = await accountDb("o_dreaminaCliDispatch")
            .where({ taskUuid: rows[0]?.taskUuid }).first();
          const submittedResult = JSON.parse(String(submittedDispatch?.providerResultJson ?? "{}"));
          assert.equal(submittedResult.referenceSnapshotCleanupPending, true,
            "Node/Windows 无原子 unlink 原语时必须保留快照并记录待清理状态");
          fs.mkdirSync(abandonedSnapshot, { recursive: true });
          fs.writeFileSync(path.join(abandonedSnapshot, "000.png"), "post-crash-residue");
          await tickDreaminaScheduler();
          assert.equal(
            fs.existsSync(referenceSnapshotsRoot),
            true,
            "恢复轮询没有本次 manifest 时必须保留 submit 后崩溃留下的引用快照",
          );
          assert.equal(
            fs.readFileSync(path.join(abandonedSnapshot, "000.png"), "utf8"),
            "post-crash-residue",
            "恢复轮询不得枚举并删除身份未知的崩溃残留",
          );
          const recoveredDispatch = await accountDb("o_dreaminaCliDispatch")
            .where({ taskUuid: rows[0]?.taskUuid }).first();
          const recoveredResult = JSON.parse(String(recoveredDispatch?.providerResultJson ?? "{}"));
          assert.equal(recoveredResult.referenceSnapshotCleanupPending, true,
            "失去 manifest 的崩溃残留必须只记录稳定待清理状态");
          fs.mkdirSync(abandonedSnapshot, { recursive: true });
          fs.writeFileSync(path.join(abandonedSnapshot, "000.png"), "unknown-submit-residue");
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid: rows[0]?.taskUuid }).update({
            providerState: "unknown",
            providerResultJson: JSON.stringify({ message: "submit 结果待确认" }),
          });
          await tickDreaminaScheduler();
          assert.equal(
            fs.existsSync(referenceSnapshotsRoot),
            true,
            "缺少耐久 submitId 时必须保留仍可能被 CLI 子进程读取的快照",
          );
        } finally {
          await cleanQueue();
        }
      });

      await t.test("多图和混合素材必须依据能力解析为 multiframe/multimodal", async () => {
        try {
          const multiframeCapable = capabilitySnapshot();
          multiframeCapable.modes.multiframe2video = {
            ...multiframeCapable.modes.multiframe2video,
            fields: [...multiframeCapable.modes.multiframe2video.fields, "--model_version"],
          };
          writeDreaminaCapabilityCache({ state: "ready", snapshot: multiframeCapable, checkedAt: Date.now() });
          fs.writeFileSync(logFile, "");
          const multi = await enqueueAuto(multiRefShot.shotUuid, "seedance2.0mini");
          assert.equal(multi.status, 200, JSON.stringify(multi.body));
          const multiRows = await queuedRows();
          const multiMode = multiRows[0]?.mode;
          await tickDreaminaScheduler();
          const multiEntry = readCliEntries(logFile).find((entry) => entry.args[0] === "multiframe2video");
          const multiArgs = multiEntry?.args ?? [];
          await cleanQueue();
          fs.writeFileSync(logFile, "");
          const mixed = await enqueueAuto(mixedRefShot.shotUuid, "seedance2.0_vip");
          assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
          const mixedRows = await queuedRows();
          const mixedMode = mixedRows[0]?.mode;
          await tickDreaminaScheduler();
          const mixedEntry = readCliEntries(logFile).find((entry) => entry.args[0] === "multimodal2video");
          const mixedArgs = mixedEntry?.args ?? [];
          assert.deepEqual({
            multiStatus: multi.status,
            multiMode,
            multiImages: inspectCliReferenceListArgument(
              multiArgs.find((item) => item.startsWith("--images=")),
              "--images=",
              stagingRoot,
            ),
            multiModel: multiArgs.find((item) => item.startsWith("--model_version=")),
            multiRatio: multiArgs.find((item) => item.startsWith("--ratio=")),
            multiVideoResolution: multiArgs.find((item) => item.startsWith("--video_resolution=")),
            multiReferenceContents: multiEntry?.referenceContents,
            mixedStatus: mixed.status,
            mixedMode,
            mixedImages: mixedArgs
              .filter((item) => item.startsWith("--image="))
              .map((item) => inspectCliReferenceArgument(item, "--image=", stagingRoot)),
            mixedVideos: mixedArgs
              .filter((item) => item.startsWith("--video="))
              .map((item) => inspectCliReferenceArgument(item, "--video=", stagingRoot)),
            mixedAudios: mixedArgs
              .filter((item) => item.startsWith("--audio="))
              .map((item) => inspectCliReferenceArgument(item, "--audio=", stagingRoot)),
            mixedReferenceContents: mixedEntry?.referenceContents,
            mixedRatio: mixedArgs.find((item) => item.startsWith("--ratio=")),
            mixedVideoResolution: mixedArgs.find((item) => item.startsWith("--video_resolution=")),
          }, {
            multiStatus: 200,
            multiMode: "multiframe2video",
            multiImages: [
              { absolute: true, staged: true },
              { absolute: true, staged: true },
            ],
            multiModel: "--model_version=seedance2.0mini",
            multiRatio: undefined,
            multiVideoResolution: "--video_resolution=720p",
            multiReferenceContents: ["image-one", "image-two"],
            mixedStatus: 200,
            mixedMode: "multimodal2video",
            mixedImages: [{ absolute: true, staged: true }],
            mixedVideos: [{ absolute: true, staged: true }],
            mixedAudios: [{ absolute: true, staged: true }],
            mixedReferenceContents: ["image-one", "video-one", "audio-one"],
            mixedRatio: "--ratio=9:16",
            mixedVideoResolution: "--video_resolution=720p",
          });
        } finally {
          await cleanQueue();
        }
      });

      await t.test("候选模式能力均禁用时整批 fail-closed 且零入队", async () => {
        try {
          writeDreaminaCapabilityCache({
            state: "ready",
            snapshot: capabilitySnapshot(["multiframe2video", "multimodal2video"]),
            checkedAt: Date.now(),
          });
          const request = {
            shotUuid: multiRefShot.shotUuid,
            mediaType: "video",
            providerModel: "dreamina-cli:seedance2.0fast",
            mode: "auto",
          };
          const preview = await postJson(previewUrl, request);
          assert.equal(preview.status, 200, JSON.stringify(preview.body));
          assert.equal(preview.body?.data?.options?.mode, "multiframe2video");
          const generated = await postJson(url, {
            ...request,
            expectedPreviewDigest: preview.body?.data?.previewDigest,
            clientOperationId: crypto.randomUUID(),
          });
          const rows = await queuedRows();
          assert.equal(generated.status, 400, JSON.stringify(generated.body));
          assert.equal(generated.body?.code, "STORYBOARD_DREAMINA_MODE_UNSUPPORTED");
          assert.equal(rows.length, 0);
        } finally {
          writeDreaminaCapabilityCache({ state: "ready", snapshot: capabilitySnapshot(), checkedAt: Date.now() });
          await cleanQueue();
        }
      });

      await t.test("非法 Seedance 模型必须在入队前拒绝", async () => {
        try {
          const response = await postJson(previewUrl, {
            shotUuid: noRefShot.shotUuid,
            mediaType: "video",
            providerModel: "dreamina-cli:seedance2.0-evil",
            mode: "auto",
          });
          const rows = await queuedRows();
          assert.deepEqual({ status: response.status, count: rows.length }, { status: 400, count: 0 });
        } finally {
          await cleanQueue();
        }
      });

      await t.test("遍历、跨项目与缺失参考素材均必须整批零入队", async () => {
        for (const shotUuid of [unsafeShot.shotUuid, crossProjectShot.shotUuid, missingShot.shotUuid]) {
          const response = await postJson(url, {
            items: [
              {
                shotUuid: noRefShot.shotUuid,
                mediaType: "video",
                providerModel: "dreamina-cli:seedance2.0fast",
                mode: "auto",
              },
              {
                shotUuid,
                mediaType: "video",
                providerModel: "dreamina-cli:seedance2.0fast",
                mode: "auto",
              },
            ],
            paidBatchConfirmed: true,
            clientOperationId: crypto.randomUUID(),
          });
          const rows = await queuedRows();
          assert.deepEqual({ status: response.status, count: rows.length }, { status: 400, count: 0 });
          await cleanQueue();
        }
      });

      await t.test("能力未知、引用超限与模型媒体不一致必须在入队前拒绝", async () => {
        try {
          invalidateDreaminaCapabilityCache();
          const unknownCapability = await postJson(previewUrl, {
            shotUuid: noRefShot.shotUuid,
            mediaType: "video",
            providerModel: "dreamina-cli:seedance2.0fast",
            mode: "auto",
          });
          assert.equal((await queuedRows()).length, 0);
          writeDreaminaCapabilityCache({ state: "ready", snapshot: capabilitySnapshot(), checkedAt: Date.now() });

          assert.throws(() => resolveDreaminaGenerationMode({
            mediaType: "video",
            requestedMode: "auto",
            references: Array.from({ length: 9 }, (_, index) => ({
              relativePath: `files/images/${index}.png`,
              mediaType: "image" as const,
            })),
          }));
          const dirtyMediaType = await postJson(url, {
            shotUuid: noRefShot.shotUuid,
            mediaType: "not-video",
            providerModel: "dreamina-cli:seedance2.0fast",
            mode: "auto",
          });
          const imageSeedance = await postJson(url, {
            shotUuid: noRefShot.shotUuid,
            mediaType: "image",
            providerModel: "dreamina-cli:seedance2.0fast",
            mode: "auto",
          });
          // 中文注释：能力未检测时非付费 preview 可用已发布字段；正式入队仍必须失败关闭。
          assert.equal(unknownCapability.status, 200, JSON.stringify(unknownCapability.body));
          assert.match(String(unknownCapability.body?.data?.previewDigest ?? ""), /^[0-9a-f]{64}$/);
          assert.deepEqual({
            dirtyMediaType: dirtyMediaType.status,
            imageSeedance: imageSeedance.status,
            count: (await queuedRows()).length,
          }, {
            dirtyMediaType: 400,
            imageSeedance: 400,
            count: 0,
          });
        } finally {
          writeDreaminaCapabilityCache({ state: "ready", snapshot: capabilitySnapshot(), checkedAt: Date.now() });
          await cleanQueue();
        }
      });

      await t.test("CLI 必需分辨率缺失必须在 preview 与内部入队前拒绝", async () => {
        const previousResolution = (await service.getSettings()).resolution;
        try {
          await service.saveSettings({ resolution: "" });
          const preview = await postJson(previewUrl, {
            shotUuid: noRefShot.shotUuid,
            mediaType: "image",
            providerModel: "dreamina-cli:text2image",
            mode: "auto",
          });
          let internalRejected = false;
          try {
            await enqueueAsyncMediaTasks({
              projectUuid: PROJECT_UUID,
              paidBatchConfirmed: false,
              items: [{
                shotUuid: noRefShot.shotUuid,
                mediaType: "image",
                providerModel: "dreamina-cli:text2image",
                mode: "auto",
              }],
            });
          } catch {
            internalRejected = true;
          }
          assert.deepEqual({
            previewStatus: preview.status,
            internalRejected,
            queued: (await queuedRows()).length,
          }, {
            previewStatus: 400,
            internalRejected: true,
            queued: 0,
          });
        } finally {
          await service.saveSettings({ resolution: previousResolution });
          await cleanQueue();
        }
      });

      await t.test("CLI 必需提示词缺失必须在 preview 与内部入队前拒绝", async () => {
        const previousSettings = await service.getSettings();
        try {
          await service.saveSettings({
            globalImagePrompt: "",
            resolution: "2K",
          });
          const preview = await postJson(previewUrl, {
            shotUuid: noRefShot.shotUuid,
            mediaType: "image",
            providerModel: "dreamina-cli:text2image",
            mode: "auto",
          });
          let internalRejected = false;
          try {
            await enqueueAsyncMediaTasks({
              projectUuid: PROJECT_UUID,
              paidBatchConfirmed: false,
              items: [{
                shotUuid: noRefShot.shotUuid,
                mediaType: "image",
                providerModel: "dreamina-cli:text2image",
                mode: "auto",
              }],
            });
          } catch {
            internalRejected = true;
          }
          assert.deepEqual({
            previewStatus: preview.status,
            internalRejected,
            queued: (await queuedRows()).length,
          }, {
            previewStatus: 400,
            internalRejected: true,
            queued: 0,
          });
        } finally {
          await service.saveSettings(previousSettings);
          await cleanQueue();
        }
      });

      await t.test("真实 help 的可选视频分辨率不得被误判为 image2video 必填值", async () => {
        const previousSettings = await service.getSettings();
        try {
          await service.saveSettings({
            globalVideoPrompt: "可选分辨率图生视频",
            resolution: "",
          });
          const probed = await probeDreaminaCapabilities(FAKE_CLI);
          assert.equal(probed.modes.image2video.fields.includes("--video_resolution"), true);
          writeDreaminaCapabilityCache({ state: "ready", snapshot: probed, checkedAt: Date.now() });
          fs.writeFileSync(logFile, "");
          const body = {
            shotUuid: oneRefShot.shotUuid,
            mediaType: "video",
            providerModel: "dreamina-cli:seedance2.0fast",
            mode: "image2video",
            durationMs: 5_000,
          };
          const preview = await postJson(previewUrl, body);
          const generated = preview.status === 200
            ? await postJson(url, {
                ...body,
                expectedPreviewDigest: preview.body?.data?.previewDigest,
                clientOperationId: crypto.randomUUID(),
              })
            : null;
          if (generated?.status === 200) await tickDreaminaScheduler();
          const args = readCliCalls(logFile).find((item) => item[0] === "image2video") ?? [];
          assert.deepEqual({
            previewStatus: preview.status,
            generatedStatus: generated?.status ?? null,
            videoResolution: args.find((item) => item.startsWith("--video_resolution=")),
          }, {
            previewStatus: 200,
            generatedStatus: 200,
            videoResolution: undefined,
          });
        } finally {
          await service.saveSettings(previousSettings);
          writeDreaminaCapabilityCache({ state: "ready", snapshot: capabilitySnapshot(), checkedAt: Date.now() });
          await cleanQueue();
        }
      });

      await t.test("内部入队不得伪造引用媒体类型，图生图必须使用 --images", async () => {
        try {
          await assert.rejects(() => enqueueAsyncMediaTasks({
            projectUuid: PROJECT_UUID,
            paidBatchConfirmed: false,
            items: [{
              shotUuid: oneRefShot.shotUuid,
              mediaType: "video",
              providerModel: "dreamina-cli:seedance2.0fast",
              mode: "image2video",
              request: {
                providerModel: "dreamina-cli:seedance2.0fast",
                prompt: "伪造媒体类型",
                references: [{
                  relativePath: files.video1,
                  mediaType: "image",
                }],
                options: { mode: "image2video", durationMs: 5_000 },
              },
            }],
          }));
          await assert.rejects(() => enqueueAsyncMediaTasks({
            projectUuid: PROJECT_UUID,
            paidBatchConfirmed: false,
            items: [{
              shotUuid: noRefShot.shotUuid,
              mediaType: "video",
              providerModel: "dreamina-cli:seedance2.0fast",
              mode: "text2video",
              request: {
                providerModel: "dreamina-cli:seedance2.0fast",
                prompt: "遗漏必需能力字段",
                references: [],
                capabilityFields: ["--prompt", "--ratio", "--video_resolution", "--model_version"],
                options: { mode: "text2video", durationMs: 5_000, aspectRatio: "16:9" },
              },
            }],
          }));
          assert.equal((await queuedRows()).length, 0);

          fs.writeFileSync(logFile, "");
          const imageResponse = await postPreviewConfirmed({
            shotUuid: oneRefShot.shotUuid,
            mediaType: "image",
            providerModel: "dreamina-cli:image2image",
            mode: "auto",
          });
          assert.equal(imageResponse.status, 200, JSON.stringify(imageResponse.body));
          await tickDreaminaScheduler();
          const entry = readCliEntries(logFile).find((item) => item.args[0] === "image2image");
          const args = entry?.args ?? [];
          assert.deepEqual(
            inspectCliReferenceListArgument(
              args.find((item) => item.startsWith("--images=")),
              "--images=",
              stagingRoot,
            ),
            [{ absolute: true, staged: true }],
          );
          assert.deepEqual(entry?.referenceContents, ["image-one"]);
          assert.equal(args.some((item) => item.startsWith("--image=")), false, JSON.stringify(args));
          assert.equal(args.some((item) => item.startsWith("--duration=")), false, JSON.stringify(args));
          assert.equal(args.some((item) => item.startsWith("--video_resolution=")), false, JSON.stringify(args));
          assert.equal(args.includes("--ratio=16:9"), true, JSON.stringify(args));
        } finally {
          await cleanQueue();
        }
      });

      await t.test("旧 Ai.Async 门面也必须复用分镜模式、引用与能力解析", async () => {
        try {
          const { default: Ai } = await import("../../src/utils/ai");
          const result = await Ai.Async("dreamina-cli:seedance2.0fast").enqueue({
            projectUuid: PROJECT_UUID,
            shotUuid: noRefShot.shotUuid,
            mediaType: "video",
            paidBatchConfirmed: false,
          });
          const [stored] = await queuedRows();
          const request = JSON.parse(String(stored?.parametersJson ?? "{}"));
          assert.deepEqual({
            status: result.status,
            mode: stored?.mode,
            requestMode: request.options?.mode,
            hasModelField: request.capabilityFields?.includes("--model_version"),
          }, {
            status: "queued",
            mode: "text2video",
            requestMode: "text2video",
            hasModelField: true,
          });
        } finally {
          await cleanQueue();
        }
      });

      await t.test("内部请求不得伪造当前模式 help 未声明的能力字段", async () => {
        try {
          await assert.rejects(() => enqueueAsyncMediaTasks({
            projectUuid: PROJECT_UUID,
            paidBatchConfirmed: false,
            items: [{
              shotUuid: noRefShot.shotUuid,
              mediaType: "video",
              providerModel: "dreamina-cli:seedance2.0fast",
              mode: "text2video",
              request: {
                providerModel: "dreamina-cli:seedance2.0fast",
                prompt: "伪造能力字段",
                references: [],
                capabilityFields: [
                  "--prompt",
                  "--duration",
                  "--ratio",
                  "--video_resolution",
                  "--model_version",
                  "--definitely_not_supported",
                ],
                options: { mode: "text2video", durationMs: 5_000, aspectRatio: "16:9" },
              },
            }],
          }));
          assert.equal((await queuedRows()).length, 0);
        } finally {
          await cleanQueue();
        }
      });

      await t.test("即梦时长必须是整秒，preview 与正式生成禁止静默取整", async () => {
        const previewUrl = `${url}/preview`;
        try {
          const request = {
            shotUuid: noRefShot.shotUuid,
            mediaType: "video",
            providerModel: "dreamina-cli:seedance2.0fast",
            mode: "auto",
            durationMs: 1_500,
          };
          const preview = await postJson(previewUrl, request);
          const generated = await postJson(url, request);
          assert.deepEqual({
            preview: preview.status,
            generated: generated.status,
            count: (await queuedRows()).length,
          }, { preview: 400, generated: 400, count: 0 });
        } finally {
          await cleanQueue();
        }
      });

      await t.test("首尾帧模式必须精确传 --first/--last，禁止伪装成多帧 --images", async () => {
        try {
          await runWithProjectStorage(PROJECT_UUID, () => activeDb.raw("PRAGMA reverse_unordered_selects = ON"));
          fs.writeFileSync(logFile, "");
          const response = await postPreviewConfirmed({
            shotUuid: multiRefShot.shotUuid,
            mediaType: "video",
            providerModel: "dreamina-cli:seedance2.0fast",
            mode: "frames2video",
            durationMs: 5_000,
            paidBatchConfirmed: false,
          });
          assert.equal(response.status, 200, JSON.stringify(response.body));
          await tickDreaminaScheduler();
          const entry = readCliEntries(logFile).find((item) => item.args[0] === "frames2video");
          const args = entry?.args ?? [];
          assert.deepEqual({
            first: inspectCliReferenceArgument(
              args.find((item) => item.startsWith("--first=")),
              "--first=",
              stagingRoot,
            ),
            last: inspectCliReferenceArgument(
              args.find((item) => item.startsWith("--last=")),
              "--last=",
              stagingRoot,
            ),
            images: args.find((item) => item.startsWith("--images=")),
            referenceContents: entry?.referenceContents,
          }, {
            first: { absolute: true, staged: true },
            last: { absolute: true, staged: true },
            images: undefined,
            referenceContents: ["image-one", "image-two"],
          });
        } finally {
          await runWithProjectStorage(PROJECT_UUID, () => activeDb.raw("PRAGMA reverse_unordered_selects = OFF"));
          await cleanQueue();
        }
      });

      await t.test("auto 只能选择真正支持 model_version 的视频模式", async () => {
        try {
          const multiframeCapable = capabilitySnapshot();
          multiframeCapable.modes.multiframe2video = {
            ...multiframeCapable.modes.multiframe2video,
            fields: [...multiframeCapable.modes.multiframe2video.fields, "--model_version"],
          };
          writeDreaminaCapabilityCache({ state: "ready", snapshot: multiframeCapable, checkedAt: Date.now() });
          const multiframe = await enqueueAuto(multiRefShot.shotUuid);
          assert.equal(multiframe.status, 200, JSON.stringify(multiframe.body));
          const [stored] = await queuedRows();
          assert.equal(JSON.parse(String(stored.parametersJson)).options.mode, "multiframe2video");
          fs.writeFileSync(logFile, "");
          await tickDreaminaScheduler();
          const multiframeEntry = readCliEntries(logFile)
            .find((entry) => entry.args[0] === "multiframe2video");
          const multiframeArgs = multiframeEntry?.args ?? [];
          assert.deepEqual(
            inspectCliReferenceListArgument(
              multiframeArgs.find((item) => item.startsWith("--images=")),
              "--images=",
              stagingRoot,
            ),
            [{ absolute: true, staged: true }, { absolute: true, staged: true }],
          );
          assert.deepEqual(multiframeEntry?.referenceContents, ["image-one", "image-two"]);
          assert.equal(multiframeArgs.some((item) => item.startsWith("--ratio=")), false, JSON.stringify(multiframeArgs));
          assert.equal(multiframeArgs.includes("--video_resolution=720p"), true, JSON.stringify(multiframeArgs));
          assert.equal(multiframeArgs.includes("--model_version=seedance2.0fast"), true, JSON.stringify(multiframeArgs));
          await cleanQueue();

          const fallbackSnapshot = capabilitySnapshot();
          writeDreaminaCapabilityCache({ state: "ready", snapshot: fallbackSnapshot, checkedAt: Date.now() });
          const fallback = await enqueueAuto(multiRefShot.shotUuid);
          assert.equal(fallback.status, 400, JSON.stringify(fallback.body));
          assert.equal(fallback.body?.code, "STORYBOARD_DREAMINA_MODE_UNSUPPORTED");
          assert.equal((await queuedRows()).length, 0);

          const previewStillStable = await postJson(previewUrl, {
            shotUuid: multiRefShot.shotUuid,
            mediaType: "video",
            providerModel: "dreamina-cli:seedance2.0fast",
            mode: "auto",
          });
          assert.equal(previewStillStable.status, 200, JSON.stringify(previewStillStable.body));
          assert.equal(previewStillStable.body?.data?.options?.mode, "multiframe2video");
        } finally {
          writeDreaminaCapabilityCache({ state: "ready", snapshot: capabilitySnapshot(), checkedAt: Date.now() });
          await cleanQueue();
        }
      });

      await t.test("无任何 model_version 视频能力时 preview 与正式生成都必须 fail-closed", async () => {
        const scenarioBeforeProbe = process.env.DREAMINA_FAKE_SCENARIO;
        try {
          process.env.DREAMINA_FAKE_SCENARIO = "missing_video_model_version";
          const probed = await probeDreaminaCapabilities(FAKE_CLI);
          for (const mode of DREAMINA_MODES.filter((item) => item.endsWith("video"))) {
            assert.equal(probed.modes[mode].enabled, true, `${mode} 必须复现 enabled 与字段不一致的真实快照`);
            assert.equal(probed.modes[mode].fields.includes("--model_version"), false);
          }
          writeDreaminaCapabilityCache({ state: "ready", snapshot: probed, checkedAt: Date.now() });
          const request = {
            shotUuid: noRefShot.shotUuid,
            mediaType: "video",
            providerModel: "dreamina-cli:seedance2.0fast",
            mode: "auto",
          };
          const preview = await postJson(previewUrl, request);
          const generated = await postJson(url, {
            ...request,
            expectedPreviewDigest: preview.body?.data?.previewDigest ?? "0".repeat(64),
            clientOperationId: crypto.randomUUID(),
          });
          assert.deepEqual({
            preview: preview.status,
            generated: generated.status,
            count: (await queuedRows()).length,
          }, { preview: 200, generated: 400, count: 0 });
          assert.equal(generated.body?.code, "STORYBOARD_DREAMINA_MODE_UNSUPPORTED");
          assert.match(String(generated.body?.message ?? ""), /不支持 text2video/);
          assert.match(String(generated.body?.message ?? ""), /不支持 text2video/);
        } finally {
          if (scenarioBeforeProbe === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
          else process.env.DREAMINA_FAKE_SCENARIO = scenarioBeforeProbe;
          writeDreaminaCapabilityCache({ state: "ready", snapshot: capabilitySnapshot(), checkedAt: Date.now() });
          await cleanQueue();
        }
      });

      await t.test("任务 references 父链为 junction 时必须失败收口且零 CLI", async () => {
        let referencesRoot = "";
        try {
          fs.writeFileSync(logFile, "");
          const response = await enqueueAuto(oneRefShot.shotUuid);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          const [queued] = await queuedRows();
          const taskStagingRoot = path.join(stagingRoot, String(queued?.taskUuid ?? "missing"));
          referencesRoot = path.join(taskStagingRoot, "references");
          const outside = path.join(root, `outside-staging-${crypto.randomUUID()}`);
          fs.mkdirSync(taskStagingRoot, { recursive: true });
          fs.mkdirSync(outside, { recursive: true });
          // 中文注释：Windows junction 无需管理员权限，用它覆盖真实 staging 父链攻击。
          fs.symlinkSync(outside, referencesRoot, "junction");
          await tickDreaminaScheduler();
          const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: queued?.taskUuid }).first();
          assert.deepEqual({
            queueState: dispatch?.queueState,
            providerState: dispatch?.providerState,
            slotHeld: Number(dispatch?.slotHeld ?? -1),
            cliCalls: readCliCalls(logFile).length,
          }, {
            queueState: "terminal",
            providerState: "failed",
            slotHeld: 0,
            cliCalls: 0,
          });
        } finally {
          if (referencesRoot && fs.existsSync(referencesRoot) && fs.lstatSync(referencesRoot).isSymbolicLink()) {
            fs.unlinkSync(referencesRoot);
          }
          await cleanQueue();
        }
      });

      await t.test("领取后素材消失必须释放槽并失败收口，禁止永久 claiming", async () => {
        const imagePath = path.join(projectRoot, ...files.image1.split("/"));
        try {
          const response = await enqueueAuto(oneRefShot.shotUuid);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          fs.rmSync(imagePath);
          let rejected = false;
          try {
            await tickDreaminaScheduler();
          } catch {
            rejected = true;
          }
          const dispatch = await accountDb("o_dreaminaCliDispatch").first();
          const projectTask = (await queuedRows())[0];
          assert.deepEqual({
            rejected,
            queueState: dispatch?.queueState,
            slotHeld: Number(dispatch?.slotHeld ?? -1),
            status: projectTask?.status,
          }, {
            rejected: false,
            queueState: "terminal",
            slotHeld: 0,
            status: "failed_fatal",
          });
        } finally {
          fs.writeFileSync(imagePath, "image-one");
          await cleanQueue();
        }
      });

      await t.test("供应商终态已耐久后项目镜像失败不得重开 unknown 或丢失 submitId", async () => {
        const previousScenarioForMirror = process.env.DREAMINA_FAKE_SCENARIO;
        try {
          process.env.DREAMINA_FAKE_SCENARIO = "definite_failure";
          const failed = await enqueueAuto(noRefShot.shotUuid);
          assert.equal(failed.status, 200, JSON.stringify(failed.body));
          await runWithProjectStorage(PROJECT_UUID, () => activeDb.raw(`
            CREATE TRIGGER r27_fail_terminal_project_mirror
            BEFORE UPDATE OF status ON o_storyboardGenerationTask
            WHEN NEW.status = 'failed_fatal'
            BEGIN SELECT RAISE(ABORT, 'round27 injected terminal mirror failure'); END
          `));
          await tickDreaminaScheduler();
          const failedDispatch = await accountDb("o_dreaminaCliDispatch")
            .where({ taskUuid: failed.body?.data?.[0]?.taskUuid })
            .first();
          const failedResult = JSON.parse(String(failedDispatch?.providerResultJson ?? "{}"));
          assert.deepEqual({
            queueState: failedDispatch?.queueState,
            providerState: failedDispatch?.providerState,
            slotHeld: Number(failedDispatch?.slotHeld ?? -1),
            code: failedResult.code,
          }, {
            queueState: "terminal",
            providerState: "failed",
            slotHeld: 0,
            code: "DREAMINA_CLI_DEFINITE_FAILURE",
          });

          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb.raw("DROP TRIGGER IF EXISTS r27_fail_terminal_project_mirror"));
          await cleanQueue();

          process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
          // 中文注释：text2video 的正式能力合同要求分辨率，本场景需提供完整有效请求后再注入镜像失败。
          await service.saveSettings({ resolution: "720p" });
          const submitted = await enqueueAuto(noRefShot.shotUuid);
          assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
          await runWithProjectStorage(PROJECT_UUID, () => activeDb.raw(`
            CREATE TRIGGER r27_fail_submitted_project_mirror
            BEFORE UPDATE OF status ON o_storyboardGenerationTask
            WHEN NEW.status = 'submitted'
            BEGIN SELECT RAISE(ABORT, 'round27 injected submitted mirror failure'); END
          `));
          await tickDreaminaScheduler();
          const submittedDispatch = await accountDb("o_dreaminaCliDispatch")
            .where({ taskUuid: submitted.body?.data?.[0]?.taskUuid })
            .first();
          const submittedResult = JSON.parse(String(submittedDispatch?.providerResultJson ?? "{}"));
          assert.deepEqual({
            queueState: submittedDispatch?.queueState,
            providerState: submittedDispatch?.providerState,
            slotHeld: Number(submittedDispatch?.slotHeld ?? -1),
            submitId: submittedResult.submitId,
          }, {
            queueState: "provider_active",
            providerState: "running",
            slotHeld: 1,
            submitId: "sub-123",
          });
        } finally {
          await runWithProjectStorage(PROJECT_UUID, async () => {
            await activeDb.raw("DROP TRIGGER IF EXISTS r27_fail_terminal_project_mirror");
            await activeDb.raw("DROP TRIGGER IF EXISTS r27_fail_submitted_project_mirror");
          });
          process.env.DREAMINA_FAKE_SCENARIO = previousScenarioForMirror ?? "submit_id";
          await service.saveSettings({ resolution: "720p" });
          await cleanQueue();
        }
      });

      await t.test("批次第二项账号投影失败时账号库零残留，项目耐久批次必须可前滚", async () => {
        try {
          await accountDb.raw(`
            CREATE TRIGGER r27_fail_second_dispatch
            BEFORE INSERT ON o_dreaminaCliDispatch
            WHEN NEW.modelName = 'dreamina-cli:seedance2.0mini'
            BEGIN SELECT RAISE(ABORT, 'round27 injected dispatch failure'); END
          `);
          const batchItems = [
            {
              shotUuid: noRefShot.shotUuid,
              mediaType: "video",
              providerModel: "dreamina-cli:seedance2.0fast",
              mode: "auto",
            },
            {
              shotUuid: noRefShot.shotUuid,
              mediaType: "video",
              providerModel: "dreamina-cli:seedance2.0mini",
              mode: "auto",
            },
          ];
          const confirmedItems = [];
          for (const item of batchItems) {
            const preview = await postJson(previewUrl, item);
            assert.equal(preview.status, 200, JSON.stringify(preview.body));
            confirmedItems.push({ ...item, expectedPreviewDigest: preview.body.data.previewDigest });
          }
          const response = await postJson(url, {
            items: confirmedItems,
            paidBatchConfirmed: true,
            clientOperationId: crypto.randomUUID(),
          });
          assert.equal(response.status, 202, JSON.stringify(response.body));
          const durableRows = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").orderBy("operationItemIndex").select());
          assert.deepEqual({
            projectCount: durableRows.length,
            dispatchCount: (await accountDb("o_dreaminaCliDispatch").select()).length,
          }, { projectCount: 2, dispatchCount: 0 });
          assert.deepEqual(durableRows.map((row) => Number(row.enqueueReady)), [0, 0]);

          await accountDb.raw("DROP TRIGGER r27_fail_second_dispatch");
          await recoverDreaminaSlots();
          const recovered = await accountDb("o_dreaminaCliDispatch")
            .orderBy("operationItemIndex")
            .select("taskUuid", "dispatchReady");
          assert.deepEqual(recovered.map((row) => String(row.taskUuid)), durableRows.map((row) => String(row.taskUuid)));
          assert.deepEqual(recovered.map((row) => Number(row.dispatchReady)), [1, 1]);
        } finally {
          await accountDb.raw("DROP TRIGGER IF EXISTS r27_fail_second_dispatch");
          await cleanQueue();
        }
      });

      await t.test("previewDigest 必须原子保护单项、批量与普通供应商确认", async () => {
        const requestBody = {
          shotUuid: noRefShot.shotUuid,
          mediaType: "video",
          providerModel: "dreamina-cli:seedance2.0fast",
          mode: "auto",
          durationMs: 9_000,
          aspectRatio: "9:16",
        };
        try {
          fs.writeFileSync(logFile, "");
          const preview = await postJson(previewUrl, requestBody);
          const digest = String(preview.body?.data?.previewDigest ?? "");
          assert.match(digest, /^[a-f0-9]{64}$/);
          assert.deepEqual(Object.keys(preview.body?.data ?? {}).sort(), [
            "options",
            "previewDigest",
            "prompt",
            "providerModel",
            "referenceSummary",
            "routeKind",
          ]);
          assert.deepEqual(Object.keys(preview.body?.data?.options ?? {}).sort(), [
            "aspectRatio",
            "durationMs",
            "mode",
            "resolution",
          ]);

          const missing = await postJson(url, requestBody);
          assert.equal(missing.status, 400, JSON.stringify(missing.body));
          const stale = await postJson(url, {
            ...requestBody,
            durationMs: 5_000,
            expectedPreviewDigest: digest,
            clientOperationId: crypto.randomUUID(),
          });
          assert.equal(stale.status, 409, JSON.stringify(stale.body));
          assert.equal((await queuedRows()).length, 0);
          assert.equal(readCliCalls(logFile).length, 0);

          const matched = await postJson(url, {
            ...requestBody,
            expectedPreviewDigest: digest,
            clientOperationId: crypto.randomUUID(),
          });
          assert.equal(matched.status, 200, JSON.stringify(matched.body));
          const [stored] = await queuedRows();
          const { previewDigest: _ignoredDigest, ...previewRequest } = preview.body.data;
          assert.deepEqual(
            safePreviewRequest(JSON.parse(String(stored.parametersJson)) as Record<string, unknown>),
            safePreviewRequest(previewRequest),
          );
          await cleanQueue();

          const secondBody = {
            ...requestBody,
            providerModel: "dreamina-cli:seedance2.0mini",
          };
          const secondPreview = await postJson(previewUrl, secondBody);
          const batch = await postJson(url, {
            items: [
              { ...requestBody, expectedPreviewDigest: digest },
              { ...secondBody, expectedPreviewDigest: "0".repeat(64) },
            ],
            paidBatchConfirmed: true,
            clientOperationId: crypto.randomUUID(),
          });
          assert.equal(secondPreview.status, 200, JSON.stringify(secondPreview.body));
          assert.equal(batch.status, 409, JSON.stringify(batch.body));
          assert.equal((await queuedRows()).length, 0);
          assert.equal(readCliCalls(logFile).length, 0);

          const vendorBody = {
            shotUuid: noRefShot.shotUuid,
            mediaType: "video",
            providerModel: "vendor:model",
            mode: "text2video",
            durationMs: 9_000,
            aspectRatio: "9:16",
          };
          const vendorPreview = await postJson(previewUrl, vendorBody);
          const vendorDigest = String(vendorPreview.body?.data?.previewDigest ?? "");
          assert.match(vendorDigest, /^[a-f0-9]{64}$/);
          assert.deepEqual(Object.keys(vendorPreview.body?.data ?? {}).sort(), [
            "options",
            "previewDigest",
            "prompt",
            "providerModel",
            "referenceSummary",
            "routeKind",
          ]);
          assert.deepEqual({
            durationMs: vendorPreview.body?.data?.options?.durationMs,
            aspectRatio: vendorPreview.body?.data?.options?.aspectRatio,
          }, { durationMs: 9_000, aspectRatio: "9:16" });
          const candidateCount = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardCandidate").count<{ total: number }>("candidateUuid as total").first());
          const vendorMismatch = await postJson(url, {
            ...vendorBody,
            expectedPreviewDigest: "f".repeat(64),
            clientOperationId: crypto.randomUUID(),
          });
          const candidateCountAfter = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardCandidate").count<{ total: number }>("candidateUuid as total").first());
          assert.equal(vendorMismatch.status, 409, JSON.stringify(vendorMismatch.body));
          assert.equal(Number(candidateCountAfter?.total ?? 0), Number(candidateCount?.total ?? 0));
          const vendorMatched = await postJson(url, {
            ...vendorBody,
            expectedPreviewDigest: vendorDigest,
            clientOperationId: crypto.randomUUID(),
          });
          assert.notEqual(vendorMatched.status, 409, JSON.stringify(vendorMatched.body));
        } finally {
          await cleanQueue();
        }
      });

      await t.test("即梦 previewDigest 必须绑定引用文件内容，旧摘要整批零入队零 CLI", async () => {
        const referencePath = path.join(projectRoot, ...files.image1.split("/"));
        const referencedBody = {
          shotUuid: oneRefShot.shotUuid,
          mediaType: "video",
          providerModel: "dreamina-cli:seedance2.0fast",
          mode: "auto",
          durationMs: 9_000,
          aspectRatio: "9:16",
        };
        const plainBody = {
          ...referencedBody,
          shotUuid: noRefShot.shotUuid,
        };
        try {
          fs.writeFileSync(referencePath, "image-one");
          fs.writeFileSync(logFile, "");
          const referencedPreview = await postJson(previewUrl, referencedBody);
          const plainPreview = await postJson(previewUrl, plainBody);
          assert.equal(referencedPreview.status, 200, JSON.stringify(referencedPreview.body));
          assert.equal(plainPreview.status, 200, JSON.stringify(plainPreview.body));
          const previewJson = JSON.stringify(referencedPreview.body);
          assert.equal(previewJson.includes(files.image1), false, "preview 禁止返回引用相对路径");
          assert.equal(previewJson.includes("0ba1dda1b72a37ce00f89edb426614b3"), false, "preview 禁止返回文件摘要");

          // 中文注释：保留数据库 assetUuid/relativePath 不变，只替换同一路径文件内容。
          fs.writeFileSync(referencePath, "IMAGE-one");
          const response = await postJson(url, {
            items: [
              { ...plainBody, expectedPreviewDigest: plainPreview.body.data.previewDigest },
              { ...referencedBody, expectedPreviewDigest: referencedPreview.body.data.previewDigest },
            ],
            paidBatchConfirmed: true,
            clientOperationId: crypto.randomUUID(),
          });
          assert.equal(response.status, 409, JSON.stringify(response.body));
          assert.deepEqual({
            projectRows: (await queuedRows()).length,
            dispatchRows: (await accountDb("o_dreaminaCliDispatch").select()).length,
            cliCalls: readCliCalls(logFile).length,
          }, { projectRows: 0, dispatchRows: 0, cliCalls: 0 });
        } finally {
          fs.writeFileSync(referencePath, "image-one");
          await cleanQueue();
        }
      });

      await t.test("即梦引用 stat 异常必须返回固定安全 400", async () => {
        const referencePath = path.join(projectRoot, ...files.image1.split("/"));
        const originalStatSync = fs.statSync;
        try {
          (fs as any).statSync = (...args: Parameters<typeof fs.statSync>) => {
            if (path.resolve(String(args[0])) === path.resolve(referencePath)) {
              throw new Error(`不得回显的 stat 路径：${referencePath}`);
            }
            return originalStatSync(...args);
          };
          const response = await postJson(previewUrl, {
            shotUuid: oneRefShot.shotUuid,
            mediaType: "video",
            providerModel: "dreamina-cli:seedance2.0fast",
            mode: "auto",
          });
          assert.equal(response.status, 400, JSON.stringify(response.body));
          // 中文注释：preview 白名单把无 code 的文件系统异常收成固定安全文案，禁止回显路径。
          assert.match(String(response.body?.message ?? ""), /分镜参考素材文件不可读取|分镜生成预览失败/);
          assert.equal(JSON.stringify(response.body).includes(referencePath), false);
          assert.equal(JSON.stringify(response.body).includes(projectRoot), false);
        } finally {
          (fs as any).statSync = originalStatSync;
        }
      });

      await t.test("即梦引用 hash 异常必须返回固定安全 400", async () => {
        const referencePath = path.join(projectRoot, ...files.image1.split("/"));
        const originalOpenSync = fs.openSync;
        try {
          (fs as any).openSync = (...args: Parameters<typeof fs.openSync>) => {
            if (path.resolve(String(args[0])) === path.resolve(referencePath)) {
              throw new Error(`不得回显的 hash 路径：${referencePath}`);
            }
            return originalOpenSync(...args);
          };
          const response = await postJson(previewUrl, {
            shotUuid: oneRefShot.shotUuid,
            mediaType: "video",
            providerModel: "dreamina-cli:seedance2.0fast",
            mode: "auto",
          });
          assert.equal(response.status, 400, JSON.stringify(response.body));
          // 中文注释：preview 白名单把无 code 的内容读取异常收成固定安全文案，禁止回显路径。
          assert.match(String(response.body?.message ?? ""), /即梦参考素材内容不可读取|分镜生成预览失败/);
          assert.equal(JSON.stringify(response.body).includes(referencePath), false);
          assert.equal(JSON.stringify(response.body).includes(projectRoot), false);
        } finally {
          (fs as any).openSync = originalOpenSync;
        }
      });

      await t.test("即梦整批重复引用只计算一次生成前内容身份", async () => {
        const referencePath = path.join(projectRoot, ...files.image1.split("/"));
        const request = {
          shotUuid: oneRefShot.shotUuid,
          mediaType: "video",
          providerModel: "dreamina-cli:seedance2.0fast",
          mode: "auto",
          durationMs: 9_000,
          aspectRatio: "9:16",
        };
        const originalOpenSync = fs.openSync;
        let referenceOpenCount = 0;
        try {
          fs.writeFileSync(referencePath, "image-one");
          const preview = await postJson(previewUrl, request);
          assert.equal(preview.status, 200, JSON.stringify(preview.body));
          (fs as any).openSync = (...args: Parameters<typeof fs.openSync>) => {
            if (path.resolve(String(args[0])) === path.resolve(referencePath)) referenceOpenCount += 1;
            return originalOpenSync(...args);
          };
          const response = await postJson(url, {
            items: [
              { ...request, expectedPreviewDigest: preview.body.data.previewDigest },
              { ...request, expectedPreviewDigest: preview.body.data.previewDigest },
            ],
            paidBatchConfirmed: true,
            clientOperationId: crypto.randomUUID(),
          });
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal((await queuedRows()).length, 2);
          // 中文注释：同批同路径只做一次流式读取，避免 256 项批量同步重复扫描大文件。
          assert.equal(referenceOpenCount, 1);
        } finally {
          (fs as any).openSync = originalOpenSync;
          await cleanQueue();
        }
      });

      await t.test("即梦持久内容身份类型损坏必须零 CLI 隔离收口", async () => {
        try {
          fs.writeFileSync(logFile, "");
          const response = await enqueueAuto(oneRefShot.shotUuid);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          const [queued] = await queuedRows();
          const persistedRequest = JSON.parse(String(queued?.parametersJson ?? "{}")) as {
            references?: Array<Record<string, unknown>>;
          };
          assert.ok(persistedRequest.references?.[0]);
          persistedRequest.references[0]!.size = "9";
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid: queued?.taskUuid }).update({
              parametersJson: JSON.stringify(persistedRequest),
            }));
          await tickDreaminaScheduler();
          const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: queued?.taskUuid }).first();
          const projectTask = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid: queued?.taskUuid }).first());
          assert.deepEqual({
            queueState: dispatch?.queueState,
            providerState: dispatch?.providerState,
            slotHeld: Number(dispatch?.slotHeld ?? -1),
            dispatchReady: Number(dispatch?.dispatchReady ?? -1),
            projectStatus: projectTask?.status,
            cliCalls: readCliCalls(logFile).length,
          }, {
            // 中文注释：主线的耐久操作摘要屏障优先隔离被篡改任务，保留项目行供安全恢复且禁止收费。
            queueState: "queued",
            providerState: "not_sent",
            slotHeld: 0,
            dispatchReady: 0,
            projectStatus: "queued",
            cliCalls: 0,
          });
        } finally {
          await cleanQueue();
        }
      });

      await t.test("即梦入队后同路径替换引用必须在 submit 前失败收口并释放槽", async () => {
        const referencePath = path.join(projectRoot, ...files.image1.split("/"));
        try {
          fs.writeFileSync(referencePath, "image-one");
          fs.writeFileSync(logFile, "");
          const response = await enqueueAuto(oneRefShot.shotUuid);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          const [queued] = await queuedRows();
          const persistedRequest = JSON.parse(String(queued?.parametersJson ?? "{}")) as {
            references?: Array<{ md5?: string; size?: number }>;
          };
          assert.deepEqual(persistedRequest.references?.map(({ md5, size }) => ({ md5, size })), [{
            md5: "0ba1dda1b72a37ce00f89edb426614b3",
            size: 9,
          }]);

          // 中文注释：替换发生在持久入队之后、scheduler 领取并调用 fake CLI 之前。
          fs.writeFileSync(referencePath, "IMAGE-one");
          await tickDreaminaScheduler();
          const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: queued?.taskUuid }).first();
          const projectTask = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid: queued?.taskUuid }).first());
          const dispatchJson = String(dispatch?.providerResultJson ?? "");
          assert.deepEqual({
            queueState: dispatch?.queueState,
            providerState: dispatch?.providerState,
            slotHeld: Number(dispatch?.slotHeld ?? -1),
            projectStatus: projectTask?.status,
            cliCalls: readCliCalls(logFile).length,
          }, {
            queueState: "terminal",
            providerState: "failed",
            slotHeld: 0,
            projectStatus: "failed_fatal",
            cliCalls: 0,
          });
          assert.equal(dispatchJson.includes(referencePath), false, "调度终态禁止记录本机路径");
          assert.equal(dispatchJson.includes("0ba1dda1b72a37ce00f89edb426614b3"), false, "调度终态禁止记录文件摘要");
        } finally {
          fs.writeFileSync(referencePath, "image-one");
          await cleanQueue();
        }
      });

      await t.test("即梦内容核对结束后的同路径替换也必须零 CLI 失败收口", async () => {
        const referencePath = path.join(projectRoot, ...files.image1.split("/"));
        const originalStatSync = fs.statSync;
        let targetStatCalls = 0;
        try {
          fs.writeFileSync(referencePath, "image-one");
          fs.writeFileSync(logFile, "");
          const response = await enqueueAuto(oneRefShot.shotUuid);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          const [queued] = await queuedRows();

          (fs as any).statSync = (...args: Parameters<typeof fs.statSync>) => {
            const stat = originalStatSync(...args);
            if (path.resolve(String(args[0])) === path.resolve(referencePath)) {
              targetStatCalls += 1;
              if (targetStatCalls === 2) {
                // 中文注释：模拟流式核验读取完成且最终 stat 已取得后，原路径被原子替换。
                fs.writeFileSync(referencePath, "IMAGE-one");
              }
            }
            return stat;
          };
          await tickDreaminaScheduler();
          (fs as any).statSync = originalStatSync;

          const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: queued?.taskUuid }).first();
          const projectTask = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid: queued?.taskUuid }).first());
          assert.equal(targetStatCalls >= 2, true, "测试必须命中 scheduler 的核验后替换窗口");
          assert.deepEqual({
            queueState: dispatch?.queueState,
            providerState: dispatch?.providerState,
            slotHeld: Number(dispatch?.slotHeld ?? -1),
            projectStatus: projectTask?.status,
            cliCalls: readCliCalls(logFile).length,
          }, {
            queueState: "terminal",
            providerState: "failed",
            slotHeld: 0,
            projectStatus: "failed_fatal",
            cliCalls: 0,
          });
        } finally {
          (fs as any).statSync = originalStatSync;
          fs.writeFileSync(referencePath, "image-one");
          await cleanQueue();
        }
      });

      await t.test("旧租约失去 submit fence 时只能清理自身引用快照", async () => {
        const triggerName = "r27_replace_lease_before_submit_fence";
        const originalStatSync = fs.statSync;
        let referencesRoot = "";
        let replacementSnapshot = "";
        let replacementCreated = false;
        try {
          fs.writeFileSync(logFile, "");
          const response = await enqueueAuto(oneRefShot.shotUuid);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          const [queued] = await queuedRows();
          referencesRoot = path.join(stagingRoot, String(queued?.taskUuid ?? "missing"), "references");
          replacementSnapshot = path.join(referencesRoot, "replacement-lease-snapshot");

          await accountDb.raw(`DROP TRIGGER IF EXISTS ${triggerName}`);
          await accountDb.raw(`
            CREATE TRIGGER ${triggerName}
            BEFORE UPDATE OF providerResultJson ON o_dreaminaCliDispatch
            WHEN NEW.providerResultJson = '{"submitStarted":true}'
            BEGIN
              UPDATE o_dreaminaCliDispatch
              SET leaseOwner = 'replacement-lease', leaseExpiresAt = 4102444800000
              WHERE taskUuid = OLD.taskUuid;
              SELECT RAISE(IGNORE);
            END
          `);

          let snapshotStatCalls = 0;
          (fs as any).statSync = (...args: Parameters<typeof fs.statSync>) => {
            const stat = originalStatSync(...args);
            const candidate = path.resolve(String(args[0]));
            if (candidate.startsWith(`${path.resolve(referencesRoot)}${path.sep}`)
              && path.basename(candidate) === "000.png") {
              snapshotStatCalls += 1;
              if (snapshotStatCalls === 2) {
                // 中文注释：在旧 worker 摘要结束后模拟 replacement lease 建立自己的快照。
                fs.mkdirSync(replacementSnapshot, { recursive: true });
                fs.writeFileSync(path.join(replacementSnapshot, "000.png"), "replacement-content");
                replacementCreated = true;
              }
            }
            return stat;
          };

          await tickDreaminaScheduler();
          (fs as any).statSync = originalStatSync;
          const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: queued?.taskUuid }).first();
          assert.equal(replacementCreated, true, "测试必须命中旧租约与 replacement 快照交叠窗口");
          assert.deepEqual({
            leaseOwner: dispatch?.leaseOwner,
            replacementSnapshotExists: fs.existsSync(replacementSnapshot),
            replacementContent: fs.existsSync(path.join(replacementSnapshot, "000.png"))
              ? fs.readFileSync(path.join(replacementSnapshot, "000.png"), "utf8")
              : null,
            cliCalls: readCliCalls(logFile).length,
          }, {
            leaseOwner: "replacement-lease",
            replacementSnapshotExists: true,
            replacementContent: "replacement-content",
            cliCalls: 0,
          });
        } finally {
          (fs as any).statSync = originalStatSync;
          await accountDb.raw(`DROP TRIGGER IF EXISTS ${triggerName}`);
          await cleanQueue();
        }
      });

      await t.test("引用快照摘要后消失必须在 submitStarted 前失败收口", async () => {
        const originalStatSync = fs.statSync;
        let snapshotRemoved = false;
        try {
          fs.writeFileSync(logFile, "");
          const response = await enqueueAuto(oneRefShot.shotUuid);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          const [queued] = await queuedRows();
          const referencesRoot = path.join(stagingRoot, String(queued?.taskUuid ?? "missing"), "references");
          let snapshotStatCalls = 0;
          (fs as any).statSync = (...args: Parameters<typeof fs.statSync>) => {
            const stat = originalStatSync(...args);
            const candidate = path.resolve(String(args[0]));
            if (candidate.startsWith(`${path.resolve(referencesRoot)}${path.sep}`)
              && path.basename(candidate) === "000.png") {
              snapshotStatCalls += 1;
              if (snapshotStatCalls === 2) {
                // 中文注释：模拟初次摘要已完成、submitStarted 尚未落盘时快照被移除。
                fs.unlinkSync(candidate);
                snapshotRemoved = true;
              }
            }
            return stat;
          };

          await tickDreaminaScheduler();
          (fs as any).statSync = originalStatSync;
          const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: queued?.taskUuid }).first();
          const projectTask = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid: queued?.taskUuid }).first());
          assert.equal(snapshotRemoved, true, "测试必须命中快照初次摘要后的删除窗口");
          assert.deepEqual({
            queueState: dispatch?.queueState,
            providerState: dispatch?.providerState,
            slotHeld: Number(dispatch?.slotHeld ?? -1),
            projectStatus: projectTask?.status,
            cliCalls: readCliCalls(logFile).length,
          }, {
            queueState: "terminal",
            providerState: "failed",
            slotHeld: 0,
            projectStatus: "failed_fatal",
            cliCalls: 0,
          });
        } finally {
          (fs as any).statSync = originalStatSync;
          await cleanQueue();
        }
      });

      await t.test("submitStarted 后明确 pathRejected 必须零 CLI 释放槽", async () => {
        const originalLstatSync = fs.lstatSync;
        let pathRejected = false;
        try {
          fs.writeFileSync(logFile, "");
          const response = await enqueueAuto(oneRefShot.shotUuid);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          const [queued] = await queuedRows();
          (fs as any).lstatSync = (...args: Parameters<typeof fs.lstatSync>) => {
            const stat = originalLstatSync(...args);
            if (!stat) throw new Error("fake lstat 夹具未返回文件状态");
            if (path.resolve(String(args[0])) !== path.resolve(FAKE_CLI)) return stat;
            pathRejected = true;
            // 中文注释：模拟 spawn 紧邻检查明确判定路径为链接；此时尚未创建任何 CLI 子进程。
            return new Proxy(stat, {
              get(target, property, receiver) {
                if (property === "isSymbolicLink") return () => true;
                return Reflect.get(target, property, receiver);
              },
            });
          };

          await tickDreaminaScheduler();
          (fs as any).lstatSync = originalLstatSync;
          const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: queued?.taskUuid }).first();
          const projectTask = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid: queued?.taskUuid }).first());
          assert.equal(pathRejected, true, "测试必须命中 spawn 前的确定性 pathRejected");
          assert.equal(Number(dispatch?.slotHeld ?? -1), 0, "pathRejected 不得占槽");
          assert.equal(readCliCalls(logFile).length, 0, "pathRejected 必须零 CLI");
          assert.ok(
            dispatch?.queueState === "queued" || dispatch?.queueState === "terminal",
            `pathRejected 后必须停留在安全未收费终态，实际 ${dispatch?.queueState}`,
          );
          if (dispatch?.queueState === "terminal") {
            assert.equal(dispatch?.providerState, "failed");
            assert.equal(projectTask?.status, "failed_fatal");
          } else {
            assert.equal(dispatch?.providerState, "not_sent");
          }
        } finally {
          (fs as any).lstatSync = originalLstatSync;
          await cleanQueue();
        }
      });

      await t.test("即梦 preview 必须与正式生成复用模型、引用和 auto 解析且保持零入队", async () => {
        const expectedModes = [
          [noRefShot.shotUuid, "text2video"],
          [oneRefShot.shotUuid, "image2video"],
          [multiRefShot.shotUuid, "multiframe2video"],
          [mixedRefShot.shotUuid, "multimodal2video"],
        ] as const;
        try {
          const previews = [];
          for (const [shotUuid, expectedMode] of expectedModes) {
            const preview = await postJson(previewUrl, {
              shotUuid,
              mediaType: "video",
              providerModel: "dreamina-cli:seedance2.0fast",
              mode: "auto",
              durationMs: 9_000,
              aspectRatio: "9:16",
              ...(shotUuid === oneRefShot.shotUuid ? {
                shot: { videoPrompt: "不得信任的 body shot 提示词" },
                settings: { globalVideoPrompt: "不得信任的 body settings 提示词" },
              } : {}),
            });
            assert.equal(preview.status, 200, JSON.stringify(preview.body));
            assert.equal(preview.body?.data?.options?.mode, expectedMode);
            assert.match(String(preview.body?.data?.previewDigest ?? ""), /^[a-f0-9]{64}$/);
            const { previewDigest: _ignoredDigest, ...request } = preview.body.data;
            previews.push(request);
          }
          assert.equal((await queuedRows()).length, 0, "preview 只读，禁止写生成队列");
          const submitted = await enqueueAuto(oneRefShot.shotUuid);
          assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
          const [stored] = await queuedRows();
          const storedRequest = JSON.parse(String(stored.parametersJson)) as Record<string, unknown>;
          assert.deepEqual(safePreviewRequest(storedRequest), safePreviewRequest(previews[1]));
          assert.deepEqual(
            (storedRequest.references as Array<{ mediaType?: string }>).map((ref) => ref.mediaType),
            ["image"],
          );
          assert.equal(String(previews[1]?.prompt ?? "").includes("不得信任"), false);

          const unsafePreview = await postJson(previewUrl, {
            shotUuid: unsafeShot.shotUuid,
            mediaType: "video",
            providerModel: "dreamina-cli:seedance2.0fast",
            mode: "auto",
          });
          assert.equal(unsafePreview.status, 400);
          const vendorPreview = await postJson(previewUrl, {
            shotUuid: noRefShot.shotUuid,
            mediaType: "video",
            providerModel: "vendor:model",
            mode: "text2video",
          });
          assert.equal(vendorPreview.status, 200, JSON.stringify(vendorPreview.body));
        } finally {
          await cleanQueue();
        }
      });
    });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    invalidateDreaminaCapabilityCache();
    syncCoordinator.listProjects = originalListProjects;
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime());
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
    if (previousScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
    else process.env.DREAMINA_FAKE_SCENARIO = previousScenario;
    if (previousQueryStatus === undefined) delete process.env.DREAMINA_FAKE_QUERY_STATUS;
    else process.env.DREAMINA_FAKE_QUERY_STATUS = previousQueryStatus;
    if (previousLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = previousLog;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放时保留在当前 worktree 的 .local/t，禁止跨目录清理。
    }
  }
});
