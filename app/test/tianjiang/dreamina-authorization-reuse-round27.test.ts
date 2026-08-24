/**
 * Round27 RED：已登录复用、混合授权输出和授权强校验必须打到生产路由。
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
import { clearDreaminaAuthorizationSessions } from "../../src/tianjiang/model-providers/dreamina-cli/authorization-flow";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");

interface JsonResponse {
  status: number;
  body: any;
  data: any;
}

async function requestJson(url: string, body: object): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as any;
  return { status: response.status, body: payload, data: payload?.data ?? payload };
}

function readCommands(logFile: string): string[][] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line).args as string[]);
}

async function withAuthorizationServer(
  scenario: string,
  run: (context: { base: string; logFile: string; markerFile: string }) => Promise<void>,
): Promise<void> {
  const root = createUniqueWorktreeRoot(`dreamina-auth-r27-${scenario}`);
  const originalCwd = process.cwd();
  const logFile = path.join(root, "cli.log");
  const markerFile = path.join(root, "auth.marker");
  const identity = { issuer: "https://api.j11.com.cn", userId: 27_000 + scenario.length };
  let server: http.Server | undefined;

  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    process.env.DREAMINA_FAKE_SCENARIO = scenario;
    process.env.DREAMINA_FAKE_LOG = logFile;
    process.env.DREAMINA_FAKE_AUTH_MARKER = markerFile;
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);

    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => { enterUserStorage(identity); next(); });
    for (const name of ["updateSettings", "startAuthorization", "checkAuthorization"] as const) {
      const loaded = await import(`../../src/routes/setting/dreaminaCli/${name}`);
      app.use(`/api/setting/dreaminaCli/${name}`, loaded.default);
    }
    server = await new Promise<http.Server>((resolve) => {
      const created = app.listen(0, "127.0.0.1", () => resolve(created));
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}/api/setting/dreaminaCli`;
    const configured = await requestJson(`${base}/updateSettings`, {
      executablePath: FAKE_CLI,
      maxConcurrency: 1,
    });
    assert.equal(configured.status, 200);
    await run({ base, logFile, markerFile });
  } finally {
    clearDreaminaAuthorizationSessions();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
    delete process.env.DREAMINA_FAKE_SCENARIO;
    delete process.env.DREAMINA_FAKE_LOG;
    delete process.env.DREAMINA_FAKE_AUTH_MARKER;
  }
}

test("已登录账号启动授权必须直接复用，不得再次执行 login --headless", async () => {
  await withAuthorizationServer("already_logged_in", async ({ base, logFile }) => {
    const started = await requestJson(`${base}/startAuthorization`, { confirm: true });
    assert.equal(started.status, 200);
    assert.deepEqual(started.data, { state: "already_logged_in" });
    const commands = readCommands(logFile);
    assert.ok(commands.some((args) => args[0] === "user_credit"), "必须先验证本机账号状态");
    assert.equal(commands.some((args) => args[0] === "login"), false, "已登录不得再次发起设备授权");
  });
});

test("混合文本授权材料必须解析，且 device_code 不得返回 UI", async () => {
  await withAuthorizationServer("mixed_authorization", async ({ base }) => {
    const started = await requestJson(`${base}/startAuthorization`, { confirm: true });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.data.state, "authorization_required");
    assert.equal(started.data.verificationUri, "https://jimeng.jianying.com/auth");
    assert.equal(started.data.userCode, "ABCD-1234");
    assert.equal(JSON.stringify(started.body).includes("device_code"), false);
    assert.equal(JSON.stringify(started.body).includes("device-secret-not-for-ui"), false);
  });
});

test("空格标签授权材料必须解析，且 device_code 不得返回 UI", async () => {
  await withAuthorizationServer("spaced_authorization", async ({ base }) => {
    const started = await requestJson(`${base}/startAuthorization`, { confirm: true });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.data.state, "authorization_required");
    assert.equal(started.data.verificationUri, "https://jimeng.jianying.com/auth");
    assert.equal(started.data.userCode, "WXYZ-9876");
    assert.equal(JSON.stringify(started.body).includes("device_code"), false);
    assert.equal(JSON.stringify(started.body).includes("device-secret-not-for-ui"), false);
  });
});

test("checklogin 的泛化 ok 不得产生登录假阳性", async () => {
  await withAuthorizationServer("false_positive_check", async ({ base }) => {
    const started = await requestJson(`${base}/startAuthorization`, { confirm: true });
    assert.equal(started.status, 200);
    const checked = await requestJson(`${base}/checkAuthorization`, {
      authorizationId: started.data.authorizationId,
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.data.state, "authorizing");
  });
});

test("设备授权完成后必须以 user_credit 复核，再标记 logged_in", async () => {
  await withAuthorizationServer("authorization_then_logged_in", async ({ base, markerFile }) => {
    const started = await requestJson(`${base}/startAuthorization`, { confirm: true });
    assert.equal(started.data.state, "authorization_required");
    const checked = await requestJson(`${base}/checkAuthorization`, {
      authorizationId: started.data.authorizationId,
    });
    assert.equal(checked.data.state, "logged_in");
    assert.equal(fs.existsSync(markerFile), true);
  });
});
