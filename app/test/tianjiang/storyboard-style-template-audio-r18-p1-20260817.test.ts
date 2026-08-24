/**
 * R18 RED：小说类型 {{style}}、模板下拉、art-styles 异常脱敏、父子音频不回退。
 */
import assert from "node:assert/strict";
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
import { ensureCurrentAccountBuiltinSkills } from "../../src/tianjiang/skills/account-skills";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import * as videoStyle from "../../src/tianjiang/storyboard/storyboard-video-style";
import getAllAssets from "../../src/routes/cornerScape/getAllAssets";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 1818 };
const PROJECT = "e1818181-1818-4181-a181-181818181818";
const LEGACY_PROJECT_ID = 1818;
const ROLE_UUID = "e1818181-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const PARENT_AUDIO_UUID = "e1818181-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const CHILD_AUDIO_UUID = "e1818181-cccc-4ccc-8ccc-ccccccccccc1";
const LEAKED_PATH = "C:\\Users\\alice\\skills\\art_storyboard_video.md";

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R18",
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
  run: (input: { port: number }) => Promise<void>,
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: LEGACY_PROJECT_ID,
        name: "R18 小说类型",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await ensureCurrentAccountBuiltinSkills(getPath());
      syncCoordinator.listProjects = () => [catalogRow()] as any;
      await runWithProjectStorage(PROJECT, async () => {
        await activeDb("o_project").where({ id: LEGACY_PROJECT_ID }).update({
          type: "玄幻",
          artStyle: "3D_anime_render",
        });
      });
      const app = express();
      app.use(express.json({ limit: "2mb" }));
      app.use((_req, _res, next) => {
        enterUserStorage(IDENTITY);
        (_req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "r18" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      await prepareProjectDatabase(PROJECT);
      app.use((_req, _res, next) => runWithProjectStorage(PROJECT, next));
      app.use("/api/cornerScape/getAllAssets", getAllAssets);
      const { server, port } = await listen(app);
      try {
        await run({ port });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 测试清理失败不覆盖主断言 */ }
  }
}

test("art-styles 文件系统异常不得回显盘符、堆栈或内部路径", async () => {
  const original = videoStyle.artStylesListHook.list;
  videoStyle.artStylesListHook.list = async () => {
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${LEAKED_PATH}'`), {
      code: "ENOENT",
    });
  };
  try {
    await withRuntime("r18-art-styles-leak", async ({ port }) => {
      const listed = await jsonRequest(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/art-styles`,
      );
      const serialized = `${listed.status}:${JSON.stringify(listed.body)}${listed.text}`;
      assert.equal(serialized.includes("C:\\Users\\alice"), false, `旧实现会回显绝对路径: ${serialized}`);
      assert.equal(serialized.includes(LEAKED_PATH.replace(/\\/g, "\\\\")) || serialized.includes("alice"), false);
      assert.equal(/at\s+\S+\.(ts|js)/i.test(serialized), false);
      assert.equal(listed.body?.code, "STORYBOARD_ART_STYLES_UNAVAILABLE");
      assert.equal(listed.body?.message, "视频风格列表暂时无法读取");
    });
  } finally {
    videoStyle.artStylesListHook.list = original;
  }
});

test("{{style}} 必须使用 o_project.type 小说类型，空值保持空，且不得混入手册", async () => {
  await withRuntime("r18-novel-type-style", async ({ port }) => {
    const service = new StoryboardService(PROJECT);
    const shot = await service.insertShot({
      afterShotUuid: null,
      sourceText: "夜戏",
      videoPrompt: "角色走上石阶。",
      durationMs: 5000,
    });
    const { resolveStoryboardStylePrompt } = await import("../../src/tianjiang/storyboard/storyboard-video-style");
    const { resolveCanonicalStoryboardVideoPrompt } = await import("../../src/tianjiang/storyboard/storyboard-video-prompt");
    assert.equal(await resolveStoryboardStylePrompt(PROJECT), "玄幻");
    const prompt = await resolveCanonicalStoryboardVideoPrompt({
      projectUuid: PROJECT,
      settings: await service.getSettings(),
      shot,
      references: [],
    });
    assert.match(prompt, /风格：玄幻/);
    assert.doesNotMatch(prompt, /3D动画渲染|赛璐珞|赛璐璐/);
    await runWithProjectStorage(PROJECT, async () => {
      await activeDb("o_project").where({ id: LEGACY_PROJECT_ID }).update({ type: "  " });
    });
    assert.equal(await resolveStoryboardStylePrompt(PROJECT), "");
    const emptyPrompt = await resolveCanonicalStoryboardVideoPrompt({
      projectUuid: PROJECT,
      settings: await service.getSettings(),
      shot,
      references: [],
    });
    assert.match(emptyPrompt, /风格：。/);
    assert.doesNotMatch(emptyPrompt, /玄幻|3D动画渲染/);
    await runWithProjectStorage(PROJECT, async () => {
      await activeDb("o_project").where({ id: LEGACY_PROJECT_ID }).update({ type: "玄幻" });
    });
    const { mergeFinalGenerationRequest } = await import("../../src/tianjiang/storyboard/storyboard-generation-service");
    const previewAgain = await resolveCanonicalStoryboardVideoPrompt({
      projectUuid: PROJECT,
      settings: await service.getSettings(),
      shot,
      references: [],
    });
    const generatePrompt = (await mergeFinalGenerationRequest({
      mediaType: "video",
      providerModel: "vendor-test:video",
      settings: await service.getSettings(),
      shot,
      projectUuid: PROJECT,
    })).prompt;
    assert.equal(generatePrompt, previewAgain);
    assert.match(previewAgain, /风格：玄幻/);
    void port;
  });
});

test("art-styles 成功响应不得退化，且不得回传盘符", async () => {
  await withRuntime("r18-art-styles-ok", async ({ port }) => {
    const listed = await jsonRequest(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/art-styles`,
    );
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const rows = listed.body?.data;
    assert.ok(Array.isArray(rows));
    assert.ok(rows.some((item: { stylePath?: string }) => item.stylePath === "3D_anime_render"));
    const serialized = JSON.stringify(listed.body);
    assert.equal(/[A-Za-z]:\\/.test(serialized), false);
    assert.equal(serialized.includes("runtime-users"), false);
  });
});

test("R17 父子音频解析不得回退，getAllAssets 仍回受保护 src", async () => {
  await withRuntime("r18-audio-parent-child", async ({ port }) => {
    const context = currentUserStorage();
    assert.ok(context);
    const projectRoot = projectDirectory(getPath(), PROJECT, context.segment);
    const audioRel = "files/audios/r18-voice.mp3";
    fs.mkdirSync(path.join(projectRoot, "files", "audios"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, audioRel.split("/").join(path.sep)), Buffer.alloc(64, 1));
    await runWithProjectStorage(PROJECT, async () => {
      await activeDb("o_image").insert([
        { id: 1, filePath: "files/images/role-r18.png", type: "image", assetsId: 1, state: "已完成" },
        { id: 5, filePath: audioRel, type: "audio", assetsId: 8, state: "已完成" },
      ]);
      await activeDb("o_assets").insert([
        { id: 1, name: "姜晓棠", type: "role", describe: "女主", imageId: 1, assetUuid: ROLE_UUID, projectId: LEGACY_PROJECT_ID },
        { id: 7, name: "33", type: "audio", describe: "", imageId: null, assetUuid: PARENT_AUDIO_UUID, projectId: LEGACY_PROJECT_ID },
        { id: 8, name: "33文件", type: "audio", describe: "", imageId: 5, assetsId: 7, assetUuid: CHILD_AUDIO_UUID, projectId: LEGACY_PROJECT_ID },
      ]);
      await activeDb("o_assetsRole2Audio").insert({ assetsRoleId: 1, assetsAudioId: 7 });
    });
    const listed = await jsonRequest(`http://127.0.0.1:${port}/api/cornerScape/getAllAssets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: LEGACY_PROJECT_ID }),
    });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const roles = listed.body?.data ?? [];
    const role = Array.isArray(roles) ? roles.find((item: { name?: string }) => item.name === "姜晓棠") : null;
    assert.ok(role);
    const audios = role.relepedAudio ?? [];
    assert.equal(audios[0]!.id, 7);
    assert.equal(audios[0]!.src, `/api/tianjiang/runtime/projects/${PROJECT}/files/audios/r18-voice.mp3`);
    assert.equal(JSON.stringify(audios).includes("filePath"), false);
  });
});
