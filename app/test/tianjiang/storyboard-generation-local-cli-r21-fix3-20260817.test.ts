/**
 * R21-fix3 RED：应用启动后 enabled=true 时，真实 getStatus 必须等待同一次
 * version/-h + user_credit，返回 installed/logged_in/verified=true；
 * 并发必须合并；关闭零命令；未登录与失败不得伪装已登录。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { resetDreaminaStartupStatusCheckForTests } from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2123 };
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function payloadOf(body: any): any {
  return body?.data ?? body;
}

function commandLog(logFile: string): string[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8")
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { args: string[] }).args[0]);
}

function assertNoPaidOrAuthCommands(commands: string[]) {
  assert.equal(commands.includes("login"), false, JSON.stringify(commands));
  assert.equal(commands.includes("relogin"), false, JSON.stringify(commands));
  assert.equal(commands.includes("logout"), false, JSON.stringify(commands));
  assert.equal(
    commands.some((item) => String(item).endsWith("2video") || String(item).endsWith("2image")),
    false,
    JSON.stringify(commands),
  );
}

async function withStatusServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    enterUserStorage(IDENTITY);
    next();
  });
  const loaded = await import("../../src/routes/setting/dreaminaCli/getStatus");
  app.use("/api/setting/dreaminaCli/getStatus", loaded.default);
  const { server, port } = await listen(app);
  try {
    return await run(`http://127.0.0.1:${port}/api/setting/dreaminaCli/getStatus`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("启动后 getStatus 必须等待启动检测并返回 verified logged_in，并发合并", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `r21-fix3-status-${process.pid}-${crypto.randomUUID()}`);
  const logFile = path.join(root, "cli.jsonl");
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousExec = process.env.DREAMINA_TEST_EXECUTABLE;
  const previousLog = process.env.DREAMINA_FAKE_LOG;
  const previousScenario = process.env.DREAMINA_FAKE_SCENARIO;
  const previousDelay = process.env.DREAMINA_FAKE_PROBE_DELAY_MS;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.DREAMINA_FAKE_LOG = logFile;
  delete process.env.DREAMINA_FAKE_SCENARIO;
  resetDatabaseRuntimeForServe();
  resetDreaminaStartupStatusCheckForTests();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      await writeDreaminaCliSettings({ enabled: true, executablePath: FAKE_CLI });
    });
    await withStatusServer(async (url) => {
      process.env.DREAMINA_FAKE_PROBE_DELAY_MS = "80";
      fs.writeFileSync(logFile, "");
      const [first, second] = await Promise.all([getJson(url), getJson(url)]);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(second.status, 200, JSON.stringify(second.body));
      for (const response of [first, second]) {
        const payload = payloadOf(response.body);
        assert.equal(payload.enabled, true, JSON.stringify(payload));
        assert.equal(payload.install?.state, "installed", JSON.stringify(payload));
        assert.equal(payload.account?.state, "logged_in", JSON.stringify(payload));
        assert.equal(payload.account?.verified, true, JSON.stringify(payload));
        assert.ok(payload.install?.executablePath, JSON.stringify(payload));
        assert.match(String(payload.install.executablePath), /fake-dreamina-cli\.cjs$/);
        assert.ok(payload.account?.points, JSON.stringify(payload));
      }
      const commands = commandLog(logFile);
      const versionLike = commands.filter((item) => item === "version" || item === "-h");
      const credits = commands.filter((item) => item === "user_credit");
      assert.ok(versionLike.length >= 1, JSON.stringify(commands));
      assert.equal(versionLike.length, 1, `并发必须合并 version/-h: ${JSON.stringify(commands)}`);
      assert.equal(credits.length, 1, `并发必须合并 user_credit: ${JSON.stringify(commands)}`);
      assertNoPaidOrAuthCommands(commands);

      fs.writeFileSync(logFile, "");
      const cached = await getJson(url);
      assert.equal(payloadOf(cached.body).account?.verified, true);
      assert.deepEqual(commandLog(logFile), [], "TTL 命中不得再跑 CLI");
    });

    resetDreaminaStartupStatusCheckForTests();
    await runWithUserStorage(IDENTITY, async () => {
      await writeDreaminaCliSettings({ enabled: false, executablePath: FAKE_CLI });
    });
    delete process.env.DREAMINA_FAKE_PROBE_DELAY_MS;
    await withStatusServer(async (url) => {
      fs.writeFileSync(logFile, "");
      const disabled = await getJson(url);
      assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
      assert.deepEqual(commandLog(logFile), []);
      assert.notEqual(payloadOf(disabled.body).account?.state === "logged_in"
        && payloadOf(disabled.body).account?.verified === true, true);
    });

    resetDreaminaStartupStatusCheckForTests();
    process.env.DREAMINA_FAKE_SCENARIO = "not_logged_in";
    await runWithUserStorage(IDENTITY, async () => {
      await writeDreaminaCliSettings({ enabled: true, executablePath: FAKE_CLI });
    });
    await withStatusServer(async (url) => {
      fs.writeFileSync(logFile, "");
      const loggedOut = await getJson(url);
      const payload = payloadOf(loggedOut.body);
      assert.equal(loggedOut.status, 200, JSON.stringify(loggedOut.body));
      assert.equal(payload.account?.state, "logged_out", JSON.stringify(payload));
      assert.equal(payload.account?.verified, true, JSON.stringify(payload));
      assert.notEqual(payload.account?.state, "logged_in");
      const commands = commandLog(logFile);
      assert.ok(commands.includes("user_credit"), JSON.stringify(commands));
      assertNoPaidOrAuthCommands(commands);
    });

    resetDreaminaStartupStatusCheckForTests();
    process.env.DREAMINA_FAKE_SCENARIO = "not_installed";
    await withStatusServer(async (url) => {
      const failed = await getJson(url);
      const payload = payloadOf(failed.body);
      assert.equal(failed.status, 200, JSON.stringify(failed.body));
      assert.notEqual(payload.account?.state, "logged_in", JSON.stringify(payload));
      assert.notEqual(payload.account?.verified, true, JSON.stringify(payload));
      assertNoPaidOrAuthCommands(commandLog(logFile));
    });
  } finally {
    resetDreaminaStartupStatusCheckForTests();
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousExec === undefined) delete process.env.DREAMINA_TEST_EXECUTABLE;
    else process.env.DREAMINA_TEST_EXECUTABLE = previousExec;
    if (previousLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = previousLog;
    if (previousScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
    else process.env.DREAMINA_FAKE_SCENARIO = previousScenario;
    if (previousDelay === undefined) delete process.env.DREAMINA_FAKE_PROBE_DELAY_MS;
    else process.env.DREAMINA_FAKE_PROBE_DELAY_MS = previousDelay;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
