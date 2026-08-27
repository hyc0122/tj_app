/**
 * R20 RED：普通供应商失败必须按 prepare/stage/execute 分阶；
 * 即梦用户确认摘要不得因 preview/execute 的 capabilityFields 元数据漂移。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import Ai from "../../src/utils/ai";
import {
  accountDb,
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
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import {
  createStoryboardGenerationPreviewDigest,
  type FinalGenerationRequest,
} from "../../src/tianjiang/storyboard/storyboard-generation-service";
import { createSafeVendorPhaseError } from "../../src/tianjiang/storyboard/vendor-generation-safety";
import { writeReadyDreaminaTestCapability } from "./helpers/dreamina-capability";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2020 };
const PROJECT = "a0202020-2020-4020-a020-202020202020";
const PUBLISHED_TEXT2VIDEO = [
  "--prompt",
  "--duration",
  "--ratio",
  "--video_resolution",
  "--model_version",
] as const;
const LIVE_TEXT2VIDEO = [...PUBLISHED_TEXT2VIDEO, "--probe_extra"] as const;

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

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R20",
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

function leakFree(serialized: string): void {
  assert.equal(serialized.includes("sk-secret"), false);
  assert.equal(serialized.includes("signed.example"), false);
  assert.equal(/[A-Za-z]:\\/.test(serialized), false);
  assert.equal(serialized.includes("SELECT "), false);
  assert.equal(/at\s+\S+\.(ts|js)/i.test(serialized), false);
}

async function countRows(table: string): Promise<number> {
  return runWithProjectStorage(PROJECT, async () => {
    if (!await activeDb.schema.hasTable(table)) return 0;
    const rows = await activeDb(table).select();
    return rows.length;
  });
}

async function waitForTaskState(
  clientOperationId: string,
  expected: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const task = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask")
      .where({ clientOperationId })
      .first("status", "errorCode", "errorSummary"));
    if (String(task?.status ?? "") === expected) return task as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`任务 ${clientOperationId} 未在期限内进入 ${expected}`);
}

function writeReadyLiveText2Video(): void {
  const modes = Object.fromEntries(DREAMINA_MODES.map((mode) => [mode, {
    enabled: true,
    fields: mode === "text2video" ? [...LIVE_TEXT2VIDEO] : ["--prompt"],
  }])) as unknown as DreaminaCapabilitySnapshot["modes"];
  const snapshot: DreaminaCapabilitySnapshot = {
    installed: true,
    version: "r20-live",
    probedAt: Date.now(),
    loggedIn: true,
    modes,
    capabilities: [...DREAMINA_MODES],
    videoModels: [...DREAMINA_VIDEO_MODELS],
  };
  writeDreaminaCapabilityCache({ state: "ready", snapshot, checkedAt: Date.now() });
}

test("用户确认摘要不得因 capabilityFields 元数据变化而漂移，真实请求变化仍必须失配", () => {
  const baseRequest: FinalGenerationRequest = {
    providerModel: "dreamina-cli:seedance2.0fast",
    prompt: "统一夜戏光影，禁止现代招牌。",
    references: [{
      assetUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      relativePath: "files/images/a.png",
      mediaType: "image",
      md5: "a".repeat(32),
      size: 12,
    }],
    options: { aspectRatio: "9:16", resolution: "720p", durationMs: 5000, mode: "text2video" },
    capabilityFields: [...PUBLISHED_TEXT2VIDEO],
  };
  const onlyFieldsChanged: FinalGenerationRequest = {
    ...baseRequest,
    capabilityFields: [...LIVE_TEXT2VIDEO],
  };
  const promptChanged: FinalGenerationRequest = {
    ...baseRequest,
    prompt: "镜头已改，必须重新预览。",
  };
  const vendorWithoutFields: FinalGenerationRequest = {
    providerModel: "tianjiang:doubao-seedance-1-0-pro-fast",
    prompt: "普通供应商提示词",
    references: [],
    options: { aspectRatio: "9:16", resolution: "720p", durationMs: 5000, mode: "text2video" },
  };
  const vendorPolluted: FinalGenerationRequest = {
    ...vendorWithoutFields,
    capabilityFields: [...PUBLISHED_TEXT2VIDEO],
  };
  const sameUserConfirm = {
    projectUuid: PROJECT,
    shotUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    mediaType: "video" as const,
  };
  assert.equal(
    createStoryboardGenerationPreviewDigest({ ...sameUserConfirm, request: baseRequest }),
    createStoryboardGenerationPreviewDigest({ ...sameUserConfirm, request: onlyFieldsChanged }),
  );
  assert.notEqual(
    createStoryboardGenerationPreviewDigest({ ...sameUserConfirm, request: baseRequest }),
    createStoryboardGenerationPreviewDigest({ ...sameUserConfirm, request: promptChanged }),
  );
  assert.equal(
    createStoryboardGenerationPreviewDigest({ ...sameUserConfirm, request: vendorWithoutFields }),
    createStoryboardGenerationPreviewDigest({ ...sameUserConfirm, request: vendorPolluted }),
  );
});

test("普通供应商 prepare/stage/execute 必须受理后写回分阶码，prepare/stage 零 execute", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `r20-vendor-phase-${process.pid}-${crypto.randomUUID()}`);
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  const originalVideo = Ai.Video;
  const counts = { prepare: 0, stage: 0, execute: 0 };
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);

  Ai.Video = ((key: `${string}:${string}`) => ({
    async prepare() {
      if (key.endsWith(":prepare-fails")) {
        throw createSafeVendorPhaseError("prepare");
      }
      return {
        async stage() {
          if (key.endsWith(":stage-fails")) {
            throw createSafeVendorPhaseError("stage");
          }
          return {
            async execute() {
              counts.execute += 1;
              if (key.endsWith(":execute-fails")) {
                throw createSafeVendorPhaseError("execute");
              }
              return {
                async save(target: string) {
                  fs.mkdirSync(path.dirname(target), { recursive: true });
                  fs.writeFileSync(target, "vendor-ok");
                  return this;
                },
              };
            },
          };
        },
      };
    },
  })) as unknown as typeof Ai.Video;

  let server: http.Server | undefined;
  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 2020,
        name: "R20 供应商分阶",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await accountDb("o_vendorConfig").insert({
        id: "loopback",
        inputValues: "{}",
        models: JSON.stringify([
          { modelName: "prepare-fails", name: "预备失败模型", type: "video" },
          { modelName: "stage-fails", name: "暂存失败模型", type: "video" },
          { modelName: "execute-fails", name: "执行失败模型", type: "video" },
        ]),
        enable: 1,
      }).onConflict("id").merge();
      syncCoordinator.listProjects = () => [catalogRow()] as never;
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({ resolution: "720p", aspectRatio: "9:16", durationMs: 5000 });
      const shot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "夜戏",
        videoPrompt: "缓慢推进",
        durationMs: 5000,
      });
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r20-vendor" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      await prepareProjectDatabase(PROJECT);
      const listening = await listen(app);
      server = listening.server;
      const generateUrl = `http://127.0.0.1:${listening.port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`;
      const previewUrl = `${generateUrl}/preview`;
      const base = {
        shotUuid: shot.shotUuid,
        mediaType: "video",
        mode: "text2video",
        durationMs: 5000,
        aspectRatio: "9:16",
      };

      const submit = async (providerModel: string) => {
        const preview = await postJson(previewUrl, { ...base, providerModel });
        assert.equal(preview.status, 200, JSON.stringify(preview.body));
        const beforeExecute = counts.execute;
        const clientOperationId = crypto.randomUUID();
        const generated = await postJson(generateUrl, {
          ...base,
          providerModel,
          expectedPreviewDigest: preview.body?.data?.previewDigest,
          clientOperationId,
        });
        assert.equal(generated.status, 202, JSON.stringify(generated.body));
        assert.equal(generated.body?.data?.tasks?.[0]?.status, "queued", JSON.stringify(generated.body));
        const task = await waitForTaskState(clientOperationId, "failed_fatal");
        return { generated, task, executeDelta: counts.execute - beforeExecute };
      };

      const prepareFail = await submit("loopback:prepare-fails");
      leakFree(JSON.stringify(prepareFail.generated.body));
      assert.equal(prepareFail.task.errorCode, "VENDOR_PREPARE_FAILED");
      assert.equal(prepareFail.executeDelta, 0);
      assert.equal(await countRows("o_storyboardGenerationOperation"), 1);
      assert.equal(await countRows("o_storyboardGenerationTask"), 1);
      assert.equal(await countRows("o_dreaminaCliDispatch"), 0);

      const stageFail = await submit("loopback:stage-fails");
      leakFree(JSON.stringify(stageFail.generated.body));
      assert.equal(stageFail.task.errorCode, "VENDOR_MEDIA_STAGING_FAILED");
      assert.equal(stageFail.executeDelta, 0);
      assert.equal(await countRows("o_storyboardGenerationOperation"), 2);
      assert.equal(await countRows("o_storyboardGenerationTask"), 2);
      assert.equal(await countRows("o_dreaminaCliDispatch"), 0);

      const executeFail = await submit("loopback:execute-fails");
      leakFree(JSON.stringify(executeFail.generated.body));
      assert.equal(executeFail.task.errorCode, "VENDOR_GENERATION_FAILED");
      assert.ok(executeFail.executeDelta >= 1);
      assert.equal(await countRows("o_storyboardGenerationOperation"), 3);
      assert.equal(await countRows("o_storyboardGenerationTask"), 3);
    });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    Ai.Video = originalVideo;
    syncCoordinator.listProjects = originalList;
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("即梦 preview 发布态字段与 execute 实时字段不同时，相同用户确认内容不得 STALE", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `r20-dreamina-digest-${process.pid}-${crypto.randomUUID()}`);
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
        id: 2021,
        name: "R20 即梦摘要",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow()] as never;
      stopDreaminaSchedulerLoop();
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({
        globalVideoPrompt: "统一夜戏光影，禁止现代招牌。",
        aspectRatio: "9:16",
        durationMs: 5000,
        resolution: "720p",
      });
      const shot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "角色近景",
        videoPrompt: "稳定跟拍。",
        durationMs: 5000,
      });
      const app = express();
      app.use(express.json({ limit: "2mb" }));
      app.use((_req, _res, next) => {
        enterUserStorage(IDENTITY);
        (_req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r20-dreamina" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      await prepareProjectDatabase(PROJECT);
      const { server, port } = await listen(app);
      try {
        const payload = {
          shotUuid: shot.shotUuid,
          mediaType: "video",
          providerModel: "dreamina-cli:seedance2.0fast",
          mode: "text2video",
          durationMs: 5000,
          aspectRatio: "9:16",
        };
        invalidateDreaminaCapabilityCache();
        const preview = await postJson(
          `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate/preview`,
          payload,
        );
        assert.equal(preview.status, 200, JSON.stringify(preview.body));
        const digest = String(preview.body?.data?.previewDigest ?? "");
        assert.match(digest, /^[a-f0-9]{64}$/);
        writeReadyLiveText2Video();
        const generated = await postJson(
          `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`,
          {
            ...payload,
            expectedPreviewDigest: digest,
            clientOperationId: crypto.randomUUID(),
          },
        );
        assert.notEqual(generated.body?.code, "STORYBOARD_PREVIEW_STALE", JSON.stringify(generated.body));
        assert.equal(generated.status, 200, JSON.stringify(generated.body));
        const task = await runWithProjectStorage(PROJECT, () =>
          activeDb("o_storyboardGenerationTask").orderBy("createdAt", "desc").first());
        const stored = JSON.parse(String(task?.parametersJson ?? "{}")) as { capabilityFields?: string[] };
        assert.deepEqual(stored.capabilityFields, [...LIVE_TEXT2VIDEO]);
        assert.equal(JSON.stringify(stored).includes("--probe_extra"), true);

        const stalePrompt = await postJson(
          `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`,
          {
            ...payload,
            durationMs: 6000,
            expectedPreviewDigest: digest,
            clientOperationId: crypto.randomUUID(),
          },
        );
        assert.equal(stalePrompt.status, 409);
        assert.equal(stalePrompt.body?.code, "STORYBOARD_PREVIEW_STALE");
        assert.equal(stalePrompt.body?.message, "最终请求已变化，请重新预览确认");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    stopDreaminaSchedulerLoop();
    invalidateDreaminaCapabilityCache();
    writeReadyDreaminaTestCapability();
    invalidateDreaminaCapabilityCache();
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
