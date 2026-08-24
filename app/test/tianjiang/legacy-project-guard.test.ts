import assert from "node:assert/strict";
import test from "node:test";

import {
  describeLegacyProjectTarget,
  isGlobalLegacyDestructiveRoute,
  isLegacyProjectMutation,
  isLegacyProjectRoute,
} from "../../src/tianjiang/runtime/legacy-project-guard";

test("旧路由采用默认写保护并显式放行只读接口", () => {
  assert.equal(
    isLegacyProjectMutation("POST", "/api/production/workbench/selectVideo"),
    true,
  );
  assert.equal(
    isLegacyProjectMutation("POST", "/api/other/deleteAllData"),
    true,
  );
  assert.equal(
    isLegacyProjectMutation("POST", "/api/setting/dbConfig/importData"),
    true,
  );
  assert.equal(
    isLegacyProjectMutation("POST", "/api/script/getScrptApi"),
    false,
  );
  assert.equal(
    isLegacyProjectMutation("POST", "/api/setting/vendorConfig/getVendorList"),
    false,
  );
});

test("子资源 ID 优先于请求体 projectId，并覆盖生产资源表", () => {
  assert.deepEqual(
    describeLegacyProjectTarget("/api/script/updateScript", { id: 9, projectId: 999 }),
    {
      legacyProjectId: 999,
      resources: [{ table: "o_script", id: 9 }],
    },
  );
  assert.deepEqual(
    describeLegacyProjectTarget("/api/production/workbench/selectVideo", {
      trackId: 7,
      projectId: 999,
    }),
    {
      legacyProjectId: 999,
      resources: [{ table: "o_videoTrack", id: 7 }],
    },
  );
  assert.deepEqual(
    describeLegacyProjectTarget("/api/production/editImage/updateImageFlow", {
      flowId: 6,
      projectId: 999,
    }),
    {
      legacyProjectId: 999,
      resources: [{ table: "o_imageFlow", id: 6 }],
    },
  );
});

test("精确的云端项目完整编辑路由将 body.id 解析为项目授权目标", () => {
  assert.deepEqual(
    describeLegacyProjectTarget("/api/general/getSingleProject", { id: 42 }),
    {
      legacyProjectId: 42,
      resources: [],
    },
  );
  // Express 默认会将尾随斜杠匹配到同一处理器，授权目标必须保持一致。
  assert.deepEqual(
    describeLegacyProjectTarget("/api/general/getSingleProject/", { id: 42 }),
    {
      legacyProjectId: 42,
      resources: [],
    },
  );
});

test("云端项目完整编辑路由的单尾斜杠仍按只读处理", () => {
  assert.equal(
    isLegacyProjectMutation("POST", "/api/general/getSingleProject"),
    false,
  );
  // Express 接受一个尾随斜杠时，授权层不得把同一读取请求误判成写操作。
  assert.equal(
    isLegacyProjectMutation("POST", "/api/general/getSingleProject/"),
    false,
  );
  // 仅兼容一个尾随斜杠，异常双斜杠继续按默认写保护失败关闭。
  assert.equal(
    isLegacyProjectMutation("POST", "/api/general/getSingleProject//"),
    true,
  );
});

test("相邻 general 路由不得因云端项目完整编辑例外接受 body.id", () => {
  // 例外必须锁定精确路径，不能把整个 /api/general/ 前缀放宽为项目 ID 输入。
  assert.deepEqual(
    describeLegacyProjectTarget("/api/general/generalStatistics", { id: 42 }),
    {
      resources: [],
    },
  );
});

test("同一请求中的所有子资源都必须纳入交叉归属核验", () => {
  assert.deepEqual(
    describeLegacyProjectTarget("/api/script/updateScript", {
      id: 9,
      projectId: 3,
      assets: [12, 13],
    }),
    {
      legacyProjectId: 3,
      resources: [
        { table: "o_script", id: 9 },
        { table: "o_assets", id: 12 },
        { table: "o_assets", id: 13 },
      ],
    },
  );
});

test("所有项目业务前缀默认纳入保护，数据库全局清理单独失败关闭", () => {
  for (const pathname of [
    "/api/script/updateScript",
    "/api/production/workbench/selectVideo",
    "/api/agents/clearMemory",
    "/api/task/retryRemoteTask",
  ]) {
    assert.equal(isLegacyProjectRoute(pathname), true, pathname);
  }
  // 任务中心三个读取 POST 为账号级聚合，不进单项目门
  assert.equal(isLegacyProjectRoute("/api/task/getTaskApi"), false);
  assert.equal(isLegacyProjectMutation("POST", "/api/task/getTaskApi"), false);
  for (const pathname of [
    "/api/other/deleteAllData",
    "/api/setting/dbConfig/clearData",
    "/api/setting/dbConfig/clearTable",
    "/api/setting/dbConfig/importData",
  ]) {
    assert.equal(isGlobalLegacyDestructiveRoute(pathname), true, pathname);
    assert.equal(isLegacyProjectMutation("POST", pathname), true, pathname);
  }
});

test("账号级项目手册路由不进入项目授权门，真实项目路由仍受保护", () => {
  const accountManualRoutes = [
    "/api/project/addDirectorManual",
    "/api/project/addVisualManual",
    "/api/project/deleteDirectorManual",
    "/api/project/deleteVisualManual",
    "/api/project/editDirectorlManual",
    "/api/project/editVisualManual",
    "/api/project/getVisualManual",
    "/api/project/queryDirectorManual",
    "/api/project/visualManual",
  ];

  for (const pathname of accountManualRoutes) {
    assert.equal(isLegacyProjectRoute(pathname), false, pathname);
    assert.equal(isLegacyProjectMutation("POST", pathname), false, pathname);
  }

  assert.equal(isLegacyProjectRoute("/api/project/editProject"), true);
  assert.equal(isLegacyProjectMutation("POST", "/api/project/editProject"), true);

  // 首页「我的项目」列表为账号级，不得要求已打开中央项目。
  assert.equal(isLegacyProjectRoute("/api/project/getProject"), false);
  assert.equal(isLegacyProjectMutation("POST", "/api/project/getProject"), false);
});
