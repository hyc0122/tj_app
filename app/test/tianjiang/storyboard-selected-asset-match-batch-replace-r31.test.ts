/**
 * RED4/RED5：RuntimePermissionError 只能决定 HTTP 403 与 body.code=403，不得公开业务码或非白名单消息。
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
import { RuntimePermissionError } from "../../src/tianjiang/runtime/sync-coordinator";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9825 };
const PROJECT_A = "83111111-1111-4111-a111-111111111111";
const MATCH_FALLBACK = "自动匹配资产失败，请重试";
const REPLACE_FALLBACK = "批量替换失败，请重试";
const SAFE_PERMISSION_MESSAGE = "团队项目当前只读";
const LEAKY_PERMISSION_MESSAGE = "no such table: tenant_config";
const BUSINESS_WHITELIST_CODE = "STORYBOARD_PROMPT_TOO_LONG";

function permissionError(message: string): RuntimePermissionError {
  return Object.assign(new RuntimePermissionError(message), { code: BUSINESS_WHITELIST_CODE });
}

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

function assertPermissionBodyCode(code: unknown): void {
  assert.equal(code, 403);
}

async function withRuntime(run: (base: string) => Promise<void>): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-r31-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
        id: 831,
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
          id: "r31-session",
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

async function createShot(base: string): Promise<string> {
  const created = await jsonRequest(`${base}/shots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ afterShotUuid: null, sourceText: "源" }),
  });
  assert.equal(created.status, 200);
  return String(created.body.data.shotUuid);
}

test("权限异常含表名必须 HTTP 403，body 不得含 no such table/tenant_config，message 用接口固定 fallback", async () => {
  await withRuntime(async (base) => {
    const shotUuid = await createShot(base);
    const originalMatch = StoryboardService.prototype.autoMatchAssets;
    const originalReplace = StoryboardService.prototype.batchReplacePrompt;
    StoryboardService.prototype.autoMatchAssets = async () => {
      throw permissionError(LEAKY_PERMISSION_MESSAGE);
    };
    StoryboardService.prototype.batchReplacePrompt = async () => {
      throw permissionError(LEAKY_PERMISSION_MESSAGE);
    };
    try {
      const matched = await jsonRequest(`${base}/shots/actions/auto-match-assets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shotUuids: [shotUuid] }),
      });
      assert.equal(matched.status, 403);
      assertPermissionBodyCode(matched.body.code);
      assert.equal(matched.body.message, MATCH_FALLBACK);
      assert.doesNotMatch(JSON.stringify(matched.body), /no such table|tenant_config|STORYBOARD_PROMPT_TOO_LONG|STORYBOARD_PERMISSION_DENIED/i);

      const replaced = await jsonRequest(`${base}/shots/actions/batch-replace-prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shotUuids: [shotUuid], findText: "小许", replaceText: "许禾" }),
      });
      assert.equal(replaced.status, 403);
      assertPermissionBodyCode(replaced.body.code);
      assert.equal(replaced.body.message, REPLACE_FALLBACK);
      assert.doesNotMatch(JSON.stringify(replaced.body), /no such table|tenant_config|STORYBOARD_PROMPT_TOO_LONG|STORYBOARD_PERMISSION_DENIED/i);
    } finally {
      StoryboardService.prototype.autoMatchAssets = originalMatch;
      StoryboardService.prototype.batchReplacePrompt = originalReplace;
    }
  });
});

test("只有精确白名单权限消息可以公开，现有安全文案团队项目当前只读必须原样返回", async () => {
  await withRuntime(async (base) => {
    const shotUuid = await createShot(base);
    const originalMatch = StoryboardService.prototype.autoMatchAssets;
    const originalReplace = StoryboardService.prototype.batchReplacePrompt;
    StoryboardService.prototype.autoMatchAssets = async () => {
      throw permissionError(SAFE_PERMISSION_MESSAGE);
    };
    StoryboardService.prototype.batchReplacePrompt = async () => {
      throw permissionError(SAFE_PERMISSION_MESSAGE);
    };
    try {
      const matched = await jsonRequest(`${base}/shots/actions/auto-match-assets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shotUuids: [shotUuid] }),
      });
      assert.equal(matched.status, 403);
      assertPermissionBodyCode(matched.body.code);
      assert.equal(matched.body.message, SAFE_PERMISSION_MESSAGE);
      assert.doesNotMatch(JSON.stringify(matched.body), /STORYBOARD_PROMPT_TOO_LONG|STORYBOARD_PERMISSION_DENIED/);

      const replaced = await jsonRequest(`${base}/shots/actions/batch-replace-prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shotUuids: [shotUuid], findText: "小许", replaceText: "许禾" }),
      });
      assert.equal(replaced.status, 403);
      assertPermissionBodyCode(replaced.body.code);
      assert.equal(replaced.body.message, SAFE_PERMISSION_MESSAGE);
      assert.doesNotMatch(JSON.stringify(replaced.body), /STORYBOARD_PROMPT_TOO_LONG|STORYBOARD_PERMISSION_DENIED/);
    } finally {
      StoryboardService.prototype.autoMatchAssets = originalMatch;
      StoryboardService.prototype.batchReplacePrompt = originalReplace;
    }
  });
});
