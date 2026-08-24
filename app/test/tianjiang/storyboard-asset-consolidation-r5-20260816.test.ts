/**
 * R5 RED：分镜资产必须写入现有 o_assets，并支持备注、提示词、音频、整批上传与导入。
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

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9831 };
const PROJECT_A = "31111111-1111-4111-a111-111111111111";
const PROJECT_B = "32222222-2222-4222-a222-222222222222";
const SOURCE = "33333333-3333-4333-a333-333333333333";

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
      id: "asset-r5-session",
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
        id: 501,
        name: "project-a",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await initializeWorkspaceProject(PROJECT_B, {
        id: 502,
        name: "project-b",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await initializeWorkspaceProject(SOURCE, {
        id: 503,
        name: "source",
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

test("现有 o_assets 必须能新建角色、场景、道具，并持久化别名与生图提示词", async () => {
  await withTempRuntime("r5-create", [catalogRow(PROJECT_A)], async (port) => {
    const base = assetsUrl(port, PROJECT_A);
    const cases = [
      { type: "role", name: "林夏", remark: "夏夏", describe: "女主角", prompt: "portrait of linxia" },
      { type: "scene", name: "雨夜剧院", remark: "剧院", describe: "主场景", prompt: "rain theatre" },
      { type: "tool", name: "黑伞", remark: "伞", describe: "关键道具", prompt: "black umbrella" },
    ] as const;
    for (const item of cases) {
      const created = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(item),
      });
      const body = await created.json() as { data?: Record<string, unknown>; message?: string };
      assert.equal(created.status, 200, `新建 ${item.type} 失败: ${JSON.stringify(body)}`);
      assert.match(String(body.data?.assetUuid ?? ""), /^[0-9a-f-]{36}$/i);
      await runWithProjectStorage(PROJECT_A, async () => {
        const row = await activeDb("o_assets").where({ assetUuid: body.data?.assetUuid }).first();
        assert.ok(row, `${item.name} 必须写入 o_assets`);
        assert.equal(row.type, item.type);
        assert.equal(row.name, item.name);
        assert.equal(row.remark, item.remark);
        assert.equal(row.describe, item.describe);
        assert.equal(row.prompt, item.prompt);
        assert.equal(row.assetsId ?? null, null);
      });
    }
  });
});

test("角色可上传图片和音频，场景与道具只允许图片", async () => {
  await withTempRuntime("r5-media", [catalogRow(PROJECT_A)], async (port) => {
    const base = assetsUrl(port, PROJECT_A);
    const role = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "role", name: "林夏", describe: "女主" }),
    }).then((response) => response.json()) as { data: { assetUuid: string } };
    const scene = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "scene", name: "剧院" }),
    }).then((response) => response.json()) as { data: { assetUuid: string } };

    const roleImage = new FormData();
    roleImage.append("file", new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }), "linxia.png");
    const uploadedImage = await fetch(`${base}/${role.data.assetUuid}/image`, { method: "POST", body: roleImage });
    assert.equal(uploadedImage.status, 200);

    const roleAudio = new FormData();
    roleAudio.append("file", new Blob([new Uint8Array(wavBytes())], { type: "audio/wav" }), "linxia.wav");
    const uploadedAudio = await fetch(`${base}/${role.data.assetUuid}/audio`, { method: "POST", body: roleAudio });
    assert.notEqual(uploadedAudio.status, 404, "角色音频上传路由必须存在");
    const audioBody = await uploadedAudio.json() as { data?: Record<string, unknown>; message?: string };
    assert.equal(uploadedAudio.status, 200, `角色音频上传失败: ${JSON.stringify(audioBody)}`);
    assert.equal(JSON.stringify(audioBody).includes("C:"), false);
    assert.equal(JSON.stringify(audioBody).includes("filePath"), false);

    await runWithProjectStorage(PROJECT_A, async () => {
      const parent = await activeDb("o_assets").where({ assetUuid: role.data.assetUuid }).first();
      const bindings = await activeDb("o_assetsRole2Audio").where({ assetsRoleId: parent.id });
      assert.equal(bindings.length, 1, "角色必须通过现有 o_assetsRole2Audio 关联音频");
    });

    const sceneAudio = new FormData();
    sceneAudio.append("file", new Blob([new Uint8Array(wavBytes())], { type: "audio/wav" }), "theatre.wav");
    const rejected = await fetch(`${base}/${scene.data.assetUuid}/audio`, { method: "POST", body: sceneAudio });
    assert.equal(rejected.status, 400, "场景不得上传音频");
  });
});

test("批量上传成功时按文件名归并同一资产，且能被分镜绑定列表读取", async () => {
  await withTempRuntime("r5-batch-ok", [catalogRow(PROJECT_A)], async (port) => {
    const base = assetsUrl(port, PROJECT_A);
    const form = new FormData();
    form.append("type", "role");
    form.append("file", new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }), "林夏.png");
    form.append("file", new Blob([new Uint8Array(wavBytes())], { type: "audio/wav" }), "林夏.wav");
    form.append("file", new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }), "卫兵.png");
    const uploaded = await fetch(`${base}/batch`, { method: "POST", body: form });
    assert.notEqual(uploaded.status, 404, "批量上传路由必须存在");
    const body = await uploaded.json() as { data?: { created?: number; updated?: number; assets?: Array<{ name: string }> } };
    assert.equal(uploaded.status, 200, `批量上传失败: ${JSON.stringify(body)}`);
    assert.equal(body.data?.created, 2);

    const listed = await fetch(base);
    const listBody = await listed.json() as { data?: { assets?: Array<Record<string, unknown>> } };
    const names = (listBody.data?.assets ?? []).map((item) => item.name);
    assert.deepEqual(names.sort(), ["卫兵", "林夏"]);
    assert.equal((listBody.data?.assets ?? []).every((item) => ["role", "scene", "tool"].includes(String(item.type))), true);
    await runWithProjectStorage(PROJECT_A, async () => {
      const rows = await activeDb("o_assets").whereIn("type", ["role", "scene", "tool"]).whereNull("assetsId");
      assert.equal(rows.length, 2);
    });
  });
});

test("非法文件导致整批零写入，且响应不得泄露路径或堆栈", async () => {
  await withTempRuntime("r5-batch-fail", [catalogRow(PROJECT_A)], async (port) => {
    const base = assetsUrl(port, PROJECT_A);
    const form = new FormData();
    form.append("type", "scene");
    form.append("file", new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }), "剧院.png");
    form.append("file", new Blob([Uint8Array.from(Buffer.from("not-media"))], { type: "application/octet-stream" }), "C:\\\\Users\\\\secret\\\\evil.exe");
    const uploaded = await fetch(`${base}/batch`, { method: "POST", body: form });
    const text = await uploaded.text();
    assert.notEqual(uploaded.status, 404, "批量上传路由必须存在");
    assert.notEqual(uploaded.status, 200, "含非法文件的整批必须拒绝");
    assert.equal(text.includes("C:"), false, "拒绝响应不得泄露盘符");
    assert.equal(/stack|SQLITE|ENOENT|at\s+\S+\.ts/i.test(text), false, "拒绝响应不得泄露堆栈或数据库原文");
    await runWithProjectStorage(PROJECT_A, async () => {
      const count = Number((await activeDb("o_assets").count("* as count").first())?.count ?? 0);
      assert.equal(count, 0, "非法整批必须零写入");
    });
  });
});

test("JSON 与 CSV 导入必须映射字段，并可更新同名资产", async () => {
  await withTempRuntime("r5-import-ok", [catalogRow(PROJECT_A)], async (port) => {
    const base = assetsUrl(port, PROJECT_A);
    const jsonImport = await fetch(`${base}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format: "json",
        text: JSON.stringify([
          {
            type: "character",
            name: "林夏",
            aliases: ["夏夏", "Lin"],
            description: "女主角",
            prompt: "portrait",
          },
          {
            type: "场景",
            name: "剧院",
            describe: "夜戏",
            image_params: "rain theatre",
          },
        ]),
      }),
    });
    assert.notEqual(jsonImport.status, 404, "导入路由必须存在");
    const jsonBody = await jsonImport.json() as { data?: Record<string, number> };
    assert.equal(jsonImport.status, 200, `JSON 导入失败: ${JSON.stringify(jsonBody)}`);
    assert.equal(jsonBody.data?.created, 2);
    assert.equal(jsonBody.data?.updated, 0);
    assert.equal(jsonBody.data?.failed, 0);

    await runWithProjectStorage(PROJECT_A, async () => {
      const role = await activeDb("o_assets").where({ type: "role", name: "林夏" }).first();
      const scene = await activeDb("o_assets").where({ type: "scene", name: "剧院" }).first();
      assert.equal(role.remark, "夏夏,Lin");
      assert.equal(role.describe, "女主角");
      assert.equal(role.prompt, "portrait");
      assert.equal(scene.describe, "夜戏");
      assert.equal(scene.prompt, "rain theatre");
    });

    const csvImport = await fetch(`${base}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format: "csv",
        text: "type,name,aliases,description,prompt\nprop,黑伞,伞,关键道具,black umbrella\nrole,林夏,夏夏,更新后的女主,new portrait\n",
      }),
    });
    const csvBody = await csvImport.json() as { data?: Record<string, number> };
    assert.equal(csvImport.status, 200, `CSV 导入失败: ${JSON.stringify(csvBody)}`);
    assert.equal(csvBody.data?.created, 1);
    assert.equal(csvBody.data?.updated, 1);

    const listed = await fetch(base);
    const listBody = await listed.json() as { data?: { assets?: Array<Record<string, unknown>> } };
    const names = (listBody.data?.assets ?? []).map((item) => `${item.type}:${item.name}`).sort();
    assert.deepEqual(names, ["role:林夏", "scene:剧院", "tool:黑伞"]);
    await runWithProjectStorage(PROJECT_A, async () => {
      const role = await activeDb("o_assets").where({ type: "role", name: "林夏" }).first();
      assert.equal(role.describe, "更新后的女主");
      assert.equal(role.prompt, "new portrait");
      const count = Number((await activeDb("o_assets").where({ type: "role", name: "林夏" }).count("* as count").first())?.count ?? 0);
      assert.equal(count, 1, "同名同类型不得产生重复垃圾记录");
    });
  });
});

test("非法导入或未支持字段必须整批零写入，并指出安全原因", async () => {
  await withTempRuntime("r5-import-fail", [catalogRow(PROJECT_A)], async (port) => {
    const base = assetsUrl(port, PROJECT_A);
    const missingName = await fetch(`${base}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format: "json",
        text: JSON.stringify([
          { type: "role", name: "先写入的合法角色", description: "不应落地" },
          { type: "role" },
        ]),
      }),
    });
    const missingText = await missingName.text();
    assert.notEqual(missingName.status, 200);
    assert.match(missingText, /记录|第\s*2|序号/);
    assert.equal(missingText.includes("SQLITE"), false);

    const unsupported = await fetch(`${base}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format: "json",
        text: JSON.stringify([
          { type: "role", name: "林夏", character_kind: "human", image_ratio: "9:16", video_prompt: "walk" },
        ]),
      }),
    });
    const unsupportedText = await unsupported.text();
    assert.notEqual(unsupported.status, 200);
    assert.match(unsupportedText, /不支持字段/);
    assert.match(unsupportedText, /character_kind|image_ratio|video_prompt/);

    await runWithProjectStorage(PROJECT_A, async () => {
      const count = Number((await activeDb("o_assets").count("* as count").first())?.count ?? 0);
      assert.equal(count, 0, "非法导入必须零写入");
    });
  });
});

test("只读项目写入新建、批量上传和导入必须返回 403", async () => {
  await withTempRuntime("r5-readonly", [catalogRow(PROJECT_A, undefined, "viewer")], async (port) => {
    const base = assetsUrl(port, PROJECT_A);
    const created = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "role", name: "林夏" }),
    });
    assert.equal(created.status, 403);

    const batch = new FormData();
    batch.append("type", "role");
    batch.append("file", new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }), "林夏.png");
    const uploaded = await fetch(`${base}/batch`, { method: "POST", body: batch });
    assert.equal(uploaded.status, 403);

    const imported = await fetch(`${base}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "json", text: "[]" }),
    });
    assert.equal(imported.status, 403);
  });
});

test("不同项目资产不能串读串写", async () => {
  await withTempRuntime("r5-isolation", [catalogRow(PROJECT_A), catalogRow(PROJECT_B)], async (port) => {
    const created = await fetch(assetsUrl(port, PROJECT_A), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "role", name: "只属于A" }),
    }).then((response) => response.json()) as { data: { assetUuid: string } };

    const listedB = await fetch(assetsUrl(port, PROJECT_B));
    const listB = await listedB.json() as { data?: { assets?: Array<{ name?: string; assetUuid?: string }> } };
    assert.equal((listB.data?.assets ?? []).some((item) => item.assetUuid === created.data.assetUuid), false);
    assert.equal((listB.data?.assets ?? []).some((item) => item.name === "只属于A"), false);

    const spoofed = new FormData();
    spoofed.append("file", new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }), "stolen.png");
    const stolen = await fetch(`${assetsUrl(port, PROJECT_B)}/${created.data.assetUuid}/image`, {
      method: "POST",
      body: spoofed,
    });
    assert.ok([403, 404].includes(stolen.status), `跨项目写封面应被拒绝: ${stolen.status}`);
  });
});
