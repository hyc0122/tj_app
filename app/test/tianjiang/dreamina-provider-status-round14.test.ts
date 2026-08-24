/**
 * Task 6 RED：getStatus 必须一次返回安装/账户/能力/队列，且不得主动探测 CLI。
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

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function jsonRequest(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function createApp(identity: { issuer: string; userId: number }): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    enterUserStorage(identity);
    next();
  });
  for (const name of ["getStatus", "getSettings", "updateSettings", "runSelfCheck"] as const) {
    const loaded = await import(`../../src/routes/setting/dreaminaCli/${name}.ts`);
    app.use(`/api/setting/dreaminaCli/${name}`, loaded.default);
  }
  return app;
}

function payloadOf(body: any): any {
  return body?.data ?? body;
}

test("getStatus 必须同时表达安装、账户、能力和队列，且不主动拉起 CLI", async () => {
  const root = createUniqueWorktreeRoot("dreamina-status-r14");
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLog = process.env.DREAMINA_FAKE_LOG;
  const logFile = path.join(root, "cli.log");
  const identity = { issuer: "https://api.j11.com.cn", userId: 9414 };

  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    process.env.DREAMINA_FAKE_LOG = logFile;
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);

    const app = await createApp(identity);
    const { server, port } = await listen(app);
    const base = `http://127.0.0.1:${port}/api/setting/dreaminaCli`;
    try {
      const updated = await jsonRequest(`${base}/updateSettings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          executablePath: FAKE_CLI,
          preferredExecutionTarget: "windows_native",
          maxConcurrency: 2,
        }),
      });
      assert.notEqual(updated.status, 404, "updateSettings 生产路由必须存在");
      assert.equal(updated.status, 200, `updateSettings 失败: ${JSON.stringify(updated.body)}`);

      if (fs.existsSync(logFile)) fs.writeFileSync(logFile, "");
      const status = await jsonRequest(`${base}/getStatus`);
      assert.notEqual(status.status, 404, "getStatus 生产路由必须存在");
      assert.equal(status.status, 200, `getStatus 失败: ${JSON.stringify(status.body)}`);
      const payload = payloadOf(status.body);

      assert.equal(typeof payload.install, "object", `状态缺少 install: ${JSON.stringify(payload)}`);
      assert.match(String(payload.install?.state ?? ""), /not_installed|installing|installed|repair_required|failed/);
      assert.equal(typeof payload.account, "object", `状态缺少 account: ${JSON.stringify(payload)}`);
      assert.match(String(payload.account?.state ?? ""), /unknown|logged_out|authorizing|logged_in|expired|failed/);
      assert.equal(typeof payload.capability, "object", `状态缺少 capability: ${JSON.stringify(payload)}`);
      assert.equal(typeof payload.queue, "object", `状态缺少 queue: ${JSON.stringify(payload)}`);
      assert.equal(typeof payload.queue.paused, "boolean");
      assert.equal(typeof payload.queue.maxConcurrency, "number");
      assert.equal(payload.preferredExecutionTarget, "windows_native");
      assert.equal(
        payload.effectiveExecutionTarget,
        null,
        "effectiveExecutionTarget 只能由环境检测写入，不得抄写偏好",
      );
      assert.doesNotMatch(
        JSON.stringify(payload),
        /cookie|token|device_code|user_code/i,
        "状态不得回传登录材料",
      );

      const cliLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
      assert.equal(cliLog.trim(), "", `getStatus 不得主动探测 CLI，实际日志: ${cliLog}`);
      assert.equal(
        payload.account.planName === undefined || payload.account.expiresAt === undefined,
        true,
        "CLI 未返回套餐/到期时字段必须省略，不得伪造",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = originalLog;
  }
});
