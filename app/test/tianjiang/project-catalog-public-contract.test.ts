import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CentralRuntimeAdapter } from "../../src/tianjiang/runtime/central-runtime-adapter";
import { localLegacyProjectId } from "../../src/tianjiang/runtime/local-project-id";

const projectUuid = "11111111-1111-4111-a111-111111111111";

test("公开项目目录不要求也不返回数据库内部 legacyProjectId", async () => {
  const gateway = {
    forwardBusinessRequest: async () => ({
      projects: [{
        projectUuid,
        name: "本地映射项目",
        kind: "personal",
        ownerUserId: 7,
        myRole: "owner",
        currentVersion: 1,
        syncState: "synced",
        lastSyncedAt: null,
        updatedAt: "2026-08-01T00:00:00Z",
        lockStatus: "none",
        lockHolderName: "",
        openMode: "editable",
        businessType: "novel",
      }],
    }),
  };
  const adapter = new CentralRuntimeAdapter(
    gateway as any,
    { serverUrl: "https://api.j11.com.cn", user: { id: 7 } } as any,
    "22222222-2222-4222-a222-222222222222",
  );

  const catalog = await adapter.projectCatalog(7);
  assert.equal(catalog.length, 1);
  assert.equal(Object.hasOwn(catalog[0]!, "legacyProjectId"), false);
});

test("团队项目允许中央以 ownerUserId=0 表示所有权归属团队", async () => {
  const gateway = {
    forwardBusinessRequest: async () => ({
      projects: [{
        projectUuid,
        name: "团队项目",
        kind: "team",
        // 团队项目由团队持有，服务端不会伪造某个成员为个人所有者。
        ownerUserId: 0,
        myRole: "editor",
        currentVersion: 1,
        syncState: "synced",
        lastSyncedAt: null,
        updatedAt: "2026-08-03T00:00:00Z",
        lockStatus: "none",
        lockHolderName: "",
        openMode: "editable",
        businessType: "novel",
      }],
    }),
  };
  const adapter = new CentralRuntimeAdapter(
    gateway as any,
    { serverUrl: "https://api.j11.com.cn", user: { id: 7 } } as any,
    "22222222-2222-4222-a222-222222222222",
  );

  const catalog = await adapter.projectCatalog(7);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]!.kind, "team");
  assert.equal(catalog[0]!.ownerUserId, 0);
});

test("个人项目仍拒绝 ownerUserId=0", async () => {
  const gateway = {
    forwardBusinessRequest: async () => ({
      projects: [{
        projectUuid,
        name: "无效个人项目",
        kind: "personal",
        ownerUserId: 0,
        myRole: "owner",
        currentVersion: 1,
        syncState: "synced",
        lastSyncedAt: null,
        updatedAt: "2026-08-03T00:00:00Z",
        lockStatus: "none",
        lockHolderName: "",
        openMode: "editable",
        businessType: "novel",
      }],
    }),
  };
  const adapter = new CentralRuntimeAdapter(
    gateway as any,
    { serverUrl: "https://api.j11.com.cn", user: { id: 7 } } as any,
    "22222222-2222-4222-a222-222222222222",
  );

  await assert.rejects(
    () => adapter.projectCatalog(7),
    /中央项目所有者无效/,
  );
});

test("UUID 到本地旧工作区数字 ID 的映射稳定且保持安全整数", () => {
  const first = localLegacyProjectId(projectUuid);
  const second = localLegacyProjectId(projectUuid.toUpperCase());
  assert.equal(first, second);
  assert.ok(Number.isSafeInteger(first));
  assert.ok(first > 0);
});

test("App 与 Web 公共契约都不再声明 legacyProjectId", () => {
  const sources = [
    path.resolve("src", "tianjiang", "contracts.ts"),
    path.resolve("..", "web", "src", "features", "tianjiang", "contracts.ts"),
    path.resolve("..", "web", "src", "features", "tianjiang", "project", "catalog.ts"),
  ].map((filePath) => fs.readFileSync(filePath, "utf8"));
  for (const source of sources) assert.doesNotMatch(source, /legacyProjectId/);
});

test("运行时暴露 projects/refresh 且协调器实现 refreshProjectCatalog", () => {
  const runtimeRoute = fs.readFileSync(
    path.resolve("src", "routes", "tianjiang", "runtime.ts"),
    "utf8",
  );
  const coordinator = fs.readFileSync(
    path.resolve("src", "tianjiang", "runtime", "sync-coordinator.ts"),
    "utf8",
  );
  assert.match(runtimeRoute, /\/projects\/refresh/);
  assert.match(coordinator, /async refreshProjectCatalog\s*\(/);
  assert.match(coordinator, /离线状态禁止伪造中央目录刷新/);
});
