/**
 * R15 RED：最终视频提示词必须走唯一服务端渲染器；
 * 3/31 秒必须在任何 operation 前拒绝；模板必须能保存并用于当前项目。
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
import { invalidateDreaminaCapabilityCache } from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import { writeReadyDreaminaTestCapability } from "./helpers/dreamina-capability";
import { stopDreaminaSchedulerLoop } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 1515 };
const PROJECT = "f1515151-1515-4151-a151-151515151151";
const ROLE = "f1515151-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SCENE = "f1515151-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const TOOL = "f1515151-cccc-4ccc-8ccc-ccccccccccc1";

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R15",
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

async function jsonRequest(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: response.status, body };
}

async function withRuntime(
  name: string,
  run: (input: { port: number; shotUuid: string; textShotUuid: string }) => Promise<void>,
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  invalidateDreaminaCapabilityCache();
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: 1515, name: "R15 提示词", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow()] as any;
      stopDreaminaSchedulerLoop();
      writeReadyDreaminaTestCapability();
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({
        globalVideoPrompt: "统一夜戏光影。",
        aspectRatio: "9:16",
        durationMs: 5000,
        resolution: "720p",
      });
      await runWithProjectStorage(PROJECT, async () => {
        await activeDb("o_artStyle").insert({
          id: 88, name: "国风夜戏", label: "国风夜戏", prompt: "写实短剧电影感，浅景深", fileUrl: "",
        });
        await activeDb("o_project").where({ id: 1515 }).update({
          artStyle: "国风夜戏",
          type: "写实短剧电影感，浅景深",
        });
      });
      const textShot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "码头远景",
        videoPrompt: "黄晚棠从人群中挤到前面。",
        durationMs: 5000,
      });
      const boundShot = await service.insertShot({
        afterShotUuid: textShot.shotUuid,
        sourceText: "角色近景",
        visualDescription: "只有画面描述时才回退。",
        videoPrompt: "稳定跟拍角色走上石阶。",
        durationMs: 5000,
      });
      const context = currentUserStorage();
      assert.ok(context);
      const projectRoot = projectDirectory(getPath(), PROJECT, context.segment);
      const writeImage = (relative: string, bytes: string) => {
        const absolute = path.join(projectRoot, ...relative.split("/"));
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, bytes);
      };
      writeImage("files/images/role-r15.png", "r15-role");
      writeImage("files/images/scene-r15.png", "r15-scene");
      writeImage("files/images/tool-r15.png", "r15-tool");
      writeImage("files/audios/role-r15.mp3", "r15-audio");
      await runWithProjectStorage(PROJECT, async () => {
        await activeDb("o_image").insert([
          { id: 601, filePath: "files/images/role-r15.png", type: 1, assetsId: 701, state: "完成" },
          { id: 602, filePath: "files/images/scene-r15.png", type: 1, assetsId: 702, state: "完成" },
          { id: 603, filePath: "files/images/tool-r15.png", type: 1, assetsId: 703, state: "完成" },
          { id: 604, filePath: "files/audios/role-r15.mp3", type: 1, assetsId: 704, state: "完成" },
        ]);
        await activeDb("o_assets").insert([
          { id: 701, name: "姜晓棠", type: "role", describe: "女主，青衫", imageId: 601, assetUuid: ROLE, projectId: 1515 },
          { id: 702, name: "青岚码头", type: "scene", describe: "夜色石阶", imageId: 602, assetUuid: SCENE, projectId: 1515 },
          { id: 703, name: "油纸伞", type: "tool", describe: "", imageId: 603, assetUuid: TOOL, projectId: 1515 },
          { id: 704, name: "姜晓棠音色", type: "audio", describe: "", imageId: 604, assetUuid: crypto.randomUUID(), projectId: 1515 },
        ]);
        if (await activeDb.schema.hasTable("o_assetsRole2Audio")) {
          await activeDb("o_assetsRole2Audio").insert({ assetsRoleId: 701, assetsAudioId: 704 });
        }
      });
      await service.bindAsset(boundShot.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: ROLE, assetType: "role", relationRole: "appear",
      });
      await service.bindAsset(boundShot.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: SCENE, assetType: "scene", relationRole: "appear",
      });
      await service.bindAsset(boundShot.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: TOOL, assetType: "tool", relationRole: "appear",
      });
      const app = express();
      app.use(express.json({ limit: "4mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r15" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      try {
        await run({ port, shotUuid: boundShot.shotUuid, textShotUuid: textShot.shotUuid });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    stopDreaminaSchedulerLoop();
    invalidateDreaminaCapabilityCache();
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

function templatesUrl(port: number) {
  return `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/video-templates`;
}

test("当前最终提示词缺少变量渲染和引用关系，且未使用名称+描述", async () => {
  await withRuntime("r15-prompt-red", async ({ port, shotUuid }) => {
    const preview = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "auto",
        durationMs: 5000,
        aspectRatio: "9:16",
      }),
    });
    assert.equal(preview.status, 200);
    const prompt = String(preview.body?.data?.prompt ?? "");
    assert.match(prompt, /【参考素材对应关系】/);
    assert.match(prompt, /图片1：角色“姜晓棠”/);
    assert.match(prompt, /图片2：场景“青岚码头”/);
    assert.match(prompt, /图片3：道具“油纸伞”/);
    assert.match(prompt, /音频1：角色“姜晓棠”的音色/);
    assert.match(prompt, /统一夜戏光影。/);
    assert.match(prompt, /风格：写实短剧电影感，浅景深。/);
    assert.match(prompt, /角色：姜晓棠 女主，青衫。/);
    assert.match(prompt, /场景：青岚码头 夜色石阶。/);
    assert.match(prompt, /道具：油纸伞。/);
    assert.match(prompt, /稳定跟拍角色走上石阶。/);
    assert.doesNotMatch(prompt, /变量来源说明/);
    assert.doesNotMatch(prompt, /\{\{style\}\}/);
    assert.doesNotMatch(prompt, /f1515151-aaaa/);
  });
});

test("preview 与正式请求提示词必须一致；当前缺少 canonical 模板", async () => {
  await withRuntime("r15-preview-generate-red", async ({ port, shotUuid }) => {
    const payload = {
      shotUuid,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "auto",
      durationMs: 5000,
      aspectRatio: "9:16",
    };
    const preview = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(preview.status, 200);
    const previewPrompt = String(preview.body?.data?.prompt ?? "");
    assert.match(previewPrompt, /全局前置提示词：/);
    assert.match(previewPrompt, /【参考素材对应关系】/);
    assert.doesNotMatch(previewPrompt, /变量来源说明不得进入最终请求/);
    const generated = await jsonRequest(generateUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...payload,
        expectedPreviewDigest: preview.body?.data?.previewDigest,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    const task = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardGenerationTask").orderBy("createdAt", "desc").first());
    assert.ok(task);
    const stored = JSON.parse(String(task?.parametersJson ?? "{}")) as { prompt?: string; references?: unknown[] };
    assert.equal(String(stored.prompt ?? ""), previewPrompt);
    assert.equal(Array.isArray(stored.references), true);
    assert.equal(stored.references?.length, 4);
  });
});

test("视频模板无法保存并用于当前项目", async () => {
  await withRuntime("r15-template-red", async ({ port }) => {
    const listed = await jsonRequest(templatesUrl(port));
    assert.equal(listed.status, 200);
    const templates = listed.body?.data?.templates ?? listed.body?.data ?? [];
    assert.ok(Array.isArray(templates));
    assert.ok(templates.some((item: { type?: string }) => item.type === "storyboardVideoSystemTemplate"));
    const created = await jsonRequest(templatesUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "码头夜戏",
        content: "风格：{{style}}。\n{{shot_prompt}}",
      }),
    });
    assert.equal(created.status, 200);
    const templateId = created.body?.data?.id;
    assert.ok(templateId);
    const applied = await jsonRequest(`${templatesUrl(port)}/${encodeURIComponent(String(templateId))}/use`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(applied.status, 200);
  });
});

test("3/31 秒未在写入前拒绝，17 秒必须能原值进入 preview", async () => {
  await withRuntime("r15-duration-red", async ({ port, textShotUuid }) => {
    const tooShort = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: textShotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "text2video",
        durationMs: 3000,
        aspectRatio: "9:16",
      }),
    });
    const tooLong = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: textShotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "text2video",
        durationMs: 31_000,
        aspectRatio: "9:16",
      }),
    });
    const seventeen = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: textShotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "text2video",
        durationMs: 17_000,
        aspectRatio: "9:16",
      }),
    });
    assert.equal(seventeen.status, 200);
    assert.equal(seventeen.body?.data?.options?.durationMs, 17_000);
    const seventeenGenerate = await jsonRequest(generateUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: textShotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "text2video",
        durationMs: 17_000,
        aspectRatio: "9:16",
        expectedPreviewDigest: seventeen.body?.data?.previewDigest,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.equal(seventeenGenerate.status, 200, JSON.stringify(seventeenGenerate.body));
    const stored = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardGenerationTask").orderBy("createdAt", "desc").first());
    assert.equal(JSON.parse(String(stored?.parametersJson ?? "{}"))?.options?.durationMs, 17_000);
    const rejectedShort = await jsonRequest(generateUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: textShotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "text2video",
        durationMs: 3000,
        aspectRatio: "9:16",
        expectedPreviewDigest: seventeen.body?.data?.previewDigest,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    const rejectedLong = await jsonRequest(generateUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: textShotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "text2video",
        durationMs: 31_000,
        aspectRatio: "9:16",
        expectedPreviewDigest: seventeen.body?.data?.previewDigest,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.notEqual(tooShort.status, 200);
    assert.notEqual(tooLong.status, 200);
    assert.notEqual(rejectedShort.status, 200);
    assert.notEqual(rejectedLong.status, 200);
    assert.equal((await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").select())).length, 1);
    assert.match(String(tooShort.body?.message ?? ""), /4|时长/);
    assert.match(String(tooLong.body?.message ?? ""), /30|时长/);
  });
});
