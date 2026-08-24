/**
 * R21-fix2 RED：false→true 必须走真实 updateSettings，接口返回与最终 runtime
 * 都是本次 user_credit 的 logged_in，且不得被后续 unknown/路径已更新覆盖。
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
import { readDreaminaRuntimeState } from "../../src/tianjiang/model-providers/dreamina-cli/runtime-state-store";
import { readDreaminaCliSettings, writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { resetDreaminaStartupStatusCheckForTests } from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2122 };
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function postJson(url: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

test("updateSettings false→true 必须等待检测完成，返回并持久 logged_in，不得写路径已更新", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `r21-fix2-enable-${process.pid}-${crypto.randomUUID()}`);
  const logFile = path.join(root, "cli.jsonl");
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousExec = process.env.DREAMINA_TEST_EXECUTABLE;
  const previousLog = process.env.DREAMINA_FAKE_LOG;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.DREAMINA_FAKE_LOG = logFile;
  resetDatabaseRuntimeForServe();
  resetDreaminaStartupStatusCheckForTests();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      await writeDreaminaCliSettings({ enabled: false, executablePath: FAKE_CLI });
    });
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => {
      enterUserStorage(IDENTITY);
      next();
    });
    const loaded = await import("../../src/routes/setting/dreaminaCli/setEnabled");
    app.use("/api/setting/dreaminaCli/setEnabled", loaded.default);
    const { server, port } = await listen(app);
    try {
      fs.writeFileSync(logFile, "");
      const enabled = await postJson(`http://127.0.0.1:${port}/api/setting/dreaminaCli/setEnabled`, {
        enabled: true,
      });
      assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
      const payload = payloadOf(enabled.body);
      assert.equal(payload.enabled, true);
      assert.equal(payload.account?.state, "logged_in", JSON.stringify(payload));
      assert.equal(payload.install?.state, "installed", JSON.stringify(payload));
      assert.ok(payload.install?.executablePath);
      assert.notEqual(String(payload.account?.reason ?? ""), "路径已更新，尚未检测");
      assert.notEqual(String(payload.install?.reason ?? ""), "路径已更新，尚未检测");

      const runtime = await runWithUserStorage(IDENTITY, () => readDreaminaRuntimeState());
      assert.equal(runtime.account.state, "logged_in", JSON.stringify(runtime));
      assert.equal(runtime.install.state, "installed");
      assert.notEqual(String(runtime.account.reason ?? ""), "路径已更新，尚未检测");
      await new Promise((resolve) => setTimeout(resolve, 80));
      const later = await runWithUserStorage(IDENTITY, () => readDreaminaRuntimeState());
      assert.equal(later.account.state, "logged_in", JSON.stringify(later));

      fs.writeFileSync(logFile, "");
      const disabled = await postJson(`http://127.0.0.1:${port}/api/setting/dreaminaCli/setEnabled`, {
        enabled: false,
      });
      assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
      assert.deepEqual(commandLog(logFile), []);

      fs.writeFileSync(logFile, "");
      const reopened = await postJson(`http://127.0.0.1:${port}/api/setting/dreaminaCli/setEnabled`, {
        enabled: true,
      });
      assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
      assert.equal(payloadOf(reopened.body).account?.state, "logged_in");
      const commands = commandLog(logFile);
      assert.ok(commands.includes("version") || commands.includes("-h"), JSON.stringify(commands));
      assert.ok(commands.includes("user_credit"), JSON.stringify(commands));
      assert.equal(commands.includes("login"), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
