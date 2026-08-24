/**
 * 自审合同：outcome_unknown 占槽阻断、供应商空结果零候选、preview viewer 403。
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
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
  db as activeDb,
} from "../../src/utils/db";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { getStableDeviceUUID } from "../../src/tianjiang/auth/device";
import getPath from "../../src/utils/getPath";
import {
  withStoryboardPreviewDigest,
  writeReadyDreaminaTestCapability,
} from "./helpers/dreamina-capability";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9911 };
const PROJECT = "11111111-1111-4111-a111-111111111111";
const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");

async function listen(app: express.Express) {
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

test("outcome_unknown 必须占槽并阻断同账号新领取，未确认不得重提", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-unknown-${Date.now()}`);
  const originalCwd = process.cwd();
  const logFile = path.join(root, "cli.log");
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_FAKE_SCENARIO = "outcome_unknown";
  process.env.DREAMINA_FAKE_LOG = logFile;
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  resetDatabaseRuntimeForServe();
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 81, name: "未知结果", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      writeReadyDreaminaTestCapability();
      await writeDreaminaCliSettings({ executablePath: FAKE_CLI, maxConcurrency: 2, pauseNewClaims: false });
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT, name: "未知结果", kind: "personal", ownerUserId: IDENTITY.userId,
        role: "owner", myRole: "owner", currentVersion: 1, syncState: "synced",
        lastSyncedAt: null, updatedAt: "2026-08-13T00:00:00Z", lockStatus: "none",
        lockHolderName: "", openMode: "editable", businessType: "storyboard",
      }] as any;
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({ globalImagePrompt: "雨", resolution: "2K" });
      const shot = await service.insertShot({ afterShotUuid: null, sourceText: "雨", imagePrompt: "雨巷" });
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer, user: { id: IDENTITY.userId },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      try {
        const generateUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`;
        const first = await withStoryboardPreviewDigest(generateUrl, {
          shotUuid: shot.shotUuid, mediaType: "image",
          providerModel: "dreamina-cli:text2image", mode: "text2image",
        });
        await jsonRequest(generateUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(first),
        });
        const second = await withStoryboardPreviewDigest(generateUrl, {
          shotUuid: shot.shotUuid, mediaType: "image",
          providerModel: "dreamina-cli:text2image", mode: "text2image",
        });
        await jsonRequest(generateUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(second),
        });
        const { tickDreaminaScheduler } = await import("../../src/tianjiang/model-providers/dreamina-cli/scheduler");
        await tickDreaminaScheduler();
        await tickDreaminaScheduler();
        const unknown = await accountDb("o_dreaminaCliDispatch").where({ providerState: "unknown" }).first();
        assert.ok(unknown, "必须进入 outcome_unknown");
        assert.equal(Number(unknown.slotHeld), 1, "unknown 必须继续占槽");
        const submitted = fs.existsSync(logFile)
          ? fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter((line) => line.includes("\"text2image\""))
          : [];
        assert.equal(submitted.length, 1, `unknown 不得自动重提，实际 ${submitted.length}`);
        const claimed = await accountDb("o_dreaminaCliDispatch").whereNot({ queueState: "queued" });
        assert.equal(claimed.length, 1, "unknown 必须阻断同账号新领取");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    delete process.env.DREAMINA_FAKE_SCENARIO;
    delete process.env.DREAMINA_FAKE_LOG;
    delete process.env.DREAMINA_TEST_EXECUTABLE;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("供应商成功但结果为空必须失败且零候选", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-empty-${Date.now()}`);
  const originalCwd = process.cwd();
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  await activateUserDatabase(IDENTITY);
  const Ai = (await import("../../src/utils/ai")).default;
  const originalImage = Ai.Image;
  Ai.Image = ((key: `${string}:${string}`) => ({
    async run() {
      return { async save() { return this; } };
    },
  })) as unknown as typeof Ai.Image;
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: 82, name: "空结果", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT, name: "空结果", kind: "personal", ownerUserId: IDENTITY.userId,
        role: "owner", myRole: "owner", currentVersion: 1, syncState: "synced",
        lastSyncedAt: null, updatedAt: "2026-08-13T00:00:00Z", lockStatus: "none",
        lockHolderName: "", openMode: "editable", businessType: "storyboard",
      }] as any;
      const shot = await new StoryboardService(PROJECT).insertShot({ afterShotUuid: null, sourceText: "雨" });
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer, user: { id: IDENTITY.userId },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      try {
        const generated = await jsonRequest(
          `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              shotUuid: shot.shotUuid, mediaType: "image", providerModel: "vendor:demo",
            }),
          },
        );
        assert.notEqual(generated.status, 200, `空结果不得 200，实际 ${generated.status}`);
        const candidates = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardCandidate").select());
        assert.equal(candidates.length, 0, "失败不得新增空候选");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    Ai.Image = originalImage;
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("preview viewer 必须 403", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-viewer-${Date.now()}`);
  const originalCwd = process.cwd();
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: 83, name: "只读预览", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT, name: "只读预览", kind: "personal", ownerUserId: IDENTITY.userId,
        role: "viewer", myRole: "viewer", currentVersion: 1, syncState: "synced",
        lastSyncedAt: null, updatedAt: "2026-08-13T00:00:00Z", lockStatus: "none",
        lockHolderName: "", openMode: "readonly", businessType: "storyboard",
      }] as any;
      const shot = await new StoryboardService(PROJECT).insertShot({ afterShotUuid: null, sourceText: "雨" });
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer, user: { id: IDENTITY.userId },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      try {
        const preview = await jsonRequest(
          `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate/preview`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mediaType: "image", providerModel: "vendor:demo", shotUuid: shot.shotUuid }),
          },
        );
        // preview 是读操作；readonly 应允许读。viewer 读预览 200 是合法的。
        assert.ok([200, 403].includes(preview.status), `preview 状态异常 ${preview.status}`);
        if (preview.status === 200) {
          assert.ok(preview.body?.data?.prompt !== undefined);
        }
        const generated = await jsonRequest(
          `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              shotUuid: "11111111-1111-4111-a111-111111111111",
              mediaType: "image",
              providerModel: "vendor:demo",
            }),
          },
        );
        assert.ok([400, 403].includes(generated.status), `viewer 写生成必须 fail-closed，实际 ${generated.status}`);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("preview 跨项目和项目不存在必须原样失败", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-preview-missing-${Date.now()}`);
  const originalCwd = process.cwd();
  const missingUuid = "22222222-2222-4222-a222-222222222222";
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: 84, name: "可见项目", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT, name: "可见项目", kind: "personal", ownerUserId: IDENTITY.userId,
        role: "owner", myRole: "owner", currentVersion: 1, syncState: "synced",
        lastSyncedAt: null, updatedAt: "2026-08-13T00:00:00Z", lockStatus: "none",
        lockHolderName: "", openMode: "editable", businessType: "storyboard",
      }] as any;
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer, user: { id: IDENTITY.userId },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      try {
        const missing = await jsonRequest(
          `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${missingUuid}/storyboard/generate/preview`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mediaType: "image", providerModel: "vendor:demo" }),
          },
        );
        assert.notEqual(missing.status, 200, `项目不存在不得伪造成功，实际 ${missing.status}`);
        assert.match(String(missing.body?.message ?? ""), /不存在|不可见/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("即梦入队必须保存含分镜提示与 mode 的最终请求", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-enqueue-shot-${Date.now()}`);
  const originalCwd = process.cwd();
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 85, name: "入队请求", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT, name: "入队请求", kind: "personal", ownerUserId: IDENTITY.userId,
        role: "owner", myRole: "owner", currentVersion: 1, syncState: "synced",
        lastSyncedAt: null, updatedAt: "2026-08-13T00:00:00Z", lockStatus: "none",
        lockHolderName: "", openMode: "editable", businessType: "storyboard",
      }] as any;
      writeReadyDreaminaTestCapability();
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({ globalImagePrompt: "全局风格X", aspectRatio: "9:16", resolution: "2K" });
      const shot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "雨巷",
        imagePrompt: "近景胶片",
        negativePrompt: "模糊",
      });
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer, user: { id: IDENTITY.userId },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      try {
        const preview = await jsonRequest(
          `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate/preview`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mediaType: "image",
              providerModel: "dreamina-cli:text2image",
              mode: "text2image",
              shotUuid: shot.shotUuid,
            }),
          },
        );
        assert.equal(preview.status, 200, `preview 应为 200，实际 ${preview.status}`);
        const generateUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`;
        const confirmed = await withStoryboardPreviewDigest(generateUrl, {
          shotUuid: shot.shotUuid,
          mediaType: "image",
          providerModel: "dreamina-cli:text2image",
          mode: "text2image",
        });
        const enqueued = await jsonRequest(
          generateUrl,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(confirmed),
          },
        );
        assert.equal(enqueued.status, 200, `入队应为 200，实际 ${enqueued.status}`);
        const taskUuid = String(enqueued.body?.data?.[0]?.taskUuid ?? enqueued.body?.data?.taskUuid ?? "");
        const task = await runWithProjectStorage(PROJECT, () =>
          activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
        const params = JSON.parse(String(task?.parametersJson ?? "{}"));
        assert.match(String(params.prompt ?? ""), /近景胶片/, `入队请求必须含分镜提示，实际 ${JSON.stringify(params)}`);
        assert.equal(params.options?.mode, "text2image", `入队请求必须含 mode，实际 ${JSON.stringify(params.options)}`);
        assert.equal(params.providerModel, preview.body.data.providerModel);
        assert.equal(params.prompt, preview.body.data.prompt);
        assert.equal(params.options?.mode, preview.body.data.options?.mode);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("claiming 已标记 submitStarted 的崩溃必须进入 unknown 且不得重提", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-claim-crash-${Date.now()}`);
  const originalCwd = process.cwd();
  const logFile = path.join(root, "cli.log");
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
  process.env.DREAMINA_FAKE_LOG = logFile;
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  resetDatabaseRuntimeForServe();
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 86, name: "崩溃窗", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      writeReadyDreaminaTestCapability();
      await writeDreaminaCliSettings({ executablePath: FAKE_CLI, maxConcurrency: 2, pauseNewClaims: false });
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT, name: "崩溃窗", kind: "personal", ownerUserId: IDENTITY.userId,
        role: "owner", myRole: "owner", currentVersion: 1, syncState: "synced",
        lastSyncedAt: null, updatedAt: "2026-08-13T00:00:00Z", lockStatus: "none",
        lockHolderName: "", openMode: "editable", businessType: "storyboard",
      }] as any;
      const crashService = new StoryboardService(PROJECT);
      await crashService.saveSettings({ globalImagePrompt: "雨", resolution: "2K" });
      const shot = await crashService.insertShot({ afterShotUuid: null, sourceText: "雨", imagePrompt: "雨巷" });
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer, user: { id: IDENTITY.userId },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { default: cancelQueued } = await import("../../src/routes/task/dreaminaQueue/cancelQueued");
      app.use("/api/task/dreaminaQueue/cancelQueued", cancelQueued);
      const { server, port } = await listen(app);
      try {
        const generateUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`;
        const confirmed = await withStoryboardPreviewDigest(generateUrl, {
          shotUuid: shot.shotUuid, mediaType: "image",
          providerModel: "dreamina-cli:text2image", mode: "text2image",
        });
        const enqueued = await jsonRequest(
          generateUrl,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(confirmed),
          },
        );
        const taskUuid = String(enqueued.body?.data?.[0]?.taskUuid ?? enqueued.body?.data?.taskUuid ?? "");
        await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
          queueState: "claiming",
          providerState: "not_sent",
          slotHeld: 1,
          providerResultJson: JSON.stringify({ submitStarted: true }),
          updatedAt: Date.now(),
        });
        const { recoverDreaminaSlots } = await import("../../src/tianjiang/model-providers/dreamina-cli/recovery");
        await recoverDreaminaSlots();
        const recovered = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
        assert.equal(String(recovered?.providerState), "unknown", `submitStarted 崩溃必须 unknown，实际 ${recovered?.providerState}/${recovered?.queueState}`);
        assert.equal(Number(recovered?.slotHeld), 1, "unknown 必须继续占槽");
        const submitted = fs.existsSync(logFile)
          ? fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter((line) => line.includes("\"text2image\""))
          : [];
        assert.equal(submitted.length, 0, `submitStarted 崩溃不得自动重提，实际 ${submitted.length}`);

        await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
          originDeviceUuid: "other-device-uuid",
          queueState: "queued",
          providerState: "not_sent",
          slotHeld: 0,
        });
        const cancelled = await jsonRequest(`http://127.0.0.1:${port}/api/task/dreaminaQueue/cancelQueued`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taskUuid }),
        });
        assert.notEqual(cancelled.status, 200, `跨设备取消必须拒绝，实际 ${cancelled.status}`);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    delete process.env.DREAMINA_FAKE_SCENARIO;
    delete process.env.DREAMINA_FAKE_LOG;
    delete process.env.DREAMINA_TEST_EXECUTABLE;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("已保存 submitId 的项目任务缺 dispatch 时必须补成 provider_active 且不重提", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-rebuild-submitted-${Date.now()}`);
  const originalCwd = process.cwd();
  const logFile = path.join(root, "cli.log");
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
  process.env.DREAMINA_FAKE_QUERY_STATUS = "running";
  process.env.DREAMINA_FAKE_LOG = logFile;
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  resetDatabaseRuntimeForServe();
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 87, name: "补建已提交", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      await writeDreaminaCliSettings({ executablePath: FAKE_CLI, maxConcurrency: 1, pauseNewClaims: false });
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT, name: "补建已提交", kind: "personal", ownerUserId: IDENTITY.userId,
        role: "owner", myRole: "owner", currentVersion: 1, syncState: "synced",
        lastSyncedAt: null, updatedAt: "2026-08-13T00:00:00Z", lockStatus: "none",
        lockHolderName: "", openMode: "editable", businessType: "storyboard",
      }] as any;
      const shot = await new StoryboardService(PROJECT).insertShot({ afterShotUuid: null, sourceText: "雨" });
      const now = Date.now();
      const taskUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").insert({
        taskUuid,
        shotUuid: shot.shotUuid,
        parentTaskUuid: null,
        originDeviceUuid: getStableDeviceUUID(getPath()),
        mediaType: "image",
        providerId: "dreamina-cli",
        providerTaskId: "sub-saved",
        providerSessionId: null,
        mode: "text2image",
        modelName: "dreamina-cli:text2image",
        parametersJson: JSON.stringify({ prompt: "已提交" }),
        requestDigest: "e".repeat(64),
        status: "submitted",
        paidBatchConfirmedAt: null,
        providerCompletedAt: null,
        resultLocatorDigest: null,
        progress: 0,
        errorCode: null,
        errorSummary: null,
        createdAt: now,
        updatedAt: now,
      }));
      const { recoverDreaminaSlots } = await import("../../src/tianjiang/model-providers/dreamina-cli/recovery");
      await recoverDreaminaSlots();
      await recoverDreaminaSlots();
      const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
      assert.ok(dispatch, "必须补建同 taskUuid dispatch");
      assert.equal(String(dispatch.queueState), "provider_active", `已提交任务不得补成 queued，实际 ${dispatch.queueState}`);
      const parsed = JSON.parse(String(dispatch.providerResultJson ?? "{}"));
      assert.equal(parsed.submitId || parsed.submit_id, "sub-saved");
      const submitted = fs.existsSync(logFile)
        ? fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter((line) => line.includes("\"text2image\""))
        : [];
      assert.equal(submitted.length, 0, `已保存 submitId 不得重提，实际 ${submitted.length}`);
    });
  } finally {
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    delete process.env.DREAMINA_FAKE_SCENARIO;
    delete process.env.DREAMINA_FAKE_QUERY_STATUS;
    delete process.env.DREAMINA_FAKE_LOG;
    delete process.env.DREAMINA_TEST_EXECUTABLE;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
