/**
 * R6 RED：imageRatio、原子新建、精确解绑、名称回读与替换图历史。
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

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9836 };
const PROJECT_A = "61111111-1111-4111-a111-111111111111";
const PROJECT_B = "62222222-2222-4222-a222-222222222222";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000a49444154789c6360000002000100ffff03000006000557bf2cd40000000049454e44ae426082",
  "hex",
);
const PNG_B = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000a49444154789c63606000000002000100ffff03000006000557bf2cd40000000049454e44ae426082",
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

function catalogRow(projectUuid: string, assetSourceProjectUuid?: string, role = "owner") {
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
    assetSourceProjectUuid,
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
      id: "asset-r6-session",
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
        id: 601,
        name: "project-a",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await initializeWorkspaceProject(PROJECT_B, {
        id: 602,
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

test("o_assets 必须追加 imageRatio，缺值按 16:9 展示且只接受 16:9/9:16", async () => {
  await withTempRuntime("r6-ratio", [catalogRow(PROJECT_A)], async (port) => {
    const base = assetsUrl(port, PROJECT_A);
    await runWithProjectStorage(PROJECT_A, async () => {
      assert.equal(await activeDb.schema.hasColumn("o_assets", "imageRatio"), true, "必须追加 imageRatio 列");
    });
    const created = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "scene", name: "旧亭", imageRatio: "9:16" }),
    });
    const body = await created.json() as { data?: Record<string, unknown> };
    assert.equal(created.status, 200, JSON.stringify(body));
    assert.equal(body.data?.imageRatio, "9:16");
    await runWithProjectStorage(PROJECT_A, async () => {
      const row = await activeDb("o_assets").where({ assetUuid: body.data?.assetUuid }).first();
      assert.equal(row.imageRatio, "9:16");
    });

    const listed = await fetch(base).then((response) => response.json()) as { data?: { assets?: Array<Record<string, unknown>> } };
    const missing = (listed.data?.assets ?? []).find((item) => item.name === "旧亭");
    assert.equal(missing?.imageRatio, "9:16");

    const invalid = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "tool", name: "伞", imageRatio: "4:3" }),
    });
    assert.equal(invalid.status, 400);
    await runWithProjectStorage(PROJECT_A, async () => {
      const count = Number((await activeDb("o_assets").where({ name: "伞" }).count("* as count").first())?.count ?? 0);
      assert.equal(count, 0);
    });
  });
});

test("新建角色可在同一次请求中上传图片和音色，媒体失败不得残留资产", async () => {
  await withTempRuntime("r6-atomic", [catalogRow(PROJECT_A)], async (port) => {
    const base = assetsUrl(port, PROJECT_A);
    const ok = new FormData();
    ok.append("type", "role");
    ok.append("name", "林夏");
    ok.append("describe", "女主");
    ok.append("remark", "夏夏");
    ok.append("prompt", "portrait");
    ok.append("imageRatio", "9:16");
    ok.append("image", new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }), "linxia.png");
    ok.append("audio", new Blob([new Uint8Array(wavBytes())], { type: "audio/wav" }), "linxia.wav");
    const created = await fetch(base, { method: "POST", body: ok });
    const createdBody = await created.json() as { data?: Record<string, unknown>; message?: string };
    assert.equal(created.status, 200, `原子新建失败: ${JSON.stringify(createdBody)}`);
    assert.equal(createdBody.data?.imageRatio, "9:16");
    assert.match(String(createdBody.data?.coverUrl ?? ""), /\/files\/images\//);
    await runWithProjectStorage(PROJECT_A, async () => {
      const parent = await activeDb("o_assets").where({ assetUuid: createdBody.data?.assetUuid }).first();
      assert.ok(parent.imageId);
      const bindings = await activeDb("o_assetsRole2Audio").where({ assetsRoleId: parent.id });
      assert.equal(bindings.length, 1);
    });

    const bad = new FormData();
    bad.append("type", "role");
    bad.append("name", "半成品");
    bad.append("image", new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }), "half.png");
    bad.append("audio", new Blob([Uint8Array.from(Buffer.from("not-audio"))], { type: "audio/wav" }), "half.wav");
    const rejected = await fetch(base, { method: "POST", body: bad });
    const rejectedText = await rejected.text();
    assert.notEqual(rejected.status, 200);
    assert.match(rejectedText, /音频|文件|格式/);
    assert.equal(/SQLITE|C:\\|ENOENT/i.test(rejectedText), false);
    await runWithProjectStorage(PROJECT_A, async () => {
      const leftover = Number((await activeDb("o_assets").where({ name: "半成品" }).count("* as count").first())?.count ?? 0);
      assert.equal(leftover, 0, "媒体失败必须零残留");
    });
  });
});

test("批量上传与导入必须写入 imageRatio，character_kind/video_prompt 继续整批拒绝", async () => {
  await withTempRuntime("r6-batch-import", [catalogRow(PROJECT_A)], async (port) => {
    const base = assetsUrl(port, PROJECT_A);
    const form = new FormData();
    form.append("type", "scene");
    form.append("imageRatio", "9:16");
    form.append("file", new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }), "剧院.png");
    const uploaded = await fetch(`${base}/batch`, { method: "POST", body: form });
    const uploadedBody = await uploaded.json() as { data?: { created?: number } };
    assert.equal(uploaded.status, 200, JSON.stringify(uploadedBody));
    await runWithProjectStorage(PROJECT_A, async () => {
      const row = await activeDb("o_assets").where({ type: "scene", name: "剧院" }).first();
      assert.equal(row.imageRatio, "9:16");
    });

    const imported = await fetch(`${base}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format: "json",
        text: JSON.stringify([{ type: "tool", name: "黑伞", description: "道具", image_ratio: "16:9" }]),
      }),
    });
    const importBody = await imported.json() as { data?: Record<string, number> };
    assert.equal(imported.status, 200, JSON.stringify(importBody));
    assert.equal(importBody.data?.created, 1);
    await runWithProjectStorage(PROJECT_A, async () => {
      const row = await activeDb("o_assets").where({ type: "tool", name: "黑伞" }).first();
      assert.equal(row.imageRatio, "16:9");
    });

    const rejected = await fetch(`${base}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format: "csv",
        text: "type,name,character_kind,video_prompt\nrole,卫兵,群演,walk\n",
      }),
    });
    const rejectedText = await rejected.text();
    assert.notEqual(rejected.status, 200);
    assert.match(rejectedText, /不支持字段/);
    assert.match(rejectedText, /character_kind|video_prompt/);
    await runWithProjectStorage(PROJECT_A, async () => {
      const count = Number((await activeDb("o_assets").where({ name: "卫兵" }).count("* as count").first())?.count ?? 0);
      assert.equal(count, 0);
    });
  });
});

test("精确解绑只删除匹配记录，404/403/跨项目必须拒绝", async () => {
  await withTempRuntime("r6-unbind", [catalogRow(PROJECT_A), catalogRow(PROJECT_B)], async (port) => {
    const shotsA = `${storyboardUrl(port, PROJECT_A)}/shots`;
    const createdShot = await fetch(shotsA, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const shotBody = await createdShot.json() as { data?: { shotUuid?: string } };
    assert.equal(createdShot.status, 200, JSON.stringify(shotBody));
    const shotUuid = String(shotBody.data?.shotUuid ?? "");
    const createdAsset = await fetch(assetsUrl(port, PROJECT_A), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "role", name: "林夏" }),
    }).then((response) => response.json()) as { data: { assetUuid: string } };
    const bind = await fetch(`${shotsA}/${shotUuid}/bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceProjectUuid: PROJECT_A,
        assetUuid: createdAsset.data.assetUuid,
        assetType: "role",
        relationRole: "appear",
      }),
    });
    assert.equal(bind.status, 200);

    const missing = await fetch(
      `${shotsA}/${shotUuid}/bindings/99999999-9999-4999-a999-999999999999?sourceProjectUuid=${PROJECT_A}&assetType=role`,
      { method: "DELETE" },
    );
    assert.equal(missing.status, 404);

    const stolen = await fetch(
      `${storyboardUrl(port, PROJECT_B)}/shots/${shotUuid}/bindings/${createdAsset.data.assetUuid}?sourceProjectUuid=${PROJECT_A}&assetType=role`,
      { method: "DELETE" },
    );
    assert.ok([403, 404].includes(stolen.status), `跨项目解绑应拒绝: ${stolen.status}`);

    const unbound = await fetch(
      `${shotsA}/${shotUuid}/bindings/${createdAsset.data.assetUuid}?sourceProjectUuid=${PROJECT_A}&assetType=role`,
      { method: "DELETE" },
    );
    assert.notEqual(unbound.status, 404, "解绑路由必须存在");
    assert.equal(unbound.status, 200, await unbound.text());
    await runWithProjectStorage(PROJECT_A, async () => {
      const left = Number((await activeDb("o_storyboardShotAsset").count("* as count").first())?.count ?? 0);
      assert.equal(left, 0);
    });
  });
});

test("只读项目解绑必须 403", async () => {
  await withTempRuntime("r6-unbind-ro", [catalogRow(PROJECT_A, undefined, "viewer")], async (port) => {
    const denied = await fetch(
      `${storyboardUrl(port, PROJECT_A)}/shots/61111111-1111-4111-a111-111111111101/bindings/61111111-1111-4111-a111-111111111801?sourceProjectUuid=${PROJECT_A}&assetType=role`,
      { method: "DELETE" },
    );
    assert.equal(denied.status, 403);
  });
});

test("编辑名称后绑定列表返回新名称；替换图片后旧图保留历史", async () => {
  await withTempRuntime("r6-edit-replace", [catalogRow(PROJECT_A)], async (port) => {
    const base = assetsUrl(port, PROJECT_A);
    const created = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "role", name: "旧名" }),
    }).then((response) => response.json()) as { data: { assetUuid: string } };
    const first = new FormData();
    first.append("file", new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }), "a.png");
    assert.equal((await fetch(`${base}/${created.data.assetUuid}/image`, { method: "POST", body: first })).status, 200);

    const patched = await fetch(`${base}/${created.data.assetUuid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "新名", imageRatio: "9:16" }),
    });
    assert.equal(patched.status, 200);
    const listed = await fetch(base).then((response) => response.json()) as { data?: { assets?: Array<Record<string, unknown>> } };
    const item = (listed.data?.assets ?? []).find((row) => row.assetUuid === created.data.assetUuid);
    assert.equal(item?.name, "新名");
    assert.equal(item?.imageRatio, "9:16");

    const second = new FormData();
    second.append("file", new Blob([new Uint8Array(PNG_B)], { type: "image/png" }), "b.png");
    assert.equal((await fetch(`${base}/${created.data.assetUuid}/image`, { method: "POST", body: second })).status, 200);
    await runWithProjectStorage(PROJECT_A, async () => {
      const parent = await activeDb("o_assets").where({ assetUuid: created.data.assetUuid }).first();
      const history = await activeDb("o_image").where({ assetsId: parent.id }).andWhere({ state: "已完成" });
      assert.equal(history.length, 2, "旧图必须留在历史");
      assert.ok(history.some((row) => Number(row.id) === Number(parent.imageId)));
      assert.ok(history.some((row) => Number(row.id) !== Number(parent.imageId)));
    });
  });
});
