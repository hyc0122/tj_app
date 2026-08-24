/**
 * Task 9 RED：授权材料不得回传 device_code；日志不得记录登录材料。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import express from "express";

import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { enterUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { createUniqueWorktreeRoot, closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");

async function listen(app: express.Express) {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function jsonRequest(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: response.status, body };
}

test("startAuthorization 只返回授权地址和用户码，且日志不含登录材料", async () => {
  const root = createUniqueWorktreeRoot("dreamina-auth-r14");
  const originalCwd = process.cwd();
  const logFile = path.join(root, "cli.log");
  const identity = { issuer: "https://api.j11.com.cn", userId: 9914 };

  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    // 中文注释：新授权状态机先复用已登录账号；本用例只验证未登录时的设备授权材料与泄漏边界。
    process.env.DREAMINA_FAKE_SCENARIO = "not_logged_in";
    process.env.DREAMINA_FAKE_LOG = logFile;
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);

    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => { enterUserStorage(identity); next(); });
    for (const name of ["updateSettings", "startAuthorization", "checkAuthorization", "refreshAccount", "logout"] as const) {
      try {
        const loaded = await import(`../../src/routes/setting/dreaminaCli/${name}`);
        app.use(`/api/setting/dreaminaCli/${name}`, loaded.default);
      } catch {
        // GREEN 前为 404。
      }
    }
    const { server, port } = await listen(app);
    const base = `http://127.0.0.1:${port}/api/setting/dreaminaCli`;
    try {
      await jsonRequest(`${base}/updateSettings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executablePath: FAKE_CLI, maxConcurrency: 1 }),
      });
      const started = await jsonRequest(`${base}/startAuthorization`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      assert.notEqual(started.status, 404, "startAuthorization 生产路由必须存在");
      assert.equal(started.status, 200, `授权启动失败: ${JSON.stringify(started.body)}`);
      const payload = (started.body as any)?.data ?? started.body;
      assert.match(String(payload.verificationUri ?? ""), /^https:\/\//);
      assert.ok(payload.userCode, "必须返回 userCode");
      assert.equal(payload.deviceCode, undefined, "device_code 不得回传 UI");
      const dumped = JSON.stringify(started.body);
      assert.doesNotMatch(dumped, /device_code|deviceCode/i);

      const logs = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
      assert.doesNotMatch(logs, /device-secret|cookie|token=/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
    delete process.env.DREAMINA_FAKE_LOG;
  }
});
