/**
 * R17 RED：视觉手册风格、模板二次解包、父子音频查询必须走真实路由。
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
import { invalidateDreaminaCapabilityCache } from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import { writeReadyDreaminaTestCapability } from "./helpers/dreamina-capability";
import { stopDreaminaSchedulerLoop } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import getAllAssets from "../../src/routes/cornerScape/getAllAssets";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 1717 };
const PROJECT = "d1717171-1717-4171-a171-171717171717";
const LEGACY_PROJECT_ID = 1717;
const ROLE_UUID = "d1717171-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const PARENT_AUDIO_UUID = "d1717171-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const CHILD_AUDIO_UUID = "d1717171-cccc-4ccc-8ccc-ccccccccccc1";

function catalogRow() {
  return {
    projectUuid: PROJECT,
    name: "R17",
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
  invalidateDreaminaCapabilityCache();
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: LEGACY_PROJECT_ID,
        name: "R17 风格音频",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await ensureCurrentAccountBuiltinSkills(getPath());
      stopDreaminaSchedulerLoop();
      writeReadyDreaminaTestCapability();
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
          user: { id: IDENTITY.userId, username: "r17" },
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
    stopDreaminaSchedulerLoop();
    invalidateDreaminaCapabilityCache();
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 测试清理失败不覆盖主断言 */ }
  }
}

test("空 o_artStyle 时 art-styles 必须列出视觉手册 3D_anime_render，且不回磁盘路径", async () => {
  await withRuntime("r17-art-styles", async ({ port }) => {
    await runWithProjectStorage(PROJECT, async () => {
      if (await activeDb.schema.hasTable("o_artStyle")) {
        await activeDb("o_artStyle").del();
      }
    });
    const listed = await jsonRequest(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/art-styles`,
    );
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const rows = listed.body?.data;
    assert.ok(Array.isArray(rows), "art-styles.data 必须是数组");
    const anime = rows.find((item: { stylePath?: string }) => item.stylePath === "3D_anime_render");
    assert.ok(anime, "必须包含当前项目视觉手册 3D_anime_render");
    assert.ok(String(anime.name ?? "").length > 0, "label 必须是视觉手册名称");
    assert.match(String(anime.prompt ?? ""), /3D动画渲染|赛璐珞|赛璐璐/);
    const serialized = JSON.stringify(listed.body);
    assert.equal(/[A-Za-z]:\\/.test(serialized), false, "不得回传盘符路径");
    assert.equal(serialized.includes("runtime-users"), false);
    assert.equal(serialized.includes("skills/art_skills"), false);
  });
});

test("{{style}} 必须读取项目小说类型，不得混入视觉手册", async () => {
  await withRuntime("r17-style-prompt", async ({ port }) => {
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
    void port;
  });
});

test("getAllAssets 必须按父音频+子资产文件记录返回受保护 src", async () => {
  await withRuntime("r17-audio-parent-child", async ({ port }) => {
    const context = currentUserStorage();
    assert.ok(context);
    const projectRoot = projectDirectory(getPath(), PROJECT, context.segment);
    const audioRel = "files/audios/r17-voice.mp3";
    fs.mkdirSync(path.join(projectRoot, "files", "audios"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, audioRel.split("/").join(path.sep)), Buffer.alloc(64, 1));
    await runWithProjectStorage(PROJECT, async () => {
      await activeDb("o_image").insert([
        { id: 1, filePath: "files/images/role-r17.png", type: "image", assetsId: 1, state: "已完成" },
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
    assert.ok(role, "getAllAssets 必须返回角色");
    const audios = role.relepedAudio ?? [];
    assert.equal(audios.length, 1);
    assert.equal(audios[0]!.id, 7, "DTO id 必须是已绑定的音频父资产");
    assert.equal(audios[0]!.name, "33");
    assert.equal(
      audios[0]!.src,
      `/api/tianjiang/runtime/projects/${PROJECT}/files/audios/r17-voice.mp3`,
    );
    const serialized = JSON.stringify(audios);
    assert.equal(serialized.includes("filePath"), false);
    assert.equal(serialized.includes("C:/Users"), false);
    assert.equal(/[A-Za-z]:\\/.test(serialized), false);
  });
});
