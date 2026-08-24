/**
 * R12 RED：未匹配资产不得阻断导入；自动分镜规则可配置；设置只写 durationMs。
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
  STORYBOARD_IMPORT_TXT_EXAMPLE,
  assertPreviewDigest,
  buildImportPreview,
  parseImportBuffer,
} from "../../src/tianjiang/storyboard/import-export";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9942 };
const PROJECT = "c1111111-1111-4111-a111-111111111111";
const VILLAGER = "c1111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

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
  options?: { role?: string },
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
        id: 942, name: "R12", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow(PROJECT, options?.role ?? "owner")] as any;
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
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test("TXT 示例无对应资产时 preview=2 且 commit 必须 200，插入 2 条分镜、绑定 0 条", async () => {
  await withRuntime("r12-unmatched", async ({ port }) => {
    const base = `http://127.0.0.1:${port}/api/tianjiang/storyboard/${PROJECT}`;
    const contentBase64 = Buffer.from(STORYBOARD_IMPORT_TXT_EXAMPLE, "utf8").toString("base64");
    const preview = await jsonRequest(`${base}/import/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "txt", contentBase64, txtDelimiter: { mode: "auto" } }),
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body?.data?.rows?.length, 2);
    const first = preview.body.data.rows[0];
    assert.match(String(first.videoPrompt ?? first.sourceText ?? ""), /场景：/);
    assert.match(String(first.videoPrompt ?? first.sourceText ?? ""), /人物：/);
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
    assert.equal(commit.status, 200, `未匹配不得阻断导入，实际 ${commit.status} ${JSON.stringify(commit.body)}`);
    const serialized = JSON.stringify(commit.body);
    assert.equal(/SELECT |INSERT |C:\\\\|at\s+\S+\.ts/i.test(serialized), false);
    assert.ok(Number(commit.body?.data?.unmatchedCount ?? 0) > 0, "必须返回未匹配数量");
    const shots = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardShot").select().orderBy("displayOrder"));
    assert.equal(shots.length, 2);
    assert.match(String(shots[0]!.videoPrompt), /场景：/);
    assert.match(String(shots[0]!.sourceText), /人物：/);
    assert.match(String(shots[1]!.videoPrompt), /道具：烂红薯干/);
    const binds = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardShotAsset").select());
    assert.equal(binds.length, 0);
    const created = await runWithProjectStorage(PROJECT, () => activeDb("o_assets").select());
    assert.equal(created.length, 0, "不得自动新建资产");
  });
});

test("部分关键词匹配只绑定存在的资产，其他关键词不阻断", async () => {
  await withRuntime("r12-partial", async ({ port }) => {
    await runWithProjectStorage(PROJECT, async () => {
      await activeDb("o_assets").insert({
        id: 1, name: "村民", type: "role", describe: "", assetUuid: VILLAGER, projectId: 942,
      });
    });
    const base = `http://127.0.0.1:${port}/api/tianjiang/storyboard/${PROJECT}`;
    const contentBase64 = Buffer.from(STORYBOARD_IMPORT_TXT_EXAMPLE, "utf8").toString("base64");
    const preview = await jsonRequest(`${base}/import/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "txt", contentBase64 }),
    });
    const commit = await jsonRequest(`${base}/import/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format: "txt",
        contentBase64,
        previewDigest: preview.body.data.digest,
        mode: "append",
      }),
    });
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    const shots = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardShot").select());
    assert.equal(shots.length, 2);
    const binds = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardShotAsset").select());
    assert.equal(binds.length, 1);
    assert.equal(binds[0]!.assetUuid, VILLAGER);
    assert.ok(Number(commit.body?.data?.unmatchedCount ?? 0) >= 1);
  });
});

test("自动分镜规则可多选且进入 digest，精确自定义分隔符保持整行匹配", async () => {
  const shotText = [
    "分镜1：",
    "第一镜。",
    "分镜 2",
    "第二镜。",
    "小节1：",
    "不应在只启用分镜规则时拆开。",
  ].join("\n");
  const parsed = await parseImportBuffer(
    "txt",
    Buffer.from(shotText, "utf8"),
    { mode: "auto", autoRules: ["shot"] } as any,
  );
  assert.equal(parsed.rows.length, 2, `只启用分镜规则应拆成 2 条，实际 ${parsed.rows.length}`);
  assert.match(parsed.rows[1]!.videoPrompt, /不应在只启用分镜规则时拆开/);

  const allDefault = await buildImportPreview("txt", Buffer.from(shotText, "utf8").toString("base64"));
  const shotOnly = await buildImportPreview(
    "txt",
    Buffer.from(shotText, "utf8").toString("base64"),
    { mode: "auto", autoRules: ["shot"] } as any,
  );
  assert.notEqual(allDefault.digest, shotOnly.digest, "规则变化必须换摘要");
  assert.throws(
    () => (assertPreviewDigest as any)(
      "txt",
      Buffer.from(shotText, "utf8").toString("base64"),
      allDefault.digest,
      { mode: "auto", autoRules: ["shot"] },
    ),
    /内容已变化/,
  );

  const custom = await parseImportBuffer(
    "txt",
    Buffer.from("====\n甲\n====\n乙\n", "utf8"),
    { mode: "custom", delimiter: "====" },
  );
  assert.equal(custom.rows.length, 2);
  assert.match(custom.rows[0]!.videoPrompt, /甲/);
});

test("分镜设置 PUT 只写 durationMs 白名单，未知字段不得落库", async () => {
  await withRuntime("r12-settings", async ({ port }) => {
    const url = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/settings`;
    const saved = await jsonRequest(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        aspectRatio: "9:16",
        durationMs: 8000,
        defaultDurationMs: 99999,
        globalImagePrompt: "胶片颗粒",
        globalVideoPrompt: "缓慢推进",
        evilColumn: "drop-me",
      }),
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body?.data?.durationMs, 8000);
    assert.equal(saved.body?.data?.defaultDurationMs, undefined);
    assert.equal(saved.body?.data?.globalImagePrompt, "胶片颗粒");
    const read = await jsonRequest(url);
    assert.equal(read.status, 200);
    assert.equal(read.body?.data?.durationMs, 8000);
    const columns = await runWithProjectStorage(PROJECT, () => activeDb.raw("PRAGMA table_info(o_storyboardWorkspaceSettings)"));
    const names = (columns as Array<{ name: string }>).map((item) => item.name);
    assert.equal(names.includes("defaultDurationMs"), false);
    assert.equal(names.includes("evilColumn"), false);
    const row = await runWithProjectStorage(PROJECT, () =>
      activeDb("o_storyboardWorkspaceSettings").where({ id: 1 }).first());
    assert.equal(row?.durationMs, 8000);
    assert.equal((row as { defaultDurationMs?: unknown })?.defaultDurationMs, undefined);
  });
});

test("只读项目禁止保存分镜设置", async () => {
  await withRuntime("r12-settings-ro", async ({ port }) => {
    const url = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/settings`;
    const saved = await jsonRequest(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ durationMs: 3000, aspectRatio: "16:9" }),
    });
    assert.ok([403, 400].includes(saved.status), `只读保存必须失败，实际 ${saved.status}`);
  }, { role: "viewer" });
});
