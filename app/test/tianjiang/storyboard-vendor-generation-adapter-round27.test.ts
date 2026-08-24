/**
 * Round27 RED：普通供应商必须把分镜最终请求适配成 Ai.Image/Video 的顶层参数，
 * 并让 preview 摘要覆盖真实项目媒体引用的路径与内容身份。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import {
  accountDb,
  activateUserDatabase,
  db as activeDb,
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
  adaptVendorGenerationRequest,
  type FinalGenerationRequest,
} from "../../src/tianjiang/storyboard/storyboard-generation-service";
import {
  closeActivatedWorkspaceRuntime,
  createUniqueWorktreeRoot,
} from "./helpers/worktree-runtime";
import { createSafeVendorPhaseError } from "../../src/tianjiang/storyboard/vendor-generation-safety";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9731 };
const PROJECT_UUID = "31313131-3131-4131-a131-313131313131";
const ASSET_UUID = "41414141-4141-4141-a141-414141414141";

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

function vendorRequest(
  mediaType: "image" | "video",
  mode: string,
  referenceTypes: Array<"image" | "video" | "audio">,
): FinalGenerationRequest {
  return {
    providerModel: "vendor:model",
    prompt: "安全测试",
    references: referenceTypes.map((mediaType, index) => ({
      relativePath: `files/${mediaType}s/reference-${index}.${mediaType === "image" ? "png" : mediaType === "video" ? "mp4" : "mp3"}`,
      mediaType,
      md5: String(index + 1).padStart(32, "0"),
      size: index + 1,
    })),
    options: {
      aspectRatio: "16:9",
      resolution: mediaType === "image" ? "1K" : "720p",
      durationMs: 5_000,
      mode,
    },
  };
}

test("普通供应商模式必须与真实引用数量及 JSON 描述完全一致", () => {
  const invalidCases: Array<{ mediaType: "image" | "video"; mode: string; refs: Array<"image" | "video" | "audio"> }> = [
    { mediaType: "image", mode: "text2image", refs: ["image"] },
    { mediaType: "image", mode: "image2image", refs: [] },
    { mediaType: "image", mode: "image2image", refs: ["image", "image", "image", "image", "image"] },
    { mediaType: "video", mode: "text2video", refs: ["image"] },
    { mediaType: "video", mode: "image2video", refs: [] },
    { mediaType: "video", mode: "frames2video", refs: ["image"] },
    { mediaType: "video", mode: "endFrameOptional", refs: [] },
    { mediaType: "video", mode: "endFrameOptional", refs: ["image", "image", "image"] },
    { mediaType: "video", mode: "startFrameOptional", refs: ["video"] },
    { mediaType: "video", mode: "multiframe2video", refs: ["image"] },
    { mediaType: "video", mode: "multiframe2video", refs: Array.from({ length: 9 }, () => "image") },
    { mediaType: "video", mode: "multimodal2video", refs: [] },
    { mediaType: "video", mode: "multimodal2video", refs: Array.from({ length: 9 }, () => "image") },
    { mediaType: "video", mode: '["imageReference:2"]', refs: ["image"] },
    { mediaType: "video", mode: '["imageReference:1","imageReference:1"]', refs: ["image", "image"] },
  ];
  const invalidAccepted = invalidCases.filter((item) => {
    try {
      adaptVendorGenerationRequest({
        projectUuid: PROJECT_UUID,
        mediaType: item.mediaType,
        request: vendorRequest(item.mediaType, item.mode, item.refs),
      });
      return true;
    } catch {
      return false;
    }
  }).map((item) => `${item.mediaType}/${item.mode}/${item.refs.join(",") || "none"}`);

  const validCases = [
    vendorRequest("image", "text2image", []),
    vendorRequest("image", "image2image", ["image", "image", "image", "image"]),
    vendorRequest("video", "text2video", []),
    vendorRequest("video", "image2video", ["image"]),
    vendorRequest("video", "frames2video", ["image", "image"]),
    vendorRequest("video", "startFrameOptional", ["image"]),
    vendorRequest("video", "endFrameOptional", ["image", "image"]),
    vendorRequest("video", "multiframe2video", ["image", "image"]),
    vendorRequest("video", "multiframe2video", Array.from({ length: 8 }, () => "image")),
    vendorRequest("video", "multimodal2video", ["image", "video", "audio"]),
    vendorRequest("video", "multimodal2video", ["image", "video", "audio", "image", "video", "audio", "image", "video"]),
    vendorRequest("video", '["imageReference:1","videoReference:1"]', ["image", "video"]),
  ];
  const validRejected = validCases.filter((request) => {
    try {
      adaptVendorGenerationRequest({
        projectUuid: PROJECT_UUID,
        mediaType: request.options.resolution === "1K" ? "image" : "video",
        request,
      });
      return false;
    } catch {
      return true;
    }
  }).map((request) => `${request.options.resolution}/${request.options.mode}`);
  assert.deepEqual({ invalidAccepted, validRejected }, { invalidAccepted: [], validRejected: [] });
});

test("普通供应商必须收到 Ai 图片/视频顶层参数与摘要确认过的持久媒体引用", async () => {
  const root = createUniqueWorktreeRoot("vendor-adapter-round27");
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  const originalListProjects = syncCoordinator.listProjects.bind(syncCoordinator);
  const originalImage = Ai.Image;
  const originalVideo = Ai.Video;
  const capturedImage: unknown[] = [];
  const capturedVideo: unknown[] = [];
  const paidInvocations: string[] = [];
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = previousTestContext || "storyboard-vendor-generation-adapter-round27";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  // 中文注释：本地 fake 必须同时注册到账号模型目录，确保受理门禁后仍能覆盖适配与后台失败合同。
  await runWithUserStorage(IDENTITY, () => accountDb("o_vendorConfig").insert({
    id: "vendor",
    inputValues: "{}",
    models: JSON.stringify([
      { modelName: "image-model", name: "本地图片模型", type: "image" },
      { modelName: "video-model", name: "本地视频模型", type: "video" },
      { modelName: "staging-fails", name: "本地暂存失败模型", type: "video" },
      { modelName: "remote-fails", name: "本地执行失败模型", type: "video" },
      { modelName: "save-fails", name: "本地保存失败模型", type: "video" },
    ]),
    enable: 1,
  }).onConflict("id").merge({
    inputValues: "{}",
    models: JSON.stringify([
      { modelName: "image-model", name: "本地图片模型", type: "image" },
      { modelName: "video-model", name: "本地视频模型", type: "video" },
      { modelName: "staging-fails", name: "本地暂存失败模型", type: "video" },
      { modelName: "remote-fails", name: "本地执行失败模型", type: "video" },
      { modelName: "save-fails", name: "本地保存失败模型", type: "video" },
    ]),
    enable: 1,
  }));

  // 中文注释：只替换外部收费边界，路由、摘要、项目解析和结果安装仍走生产实现。
  Ai.Image = ((key: `${string}:${string}`) => {
    const createHandle = (input: unknown) => ({
      async execute() {
        paidInvocations.push(key);
        if (key === "vendor:remote-fails") {
          throw new Error("remote sk-secret https://signed.example/image C:\\private\\result.png");
        }
        capturedImage.push(input);
        return {
          async save(target: string) {
            if (key === "vendor:save-fails") {
              throw new Error("save sk-secret https://signed.example/image C:\\private\\result.png");
            }
            const context = currentUserStorage();
            assert.ok(context, "后台图片保存必须保留账号上下文");
            const absolute = path.join(
              projectDirectory(getPath(), PROJECT_UUID, context.segment),
              ...target.split("/"),
            );
            fs.mkdirSync(path.dirname(absolute), { recursive: true });
            fs.writeFileSync(absolute, "vendor-image-result");
            return this;
          },
        };
      },
    });
    return {
    async prepare(input: unknown) {
      return {
        stage: async () => {
          if (key === "vendor:staging-fails") throw createSafeVendorPhaseError("stage");
          return createHandle(input);
        },
      };
    },
    async run(input: unknown) {
      if (key === "vendor:staging-fails") {
        throw new Error("stage sk-secret https://signed.example/file C:\\private\\asset.png");
      }
      return createHandle(input).execute();
    },
  };
  }) as typeof Ai.Image;
  Ai.Video = ((key: `${string}:${string}`) => {
    const createHandle = (input: unknown) => ({
      async execute() {
        paidInvocations.push(key);
        if (key === "vendor:remote-fails") {
          throw new Error("remote sk-secret https://signed.example/video C:\\private\\result.mp4");
        }
        capturedVideo.push(input);
        return {
          async save(target: string) {
            if (key === "vendor:save-fails") {
              throw new Error("save sk-secret https://signed.example/video C:\\private\\result.mp4");
            }
            const context = currentUserStorage();
            assert.ok(context, "后台视频保存必须保留账号上下文");
            const absolute = path.join(
              projectDirectory(getPath(), PROJECT_UUID, context.segment),
              ...target.split("/"),
            );
            fs.mkdirSync(path.dirname(absolute), { recursive: true });
            fs.copyFileSync(path.resolve(__dirname, "fixtures/minimal-adoptable.mp4"), absolute);
            return this;
          },
        };
      },
    });
    return {
    async prepare(input: unknown) {
      return {
        stage: async () => {
          if (key === "vendor:staging-fails") throw createSafeVendorPhaseError("stage");
          return createHandle(input);
        },
      };
    },
    async run(input: unknown) {
      if (key === "vendor:staging-fails") {
        throw new Error("template sk-secret https://signed.example/video C:\\private\\video.mp4");
      }
      return createHandle(input).execute();
    },
  };
  }) as typeof Ai.Video;

  let server: http.Server | undefined;
  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 2731,
        name: "Round27 普通供应商适配",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT_UUID,
        name: "Round27 普通供应商适配",
        kind: "personal",
        ownerUserId: IDENTITY.userId,
        myRole: "owner",
        openMode: "editable",
      }] as any;

      const service = new StoryboardService(PROJECT_UUID);
      await service.saveSettings({
        globalImagePrompt: "统一影像",
        globalVideoPrompt: "统一动态",
        globalNegativePrompt: "水印",
        aspectRatio: "16:9",
        resolution: "2K",
        durationMs: 4_000,
      });
      const imageShot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "雨巷",
        imagePrompt: "近景胶片",
        negativePrompt: "模糊",
      });
      const videoShot = await service.insertShot({
        afterShotUuid: imageShot.shotUuid,
        sourceText: "人物奔跑",
        videoPrompt: "稳定跟拍",
        negativePrompt: "抖动",
      });
      const noReferenceVideoShot = await service.insertShot({
        afterShotUuid: videoShot.shotUuid,
        sourceText: "远景天空",
        videoPrompt: "缓慢推镜",
      });

      const context = currentUserStorage();
      assert.ok(context, "测试必须处于账号上下文");
      const relativePath = "files/images/vendor-reference.png";
      const referenceBytes = Buffer.from("round27-vendor-reference", "utf8");
      const referencePath = path.join(
        projectDirectory(getPath(), PROJECT_UUID, context.segment),
        ...relativePath.split("/"),
      );
      fs.mkdirSync(path.dirname(referencePath), { recursive: true });
      fs.writeFileSync(referencePath, referenceBytes);
      await runWithProjectStorage(PROJECT_UUID, async () => {
        await activeDb("o_image").insert({
          id: 501,
          filePath: relativePath,
          type: "role",
          assetsId: 401,
          state: "完成",
        });
        await activeDb("o_assets").insert({
          id: 401,
          name: "参考角色",
          type: "role",
          describe: "",
          imageId: 501,
          assetUuid: ASSET_UUID,
          projectId: 2731,
        });
      });
      for (const shot of [imageShot, videoShot]) {
        await service.bindAsset(shot.shotUuid, {
          sourceProjectUuid: PROJECT_UUID,
          assetUuid: ASSET_UUID,
          assetType: "role",
          relationRole: "appear",
        });
      }

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "round27-vendor" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const listening = await listen(app);
      server = listening.server;
      const generateUrl = `http://127.0.0.1:${listening.port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/storyboard/generate`;
      const previewUrl = `${generateUrl}/preview`;
      const waitForOperationState = async (clientOperationId: string, expected: string) => {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          const row = await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardGenerationOperation")
            .where({ clientOperationId })
            .first("state"));
          if (String(row?.state ?? "") === expected) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail(`operation ${clientOperationId} 未在期限内进入 ${expected}`);
      };
      const previewConfirmedGenerate = async (body: Record<string, unknown>) => {
        const clientOperationId = crypto.randomUUID();
        const preview = await postJson(previewUrl, body);
        assert.equal(preview.status, 200, JSON.stringify(preview.body));
        const generateBody = {
          ...body,
          expectedPreviewDigest: preview.body?.data?.previewDigest,
          clientOperationId,
        };
        const accepted = await postJson(generateUrl, generateBody);
        assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
        assert.equal(accepted.body?.data?.clientOperationId, clientOperationId, JSON.stringify(accepted.body));
        assert.equal(accepted.body?.data?.tasks?.[0]?.status, "queued", JSON.stringify(accepted.body));
        await waitForOperationState(clientOperationId, "completed");
        // 中文注释：同 ID/同意图完成后重放权威 completed 快照，不产生第二次收费执行。
        const generated = await postJson(generateUrl, generateBody);
        assert.equal(generated.status, 200, JSON.stringify(generated.body));
        assert.equal(Array.isArray(generated.body?.data), true, JSON.stringify(generated.body));
        assert.equal(generated.body?.data?.[0]?.status, "completed", JSON.stringify(generated.body));
        assert.equal(generated.body?.data?.[0]?.clientOperationId, clientOperationId, JSON.stringify(generated.body));
        return { preview, generated, clientOperationId };
      };

      const imageResult = await previewConfirmedGenerate({
        shotUuid: imageShot.shotUuid,
        mediaType: "image",
        providerModel: "vendor:image-model",
        mode: "image2image",
        aspectRatio: "1:1",
      });

      await service.saveSettings({ resolution: "720p" });
      const videoResult = await previewConfirmedGenerate({
        shotUuid: videoShot.shotUuid,
        mediaType: "video",
        providerModel: "vendor:video-model",
        mode: "image2video",
        durationMs: 9_000,
        aspectRatio: "9:16",
      });

      const noReferenceBody = {
        shotUuid: noReferenceVideoShot.shotUuid,
        mediaType: "video",
        providerModel: "vendor:video-model",
        mode: "text2video",
        durationMs: 5_000,
        aspectRatio: "16:9",
      };
      const boundVideoBody = {
        shotUuid: videoShot.shotUuid,
        mediaType: "video",
        providerModel: "vendor:video-model",
        mode: "image2video",
        durationMs: 9_000,
        aspectRatio: "9:16",
      };
      const noReferencePreview = await postJson(previewUrl, noReferenceBody);
      const boundVideoPreview = await postJson(previewUrl, boundVideoBody);
      assert.equal(noReferencePreview.status, 200, JSON.stringify(noReferencePreview.body));
      assert.equal(boundVideoPreview.status, 200, JSON.stringify(boundVideoPreview.body));
      const successfulImageCapture = [...capturedImage];
      const successfulVideoCapture = [...capturedVideo];
      capturedImage.length = 0;
      capturedVideo.length = 0;

      const vendorBatchOperationId = "73737373-7373-4373-a373-737373737373";
      const vendorBatchBody = {
        items: [
          { ...noReferenceBody, expectedPreviewDigest: noReferencePreview.body?.data?.previewDigest },
          { ...boundVideoBody, expectedPreviewDigest: boundVideoPreview.body?.data?.previewDigest },
        ],
        paidBatchConfirmed: true,
        clientOperationId: vendorBatchOperationId,
      };
      const acceptedVendorBatch = await postJson(generateUrl, vendorBatchBody);
      assert.equal(acceptedVendorBatch.status, 202, JSON.stringify(acceptedVendorBatch.body));
      await waitForOperationState(vendorBatchOperationId, "completed");
      const vendorBatch = await postJson(generateUrl, vendorBatchBody);
      assert.equal(vendorBatch.status, 200, JSON.stringify(vendorBatch.body));
      assert.equal(Array.isArray(vendorBatch.body?.data), true, JSON.stringify(vendorBatch.body));
      assert.deepEqual(
        vendorBatch.body.data.map((item: { clientOperationId?: unknown }) => item.clientOperationId),
        [vendorBatchOperationId, vendorBatchOperationId],
      );

      // 中文注释：第二项本地模板/暂存失败时，第一项不得先触发收费函数；错误也不得回显秘密或本机路径。
      const secondFailurePreview = await postJson(previewUrl, {
        ...noReferenceBody,
        providerModel: "vendor:staging-fails",
      });
      assert.equal(secondFailurePreview.status, 200, JSON.stringify(secondFailurePreview.body));
      const paidBeforeFailure = paidInvocations.length;
      const preflightFailureOperationId = crypto.randomUUID();
      const preflightFailure = await postJson(generateUrl, {
        items: [
          { ...noReferenceBody, expectedPreviewDigest: noReferencePreview.body?.data?.previewDigest },
          {
            ...noReferenceBody,
            providerModel: "vendor:staging-fails",
            expectedPreviewDigest: secondFailurePreview.body?.data?.previewDigest,
          },
        ],
        paidBatchConfirmed: true,
        clientOperationId: preflightFailureOperationId,
      });
      assert.equal(preflightFailure.status, 202, JSON.stringify(preflightFailure.body));
      await waitForOperationState(preflightFailureOperationId, "failed_fatal");
      const failureText = JSON.stringify(preflightFailure.body);
      const preflightPaidInvocations = paidInvocations.slice(paidBeforeFailure);
      const preflightTaskErrors = await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardGenerationTask")
        .where({ clientOperationId: preflightFailureOperationId })
        .orderBy("operationItemIndex")
        .select("status", "errorCode", "errorSummary"));

      // 中文注释：收费函数与结果保存阶段的异常在后台收敛，SQLite 也只能保存稳定码和脱敏中文摘要。
      const executionFailures = [] as Array<{ response: { status: number; body: unknown }; clientOperationId: string }>;
      for (const providerModel of ["vendor:remote-fails", "vendor:save-fails"]) {
        const failureBody = { ...noReferenceBody, providerModel };
        const preview = await postJson(previewUrl, failureBody);
        assert.equal(preview.status, 200, JSON.stringify(preview.body));
        const clientOperationId = crypto.randomUUID();
        const response = await postJson(generateUrl, {
          ...failureBody,
          expectedPreviewDigest: preview.body?.data?.previewDigest,
          clientOperationId,
        });
        executionFailures.push({ response, clientOperationId });
      }
      for (const failure of executionFailures) {
        assert.equal(failure.response.status, 202, JSON.stringify(failure.response.body));
        await waitForOperationState(failure.clientOperationId, "failed_fatal");
        const failedTask = await runWithProjectStorage(PROJECT_UUID, () => activeDb("o_storyboardGenerationTask")
          .where({ clientOperationId: failure.clientOperationId })
          .first("status", "errorCode", "errorSummary"));
        assert.deepEqual(failedTask, {
          status: "failed_fatal",
          errorCode: "VENDOR_GENERATION_FAILED",
          errorSummary: "普通供应商生成失败，请检查模型配置或稍后重试",
        });
        assert.doesNotMatch(JSON.stringify(failedTask), /sk-secret|signed\.example|C:\\private/i);
      }
      capturedImage.length = 0;
      capturedVideo.length = 0;
      fs.rmSync(referencePath);
      const invalidBatch = await postJson(generateUrl, {
        items: [
          { ...noReferenceBody, expectedPreviewDigest: noReferencePreview.body?.data?.previewDigest },
          { ...boundVideoBody, expectedPreviewDigest: boundVideoPreview.body?.data?.previewDigest },
        ],
        paidBatchConfirmed: true,
        clientOperationId: crypto.randomUUID(),
      });
      assert.equal(invalidBatch.status, 400, JSON.stringify(invalidBatch.body));
      assert.deepEqual({ image: capturedImage, video: capturedVideo }, { image: [], video: [] });
      fs.writeFileSync(referencePath, referenceBytes);

      const persistentReference = {
        type: "image",
        media: {
          projectUuid: PROJECT_UUID,
          relativePath,
          md5: crypto.createHash("md5").update(referenceBytes).digest("hex"),
          size: referenceBytes.length,
        },
      };
      assert.deepEqual({ image: successfulImageCapture, video: successfulVideoCapture }, {
        image: [{
          prompt: "统一影像 近景胶片",
          referenceList: [persistentReference],
          size: "2K",
          aspectRatio: "1:1",
        }],
        video: [{
          duration: 9,
          resolution: "720p",
          aspectRatio: "9:16",
          prompt: [
            "统一动态",
            "",
            "【参考素材对应关系】",
            "图片1：角色“参考角色”",
            "",
            "全局前置提示词：",
            "风格：。",
            "镜头语言：。",
            "时代背景：。",
            "角色：参考角色。",
            "场景：。",
            "道具：。",
            "",
            "稳定跟拍",
          ].join("\n"),
          referenceList: [persistentReference],
          audio: false,
          mode: ["singleImage"],
        }],
      });

      // 中文注释：摘要内部绑定内容身份，但响应只允许安全白名单，禁止暴露路径与摘要素材。
      for (const result of [imageResult, videoResult]) {
        assert.deepEqual(Object.keys(result.preview.body?.data ?? {}).sort(), [
          "options",
          "previewDigest",
          "prompt",
          "providerModel",
          "referenceSummary",
          "routeKind",
        ]);
        assert.deepEqual(Object.keys(result.preview.body?.data?.options ?? {}).sort(), [
          "aspectRatio",
          "durationMs",
          "mode",
          "resolution",
        ]);
        assert.equal("references" in (result.preview.body?.data ?? {}), false);
        assert.match(String(result.preview.body?.data?.previewDigest ?? ""), /^[a-f0-9]{64}$/);
      }
      assert.deepEqual({
        generateKeys: Object.keys(imageResult.generated.body?.data?.[0] ?? {}).sort(),
        paidInvocations: preflightPaidInvocations,
        failureStatus: preflightFailure.status,
        failureTaskErrors: preflightTaskErrors,
        leakedSensitiveError: /sk-secret|signed\.example|C:\\private/i.test(failureText),
      }, {
        generateKeys: ["candidateUuid", "clientOperationId", "shotUuid", "status", "taskUuid"],
        paidInvocations: [],
        failureStatus: 202,
        failureTaskErrors: [
          {
            status: "failed_fatal",
            errorCode: "VENDOR_MEDIA_STAGING_FAILED",
            errorSummary: "参考素材暂存失败，请检查网络或稍后重试",
          },
          {
            status: "failed_fatal",
            errorCode: "VENDOR_MEDIA_STAGING_FAILED",
            errorSummary: "参考素材暂存失败，请检查网络或稍后重试",
          },
        ],
        leakedSensitiveError: false,
      });
    });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    Ai.Image = originalImage;
    Ai.Video = originalVideo;
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
