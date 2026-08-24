/**
 * Task 1 RED：分镜项目类型必须通过真实生产入口被接受并落到本地库。
 * 禁止用源码 contains 或模块不存在冒充业务失败。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { validateClientControlPlaneRequest } from "../../src/tianjiang/client-control-plane-contracts";
import { CentralRuntimeAdapter } from "../../src/tianjiang/runtime/central-runtime-adapter";
import { runWithProjectStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  activateUserDatabase,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
  db as activeDb,
} from "../../src/utils/db";
import {
  closeActivatedWorkspaceRuntime,
  createUniqueWorktreeRoot,
} from "./helpers/worktree-runtime";

const STORYBOARD_UUID = "11111111-1111-4111-a111-111111111111";
const SOURCE_UUID = "22222222-2222-4222-a222-222222222222";
const DEVICE_UUID = "33333333-3333-4333-a333-333333333333";

function catalogGateway(projects: Record<string, unknown>[]) {
  return {
    forwardBusinessRequest: async () => ({ projects }),
  };
}

function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    projectUuid: STORYBOARD_UUID,
    name: "分镜工作台",
    kind: "personal",
    ownerUserId: 7,
    myRole: "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-13T00:00:00Z",
    lockStatus: "none",
    lockHolderName: "",
    openMode: "editable",
    businessType: "storyboard",
    description: "连续分镜项目",
    artStyle: "赛博朋克",
    aspectRatio: "16:9",
    defaultLanguage: "zh-CN",
    assetSourceProjectUuid: SOURCE_UUID,
    ...overrides,
  };
}

function createAdapter(projects: Record<string, unknown>[]) {
  return new CentralRuntimeAdapter(
    catalogGateway(projects) as any,
    { serverUrl: "https://api.j11.com.cn", user: { id: 7 } } as any,
    DEVICE_UUID,
  );
}

test("中央目录生产入口必须接受 storyboard 并保留一级来源", async () => {
  const catalog = await createAdapter([catalogRow()]).projectCatalog(7);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]!.businessType, "storyboard");
  assert.equal(catalog[0]!.assetSourceProjectUuid, SOURCE_UUID);
  assert.equal(catalog[0]!.name, "分镜工作台");
});

test("中央目录仍接受既有 novel/script 请求，且独立分镜可不带来源", async () => {
  const catalog = await createAdapter([
    catalogRow({
      projectUuid: "44444444-4444-4444-a444-444444444444",
      name: "小说稿",
      businessType: "novel",
      assetSourceProjectUuid: undefined,
    }),
    catalogRow({
      projectUuid: "55555555-5555-4555-a555-555555555555",
      name: "剧本草",
      businessType: "script",
      assetSourceProjectUuid: "",
    }),
    catalogRow({
      projectUuid: "66666666-6666-4666-a666-666666666666",
      name: "独立分镜",
      businessType: "storyboard",
      assetSourceProjectUuid: "",
    }),
  ]).projectCatalog(7);
  assert.deepEqual(
    catalog.map((row) => [row.businessType, row.assetSourceProjectUuid ?? ""]),
    [
      ["novel", ""],
      ["script", ""],
      ["storyboard", ""],
    ],
  );
});

test("客户端控制面创建合同必须放行 storyboard 完整创建字段", () => {
  const independent = validateClientControlPlaneRequest("createProject", {
    name: "独立分镜",
    scope: "personal",
    businessType: "storyboard",
    description: "简介",
    artStyle: "水墨",
    aspectRatio: "9:16",
    defaultLanguage: "zh-CN",
  });
  assert.equal(independent?.businessType, "storyboard");
  assert.equal(independent?.description, "简介");
  assert.equal(independent?.artStyle, "水墨");
  assert.equal(independent?.aspectRatio, "9:16");
  assert.equal(independent?.defaultLanguage, "zh-CN");
  assert.equal(Object.hasOwn(independent ?? {}, "assetSourceProjectUuid"), false);

  const shared = validateClientControlPlaneRequest("createProject", {
    name: "共享分镜",
    scope: "personal",
    businessType: "storyboard",
    description: "共享资产",
    artStyle: "写实",
    aspectRatio: "16:9",
    defaultLanguage: "zh-CN",
    assetSourceProjectUuid: SOURCE_UUID,
  });
  assert.equal(shared?.assetSourceProjectUuid, SOURCE_UUID);

  const novel = validateClientControlPlaneRequest("createProject", {
    name: "小说稿",
    scope: "personal",
    businessType: "novel",
  });
  assert.equal(novel?.businessType, "novel");
});

test("非分镜项目携带来源必须被控制面拒绝", () => {
  assert.throws(
    () => validateClientControlPlaneRequest("createProject", {
      name: "小说稿",
      scope: "personal",
      businessType: "novel",
      assetSourceProjectUuid: SOURCE_UUID,
    }),
    /来源|storyboard|资产/,
  );
});

test("initializeWorkspaceProject 必须把 storyboard 写入本地 o_project.projectType", async () => {
  const fixtureRoot = createUniqueWorktreeRoot("sb-type");
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;

  try {
    process.chdir(fixtureRoot);
    process.env.NODE_ENV = "prod";
    resetDatabaseRuntimeForServe();
    const identity = { issuer: "https://api.j11.com.cn", userId: 7013 };
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      await initializeWorkspaceProject(STORYBOARD_UUID, {
        id: 13,
        name: "分镜本地库",
        projectType: "storyboard" as "novel",
        userId: 7013,
      });
      const row = await runWithProjectStorage(STORYBOARD_UUID, () =>
        activeDb("o_project").where({ id: 13 }).first());
      assert.ok(row, "本地项目行必须存在");
      assert.equal(row.projectType, "storyboard");
      assert.equal(row.name, "分镜本地库");
    });
  } finally {
    await closeActivatedWorkspaceRuntime();
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
