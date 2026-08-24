/**
 * RED3：字面量计数必须用 indexOf 游标；未知异常必须 500 + 稳定公共码。
 */
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import test from "node:test";
import express from "express";

import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  enterUserStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9824 };
const PROJECT_A = "82111111-1111-4111-a111-111111111111";

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

async function withRuntime(run: (base: string) => Promise<void>): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-r30-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
        id: 821,
        name: "project-a",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow(PROJECT_A)] as any;
      const app = express();
      app.use(express.json({ limit: "2mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          id: "r30-session",
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
      const base = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_A}/storyboard`;
      try {
        await run(base);
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

test("纯计数/规划函数对不重叠 aa 计为 2，且不调用 split/join/replaceAll", async () => {
  const mod = await import("../../src/tianjiang/storyboard/storyboard-prompt-replace");
  const originalSplit = String.prototype.split;
  const originalJoin = Array.prototype.join;
  const originalReplaceAll = String.prototype.replaceAll;
  let forbiddenCalls = 0;
  String.prototype.split = function (this: string, separator: any, limit?: number) {
    forbiddenCalls += 1;
    return originalSplit.call(this, separator, limit);
  };
  Array.prototype.join = function (this: unknown[], separator?: string) {
    forbiddenCalls += 1;
    return originalJoin.call(this, separator);
  };
  String.prototype.replaceAll = function (this: string, searchValue: any, replaceValue: any) {
    forbiddenCalls += 1;
    return originalReplaceAll.call(this, searchValue, replaceValue);
  };
  try {
    assert.equal(mod.countLiteralOccurrences("aaaa", "aa"), 2);
    assert.equal(mod.countLiteralOccurrences("ababab", "ab"), 3);
    assert.equal(mod.countLiteralOccurrences("aaa", "aa"), 1);
    const planned = mod.planLiteralReplacement("aaaa", "aa", "b");
    assert.equal(planned.count, 2);
    assert.equal(planned.projectedLength, 2);
    assert.equal(mod.applyLiteralReplacement("aaaa", "aa", "b"), "bb");
    assert.equal(forbiddenCalls, 0, "计数和构造替换结果不得 split/join/replaceAll");
  } finally {
    String.prototype.split = originalSplit;
    Array.prototype.join = originalJoin;
    String.prototype.replaceAll = originalReplaceAll;
  }
});

test("未知异常必须 HTTP 500 且公共码 STORYBOARD_BATCH_TOOL_FAILED，body 不得含 SQLITE", async () => {
  await withRuntime(async (base) => {
    const created = await jsonRequest(`${base}/shots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ afterShotUuid: null, sourceText: "源" }),
    });
    assert.equal(created.status, 200);
    const shotUuid = String(created.body.data.shotUuid);
    const originalMatch = StoryboardService.prototype.autoMatchAssets;
    const originalReplace = StoryboardService.prototype.batchReplacePrompt;
    StoryboardService.prototype.autoMatchAssets = async () => {
      throw Object.assign(
        new Error("SQLITE_ERROR: no such table o_storyboardShotAsset at C:\\Users\\secret\\project.sqlite"),
        { code: "SQLITE_ERROR" },
      );
    };
    StoryboardService.prototype.batchReplacePrompt = async () => {
      throw Object.assign(
        new Error("SQLITE_ERROR: UNIQUE constraint failed: o_storyboardShot E:\\new-work\\db.sqlite"),
        { code: "SQLITE_ERROR" },
      );
    };
    try {
      const matched = await jsonRequest(`${base}/shots/actions/auto-match-assets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shotUuids: [shotUuid] }),
      });
      assert.equal(matched.status, 500);
      assert.equal(matched.body.code, "STORYBOARD_BATCH_TOOL_FAILED");
      assert.match(String(matched.body.message), /失败/);
      assert.doesNotMatch(JSON.stringify(matched.body), /SQLITE|sqlite|o_storyboard|C:\\\\Users|E:\\\\new-work/i);

      const replaced = await jsonRequest(`${base}/shots/actions/batch-replace-prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shotUuids: [shotUuid], findText: "小许", replaceText: "许禾" }),
      });
      assert.equal(replaced.status, 500);
      assert.equal(replaced.body.code, "STORYBOARD_BATCH_TOOL_FAILED");
      assert.match(String(replaced.body.message), /失败/);
      assert.doesNotMatch(JSON.stringify(replaced.body), /SQLITE|sqlite|o_storyboard|C:\\\\Users|E:\\\\new-work/i);
    } finally {
      StoryboardService.prototype.autoMatchAssets = originalMatch;
      StoryboardService.prototype.batchReplacePrompt = originalReplace;
    }
  });
});
