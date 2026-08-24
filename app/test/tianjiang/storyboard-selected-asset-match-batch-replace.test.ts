/**
 * RED：勾选分镜范围内的资产自动匹配与批量文本替换。
 * 空选择必须 400；只处理提交的 shot UUID；匹配与替换在同一项目事务内完成。
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

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9822 };
const PROJECT_A = "71111111-1111-4111-a111-111111111111";
const PROJECT_B = "72222222-2222-4222-a222-222222222222";
const SOURCE = "73333333-3333-4333-a333-333333333333";
const MISSING_SHOT = "79999999-9999-4999-a999-999999999999";

const EXAMPLE_PROMPT = [
  "场景：日，老许农资",
  "人物：小许、监管工作人员",
  "道具：文件夹",
  "分镜提示词：小许在老许农资拿起文件夹，监管工作人员进门。",
].join("\n");

function catalogRow(projectUuid: string, extras: Record<string, unknown> = {}) {
  return {
    projectUuid,
    name: projectUuid.slice(0, 8),
    kind: extras.kind ?? "personal",
    ownerUserId: IDENTITY.userId,
    role: extras.myRole ?? "owner",
    myRole: extras.myRole ?? "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-22T00:00:00Z",
    lockStatus: extras.lockStatus ?? "none",
    lockHolderName: "",
    openMode: extras.openMode ?? "editable",
    businessType: "storyboard",
    assetSourceProjectUuid: extras.assetSourceProjectUuid,
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
  assert.doesNotMatch(message, /[A-Za-z]:\\/);
  assert.doesNotMatch(message, /node_modules|sqlite|E:\\|C:\\Users\\/i);
}

async function createShot(
  base: string,
  fields: {
    sourceText?: string;
    visualDescription?: string;
    imagePrompt?: string;
    videoPrompt?: string;
    negativePrompt?: string;
    afterShotUuid?: string | null;
  } = {},
): Promise<any> {
  const created = await jsonRequest(`${base}/shots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      afterShotUuid: fields.afterShotUuid === undefined ? null : fields.afterShotUuid,
      sourceText: fields.sourceText ?? "源文本",
      visualDescription: fields.visualDescription ?? "画面描述",
    }),
  });
  assert.equal(created.status, 200, `创建分镜失败 ${created.status} ${JSON.stringify(created.body)}`);
  const shotUuid = String(created.body.data.shotUuid);
  const patched = await jsonRequest(`${base}/shots/${shotUuid}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceText: fields.sourceText ?? "源文本",
      visualDescription: fields.visualDescription ?? "画面描述",
      imagePrompt: fields.imagePrompt ?? "图片提示词",
      videoPrompt: fields.videoPrompt ?? "",
      negativePrompt: fields.negativePrompt ?? "负面提示词",
    }),
  });
  assert.equal(patched.status, 200, `写入分镜提示词失败 ${patched.status}`);
  return patched.body.data;
}

async function createAsset(
  base: string,
  input: { type: "role" | "scene" | "tool"; name: string; remark?: string },
): Promise<any> {
  const created = await jsonRequest(`${base}/assets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: input.type,
      name: input.name,
      remark: input.remark ?? "",
      describe: `${input.name}说明`,
    }),
  });
  assert.equal(created.status, 200, `创建资产失败 ${created.status} ${JSON.stringify(created.body)}`);
  return created.body.data;
}

async function bindAsset(
  base: string,
  shotUuid: string,
  asset: { assetUuid: string; type: string; sourceProjectUuid: string },
): Promise<void> {
  const bound = await jsonRequest(`${base}/shots/${shotUuid}/bindings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceProjectUuid: asset.sourceProjectUuid,
      assetUuid: asset.assetUuid,
      assetType: asset.type,
      relationRole: "appear",
    }),
  });
  assert.equal(bound.status, 200, `手动绑定失败 ${bound.status} ${JSON.stringify(bound.body)}`);
}

async function listShots(base: string): Promise<any[]> {
  const listed = await jsonRequest(`${base}/shots`);
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body.data));
  return listed.body.data;
}

async function shotRow(projectUuid: string, shotUuid: string): Promise<any> {
  return runWithProjectStorage(projectUuid, () => activeDb("o_storyboardShot").where({ shotUuid }).first());
}

async function bindingRows(projectUuid: string, shotUuid: string): Promise<any[]> {
  return runWithProjectStorage(projectUuid, () => (
    activeDb("o_storyboardShotAsset").where({ shotUuid }).orderBy("id")
  ));
}

async function journalGeneration(projectUuid: string): Promise<number> {
  return runWithProjectStorage(projectUuid, async () => {
    const row = await activeDb("o_legacyMutationJournal").max("generation as maxGen").first();
    return Number((row as { maxGen?: number | null } | undefined)?.maxGen ?? 0);
  });
}

function bindingKey(row: { assetUuid?: string; assetType?: string }): string {
  return `${row.assetType}:${row.assetUuid}`;
}

async function withRuntime(
  catalog: unknown[],
  run: (ctx: { port: number; baseA: string; baseB: string; baseSource: string }) => Promise<void>,
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-match-replace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
        id: 711,
        name: "project-a",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await initializeWorkspaceProject(PROJECT_B, {
        id: 722,
        name: "project-b",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await initializeWorkspaceProject(SOURCE, {
        id: 733,
        name: "asset-source",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      syncCoordinator.listProjects = () => catalog as any;
      const app = express();
      app.use(express.json({ limit: "2mb" }));
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          id: "match-replace-session",
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
        await run({
          port,
          baseA: storyboardUrl(port, PROJECT_A),
          baseB: storyboardUrl(port, PROJECT_B),
          baseSource: storyboardUrl(port, SOURCE),
        });
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

async function seedExampleAssets(base: string) {
  const xuhe = await createAsset(base, { type: "role", name: "许禾", remark: "小许" });
  const supervisor = await createAsset(base, { type: "role", name: "监管工作人员", remark: "监管" });
  const farm = await createAsset(base, { type: "scene", name: "老许农资" });
  const hotel = await createAsset(base, { type: "scene", name: "酒店" });
  const folder = await createAsset(base, { type: "tool", name: "文件夹" });
  return { xuhe, supervisor, farm, hotel, folder };
}

test("空选择必须 400，空数组不得解释成全部分镜", async () => {
  await withRuntime([catalogRow(PROJECT_A)], async ({ baseA }) => {
    await seedExampleAssets(baseA);
    const shot = await createShot(baseA, { videoPrompt: EXAMPLE_PROMPT });
    const emptyMatch = await jsonRequest(`${baseA}/shots/actions/auto-match-assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shotUuids: [] }),
    });
    assert.equal(emptyMatch.status, 400);
    assertSafePublicError(emptyMatch.body);
    const emptyReplace = await jsonRequest(`${baseA}/shots/actions/batch-replace-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shotUuids: [], findText: "小许", replaceText: "许禾" }),
    });
    assert.equal(emptyReplace.status, 400);
    assertSafePublicError(emptyReplace.body);
    const after = await listShots(baseA);
    assert.equal(after[0].shotUuid, shot.shotUuid);
    assert.equal(after[0].bindings?.length ?? 0, 0);
    assert.equal(after[0].videoPrompt, EXAMPLE_PROMPT);
  });
});

test("只处理提交的 shot UUID，未勾选分镜提示词和绑定逐字节不变", async () => {
  await withRuntime([catalogRow(PROJECT_A)], async ({ baseA }) => {
    const assets = await seedExampleAssets(baseA);
    const selected = await createShot(baseA, { videoPrompt: EXAMPLE_PROMPT, sourceText: "选中源" });
    const ignored = await createShot(baseA, {
      afterShotUuid: selected.shotUuid,
      videoPrompt: "场景：日，酒店\n人物：小许\n道具：文件夹\n分镜提示词：小许走进酒店拿起文件夹。",
      sourceText: "未选源",
      visualDescription: "未选画面",
      imagePrompt: "未选图片",
      negativePrompt: "未选负面",
    });
    await bindAsset(baseA, ignored.shotUuid, {
      assetUuid: assets.hotel.assetUuid,
      type: "scene",
      sourceProjectUuid: PROJECT_A,
    });
    const ignoredRowBefore = await shotRow(PROJECT_A, ignored.shotUuid);
    const ignoredBindingsBefore = JSON.stringify(await bindingRows(PROJECT_A, ignored.shotUuid));
    const matched = await jsonRequest(`${baseA}/shots/actions/auto-match-assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shotUuids: [selected.shotUuid] }),
    });
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    assert.equal(matched.body.data.selectedCount, 1);
    assert.equal(matched.body.data.processedCount, 1);
    const ignoredRowAfter = await shotRow(PROJECT_A, ignored.shotUuid);
    const ignoredBindingsAfter = JSON.stringify(await bindingRows(PROJECT_A, ignored.shotUuid));
    assert.equal(ignoredRowAfter.videoPrompt, ignoredRowBefore.videoPrompt);
    assert.equal(ignoredRowAfter.sourceText, ignoredRowBefore.sourceText);
    assert.equal(ignoredRowAfter.visualDescription, ignoredRowBefore.visualDescription);
    assert.equal(ignoredRowAfter.imagePrompt, ignoredRowBefore.imagePrompt);
    assert.equal(ignoredRowAfter.negativePrompt, ignoredRowBefore.negativePrompt);
    assert.equal(ignoredBindingsAfter, ignoredBindingsBefore);
  });
});

test("名称与别名匹配，并映射角色、场景、道具类型", async () => {
  await withRuntime([catalogRow(PROJECT_A)], async ({ baseA }) => {
    const assets = await seedExampleAssets(baseA);
    const shot = await createShot(baseA, { videoPrompt: EXAMPLE_PROMPT });
    const matched = await jsonRequest(`${baseA}/shots/actions/auto-match-assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shotUuids: [shot.shotUuid] }),
    });
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    const listed = await listShots(baseA);
    const keys = new Set((listed[0].bindings ?? []).map((row: any) => bindingKey(row)));
    assert.ok(keys.has(`role:${assets.xuhe.assetUuid}`), "别名小许应绑定许禾");
    assert.ok(keys.has(`role:${assets.supervisor.assetUuid}`), "应绑定监管工作人员");
    assert.ok(keys.has(`scene:${assets.farm.assetUuid}`), "应绑定老许农资");
    assert.ok(keys.has(`tool:${assets.folder.assetUuid}`), "应绑定文件夹");
    assert.equal(keys.has(`scene:${assets.hotel.assetUuid}`), false, "日不得匹配成场景");
    assert.equal(listed[0].videoPrompt, EXAMPLE_PROMPT, "匹配不得改写原始提示词");
  });
});

test("更长名称优先，短角色名后紧跟括号限定不得误绑", async () => {
  await withRuntime([catalogRow(PROJECT_A)], async ({ baseA }) => {
    const longRole = await createAsset(baseA, { type: "role", name: "监管工作人员" });
    const shortRole = await createAsset(baseA, { type: "role", name: "监管" });
    const zhang = await createAsset(baseA, { type: "role", name: "张三" });
    const shot = await createShot(baseA, {
      videoPrompt: "人物：监管工作人员、张三（少年）\n分镜提示词：监管工作人员看见张三（少年）。",
    });
    const matched = await jsonRequest(`${baseA}/shots/actions/auto-match-assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shotUuids: [shot.shotUuid] }),
    });
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    const listed = await listShots(baseA);
    const keys = new Set((listed[0].bindings ?? []).map((row: any) => bindingKey(row)));
    assert.ok(keys.has(`role:${longRole.assetUuid}`));
    assert.equal(keys.has(`role:${shortRole.assetUuid}`), false);
    assert.equal(keys.has(`role:${zhang.assetUuid}`), false);
  });
});

test("道具只从道具字段匹配，正文常用名词不得误绑", async () => {
  await withRuntime([catalogRow(PROJECT_A)], async ({ baseA }) => {
    const folder = await createAsset(baseA, { type: "tool", name: "文件夹" });
    const bodyOnly = await createShot(baseA, {
      videoPrompt: "分镜提示词：小许在老许农资拿起文件夹。",
    });
    const withField = await createShot(baseA, {
      afterShotUuid: bodyOnly.shotUuid,
      videoPrompt: "道具：文件夹\n分镜提示词：小许在老许农资拿起文件夹。",
    });
    const matched = await jsonRequest(`${baseA}/shots/actions/auto-match-assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shotUuids: [bodyOnly.shotUuid, withField.shotUuid] }),
    });
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    const listed = await listShots(baseA);
    const bodyShot = listed.find((row: any) => row.shotUuid === bodyOnly.shotUuid);
    const fieldShot = listed.find((row: any) => row.shotUuid === withField.shotUuid);
    assert.equal((bodyShot.bindings ?? []).some((row: any) => row.assetUuid === folder.assetUuid), false);
    assert.equal((fieldShot.bindings ?? []).some((row: any) => row.assetUuid === folder.assetUuid && row.assetType === "tool"), true);
  });
});

test("场景环境词过滤，并最多自动绑定一个场景", async () => {
  await withRuntime([catalogRow(PROJECT_A)], async ({ baseA }) => {
    const day = await createAsset(baseA, { type: "scene", name: "日" });
    const hotel = await createAsset(baseA, { type: "scene", name: "酒店" });
    const farm = await createAsset(baseA, { type: "scene", name: "老许农资" });
    const hotelShot = await createShot(baseA, { videoPrompt: "场景：日，酒店\n分镜提示词：酒店大厅灯火通明。" });
    const farmShot = await createShot(baseA, {
      afterShotUuid: hotelShot.shotUuid,
      videoPrompt: "场景：外 老许农资 冬至上午\n分镜提示词：小许走进老许农资。",
    });
    const matched = await jsonRequest(`${baseA}/shots/actions/auto-match-assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shotUuids: [hotelShot.shotUuid, farmShot.shotUuid] }),
    });
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    const listed = await listShots(baseA);
    const hotelBindings = (listed.find((row: any) => row.shotUuid === hotelShot.shotUuid).bindings ?? [])
      .filter((row: any) => row.assetType === "scene");
    const farmBindings = (listed.find((row: any) => row.shotUuid === farmShot.shotUuid).bindings ?? [])
      .filter((row: any) => row.assetType === "scene");
    assert.deepEqual(hotelBindings.map((row: any) => row.assetUuid), [hotel.assetUuid]);
    assert.deepEqual(farmBindings.map((row: any) => row.assetUuid), [farm.assetUuid]);
    assert.equal(hotelBindings.some((row: any) => row.assetUuid === day.assetUuid), false);
  });
});

test("已有手动场景不被覆盖，现有绑定保留，重复运行幂等", async () => {
  await withRuntime([catalogRow(PROJECT_A)], async ({ baseA }) => {
    const assets = await seedExampleAssets(baseA);
    const shot = await createShot(baseA, { videoPrompt: EXAMPLE_PROMPT });
    await bindAsset(baseA, shot.shotUuid, {
      assetUuid: assets.hotel.assetUuid,
      type: "scene",
      sourceProjectUuid: PROJECT_A,
    });
    await bindAsset(baseA, shot.shotUuid, {
      assetUuid: assets.xuhe.assetUuid,
      type: "role",
      sourceProjectUuid: PROJECT_A,
    });
    const first = await jsonRequest(`${baseA}/shots/actions/auto-match-assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shotUuids: [shot.shotUuid] }),
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const afterFirst = await listShots(baseA);
    const firstKeys = (afterFirst[0].bindings ?? []).map((row: any) => bindingKey(row)).sort();
    assert.ok(firstKeys.includes(`scene:${assets.hotel.assetUuid}`));
    assert.equal(firstKeys.includes(`scene:${assets.farm.assetUuid}`), false);
    assert.ok(firstKeys.includes(`role:${assets.xuhe.assetUuid}`));
    assert.ok(firstKeys.includes(`role:${assets.supervisor.assetUuid}`));
    const second = await jsonRequest(`${baseA}/shots/actions/auto-match-assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shotUuids: [shot.shotUuid] }),
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.data.createdBindingCount, 0);
    const afterSecond = await listShots(baseA);
    const secondKeys = (afterSecond[0].bindings ?? []).map((row: any) => bindingKey(row)).sort();
    assert.deepEqual(secondKeys, firstKeys);
  });
});

test("歧义别名不得绑定，并报告冲突数量和安全资产名称", async () => {
  await withRuntime([catalogRow(PROJECT_A)], async ({ baseA }) => {
    const first = await createAsset(baseA, { type: "role", name: "许禾甲", remark: "小许" });
    const second = await createAsset(baseA, { type: "role", name: "许禾乙", remark: "小许" });
    const shot = await createShot(baseA, { videoPrompt: "人物：小许\n分镜提示词：小许走进门。" });
    const matched = await jsonRequest(`${baseA}/shots/actions/auto-match-assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shotUuids: [shot.shotUuid] }),
    });
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    assert.ok(Number(matched.body.data.conflictCount) >= 1);
    const listed = await listShots(baseA);
    const keys = new Set((listed[0].bindings ?? []).map((row: any) => row.assetUuid));
    assert.equal(keys.has(first.assetUuid), false);
    assert.equal(keys.has(second.assetUuid), false);
    const message = `${matched.body.message ?? ""}${JSON.stringify(matched.body.data ?? {})}`;
    assert.match(message, /许禾甲|许禾乙|小许/);
    assert.doesNotMatch(message, /[A-Za-z]:\\|sqlite|node_modules/i);
  });
});

test("空 videoPrompt 记为提示词为空，不得退回 visualDescription 或 sourceText", async () => {
  await withRuntime([catalogRow(PROJECT_A)], async ({ baseA }) => {
    const assets = await seedExampleAssets(baseA);
    const shot = await createShot(baseA, {
      videoPrompt: "",
      sourceText: "小许在老许农资拿起文件夹，监管工作人员进门。",
      visualDescription: "小许在老许农资拿起文件夹，监管工作人员进门。",
    });
    const matched = await jsonRequest(`${baseA}/shots/actions/auto-match-assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shotUuids: [shot.shotUuid] }),
    });
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    assert.equal(matched.body.data.emptyPromptCount, 1);
    const listed = await listShots(baseA);
    assert.equal(listed[0].bindings?.length ?? 0, 0);
    assert.equal((listed[0].bindings ?? []).some((row: any) => row.assetUuid === assets.xuhe.assetUuid), false);
  });
});

test("共享资产来源项目必须通过网关绑定到来源 UUID", async () => {
  await withRuntime(
    [catalogRow(PROJECT_A, { assetSourceProjectUuid: SOURCE }), catalogRow(SOURCE)],
    async ({ baseA, baseSource }) => {
      const assets = await seedExampleAssets(baseSource);
      const shot = await createShot(baseA, { videoPrompt: EXAMPLE_PROMPT });
      const matched = await jsonRequest(`${baseA}/shots/actions/auto-match-assets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shotUuids: [shot.shotUuid] }),
      });
      assert.equal(matched.status, 200, JSON.stringify(matched.body));
      const listed = await listShots(baseA);
      const bindings = listed[0].bindings ?? [];
      assert.ok(bindings.length >= 4);
      assert.ok(bindings.every((row: any) => row.sourceProjectUuid === SOURCE));
      assert.ok(bindings.some((row: any) => row.assetUuid === assets.xuhe.assetUuid && row.assetType === "role"));
      assert.ok(bindings.some((row: any) => row.assetUuid === assets.farm.assetUuid && row.assetType === "scene"));
    },
  );
});

test("非本项目分镜导致整批回滚，且不新增 mutation journal", async () => {
  await withRuntime([catalogRow(PROJECT_A), catalogRow(PROJECT_B)], async ({ baseA, baseB }) => {
    await seedExampleAssets(baseA);
    const local = await createShot(baseA, { videoPrompt: EXAMPLE_PROMPT });
    const foreign = await createShot(baseB, { videoPrompt: EXAMPLE_PROMPT });
    const beforeBindings = JSON.stringify(await bindingRows(PROJECT_A, local.shotUuid));
    const beforePrompt = (await shotRow(PROJECT_A, local.shotUuid)).videoPrompt;
    const beforeJournal = await journalGeneration(PROJECT_A);
    const matched = await jsonRequest(`${baseA}/shots/actions/auto-match-assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shotUuids: [local.shotUuid, foreign.shotUuid] }),
    });
    assert.equal(matched.status, 400);
    assertSafePublicError(matched.body);
    assert.equal(JSON.stringify(await bindingRows(PROJECT_A, local.shotUuid)), beforeBindings);
    assert.equal((await shotRow(PROJECT_A, local.shotUuid)).videoPrompt, beforePrompt);
    assert.equal(await journalGeneration(PROJECT_A), beforeJournal);
    const missing = await jsonRequest(`${baseA}/shots/actions/auto-match-assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shotUuids: [local.shotUuid, MISSING_SHOT] }),
    });
    assert.equal(missing.status, 400);
    assert.equal(await journalGeneration(PROJECT_A), beforeJournal);
  });
});

test("批量替换只改 videoPrompt，并替换全部出现次数，空替换表示删除", async () => {
  await withRuntime([catalogRow(PROJECT_A)], async ({ baseA }) => {
    const first = await createShot(baseA, {
      videoPrompt: "小许看见小许",
      sourceText: "小许源文本",
      visualDescription: "小许画面",
      imagePrompt: "小许图片",
      negativePrompt: "小许负面",
    });
    const second = await createShot(baseA, {
      afterShotUuid: first.shotUuid,
      videoPrompt: "无人出场",
      sourceText: "小许不应改",
    });
    const third = await createShot(baseA, {
      afterShotUuid: second.shotUuid,
      videoPrompt: "小许离开",
    });
    const replaced = await jsonRequest(`${baseA}/shots/actions/batch-replace-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuids: [first.shotUuid, second.shotUuid, third.shotUuid],
        findText: "小许",
        replaceText: "许禾",
      }),
    });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal(replaced.body.data.selectedCount, 3);
    assert.equal(replaced.body.data.affectedShotCount, 2);
    assert.equal(replaced.body.data.replacementCount, 3);
    const listed = await listShots(baseA);
    const byId = Object.fromEntries(listed.map((row: any) => [row.shotUuid, row]));
    assert.equal(byId[first.shotUuid].videoPrompt, "许禾看见许禾");
    assert.equal(byId[first.shotUuid].sourceText, "小许源文本");
    assert.equal(byId[first.shotUuid].visualDescription, "小许画面");
    assert.equal(byId[first.shotUuid].imagePrompt, "小许图片");
    assert.equal(byId[first.shotUuid].negativePrompt, "小许负面");
    assert.equal(byId[second.shotUuid].videoPrompt, "无人出场");
    assert.equal(byId[second.shotUuid].sourceText, "小许不应改");
    assert.equal(byId[third.shotUuid].videoPrompt, "许禾离开");

    const deleted = await jsonRequest(`${baseA}/shots/actions/batch-replace-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuids: [third.shotUuid],
        findText: "许禾",
        replaceText: "",
      }),
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.data.replacementCount, 1);
    const afterDelete = await listShots(baseA);
    assert.equal(afterDelete.find((row: any) => row.shotUuid === third.shotUuid).videoPrompt, "离开");
  });
});

test("空查找被拒绝；批量失败全部回滚并正确写 mutation journal", async () => {
  await withRuntime([catalogRow(PROJECT_A), catalogRow(PROJECT_B)], async ({ baseA, baseB }) => {
    const local = await createShot(baseA, { videoPrompt: "小许在门口", sourceText: "源小许" });
    const foreign = await createShot(baseB, { videoPrompt: "小许在门口" });
    const emptyFind = await jsonRequest(`${baseA}/shots/actions/batch-replace-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuids: [local.shotUuid],
        findText: "",
        replaceText: "许禾",
      }),
    });
    assert.equal(emptyFind.status, 400);
    assertSafePublicError(emptyFind.body);
    const beforeJournal = await journalGeneration(PROJECT_A);
    const beforeRow = await shotRow(PROJECT_A, local.shotUuid);
    const failed = await jsonRequest(`${baseA}/shots/actions/batch-replace-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuids: [local.shotUuid, foreign.shotUuid],
        findText: "小许",
        replaceText: "许禾",
      }),
    });
    assert.equal(failed.status, 400);
    assertSafePublicError(failed.body);
    const afterRow = await shotRow(PROJECT_A, local.shotUuid);
    assert.equal(afterRow.videoPrompt, beforeRow.videoPrompt);
    assert.equal(afterRow.sourceText, beforeRow.sourceText);
    assert.equal(await journalGeneration(PROJECT_A), beforeJournal);

    const ok = await jsonRequest(`${baseA}/shots/actions/batch-replace-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotUuids: [local.shotUuid],
        findText: "小许",
        replaceText: "许禾",
      }),
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(await journalGeneration(PROJECT_A) > beforeJournal);
    assert.equal((await shotRow(PROJECT_A, local.shotUuid)).videoPrompt, "许禾在门口");
    assert.equal((await shotRow(PROJECT_A, local.shotUuid)).sourceText, "源小许");
  });
});

test("纯匹配器覆盖示例提示词、场景环境词和道具字段边界", async () => {
  const { matchAssetsForPrompt } = await import("../../src/tianjiang/storyboard/storyboard-asset-matcher");
  const assets = [
    { assetUuid: "role-xuhe", name: "许禾", type: "role" as const, remark: "小许", sourceProjectUuid: PROJECT_A },
    { assetUuid: "role-supervisor", name: "监管工作人员", type: "role" as const, remark: "监管", sourceProjectUuid: PROJECT_A },
    { assetUuid: "scene-farm", name: "老许农资", type: "scene" as const, remark: "", sourceProjectUuid: PROJECT_A },
    { assetUuid: "scene-hotel", name: "酒店", type: "scene" as const, remark: "", sourceProjectUuid: PROJECT_A },
    { assetUuid: "tool-folder", name: "文件夹", type: "tool" as const, remark: "", sourceProjectUuid: PROJECT_A },
  ];
  const matched = matchAssetsForPrompt(EXAMPLE_PROMPT, assets);
  assert.deepEqual(
    matched.matches.map((item) => `${item.assetType}:${item.assetUuid}`).sort(),
    ["role:role-supervisor", "role:role-xuhe", "scene:scene-farm", "tool:tool-folder"],
  );
  const bodyOnly = matchAssetsForPrompt("分镜提示词：小许在老许农资拿起文件夹。", assets);
  assert.equal(bodyOnly.matches.some((item) => item.assetUuid === "tool-folder"), false);
  const hotel = matchAssetsForPrompt("场景：日，酒店", assets);
  assert.deepEqual(hotel.matches.map((item) => item.assetUuid), ["scene-hotel"]);
});
