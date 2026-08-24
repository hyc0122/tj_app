/**
 * RED2：Unicode 偏移、替换长度上限、真实 5 条分块、安全错误与增量响应。
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
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9823 };
const PROJECT_A = "81111111-1111-4111-a111-111111111111";
const MAX_SHOT_ACTION = 500;
const MAX_FIND_TEXT = 4000;
const MAX_REPLACE_TEXT = 8000;
const MAX_VIDEO_PROMPT = 20_000;
const MAX_BATCH_PROMPT_TOTAL = 2_000_000;

function catalogRow(projectUuid: string) {
  return {
    projectUuid,
    name: projectUuid.slice(0, 8),
    kind: "personal",
    ownerUserId: IDENTITY.userId,
    role: "owner",
    myRole: "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-23T00:00:00Z",
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
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

function storyboardUrl(port: number, projectUuid: string): string {
  return `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/storyboard`;
}

function assertSafePublicError(body: any): void {
  const message = String(body?.message ?? "");
  assert.ok(message.length > 0, "错误必须返回中文提示");
  assert.match(message, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(message, /[A-Za-z]:\\/);
  assert.doesNotMatch(message, /node_modules|sqlite|SQLITE|SELECT |INSERT |UPDATE |FROM |o_storyboard|o_legacy|E:\\|C:\\Users\\/i);
}

function shotUuidAt(index: number): string {
  return `81111111-1111-4111-a111-${String(index + 1).padStart(12, "0")}`;
}

async function createShot(base: string, fields: { videoPrompt?: string; afterShotUuid?: string | null } = {}) {
  const created = await jsonRequest(`${base}/shots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ afterShotUuid: fields.afterShotUuid === undefined ? null : fields.afterShotUuid, sourceText: "源" }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const shotUuid = String(created.body.data.shotUuid);
  const patched = await jsonRequest(`${base}/shots/${shotUuid}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ videoPrompt: fields.videoPrompt ?? "" }),
  });
  assert.equal(patched.status, 200);
  return patched.body.data;
}

async function createAsset(base: string, input: { type: "role" | "scene" | "tool"; name: string; remark?: string }) {
  const created = await jsonRequest(`${base}/assets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: input.type, name: input.name, remark: input.remark ?? "", describe: `${input.name}说明` }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return created.body.data;
}

async function journalGeneration(projectUuid: string): Promise<number> {
  return runWithProjectStorage(projectUuid, async () => {
    const row = await activeDb("o_legacyMutationJournal").max("generation as maxGen").first();
    return Number((row as { maxGen?: number | null } | undefined)?.maxGen ?? 0);
  });
}

async function insertShotRows(rows: Array<{ shotUuid: string; displayOrder: number; videoPrompt: string }>): Promise<void> {
  const stamp = new Date().toISOString();
  await runWithProjectStorage(PROJECT_A, async () => {
    for (let index = 0; index < rows.length; index += 20) {
      const batch = rows.slice(index, index + 20);
      await activeDb("o_storyboardShot").insert(batch.map((row) => ({
        shotUuid: row.shotUuid,
        displayOrder: row.displayOrder,
        videoPrompt: row.videoPrompt,
        sourceText: "源",
        createdAt: stamp,
        updatedAt: stamp,
      })));
    }
  });
}

function inListSizes(sql: string): number[] {
  const sizes: number[] = [];
  const matches = sql.matchAll(/\bin\s*\(([^)]*)\)/gi);
  for (const match of matches) {
    const inner = String(match[1] ?? "").trim();
    if (!inner) continue;
    sizes.push(inner.split(",").filter((part) => part.trim()).length);
  }
  return sizes;
}

function insertRowCount(sql: string, bindings: unknown[]): number {
  const valuesAt = sql.toLowerCase().indexOf(" values ");
  if (valuesAt < 0) return 0;
  const tuples = (sql.slice(valuesAt).match(/\),\s*\(/g)?.length ?? 0) + 1;
  if (bindings.length > 0 && tuples === 1) {
    const firstTuple = sql.slice(valuesAt).match(/\(([^)]*)\)/);
    const cols = firstTuple ? firstTuple[1].split(",").filter((part) => part.trim()).length : 0;
    if (cols > 0) return Math.round(bindings.length / cols);
  }
  return tuples;
}

function tableOf(sql: string): string {
  const insert = sql.match(/insert\s+into\s+[`"]?(\w+)/i);
  if (insert) return insert[1] ?? "";
  const update = sql.match(/update\s+[`"]?(\w+)/i);
  if (update) return update[1] ?? "";
  const from = sql.match(/from\s+[`"]?(\w+)/i);
  return from?.[1] ?? "";
}

async function withRuntime(run: (ctx: { port: number; base: string }) => Promise<void>): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-r29-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
      await initializeWorkspaceProject(PROJECT_A, {
        id: 811,
        name: "project-a",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow(PROJECT_A)] as any;
      const app = express();
      app.use(express.json({ limit: "4mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          id: "r29-session",
          serverUrl: IDENTITY.issuer,
          token: "test-token",
          expiresAt: Date.now() + 60_000,
          user: { id: IDENTITY.userId, username: "alice", nickname: "alice" },
          validatedAt: Date.now(),
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      try {
        await run({ port, base: storyboardUrl(port, PROJECT_A) });
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

test("Unicode 码元偏移：🎬张三 只能绑定张三且 start/end 为 UTF-16 2/4", async () => {
  const { matchAssetsForPrompt } = await import("../../src/tianjiang/storyboard/storyboard-asset-matcher");
  const prompt = "🎬张三";
  assert.equal(prompt.length, 4);
  assert.equal("🎬".length, 2);
  const matched = matchAssetsForPrompt(prompt, [
    { assetUuid: "role-zhang", name: "张三", type: "role", remark: "", sourceProjectUuid: PROJECT_A },
    { assetUuid: "role-san", name: "三", type: "role", remark: "", sourceProjectUuid: PROJECT_A },
  ]);
  assert.deepEqual(matched.matches.map((item) => item.assetUuid), ["role-zhang"]);
  const hit = matched.matches[0]!;
  assert.equal(hit.matchedText, "张三");
  assert.equal(hit.start, 2);
  assert.equal(hit.end, 4);
  assert.equal(prompt.slice(hit.start, hit.end), "张三");
});

test("emoji、内部空白和括号归一后不得用短名误绑张三（少年）", async () => {
  const { matchAssetsForPrompt } = await import("../../src/tianjiang/storyboard/storyboard-asset-matcher");
  const assets = [
    { assetUuid: "role-zhang", name: "张三", type: "role" as const, remark: "", sourceProjectUuid: PROJECT_A },
    { assetUuid: "role-san", name: "三", type: "role" as const, remark: "", sourceProjectUuid: PROJECT_A },
  ];
  const qualified = matchAssetsForPrompt("🎬张三（少年）", assets);
  assert.equal(qualified.matches.some((item) => item.assetUuid === "role-zhang"), false);
  assert.equal(qualified.matches.some((item) => item.assetUuid === "role-san"), false);

  const spaced = matchAssetsForPrompt("🎬 张 三", assets);
  assert.deepEqual(spaced.matches.map((item) => item.assetUuid), ["role-zhang"]);
  const spacedHit = spaced.matches[0]!;
  assert.equal(spacedHit.start, 3);
  assert.equal(spacedHit.end, 6);
  assert.equal("🎬 张 三".slice(spacedHit.start, spacedHit.end), "张 三");

  const brackets = matchAssetsForPrompt("🎬张三【少年】", assets);
  assert.equal(brackets.matches.some((item) => item.assetUuid === "role-zhang"), false);
});

test("批量替换必须先算 projectedLength，单条 20000 与合计 2000000 超限整批回滚", async () => {
  await withRuntime(async ({ base }) => {
    const overShot = await createShot(base, { videoPrompt: `${"x".repeat(19_990)}ab` });
    const beforeJournal = await journalGeneration(PROJECT_A);
    const overSingle = await jsonRequest(`${base}/shots/actions/batch-replace-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuids: [overShot.shotUuid],
        findText: "ab",
        replaceText: "abcdefghijklmnopqr",
      }),
    });
    assert.equal(overSingle.status, 400);
    assertSafePublicError(overSingle.body);
    assert.match(String(overSingle.body.message), /长度|上限/);
    const unchanged = await runWithProjectStorage(PROJECT_A, () => (
      activeDb("o_storyboardShot").where({ shotUuid: overShot.shotUuid }).first()
    ));
    assert.equal(unchanged.videoPrompt, `${"x".repeat(19_990)}ab`);
    assert.equal(await journalGeneration(PROJECT_A), beforeJournal);

    const totalRows = Array.from({ length: 110 }, (_, index) => ({
      shotUuid: shotUuidAt(index + 200),
      displayOrder: index + 10,
      videoPrompt: "a".repeat(10_000),
    }));
    await insertShotRows(totalRows);
    const beforeTotalJournal = await journalGeneration(PROJECT_A);
    const overTotal = await jsonRequest(`${base}/shots/actions/batch-replace-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuids: totalRows.map((row) => row.shotUuid),
        findText: "a",
        replaceText: "aa",
      }),
    });
    assert.equal(overTotal.status, 400);
    assertSafePublicError(overTotal.body);
    assert.match(String(overTotal.body.message), /总长度|合计|上限/);
    const afterRow = await runWithProjectStorage(PROJECT_A, () => (
      activeDb("o_storyboardShot").where({ shotUuid: totalRows[0]!.shotUuid }).first()
    ));
    assert.equal(afterRow.videoPrompt, "a".repeat(10_000));
    assert.equal(await journalGeneration(PROJECT_A), beforeTotalJournal);
    void MAX_VIDEO_PROMPT;
    void MAX_BATCH_PROMPT_TOTAL;
  });
});

test("500 条分镜读写必须按最多 5 条一批，且 POST 返回最新分镜 DTO", async () => {
  await withRuntime(async ({ base }) => {
    const xuhe = await createAsset(base, { type: "role", name: "许禾", remark: "小许" });
    const rows = Array.from({ length: MAX_SHOT_ACTION }, (_, index) => ({
      shotUuid: shotUuidAt(index),
      displayOrder: index + 1,
      videoPrompt: "小许在门口",
    }));
    await insertShotRows(rows);
    const captured: Array<{ sql: string; bindings: unknown[] }> = [];
    const collect = (query: { sql?: string; bindings?: unknown[] }) => {
      captured.push({ sql: String(query.sql ?? ""), bindings: Array.isArray(query.bindings) ? query.bindings : [] });
    };
    await runWithProjectStorage(PROJECT_A, () => activeDb.on("query", collect));
    let matched: { status: number; body: any };
    try {
      matched = await jsonRequest(`${base}/shots/actions/auto-match-assets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shotUuids: rows.map((row) => row.shotUuid) }),
      });
    } finally {
      await runWithProjectStorage(PROJECT_A, () => activeDb.off("query", collect));
    }
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    const shotQueries = captured.filter((item) => /o_storyboardShot\b/i.test(item.sql) && !/o_storyboardShotAsset/i.test(item.sql));
    const bindingQueries = captured.filter((item) => /o_storyboardShotAsset/i.test(item.sql));
    for (const item of [...shotQueries, ...bindingQueries]) {
      const sizes = inListSizes(item.sql);
      for (const size of sizes) {
        assert.ok(size <= 5, `IN 列表超过 5：${item.sql}`);
      }
      if (/insert\s+into/i.test(item.sql)) {
        assert.ok(insertRowCount(item.sql, item.bindings) <= 5, `一次 INSERT 超过 5 行：${item.sql}`);
      }
    }
    const bindingInserts = bindingQueries.filter((item) => /insert\s+into/i.test(item.sql));
    assert.ok(bindingInserts.length >= 2, "不得把全部分镜绑定打成一个超大 INSERT");
    assert.ok(bindingInserts.every((item) => insertRowCount(item.sql, item.bindings) <= 5));

    const payloadShots = matched.body.data.shots;
    assert.ok(Array.isArray(payloadShots) && payloadShots.length === MAX_SHOT_ACTION);
    const sample = payloadShots.find((row: any) => row.shotUuid === rows[0]!.shotUuid);
    assert.ok(sample, "必须回传选中分镜");
    assert.equal(sample.videoPrompt, "小许在门口");
    assert.ok(Array.isArray(sample.bindings));
    assert.ok(sample.bindings.some((row: any) => row.assetUuid === xuhe.assetUuid && row.assetType === "role"));
    assert.equal(typeof sample.displayOrder, "number");

    captured.length = 0;
    await runWithProjectStorage(PROJECT_A, () => activeDb.on("query", collect));
    let replaced: { status: number; body: any };
    try {
      replaced = await jsonRequest(`${base}/shots/actions/batch-replace-prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shotUuids: rows.map((row) => row.shotUuid),
          findText: "小许",
          replaceText: "许禾",
        }),
      });
    } finally {
      await runWithProjectStorage(PROJECT_A, () => activeDb.off("query", collect));
    }
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    const shotUpdates = captured.filter((item) => (
      /update\s+[`"]?o_storyboardShot\b/i.test(item.sql) && !/o_storyboardShotAsset/i.test(item.sql)
    ));
    assert.ok(shotUpdates.length > 0, "必须批量更新 videoPrompt");
    assert.ok(shotUpdates.length <= Math.ceil(MAX_SHOT_ACTION / 5), `不得逐镜头 500 次 UPDATE，实际 ${shotUpdates.length}`);
    for (const item of shotUpdates) {
      const sizes = inListSizes(item.sql);
      if (sizes.length) assert.ok(sizes.every((size) => size <= 5), `UPDATE IN 超过 5：${item.sql}`);
      assert.doesNotMatch(item.sql, /where [`"]?shotUuid[`"]?\s*=\s*\?/i);
    }
    const replacedShot = replaced.body.data.shots.find((row: any) => row.shotUuid === rows[0]!.shotUuid);
    assert.equal(replacedShot.videoPrompt, "许禾在门口");
    void tableOf;
  });
});

test("未知异常与超长字段必须返回稳定中文，不得回显 SQL 或路径", async () => {
  await withRuntime(async ({ base }) => {
    const shot = await createShot(base, { videoPrompt: "小许" });
    const originalMatch = StoryboardService.prototype.autoMatchAssets;
    const originalReplace = StoryboardService.prototype.batchReplacePrompt;
    StoryboardService.prototype.autoMatchAssets = async () => {
      throw new Error("SQLITE_ERROR: no such table o_storyboardShotAsset at C:\\Users\\secret\\project.sqlite SELECT * FROM o_legacyMutationJournal");
    };
    StoryboardService.prototype.batchReplacePrompt = async () => {
      throw new Error("SQLITE_ERROR: UNIQUE constraint failed: o_storyboardShot.displayOrder E:\\new-work\\db.sqlite");
    };
    try {
      const matched = await jsonRequest(`${base}/shots/actions/auto-match-assets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shotUuids: [shot.shotUuid] }),
      });
      assert.ok(matched.status >= 400);
      assertSafePublicError(matched.body);
      const replaced = await jsonRequest(`${base}/shots/actions/batch-replace-prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shotUuids: [shot.shotUuid], findText: "小许", replaceText: "许禾" }),
      });
      assert.ok(replaced.status >= 400);
      assertSafePublicError(replaced.body);
    } finally {
      StoryboardService.prototype.autoMatchAssets = originalMatch;
      StoryboardService.prototype.batchReplacePrompt = originalReplace;
    }

    const tooMany = await jsonRequest(`${base}/shots/actions/auto-match-assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shotUuids: Array.from({ length: 501 }, (_, index) => shotUuidAt(index)) }),
    });
    assert.equal(tooMany.status, 400);
    assert.match(String(tooMany.body.message), /最多处理 500|一次最多/);
    assertSafePublicError(tooMany.body);

    const longFind = await jsonRequest(`${base}/shots/actions/batch-replace-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuids: [shot.shotUuid],
        findText: "a".repeat(MAX_FIND_TEXT + 1),
        replaceText: "b",
      }),
    });
    assert.equal(longFind.status, 400);
    assert.match(String(longFind.body.message), /查找文本过长/);
    assert.doesNotMatch(String(longFind.body.message), /不能为空/);
    assertSafePublicError(longFind.body);

    const longReplace = await jsonRequest(`${base}/shots/actions/batch-replace-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuids: [shot.shotUuid],
        findText: "小许",
        replaceText: "b".repeat(MAX_REPLACE_TEXT + 1),
      }),
    });
    assert.equal(longReplace.status, 400);
    assert.match(String(longReplace.body.message), /替换文本过长/);
    assertSafePublicError(longReplace.body);
  });
});
