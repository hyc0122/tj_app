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

test("未确认不得执行 wsl --install，且不得修改默认发行版", async () => {
  const root = createUniqueWorktreeRoot("dreamina-wsl-install-r14");
  const originalCwd = process.cwd();
  const identity = { issuer: "https://api.j11.com.cn", userId: 1010 };
  const commands: string[][] = [];
  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    const manager = await import("../../src/tianjiang/model-providers/dreamina-cli/wsl-manager");
    manager.bindWslExecutor(async (file: string, args: string[]) => {
      commands.push([file, ...args]);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => { enterUserStorage(identity); next(); });
    try {
      const loaded = await import("../../src/routes/setting/dreaminaCli/prepareWslInstall");
      app.use("/api/setting/dreaminaCli/prepareWslInstall", loaded.default);
    } catch { /* 404 */ }
    const { server, port } = await listen(app);
    try {
      const denied = await fetch(`http://127.0.0.1:${port}/api/setting/dreaminaCli/prepareWslInstall`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: false }),
      });
      assert.notEqual(denied.status, 404, "prepareWslInstall 生产路由必须存在");
      assert.notEqual(denied.status, 200, "未确认不得安装 WSL");
      assert.ok(!commands.some((item) => item.includes("--install")), "未确认不得执行 wsl --install");
      assert.ok(!commands.some((item) => item.includes("--set-default")), "不得修改默认发行版");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
