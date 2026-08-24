/**
 * Round17 RED：savePrompt/updatePrompt/deletePrompt 必须拒绝路径穿越，且目录外零写入。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import express from "express";

import { enterUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  accountDatabase,
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const identity = { issuer: "https://api.j11.com.cn", userId: 1720 };

async function listen(app: express.Express) {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

test("savePrompt 路径穿越必须 400 且目标目录外零文件", async () => {
  const root = createUniqueWorktreeRoot("r17-prompt-path");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    enterUserStorage(identity);
    const outside = path.join(root, "outside-secret.md");
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => {
      enterUserStorage(identity);
      next();
    });
    app.use("/api/setting/modelMap/savePrompt", (await import("../../src/routes/setting/modelMap/savePrompt")).default);
    app.use("/api/setting/modelMap/updatePrompt", (await import("../../src/routes/setting/modelMap/updatePrompt")).default);
    app.use("/api/setting/modelMap/deletePrompt", (await import("../../src/routes/setting/modelMap/deletePrompt")).default);
    app.use("/api/setting/modelMap/bindingPrompt", (await import("../../src/routes/setting/modelMap/bindingPrompt")).default);
    const { server, port } = await listen(app);
    try {
      for (const name of ["../outside-secret", "..\\outside-secret", "/tmp/evil", "C:\\\\Windows\\\\evil", "\\\\unc\\\\share"]) {
        const response = await fetch(`http://127.0.0.1:${port}/api/setting/modelMap/savePrompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, data: "pwned", type: "video" }),
        });
        assert.equal(response.status, 400, `name=${name} 必须 400，实际=${response.status}`);
        const updated = await fetch(`http://127.0.0.1:${port}/api/setting/modelMap/updatePrompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, data: "pwned", type: "video" }),
        });
        assert.equal(updated.status, 400, `updatePrompt name=${name} 必须 400，实际=${updated.status}`);
      }
      for (const badPath of ["../outside-secret.md", "..\\outside-secret.md", "/tmp/evil.md", "C:/Windows/evil.md", "\\\\unc\\\\share.md", "video/../outside.md"]) {
        const deleted = await fetch(`http://127.0.0.1:${port}/api/setting/modelMap/deletePrompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: badPath }),
        });
        assert.equal(deleted.status, 400, `deletePrompt path=${badPath} 必须 400，实际=${deleted.status}`);
      }
      assert.equal(fs.existsSync(outside), false, "穿越不得在夹具根写下 outside-secret.md");
      const escaped = path.join(root, "data", "outside-secret.md");
      assert.equal(fs.existsSync(escaped), false, "穿越不得写到 data/outside-secret.md");

      const saved = await fetch(`http://127.0.0.1:${port}/api/setting/modelMap/savePrompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "r17safe", data: "safe-body", type: "video" }),
      });
      assert.equal(saved.status, 200, `合法 savePrompt 必须成功，实际=${saved.status}`);
      const bound = await fetch(`http://127.0.0.1:${port}/api/setting/modelMap/bindingPrompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          vendorId: "tianjiang",
          model: "r17-safe-model",
          path: "video/r17safe.md",
          fileName: "r17safe.md",
        }),
      });
      assert.equal(bound.status, 200, `bindingPrompt 必须成功，实际=${bound.status}`);
      const before = await accountDatabase()("o_modelPrompt").where({ vendorId: "tianjiang", model: "r17-safe-model" }).first();
      assert.ok(before, "删除前必须已有模型提示词映射");
      const removed = await fetch(`http://127.0.0.1:${port}/api/setting/modelMap/deletePrompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "video/r17safe.md" }),
      });
      assert.equal(removed.status, 200, `deletePrompt 必须成功，实际=${removed.status}`);
      const after = await accountDatabase()("o_modelPrompt").where({ vendorId: "tianjiang", model: "r17-safe-model" }).first();
      assert.equal(after, undefined, "删除提示词文件后账号映射必须消失");
    } finally {
      await new Promise<void>((resolve) => {
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        server.close(() => resolve());
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    // 中文注释：先等 HTTP 句柄收干净再关 SQLite，避免 Windows libuv UV_HANDLE_CLOSING。
    await new Promise((resolve) => setTimeout(resolve, 200));
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});
