/**
 * R8 RED：o_storyboardShotAsset.voiceEnabled、精确 PATCH、生成音频过滤。
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
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { resolveStoryboardProjectReferences } from "../../src/tianjiang/storyboard/storyboard-generation-service";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9838 };
const PROJECT_A = "81111111-1111-4111-a111-111111111111";
const PROJECT_B = "82222222-2222-4222-a222-222222222222";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000a49444154789c6360000002000100ffff03000006000557bf2cd40000000049454e44ae426082",
  "hex",
);

function wavBytes(): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(40, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(4, 40);
  return Buffer.concat([header, Buffer.from([0, 0, 0, 0])]);
}

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
      id: "voice-r8-session",
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

function assetsUrl(port: number, projectUuid: string): string {
  return `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/storyboard/assets`;
}

function storyboardUrl(port: number, projectUuid: string): string {
  return `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/storyboard`;
}

async function withTempRuntime(
  prefix: string,
  catalog: unknown[],
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
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT_A, {
        id: 801,
        name: "project-a",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await initializeWorkspaceProject(PROJECT_B, {
        id: 802,
        name: "project-b",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => catalog as any;
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

async function createRoleWithMedia(port: number, name: string): Promise<string> {
  const form = new FormData();
  form.append("type", "role");
  form.append("name", name);
  form.append("image", new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }), `${name}.png`);
  form.append("audio", new Blob([new Uint8Array(wavBytes())], { type: "audio/wav" }), `${name}.wav`);
  const created = await fetch(assetsUrl(port, PROJECT_A), { method: "POST", body: form });
  const body = await created.json() as { data?: { assetUuid?: string } };
  assert.equal(created.status, 200, JSON.stringify(body));
  return String(body.data?.assetUuid ?? "");
}

test("o_storyboardShotAsset 必须追加 voiceEnabled，绑定列表按 true 回读", async () => {
  await withTempRuntime("r8-voice-col", [catalogRow(PROJECT_A)], async (port) => {
    await runWithProjectStorage(PROJECT_A, async () => {
      assert.equal(await activeDb.schema.hasColumn("o_storyboardShotAsset", "voiceEnabled"), true, "必须追加 voiceEnabled 列");
    });
    const assetUuid = await createRoleWithMedia(port, "林夏");
    const shot = await fetch(`${storyboardUrl(port, PROJECT_A)}/shots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((response) => response.json()) as { data?: { shotUuid?: string } };
    const shotUuid = String(shot.data?.shotUuid ?? "");
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
    const listed = await fetch(`${storyboardUrl(port, PROJECT_A)}/shots`).then((response) => response.json()) as {
      data?: Array<{ bindings?: Array<{ voiceEnabled?: boolean; assetUuid?: string }> }>;
    };
    const binding = listed.data?.[0]?.bindings?.find((item) => item.assetUuid === assetUuid);
    assert.equal(binding?.voiceEnabled, true);
    const assets = await fetch(assetsUrl(port, PROJECT_A)).then((response) => response.json()) as {
      data?: { assets?: Array<{ assetUuid?: string; hasAudio?: boolean }> };
    };
    assert.equal(assets.data?.assets?.find((item) => item.assetUuid === assetUuid)?.hasAudio, true);
  });
});

test("PATCH 绑定只更新精确角色 voiceEnabled，只读/跨项目/非角色必须拒绝", async () => {
  await withTempRuntime("r8-voice-patch", [catalogRow(PROJECT_A), catalogRow(PROJECT_B)], async (port) => {
    const assetUuid = await createRoleWithMedia(port, "林夏");
    const scene = await fetch(assetsUrl(port, PROJECT_A), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "scene", name: "剧院" }),
    }).then((response) => response.json()) as { data?: { assetUuid?: string } };
    const shot = await fetch(`${storyboardUrl(port, PROJECT_A)}/shots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((response) => response.json()) as { data?: { shotUuid?: string } };
    const shotUuid = String(shot.data?.shotUuid ?? "");
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
    await fetch(`${storyboardUrl(port, PROJECT_A)}/shots/${shotUuid}/bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceProjectUuid: PROJECT_A,
        assetUuid: scene.data?.assetUuid,
        assetType: "scene",
        relationRole: "appear",
      }),
    });

    const missing = await fetch(
      `${storyboardUrl(port, PROJECT_A)}/shots/${shotUuid}/bindings/99999999-9999-4999-a999-999999999999?sourceProjectUuid=${PROJECT_A}&assetType=role&relationRole=appear`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ voiceEnabled: false }) },
    );
    assert.equal(missing.status, 404);

    const sceneDenied = await fetch(
      `${storyboardUrl(port, PROJECT_A)}/shots/${shotUuid}/bindings/${scene.data?.assetUuid}?sourceProjectUuid=${PROJECT_A}&assetType=scene&relationRole=appear`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ voiceEnabled: false }) },
    );
    assert.equal(sceneDenied.status, 400);

    const stolen = await fetch(
      `${storyboardUrl(port, PROJECT_B)}/shots/${shotUuid}/bindings/${assetUuid}?sourceProjectUuid=${PROJECT_A}&assetType=role&relationRole=appear`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ voiceEnabled: false }) },
    );
    assert.ok([403, 404].includes(stolen.status), `跨项目更新应拒绝: ${stolen.status}`);

    const patched = await fetch(
      `${storyboardUrl(port, PROJECT_A)}/shots/${shotUuid}/bindings/${assetUuid}?sourceProjectUuid=${PROJECT_A}&assetType=role&relationRole=appear`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ voiceEnabled: false }) },
    );
    const patchedBody = await patched.json() as { data?: { voiceEnabled?: boolean }; message?: string };
    assert.notEqual(patched.status, 404, "PATCH 绑定路由必须存在");
    assert.equal(patched.status, 200, JSON.stringify(patchedBody));
    assert.equal(patchedBody.data?.voiceEnabled, false);
    assert.equal(/SQLITE|C:\\|ENOENT/i.test(JSON.stringify(patchedBody)), false);
  });
});

test("只读项目更新音色开关必须 403", async () => {
  await withTempRuntime("r8-voice-ro", [catalogRow(PROJECT_A, "viewer")], async (port) => {
    const denied = await fetch(
      `${storyboardUrl(port, PROJECT_A)}/shots/81111111-1111-4111-a111-111111111101/bindings/81111111-1111-4111-a111-111111111801?sourceProjectUuid=${PROJECT_A}&assetType=role&relationRole=appear`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ voiceEnabled: false }) },
    );
    assert.equal(denied.status, 403);
  });
});

test("voiceEnabled=false 时解析引用不得包含该角色音频，开启时必须包含", async () => {
  await withTempRuntime("r8-voice-refs", [catalogRow(PROJECT_A)], async (port) => {
    const assetUuid = await createRoleWithMedia(port, "林夏");
    const shot = await fetch(`${storyboardUrl(port, PROJECT_A)}/shots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((response) => response.json()) as { data?: { shotUuid?: string } };
    const shotUuid = String(shot.data?.shotUuid ?? "");
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
    const enabled = await resolveStoryboardProjectReferences({
      projectUuid: PROJECT_A,
      bindings: [{ sourceProjectUuid: PROJECT_A, assetUuid, assetType: "role", relationRole: "appear", voiceEnabled: true }],
    });
    assert.ok(enabled.some((item) => item.mediaType === "audio"), "开启时必须解析角色音频");
    assert.equal(enabled.filter((item) => item.mediaType === "audio").length, 1);

    await fetch(
      `${storyboardUrl(port, PROJECT_A)}/shots/${shotUuid}/bindings/${assetUuid}?sourceProjectUuid=${PROJECT_A}&assetType=role&relationRole=appear`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ voiceEnabled: false }) },
    );
    const disabled = await resolveStoryboardProjectReferences({
      projectUuid: PROJECT_A,
      bindings: [{ sourceProjectUuid: PROJECT_A, assetUuid, assetType: "role", relationRole: "appear", voiceEnabled: false }],
    });
    assert.equal(disabled.some((item) => item.mediaType === "audio"), false, "关闭后不得包含该角色音频");
    assert.ok(disabled.some((item) => item.mediaType === "image"), "关闭后仍保留角色图片");
  });
});
