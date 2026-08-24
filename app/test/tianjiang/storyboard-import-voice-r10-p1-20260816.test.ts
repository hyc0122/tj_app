/**
 * R10 RED：TXT/CSV 批量导入扩展、previewDigest 绑定分隔配置、relepedAudio 只回安全 src。
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
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  assertPreviewDigest,
  buildImportPreview,
  parseImportBuffer,
} from "../../src/tianjiang/storyboard/import-export";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9930 };
const PROJECT = "a1111111-1111-4111-a111-111111111111";
const ROLE_LINXIA = "a1111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SCENE_RAIN = "a1111111-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const TOOL_UMBRELLA = "a1111111-cccc-4ccc-8ccc-ccccccccccc1";

function catalogRow(projectUuid: string, role = "owner") {
  return {
    projectUuid,
    name: projectUuid.slice(0, 8),
    kind: "personal",
    ownerUserId: IDENTITY.userId,
    role,
    myRole: role,
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-16T00:00:00Z",
    lockStatus: "none",
    lockHolderName: "",
    openMode: role === "viewer" ? "readonly" : "editable",
    businessType: "storyboard",
  };
}

function numberedTxt(): string {
  return [
    "小节1：",
    "场景：雨巷",
    "人物：林夏、卫兵",
    "道具：油纸伞",
    "缓慢推进，近景。",
    "",
    "小节2：",
    "场景：屋顶",
    "人物：林夏",
    "镜头切到屋顶。",
    "",
  ].join("\n");
}

function hashTxt(): string {
  return [
    "# 1",
    "场景：黑屏字卡。",
    "人物：无",
    "镜号1：黑屏。",
    "",
    "# 2",
    "场景：土屋",
    "人物：村民",
    "镜号1：广角缓推。",
    "",
  ].join("\n");
}

function customDelimitedTxt(): string {
  return [
    "====",
    "第一段正文",
    "====",
    "第二段正文",
    ".* 这一行不能被正则当成分隔符",
    "",
  ].join("\n");
}

function quotedCsv(): string {
  return [
    "场景,人物,道具,分镜提示词",
    "雨巷,\"林夏,卫兵\",油纸伞,\"第一行提示",
    "第二行提示\"",
  ].join("\n");
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

test("TXT 小节1/小节2、# 1/# 2 与 BOM/CRLF 必须批量解析", async () => {
  const numbered = await parseImportBuffer("txt", Buffer.from(numberedTxt(), "utf8"));
  assert.equal(numbered.errors.length, 0);
  assert.equal(numbered.rows.length, 2, `小节1/小节2 必须拆成 2 条，实际 ${numbered.rows.length}`);
  assert.match(numbered.rows[0]!.videoPrompt, /场景：雨巷/);
  assert.match(numbered.rows[0]!.sourceText, /缓慢推进/);

  const hashed = await parseImportBuffer("txt", Buffer.from(hashTxt(), "utf8"));
  assert.equal(hashed.rows.length, 2, `# 1/# 2 必须拆成 2 条，实际 ${hashed.rows.length}`);
  assert.match(hashed.rows[1]!.videoPrompt, /广角缓推/);

  const bomCrlf = `\uFEFF小节：1｜估时15秒\r\n英雄走进雨巷。\r\n小节: 2 | 估时 8 秒\r\n镜头切到屋顶。\r\n视频段：3\r\n空镜。\r\n`;
  const compat = await parseImportBuffer("txt", Buffer.from(bomCrlf, "utf8"));
  assert.equal(compat.rows.length, 3);
  assert.equal(compat.rows[0]!.durationMs, 15_000);
  assert.equal(compat.rows[1]!.durationMs, 8_000);
  assert.match(compat.rows[2]!.sourceText, /空镜/);
});

test("自定义普通文本分隔符按整行精确匹配，不能按正则解释", async () => {
  const parsed = await (parseImportBuffer as (
    format: "txt",
    buffer: Buffer,
    config?: { mode: "auto" | "custom"; delimiter?: string },
  ) => ReturnType<typeof parseImportBuffer>)(
    "txt",
    Buffer.from(customDelimitedTxt(), "utf8"),
    { mode: "custom", delimiter: "====" },
  );
  assert.equal(parsed.rows.length, 2, `自定义分隔必须拆成 2 条，实际 ${parsed.rows.length}`);
  assert.match(parsed.rows[0]!.videoPrompt, /第一段正文/);
  assert.match(parsed.rows[1]!.videoPrompt, /第二段正文/);
  assert.match(parsed.rows[1]!.videoPrompt, /\.\* 这一行不能被正则当成分隔符/);

  const regexTrap = await (parseImportBuffer as (
    format: "txt",
    buffer: Buffer,
    config?: { mode: "auto" | "custom"; delimiter?: string },
  ) => ReturnType<typeof parseImportBuffer>)(
    "txt",
    Buffer.from(".*\nalpha\n.*\nbeta\n", "utf8"),
    { mode: "custom", delimiter: ".*" },
  );
  assert.equal(regexTrap.rows.length, 2, ".* 只能匹配字面整行，不能当正则");
  assert.equal(regexTrap.rows[0]!.videoPrompt.includes("alpha"), true);
  assert.equal(regexTrap.rows[1]!.videoPrompt.includes("beta"), true);
});

test("场景/人物/道具原行必须完整留在 videoPrompt 与 sourceText，同时写入 assetNames", async () => {
  const parsed = await parseImportBuffer("txt", Buffer.from(numberedTxt(), "utf8"));
  const first = parsed.rows[0]!;
  assert.match(first.videoPrompt, /场景：雨巷/);
  assert.match(first.videoPrompt, /人物：林夏、卫兵/);
  assert.match(first.videoPrompt, /道具：油纸伞/);
  assert.match(first.sourceText, /场景：雨巷/);
  assert.match(first.sourceText, /人物：林夏、卫兵/);
  assert.deepEqual([...first.assetNames.scene], ["雨巷"]);
  assert.deepEqual([...first.assetNames.role], ["林夏", "卫兵"]);
  assert.deepEqual([...first.assetNames.tool], ["油纸伞"]);
  assert.deepEqual([...parsed.rows[1]!.assetNames.role], ["林夏"]);
  assert.equal(first.videoPrompt.includes("小节1"), false, "只移除分镜分隔头");
});

test("CSV 四列表头和带换行的引号单元格必须正确解析", async () => {
  const parsed = await parseImportBuffer("csv", Buffer.from(`\uFEFF${quotedCsv()}`, "utf8"));
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]!.videoPrompt, "第一行提示\n第二行提示");
  assert.match(parsed.rows[0]!.sourceText, /第一行提示/);
  assert.deepEqual([...parsed.rows[0]!.assetNames.scene], ["雨巷"]);
  assert.deepEqual([...parsed.rows[0]!.assetNames.role], ["林夏", "卫兵"]);
  assert.deepEqual([...parsed.rows[0]!.assetNames.tool], ["油纸伞"]);
});

test("分隔配置变化必须导致旧 previewDigest 409，commit 零写入", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `r10-digest-${Date.now()}`);
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
        id: 930, name: "R10 导入", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow(PROJECT)] as any;
      const app = express();
      app.use(express.json({ limit: "4mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "alice" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      const { default: storyboardHttp } = await import("../../src/routes/tianjiang/storyboard-http");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      app.use("/api/tianjiang/storyboard", storyboardHttp);
      const { server, port } = await listen(app);
      const base = `http://127.0.0.1:${port}/api/tianjiang/storyboard/${PROJECT}`;
      const contentBase64 = Buffer.from(customDelimitedTxt(), "utf8").toString("base64");
      try {
        const preview = await jsonRequest(`${base}/import/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            format: "txt",
            contentBase64,
            txtDelimiter: { mode: "auto" },
          }),
        });
        assert.equal(preview.status, 200, JSON.stringify(preview.body));
        const autoDigest = String(preview.body?.data?.digest ?? "");
        assert.ok(autoDigest);
        const customPreview = await (buildImportPreview as (
          format: "txt",
          content: string,
          config?: { mode: "auto" | "custom"; delimiter?: string },
        ) => ReturnType<typeof buildImportPreview>)("txt", contentBase64, { mode: "custom", delimiter: "====" });
        assert.notEqual(customPreview.digest, autoDigest, "只改分隔符也必须换摘要");
        assert.throws(
          () => (assertPreviewDigest as (
            format: "txt",
            content: string,
            digest: string,
            config?: { mode: "auto" | "custom"; delimiter?: string },
          ) => void)("txt", contentBase64, autoDigest, { mode: "custom", delimiter: "====" }),
          /内容已变化/,
        );

        const commit = await jsonRequest(`${base}/import/commit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            format: "txt",
            contentBase64,
            previewDigest: autoDigest,
            mode: "append",
            txtDelimiter: { mode: "custom", delimiter: "====" },
          }),
        });
        assert.equal(commit.status, 409, `分隔配置变化必须 409，实际 ${commit.status} ${JSON.stringify(commit.body)}`);
        const shots = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardShot").select());
        assert.equal(shots.length, 0, "摘要不一致必须整批零写入");
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
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("批量导入必须按条数、displayOrder 和资产绑定一次性写入", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `r10-commit-${Date.now()}`);
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
        id: 931, name: "R10 提交", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      await runWithProjectStorage(PROJECT, async () => {
        await activeDb("o_assets").insert([
          { id: 1, name: "林夏", type: "role", describe: "", assetUuid: ROLE_LINXIA, projectId: 931 },
          { id: 2, name: "雨巷", type: "scene", describe: "", assetUuid: SCENE_RAIN, projectId: 931 },
          { id: 3, name: "油纸伞", type: "tool", describe: "", assetUuid: TOOL_UMBRELLA, projectId: 931 },
          { id: 4, name: "卫兵", type: "role", describe: "", assetUuid: crypto.randomUUID(), projectId: 931 },
          { id: 5, name: "屋顶", type: "scene", describe: "", assetUuid: crypto.randomUUID(), projectId: 931 },
        ]);
      });
      syncCoordinator.listProjects = () => [catalogRow(PROJECT)] as any;
      const app = express();
      app.use(express.json({ limit: "4mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "alice" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      const { default: storyboardHttp } = await import("../../src/routes/tianjiang/storyboard-http");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      app.use("/api/tianjiang/storyboard", storyboardHttp);
      const { server, port } = await listen(app);
      const base = `http://127.0.0.1:${port}/api/tianjiang/storyboard/${PROJECT}`;
      const contentBase64 = Buffer.from(numberedTxt(), "utf8").toString("base64");
      try {
        const preview = await jsonRequest(`${base}/import/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ format: "txt", contentBase64, txtDelimiter: { mode: "auto" } }),
        });
        assert.equal(preview.status, 200, JSON.stringify(preview.body));
        assert.equal(preview.body?.data?.rows?.length, 2);
        const commit = await jsonRequest(`${base}/import/commit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            format: "txt",
            contentBase64,
            previewDigest: preview.body.data.digest,
            mode: "append",
            txtDelimiter: { mode: "auto" },
          }),
        });
        assert.equal(commit.status, 200, JSON.stringify(commit.body));
        const shots = await runWithProjectStorage(PROJECT, () =>
          activeDb("o_storyboardShot").select().orderBy("displayOrder"));
        assert.equal(shots.length, 2);
        assert.equal(shots[0]!.displayOrder, 1);
        assert.equal(shots[1]!.displayOrder, 2);
        assert.match(String(shots[0]!.videoPrompt), /场景：雨巷/);
        assert.match(String(shots[0]!.sourceText), /人物：林夏/);
        const binds = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardShotAsset").select());
        assert.ok(binds.some((row: { assetUuid: string }) => row.assetUuid === ROLE_LINXIA));
        assert.ok(binds.some((row: { assetUuid: string }) => row.assetUuid === SCENE_RAIN));
        assert.ok(binds.some((row: { assetUuid: string }) => row.assetUuid === TOOL_UMBRELLA));
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
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("relepedAudio 只返回安全 src，不返回 filePath/绝对路径，并受项目隔离", async () => {
  const { buildRelatedAudioDtos } = await import("../../src/tianjiang/storyboard/related-audio-dto");
  const dtos = await buildRelatedAudioDtos(
    [
      { id: 2, name: "林夏音色", filePath: "files/audios/linxia.mp3" },
      { id: 3, name: "脏路径", filePath: "C:/Users/alice/secret.mp3" },
      { id: 4, name: "越权", filePath: "../outside.mp3" },
    ],
    {
      projectUuid: PROJECT,
      getFileUrl: async (logicalPath) => `/api/tianjiang/runtime/projects/${PROJECT}/${logicalPath}`,
    },
  );
  assert.equal(dtos.length, 3);
  assert.deepEqual(dtos[0], {
    id: 2,
    name: "林夏音色",
    src: `/api/tianjiang/runtime/projects/${PROJECT}/files/audios/linxia.mp3`,
  });
  assert.equal(dtos[1]!.src, undefined, "绝对路径不得生成 src");
  assert.equal(dtos[2]!.src, undefined, "越权路径不得生成 src");
  const serialized = JSON.stringify(dtos);
  assert.equal(serialized.includes("filePath"), false);
  assert.equal(serialized.includes("C:/Users"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(dtos[0], "filePath"), false);
});
