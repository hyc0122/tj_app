/**
 * Task 8 RED：环境检测只声明真实依赖，且不得触发下载。
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";

import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { enterUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { createUniqueWorktreeRoot, closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

async function listen(app: express.Express) {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

test("getEnvironment 只返回 dreamina_binary，且零下载", async () => {
  const root = createUniqueWorktreeRoot("dreamina-env-r14");
  const originalCwd = process.cwd();
  const identity = { issuer: "https://api.j11.com.cn", userId: 9810 };
  let downloads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const target = String(args[0]);
    if (!target.includes("127.0.0.1") && !target.includes("localhost")) downloads += 1;
    return originalFetch(...args);
  }) as typeof fetch;

  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);

    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => { enterUserStorage(identity); next(); });
    try {
      const loaded = await import("../../src/routes/setting/dreaminaCli/getEnvironment");
      app.use("/api/setting/dreaminaCli/getEnvironment", loaded.default);
    } catch {
      // GREEN 前为 404。
    }
    const { server, port } = await listen(app);
    try {
      downloads = 0;
      const response = await fetch(`http://127.0.0.1:${port}/api/setting/dreaminaCli/getEnvironment`);
      assert.notEqual(response.status, 404, "getEnvironment 生产路由必须存在");
      const body = await response.json() as any;
      const payload = body.data ?? body;
      const deps = payload.dependencies ?? [];
      assert.equal(deps.length, 1, `Windows native 只声明 dreamina_binary，实际 ${JSON.stringify(deps)}`);
      assert.equal(deps[0].id, "dreamina_binary");
      assert.equal(downloads, 0, "环境检测不得下载");
      assert.equal(payload.suggestWsl, false, "未分类为平台不兼容时不得建议 WSL");
      assert.equal(payload.linuxReleaseAvailable, false, "官方未提供 Linux 发行物时必须明确不可用");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    globalThis.fetch = originalFetch;
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
