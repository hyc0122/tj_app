/**
 * R24-fix RED：updateSettings 改路径后，旧 getStatus 探测不得回写旧路径或唤醒调度。
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
import { invalidateDreaminaCapabilityCache } from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import { resetDreaminaStartupStatusCheckForTests } from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import { resetDreaminaEnablementForTests } from "../../src/tianjiang/model-providers/dreamina-cli/dreamina-enablement";
import { readDreaminaRuntimeState } from "../../src/tianjiang/model-providers/dreamina-cli/runtime-state-store";
import {
  stopDreaminaSchedulerLoop,
} from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import {
  readDreaminaCliSettings,
  writeDreaminaCliSettings,
} from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2424 };
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");

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
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function commandLines(logFile: string): Array<{ args: string[] }> {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").trim().split(/\n/).filter(Boolean).map((line) =>
    JSON.parse(line) as { args: string[] });
}

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const normalize = (value: string) => (process.platform === "win32"
    ? path.resolve(value).toLocaleLowerCase("en-US")
    : path.resolve(value));
  return normalize(left) === normalize(right);
}

test("P1-1 慢速 getStatus 探测路径 A 时改成 B，旧探测不得回写 A 或唤醒调度", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `r24-fix-path-${process.pid}-${crypto.randomUUID()}`);
  const logFile = path.join(root, "cli.jsonl");
  const pathB = path.join(root, "dreamina-b.bin");
  const previousCwd = process.cwd();
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    DREAMINA_TEST_EXECUTABLE: process.env.DREAMINA_TEST_EXECUTABLE,
    DREAMINA_FAKE_LOG: process.env.DREAMINA_FAKE_LOG,
    DREAMINA_FAKE_PROBE_DELAY_MS: process.env.DREAMINA_FAKE_PROBE_DELAY_MS,
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(pathB, "not-a-cli");
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.DREAMINA_FAKE_LOG = logFile;
  delete process.env.DREAMINA_FAKE_PROBE_DELAY_MS;
  resetDatabaseRuntimeForServe();
  resetDreaminaStartupStatusCheckForTests();
  resetDreaminaEnablementForTests();
  invalidateDreaminaCapabilityCache();
  stopDreaminaSchedulerLoop();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await writeDreaminaCliSettings({ enabled: true, executablePath: FAKE_CLI, pauseNewClaims: false });
    });
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => {
      enterUserStorage(IDENTITY);
      next();
    });
    app.use("/api/setting/dreaminaCli/getStatus", (await import("../../src/routes/setting/dreaminaCli/getStatus")).default);
    app.use("/api/setting/dreaminaCli/updateSettings", (await import("../../src/routes/setting/dreaminaCli/updateSettings")).default);
    const { server, port } = await listen(app);
    const statusUrl = `http://127.0.0.1:${port}/api/setting/dreaminaCli/getStatus`;
    const updateUrl = `http://127.0.0.1:${port}/api/setting/dreaminaCli/updateSettings`;
    try {
      process.env.DREAMINA_FAKE_PROBE_DELAY_MS = "700";
      fs.writeFileSync(logFile, "");
      const statusA = jsonRequest(statusUrl);
      const started = Date.now();
      while (Date.now() - started < 2000 && commandLines(logFile).length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      process.env.DREAMINA_FAKE_PROBE_DELAY_MS = "10";
      const updated = await jsonRequest(updateUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executablePath: pathB }),
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      await statusA;
      const settings = await runWithUserStorage(IDENTITY, () => readDreaminaCliSettings());
      const runtime = await runWithUserStorage(IDENTITY, () => readDreaminaRuntimeState());
      assert.equal(samePath(settings.executablePath, pathB), true, `最终设置必须是 B: ${settings.executablePath}`);
      assert.equal(samePath(runtime.executablePath, FAKE_CLI), false, `运行态不得回写 A: ${runtime.executablePath}`);
      assert.equal(samePath(runtime.install?.executablePath, FAKE_CLI), false, `install 不得回写 A: ${runtime.install?.executablePath}`);
      assert.equal(samePath(runtime.executablePath, pathB) || runtime.install?.reason === "待检测", true,
        JSON.stringify({ path: runtime.executablePath, reason: runtime.install?.reason }));
      const generate = commandLines(logFile).filter((line) =>
        String(line.args[0]).endsWith("2video") && !line.args.includes("-h"));
      assert.deepEqual(generate, [], "旧探测不得唤醒调度去生成");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    stopDreaminaSchedulerLoop();
    resetDreaminaStartupStatusCheckForTests();
    resetDreaminaEnablementForTests();
    invalidateDreaminaCapabilityCache();
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
