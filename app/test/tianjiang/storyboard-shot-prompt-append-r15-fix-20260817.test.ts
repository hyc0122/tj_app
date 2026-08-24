/**
 * R15-fix RED：自定义模板未声明 {{shot_prompt}} 时，
 * 非空分镜提示词必须在渲染结果末尾只追加一次。
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

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 1516 };
const PROJECT = "f1516151-1616-4161-a161-161616161616";
const ROLE = "f1516151-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SCENE = "f1516151-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const TOOL = "f1516151-cccc-4ccc-8ccc-ccccccccccc1";

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R15-fix",
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
  run: (input: { port: number; shotUuid: string; emptyShotUuid: string }) => Promise<void>,
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
        id: 1516, name: "R15-fix 追加", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
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
          id: 89, name: "国风夜戏", label: "国风夜戏", prompt: "写实短剧电影感，浅景深", fileUrl: "",
        });
        await activeDb("o_project").where({ id: 1516 }).update({
          artStyle: "国风夜戏",
          type: "写实短剧电影感，浅景深",
        });
      });
      const emptyShot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "空提示词镜头",
        durationMs: 5000,
      });
      const boundShot = await service.insertShot({
        afterShotUuid: emptyShot.shotUuid,
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
      writeImage("files/images/role-r15fix.png", "r15-fix-role");
      writeImage("files/images/scene-r15fix.png", "r15-fix-scene");
      writeImage("files/images/tool-r15fix.png", "r15-fix-tool");
      writeImage("files/audios/role-r15fix.mp3", "r15-fix-audio");
      await runWithProjectStorage(PROJECT, async () => {
        await activeDb("o_image").insert([
          { id: 611, filePath: "files/images/role-r15fix.png", type: 1, assetsId: 711, state: "完成" },
          { id: 612, filePath: "files/images/scene-r15fix.png", type: 1, assetsId: 712, state: "完成" },
          { id: 613, filePath: "files/images/tool-r15fix.png", type: 1, assetsId: 713, state: "完成" },
          { id: 614, filePath: "files/audios/role-r15fix.mp3", type: 1, assetsId: 714, state: "完成" },
        ]);
        await activeDb("o_assets").insert([
          { id: 711, name: "姜晓棠", type: "role", describe: "女主，青衫", imageId: 611, assetUuid: ROLE, projectId: 1516 },
          { id: 712, name: "青岚码头", type: "scene", describe: "夜色石阶", imageId: 612, assetUuid: SCENE, projectId: 1516 },
          { id: 713, name: "油纸伞", type: "tool", describe: "", imageId: 613, assetUuid: TOOL, projectId: 1516 },
          { id: 714, name: "姜晓棠音色", type: "audio", describe: "", imageId: 614, assetUuid: crypto.randomUUID(), projectId: 1516 },
        ]);
        if (await activeDb.schema.hasTable("o_assetsRole2Audio")) {
          await activeDb("o_assetsRole2Audio").insert({ assetsRoleId: 711, assetsAudioId: 714 });
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
          user: { id: IDENTITY.userId, username: "r15fix" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      try {
        await run({ port, shotUuid: boundShot.shotUuid, emptyShotUuid: emptyShot.shotUuid });
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

async function useTemplate(port: number, content: string): Promise<void> {
  const created = await jsonRequest(templatesUrl(port), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `r15-fix-${crypto.randomUUID().slice(0, 8)}`, content }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const templateId = created.body?.data?.id;
  assert.ok(templateId);
  const applied = await jsonRequest(`${templatesUrl(port)}/${encodeURIComponent(String(templateId))}/use`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

test("自定义模板不含 shot_prompt 时必须把非空分镜提示词追加到末尾一次", async () => {
  await withRuntime("r15-fix-append-red", async ({ port, shotUuid }) => {
    await useTemplate(port, "风格：{{style}}。\n角色：{{roles}}。\n未知：{{unknown_token}}。");
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
    assert.match(prompt, /风格：写实短剧电影感，浅景深。/);
    assert.match(prompt, /角色：姜晓棠 女主，青衫。/);
    assert.doesNotMatch(prompt, /\{\{unknown_token\}\}/);
    assert.doesNotMatch(prompt, /\{\{shot_prompt\}\}/);
    assert.doesNotMatch(prompt, /变量来源说明/);
    assert.doesNotMatch(prompt, /f1516151-aaaa/);
    assert.equal(countOccurrences(prompt, "稳定跟拍角色走上石阶。"), 1);
    assert.ok(
      prompt.endsWith("\n\n稳定跟拍角色走上石阶。"),
      `缺少末尾一次追加，实际=${JSON.stringify(prompt)}`,
    );
  });
});

test("模板已含 shot_prompt 时只能原位出现一次，且 preview 与正式入队一致", async () => {
  await withRuntime("r15-fix-once-red", async ({ port, shotUuid }) => {
    await useTemplate(port, "风格：{{style}}。\n{{ shot_prompt }}");
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
    assert.match(previewPrompt, /【参考素材对应关系】/);
    assert.match(previewPrompt, /图片2：场景“青岚码头”/);
    assert.match(previewPrompt, /音频1：角色“姜晓棠”的音色/);
    assert.equal(countOccurrences(previewPrompt, "稳定跟拍角色走上石阶。"), 1);
    assert.equal(previewPrompt.includes("\n\n稳定跟拍角色走上石阶。\n\n稳定跟拍角色走上石阶。"), false);
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
    const stored = JSON.parse(String(task?.parametersJson ?? "{}")) as { prompt?: string };
    assert.equal(String(stored.prompt ?? ""), previewPrompt);
  });
});

test("shot_prompt 为空时不得追加无意义内容", async () => {
  await withRuntime("r15-fix-empty-red", async ({ port, emptyShotUuid }) => {
    await useTemplate(port, "风格：{{style}}。");
    const preview = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: emptyShotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "text2video",
        durationMs: 5000,
        aspectRatio: "9:16",
      }),
    });
    assert.equal(preview.status, 200);
    const prompt = String(preview.body?.data?.prompt ?? "");
    assert.match(prompt, /风格：写实短剧电影感，浅景深。/);
    assert.equal(prompt.includes("undefined"), false);
    assert.equal(prompt.includes("null"), false);
    assert.doesNotMatch(prompt, /\n\n$/);
    assert.doesNotMatch(prompt, /\{\{/);
  });
});
