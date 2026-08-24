/**
 * R19 RED：全局提示词合成、父子音频引用、preview 安全摘要、generate 稳定错误码。
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
  prepareProjectDatabase,
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

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 1919 };
const PROJECT = "f1919191-1919-4191-a191-191919191919";
const LEGACY_PROJECT_ID = 1919;
const ROLE = "f1919191-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SCENE = "f1919191-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const TOOL = "f1919191-cccc-4ccc-8ccc-ccccccccccc1";
const PARENT_AUDIO = "f1919191-dddd-4ddd-8ddd-ddddddddddd1";
const CHILD_AUDIO = "f1919191-eeee-4eee-8eee-eeeeeeeeeee1";
const GLOBAL_PROMPT = "统一夜戏光影，禁止现代招牌。";
const LEAK_PATH = "C:\\Users\\alice\\projects\\secret.sqlite";

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R19",
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
  return { status: response.status, body, text };
}

async function withRuntime(
  name: string,
  options: { capability: "ready" | "none"; globalVideoPrompt?: string; omitAudioFile?: boolean; voiceEnabled?: boolean },
  run: (input: { port: number; shotUuid: string; service: StoryboardService }) => Promise<void>,
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
        id: LEGACY_PROJECT_ID,
        name: "R19 提交失败",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow()] as any;
      stopDreaminaSchedulerLoop();
      if (options.capability === "ready") writeReadyDreaminaTestCapability();
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({
        globalVideoPrompt: options.globalVideoPrompt ?? GLOBAL_PROMPT,
        aspectRatio: "9:16",
        durationMs: 5000,
        resolution: "720p",
        videoPromptTemplateContent: "风格：{{style}}。\n{{shot_prompt}}",
      });
      await runWithProjectStorage(PROJECT, async () => {
        await activeDb("o_project").where({ id: LEGACY_PROJECT_ID }).update({ type: "玄幻" });
      });
      const shot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "角色近景",
        videoPrompt: "稳定跟拍角色走上石阶。",
        durationMs: 5000,
      });
      const context = currentUserStorage();
      assert.ok(context);
      const projectRoot = projectDirectory(getPath(), PROJECT, context.segment);
      const writeRel = (relative: string, bytes: string) => {
        const absolute = path.join(projectRoot, ...relative.split("/"));
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, bytes);
      };
      writeRel("files/images/role-r19.png", "r19-role");
      writeRel("files/images/scene-r19.png", "r19-scene");
      writeRel("files/images/tool-r19.png", "r19-tool");
      if (!options.omitAudioFile) writeRel("files/audios/r19-voice.mp3", "r19-audio");
      await runWithProjectStorage(PROJECT, async () => {
        await activeDb("o_image").insert([
          { id: 1, filePath: "files/images/role-r19.png", type: "image", assetsId: 1, state: "已完成" },
          { id: 2, filePath: "files/images/scene-r19.png", type: "image", assetsId: 2, state: "已完成" },
          { id: 3, filePath: "files/images/tool-r19.png", type: "image", assetsId: 3, state: "已完成" },
          ...(options.omitAudioFile ? [] : [
            { id: 5, filePath: "files/audios/r19-voice.mp3", type: "audio", assetsId: 8, state: "已完成" },
          ]),
        ]);
        await activeDb("o_assets").insert([
          { id: 1, name: "姜晓棠", type: "role", describe: "女主", imageId: 1, assetUuid: ROLE, projectId: LEGACY_PROJECT_ID },
          { id: 2, name: "青岚码头", type: "scene", describe: "夜色石阶", imageId: 2, assetUuid: SCENE, projectId: LEGACY_PROJECT_ID },
          { id: 3, name: "油纸伞", type: "tool", describe: "", imageId: 3, assetUuid: TOOL, projectId: LEGACY_PROJECT_ID },
          { id: 7, name: "33", type: "audio", describe: "", imageId: null, assetUuid: PARENT_AUDIO, projectId: LEGACY_PROJECT_ID },
          { id: 8, name: "33文件", type: "audio", describe: "", imageId: options.omitAudioFile ? null : 5, assetsId: 7, assetUuid: CHILD_AUDIO, projectId: LEGACY_PROJECT_ID },
        ]);
        await activeDb("o_assetsRole2Audio").insert({ assetsRoleId: 1, assetsAudioId: 7 });
      });
      await service.bindAsset(shot.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: ROLE, assetType: "role", relationRole: "appear",
      });
      await service.bindAsset(shot.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: SCENE, assetType: "scene", relationRole: "appear",
      });
      await service.bindAsset(shot.shotUuid, {
        sourceProjectUuid: PROJECT, assetUuid: TOOL, assetType: "tool", relationRole: "appear",
      });
      if (options.voiceEnabled === false) {
        await service.updateBindingVoice(shot.shotUuid, {
          assetUuid: ROLE,
          sourceProjectUuid: PROJECT,
          assetType: "role",
          relationRole: "appear",
          voiceEnabled: false,
        });
      }
      const app = express();
      app.use(express.json({ limit: "2mb" }));
      app.use((_req, _res, next) => {
        enterUserStorage(IDENTITY);
        (_req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r19" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      await prepareProjectDatabase(PROJECT);
      const { server, port } = await listen(app);
      try {
        await run({ port, shotUuid: shot.shotUuid, service });
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

function leakFree(serialized: string): void {
  assert.equal(serialized.includes(LEAK_PATH), false);
  assert.equal(/[A-Za-z]:\\/.test(serialized), false);
  assert.equal(serialized.includes("runtime-users"), false);
  assert.equal(/at\s+\S+\.(ts|js)/i.test(serialized), false);
  assert.equal(serialized.includes("SELECT "), false);
}

test("globalVideoPrompt、素材对应关系和模板必须按固定顺序各出现一次", async () => {
  await withRuntime("r19-compose-order", { capability: "ready" }, async ({ port, shotUuid, service }) => {
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
        settings: { globalVideoPrompt: "预览体不得覆盖已保存提示词" },
      }),
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const prompt = String(preview.body?.data?.prompt ?? "");
    assert.match(prompt, new RegExp(`${GLOBAL_PROMPT}[\\s\\S]*【参考素材对应关系】[\\s\\S]*风格：玄幻。[\\s\\S]*稳定跟拍角色走上石阶。`));
    assert.equal(prompt.indexOf(GLOBAL_PROMPT) < prompt.indexOf("【参考素材对应关系】"), true);
    assert.equal(prompt.indexOf("【参考素材对应关系】") < prompt.indexOf("风格：玄幻。"), true);
    assert.equal(prompt.split(GLOBAL_PROMPT).length - 1, 1);
    assert.equal(prompt.split("【参考素材对应关系】").length - 1, 1);
    assert.equal(prompt.split("稳定跟拍角色走上石阶。").length - 1, 1);
    assert.doesNotMatch(prompt, /预览体不得覆盖已保存提示词/);
    const settings = await service.getSettings();
    const { resolveCanonicalStoryboardVideoPrompt } = await import("../../src/tianjiang/storyboard/storyboard-video-prompt");
    const canonical = await resolveCanonicalStoryboardVideoPrompt({
      projectUuid: PROJECT,
      settings,
      shot: (await service.listShots()).find((item) => item.shotUuid === shotUuid)!,
      references: [],
    });
    assert.match(canonical, new RegExp(`^${GLOBAL_PROMPT}`));
  });
});

test("globalVideoPrompt 为空时必须跳过且不产生空标题", async () => {
  await withRuntime("r19-compose-empty", { capability: "ready", globalVideoPrompt: "   " }, async ({ port, shotUuid }) => {
    const preview = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid, mediaType: "video", providerModel: "dreamina-cli:seedance2.0fast",
        mode: "auto", durationMs: 5000, aspectRatio: "9:16",
      }),
    });
    assert.equal(preview.status, 200);
    const prompt = String(preview.body?.data?.prompt ?? "");
    assert.doesNotMatch(prompt, /统一夜戏光影/);
    assert.match(prompt, /^【参考素材对应关系】/);
  });
});

test("模板不含 shot_prompt 时仍只追加一次分镜提示词", async () => {
  await withRuntime("r19-shot-prompt-once", { capability: "ready" }, async ({ port, shotUuid, service }) => {
    await service.saveSettings({ videoPromptTemplateContent: "风格：{{style}}。" });
    const preview = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid, mediaType: "video", providerModel: "dreamina-cli:seedance2.0fast",
        mode: "auto", durationMs: 5000, aspectRatio: "9:16",
      }),
    });
    assert.equal(preview.status, 200);
    const prompt = String(preview.body?.data?.prompt ?? "");
    assert.equal(prompt.split("稳定跟拍角色走上石阶。").length - 1, 1);
    assert.match(prompt, /风格：玄幻。\s+稳定跟拍角色走上石阶。/);
  });
});

test("音色开启且文件可读时必须产生 audio reference 与音频对应关系", async () => {
  await withRuntime("r19-audio-on", { capability: "ready" }, async ({ port, shotUuid }) => {
    const preview = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid, mediaType: "video", providerModel: "dreamina-cli:seedance2.0fast",
        mode: "auto", durationMs: 5000, aspectRatio: "9:16",
      }),
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const prompt = String(preview.body?.data?.prompt ?? "");
    assert.match(prompt, /音频1：角色“姜晓棠”的音色/);
    assert.equal(preview.body?.data?.options?.mode, "multimodal2video");
    const summary = preview.body?.data?.referenceSummary;
    assert.ok(summary);
    assert.equal(summary.audio?.count, 1);
    assert.match(String(summary.audio?.labels?.[0] ?? ""), /姜晓棠/);
    const serialized = JSON.stringify(preview.body);
    assert.equal(serialized.includes("relativePath"), false);
    assert.equal(serialized.includes("assetUuid"), false);
    assert.equal(serialized.includes("md5"), false);
    assert.equal(serialized.includes("filePath"), false);
    leakFree(serialized);

    const generated = await jsonRequest(generateUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid, mediaType: "video", providerModel: "dreamina-cli:seedance2.0fast",
        mode: "auto", durationMs: 5000, aspectRatio: "9:16",
        expectedPreviewDigest: preview.body?.data?.previewDigest,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    const task = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardGenerationTask").orderBy("createdAt", "desc").first());
    const stored = JSON.parse(String(task?.parametersJson ?? "{}")) as { prompt?: string; references?: Array<{ mediaType?: string }> };
    assert.equal(stored.prompt, prompt);
    assert.equal(stored.references?.some((item) => item.mediaType === "audio"), true);
  });
});

test("音色关闭或文件缺失时不得虚构 audio reference", async () => {
  await withRuntime("r19-audio-off", { capability: "ready", voiceEnabled: false }, async ({ port, shotUuid }) => {
    const preview = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid, mediaType: "video", providerModel: "dreamina-cli:seedance2.0fast",
        mode: "auto", durationMs: 5000, aspectRatio: "9:16",
      }),
    });
    assert.equal(preview.status, 200);
    assert.doesNotMatch(String(preview.body?.data?.prompt ?? ""), /音频1/);
    assert.equal(Number(preview.body?.data?.referenceSummary?.audio?.count ?? 0), 0);
  });
  await withRuntime("r19-audio-missing", { capability: "ready", omitAudioFile: true }, async ({ port, shotUuid }) => {
    const preview = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid, mediaType: "video", providerModel: "dreamina-cli:seedance2.0fast",
        mode: "auto", durationMs: 5000, aspectRatio: "9:16",
      }),
    });
    assert.equal(preview.status, 200);
    assert.doesNotMatch(String(preview.body?.data?.prompt ?? ""), /音频1/);
    assert.equal(Number(preview.body?.data?.referenceSummary?.audio?.count ?? 0), 0);
  });
});

test("preview 与 generate 的 prompt、references 和 digest 必须一致", async () => {
  await withRuntime("r19-preview-generate", { capability: "ready" }, async ({ port, shotUuid }) => {
    const payload = {
      shotUuid, mediaType: "video", providerModel: "dreamina-cli:seedance2.0fast",
      mode: "auto", durationMs: 5000, aspectRatio: "9:16",
    };
    const preview = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(preview.status, 200);
    const digest = String(preview.body?.data?.previewDigest ?? "");
    const generated = await jsonRequest(generateUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, expectedPreviewDigest: digest, clientOperationId: crypto.randomUUID() }),
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    const task = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardGenerationTask").orderBy("createdAt", "desc").first());
    const stored = JSON.parse(String(task?.parametersJson ?? "{}")) as { prompt?: string; references?: unknown[] };
    assert.equal(stored.prompt, preview.body?.data?.prompt);
    assert.equal(Array.isArray(stored.references), true);
    assert.ok((stored.references?.length ?? 0) >= 4);
  });
});

test("能力未就绪的截图等价请求：preview 成功、generate 稳定拒绝且零写入", async () => {
  await withRuntime("r19-capability-gate", { capability: "none" }, async ({ port, shotUuid }) => {
    const payload = {
      shotUuid, mediaType: "video", providerModel: "dreamina-cli:seedance2.0fast",
      mode: "auto", durationMs: 5000, aspectRatio: "9:16",
    };
    const preview = await jsonRequest(previewUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(preview.status, 200);
    const generated = await jsonRequest(generateUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...payload,
        expectedPreviewDigest: preview.body?.data?.previewDigest,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.equal(generated.status, 400);
    // 中文注释：缓存为空只能证明能力尚不可用；没有 installed=false 证据时不得推断为未安装。
    assert.equal(generated.body?.code, "STORYBOARD_DREAMINA_CLI_UNAVAILABLE");
    assert.equal(generated.body?.message, "即梦 CLI 不可用");
    leakFree(`${generated.status}:${JSON.stringify(generated.body)}${generated.text}`);
    const tasks = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").select());
    const ops = await runWithProjectStorage(PROJECT, async () => {
      const hasOps = await activeDb.schema.hasTable("o_storyboardGenerationOperation");
      return hasOps ? activeDb("o_storyboardGenerationOperation").select() : [];
    });
    assert.equal(tasks.length, 0);
    assert.equal(Array.isArray(ops) ? ops.length : 0, 0);
  });
});

test("generate 各稳定错误码：缺预览、预览变化、非法时长，且未知错误脱敏", async () => {
  await withRuntime("r19-generate-codes", { capability: "ready" }, async ({ port, shotUuid }) => {
    const missing = await jsonRequest(generateUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid, mediaType: "video", providerModel: "dreamina-cli:seedance2.0fast",
        mode: "auto", durationMs: 5000, aspectRatio: "9:16",
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body?.code, "STORYBOARD_PREVIEW_REQUIRED");
    assert.equal(missing.body?.message, "生成前必须先完成最终请求预览确认");

    const stale = await jsonRequest(generateUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid, mediaType: "video", providerModel: "dreamina-cli:seedance2.0fast",
        mode: "auto", durationMs: 5000, aspectRatio: "9:16",
        expectedPreviewDigest: "ab".repeat(32),
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body?.code, "STORYBOARD_PREVIEW_STALE");
    assert.equal(stale.body?.message, "最终请求已变化，请重新预览确认");

    const duration = await jsonRequest(generateUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid, mediaType: "video", providerModel: "dreamina-cli:seedance2.0fast",
        mode: "auto", durationMs: 3000, aspectRatio: "9:16",
        expectedPreviewDigest: "cd".repeat(32),
        clientOperationId: crypto.randomUUID(),
      }),
    });
    assert.equal(duration.status, 400);
    assert.equal(duration.body?.code, "STORYBOARD_VIDEO_DURATION_INVALID");
    leakFree(JSON.stringify(duration.body));

    const tasks = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").select());
    assert.equal(tasks.length, 0);
  });
});

test("正式 generate 不得通过 writeError 回显盘符或堆栈", async () => {
  await withRuntime("r19-generate-sanitize", { capability: "ready" }, async ({ port }) => {
    const leaked = await jsonRequest(generateUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuid: "not-a-uuid",
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "auto",
        durationMs: 5000,
        clientOperationId: crypto.randomUUID(),
      }),
    });
    const serialized = `${leaked.status}:${JSON.stringify(leaked.body)}${leaked.text}`;
    leakFree(serialized);
    assert.notEqual(String(leaked.body?.message ?? ""), LEAK_PATH);
  });
});
