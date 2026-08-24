/**
 * R9 RED：有绑定不得 text2video，无绑定仍可；预览与正式生成模式一致。
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
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import {
  withStoryboardPreviewDigest,
  writeReadyDreaminaTestCapability,
} from "./helpers/dreamina-capability";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9919 };
const PROJECT_A = "91111111-1111-4111-a111-111111111111";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000a49444154789c6360000002000100ffff03000006000557bf2cd40000000049454e44ae426082",
  "hex",
);

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

async function createRuntimeApp(): Promise<{ server: http.Server; port: number }> {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    enterUserStorage(IDENTITY);
    (req as { centralSession?: unknown }).centralSession = {
      id: "r9-mode-session",
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
  return listen(app);
}

function storyboardUrl(port: number, projectUuid: string): string {
  return `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/storyboard`;
}

async function jsonRequest(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function withTempRuntime(
  prefix: string,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  writeReadyDreaminaTestCapability();
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT_A, {
        id: 919,
        name: "project-a",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => [catalogRow(PROJECT_A)] as any;
      const service = new StoryboardService(PROJECT_A);
      await service.saveSettings({
        globalVideoPrompt: "R9 分镜视频提示词",
        resolution: "720p",
      });
      const { server, port } = await createRuntimeApp();
      try {
        await run(port);
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
    void currentUserStorage;
  }
}

async function createRoleWithImage(port: number, name: string): Promise<string> {
  const form = new FormData();
  form.append("type", "role");
  form.append("name", name);
  form.append("image", new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }), `${name}.png`);
  const created = await fetch(`${storyboardUrl(port, PROJECT_A)}/assets`, { method: "POST", body: form });
  const body = await created.json() as { data?: { assetUuid?: string } };
  assert.equal(created.status, 200, JSON.stringify(body));
  return String(body.data?.assetUuid ?? "");
}

async function insertShot(port: number): Promise<string> {
  const shot = await fetch(`${storyboardUrl(port, PROJECT_A)}/shots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ videoPrompt: "缓慢跟随角色走入剧院" }),
  }).then((response) => response.json()) as { data?: { shotUuid?: string } };
  const shotUuid = String(shot.data?.shotUuid ?? "");
  assert.match(shotUuid, /^[0-9a-f-]{36}$/i);
  return shotUuid;
}

test("有角色绑定的镜头不能用 text2video 预览或正式生成，且不得丢弃绑定假绿", async () => {
  await withTempRuntime("r9-bound-text2video", async (port) => {
    const assetUuid = await createRoleWithImage(port, "林夏");
    const shotUuid = await insertShot(port);
    const bind = await fetch(`${storyboardUrl(port, PROJECT_A)}/shots/${shotUuid}/bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceProjectUuid: PROJECT_A,
        assetUuid,
        assetType: "role",
        relationRole: "appear",
      }),
    });
    assert.equal(bind.status, 200);
    const generateUrl = `${storyboardUrl(port, PROJECT_A)}/generate`;
    const preview = await jsonRequest(`${generateUrl}/preview`, {
      shotUuid,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "text2video",
      durationMs: 5_000,
      aspectRatio: "9:16",
    });
    assert.equal(preview.status, 400, JSON.stringify(preview.body));
    assert.match(String(preview.body?.message ?? ""), /绑定|纯文本/);
    assert.equal(/SQLITE|C:\\|ENOENT|stack/i.test(JSON.stringify(preview.body)), false);

    let generateThrew = false;
    try {
      await withStoryboardPreviewDigest(generateUrl, {
        shotUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "text2video",
        durationMs: 5_000,
        aspectRatio: "9:16",
      });
    } catch {
      generateThrew = true;
    }
    assert.equal(generateThrew, true, "有绑定不得先拿到 text2video 预览摘要");
    const generated = await jsonRequest(generateUrl, {
      shotUuid,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "text2video",
      durationMs: 5_000,
      aspectRatio: "9:16",
      clientOperationId: crypto.randomUUID(),
    });
    assert.equal(generated.status, 400, JSON.stringify(generated.body));
    assert.match(String(generated.body?.message ?? ""), /绑定|纯文本/);
    const listed = await fetch(`${storyboardUrl(port, PROJECT_A)}/shots`).then((response) => response.json()) as {
      data?: Array<{ bindings?: Array<{ assetUuid?: string }> }>;
    };
    assert.equal(listed.data?.[0]?.bindings?.some((item) => item.assetUuid === assetUuid), true);
    const tasks = await runWithProjectStorage(PROJECT_A, () =>
      activeDb("o_storyboardGenerationTask").count<{ total: number }>("taskUuid as total").first());
    assert.equal(Number(tasks?.total ?? 0), 0);
  });
});

test("无绑定镜头仍可 text2video，且预览与正式生成模式一致", async () => {
  await withTempRuntime("r9-free-text2video", async (port) => {
    const shotUuid = await insertShot(port);
    const generateUrl = `${storyboardUrl(port, PROJECT_A)}/generate`;
    const preview = await jsonRequest(`${generateUrl}/preview`, {
      shotUuid,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "text2video",
      durationMs: 5_000,
      aspectRatio: "9:16",
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body?.data?.options?.mode, "text2video");
    const confirmed = await withStoryboardPreviewDigest(generateUrl, {
      shotUuid,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "text2video",
      durationMs: 5_000,
      aspectRatio: "9:16",
    });
    const generated = await jsonRequest(generateUrl, confirmed);
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    const taskUuid = String(generated.body?.data?.[0]?.taskUuid ?? "");
    const row = await runWithProjectStorage(PROJECT_A, () =>
      activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
    const options = JSON.parse(String(row?.parametersJson ?? "{}")) as { options?: { mode?: string } };
    assert.equal(options.options?.mode, "text2video");
    assert.equal(options.options?.mode, preview.body?.data?.options?.mode);
  });
});

test("有绑定镜头 auto 预览与正式生成必须解析为同一模式", async () => {
  await withTempRuntime("r9-bound-auto", async (port) => {
    const assetUuid = await createRoleWithImage(port, "林夏");
    const shotUuid = await insertShot(port);
    await fetch(`${storyboardUrl(port, PROJECT_A)}/shots/${shotUuid}/bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceProjectUuid: PROJECT_A,
        assetUuid,
        assetType: "role",
        relationRole: "appear",
      }),
    });
    const generateUrl = `${storyboardUrl(port, PROJECT_A)}/generate`;
    const preview = await jsonRequest(`${generateUrl}/preview`, {
      shotUuid,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "auto",
      durationMs: 5_000,
      aspectRatio: "9:16",
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const previewMode = String(preview.body?.data?.options?.mode ?? "");
    assert.notEqual(previewMode, "text2video");
    assert.ok(["image2video", "multiframe2video", "multimodal2video"].includes(previewMode), previewMode);
    const confirmed = await withStoryboardPreviewDigest(generateUrl, {
      shotUuid,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "auto",
      durationMs: 5_000,
      aspectRatio: "9:16",
    });
    const generated = await jsonRequest(generateUrl, confirmed);
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    const taskUuid = String(generated.body?.data?.[0]?.taskUuid ?? "");
    const row = await runWithProjectStorage(PROJECT_A, () =>
      activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
    const options = JSON.parse(String(row?.parametersJson ?? "{}")) as { options?: { mode?: string } };
    assert.equal(options.options?.mode, previewMode);
  });
});
