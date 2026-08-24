/**
 * R24-fix2 lock RED：路径更新与探测持久化必须共享账号级串行锁。
 * 覆盖 persist 锁内最终校验之后、写入 settings/runtime 之前的窗口。
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
import {
  invalidateDreaminaCapabilityCache,
  readDreaminaCapabilityCache,
  writeDreaminaCapabilityCache,
} from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import {
  resetDreaminaStartupStatusCheckForTests,
  setDreaminaPersistAfterLockedCheckHookForTests,
} from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import { resetDreaminaEnablementForTests } from "../../src/tianjiang/model-providers/dreamina-cli/dreamina-enablement";
import { readDreaminaRuntimeState } from "../../src/tianjiang/model-providers/dreamina-cli/runtime-state-store";
import { stopDreaminaSchedulerLoop } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import {
  readDreaminaCliSettings,
  writeDreaminaCliSettings,
} from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { currentUserStorage, enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2727 };
const OTHER = { issuer: "https://api.j11.com.cn", userId: 2728 };
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

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const normalize = (value: string) => (process.platform === "win32"
    ? path.resolve(value).toLocaleLowerCase("en-US")
    : path.resolve(value));
  return normalize(left) === normalize(right);
}

function commandLines(logFile: string): Array<{ args: string[] }> {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").trim().split(/\n/).filter(Boolean).map((line) =>
    JSON.parse(line) as { args: string[] });
}

test("锁内最终校验后并发 updateSettings A→B，最终只能留下 B", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `r24-fix2-lock-${process.pid}-${crypto.randomUUID()}`);
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
  setDreaminaPersistAfterLockedCheckHookForTests(null);
  stopDreaminaSchedulerLoop();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await writeDreaminaCliSettings({ enabled: true, executablePath: FAKE_CLI, pauseNewClaims: false });
    });
    enterUserStorage(IDENTITY);
    const otherScope = "other-account-segment-lock";
    writeDreaminaCapabilityCache({
      state: "ready",
      snapshot: {
        installed: true,
        version: "other-keep",
        probedAt: 1,
        loggedIn: true,
        modes: {} as never,
        capabilities: [],
        videoModels: [],
      },
      checkedAt: 1,
    }, otherScope);
    writeDreaminaCapabilityCache({
      state: "ready",
      snapshot: {
        installed: true,
        version: "mine-before",
        probedAt: 1,
        loggedIn: true,
        modes: {} as never,
        capabilities: [],
        videoModels: [],
      },
      checkedAt: 1,
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
      process.env.DREAMINA_FAKE_PROBE_DELAY_MS = "200";
      fs.writeFileSync(logFile, "");
      let updatePromise: Promise<{ status: number; body: any }> | undefined;
      let updateFinishedWhileAHeld = false;
      setDreaminaPersistAfterLockedCheckHookForTests(async () => {
        updatePromise = jsonRequest(updateUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ executablePath: pathB }),
        });
        const raced = await Promise.race([
          updatePromise.then((result) => {
            updateFinishedWhileAHeld = true;
            return result;
          }),
          new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 120)),
        ]);
        void raced;
      });
      const statusA = jsonRequest(statusUrl);
      const started = Date.now();
      while (Date.now() - started < 3000 && commandLines(logFile).length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await statusA;
      assert.ok(updatePromise, "锁内钩子必须发出真实 updateSettings");
      const updated = await updatePromise;
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      const settings = await runWithUserStorage(IDENTITY, () => readDreaminaCliSettings());
      const runtime = await runWithUserStorage(IDENTITY, () => readDreaminaRuntimeState());
      assert.equal(samePath(settings.executablePath, pathB), true, `最终设置必须是 B: ${settings.executablePath}`);
      assert.equal(samePath(runtime.executablePath, FAKE_CLI), false, `最终 runtime 不得留下 A: ${runtime.executablePath}`);
      assert.equal(samePath(runtime.install?.executablePath, FAKE_CLI), false, `install 不得留下 A`);
      assert.ok(
        samePath(runtime.executablePath, pathB) || runtime.install?.reason === "待检测",
        JSON.stringify({ path: runtime.executablePath, reason: runtime.install?.reason }),
      );
      const mine = readDreaminaCapabilityCache(currentUserStorage()?.segment);
      assert.notEqual(mine.snapshot?.version, "from-A-persist");
      if (mine.state === "ready" && mine.snapshot?.version) {
        assert.notEqual(mine.snapshot.version, "mine-before");
      }
      assert.equal(readDreaminaCapabilityCache(otherScope).snapshot?.version, "other-keep");
      const generate = commandLines(logFile).filter((line) =>
        String(line.args[0]).endsWith("2video") && !line.args.includes("-h"));
      assert.deepEqual(generate, [], "路径 A 不得唤醒调度器去生成");
      void updateFinishedWhileAHeld;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    setDreaminaPersistAfterLockedCheckHookForTests(null);
    stopDreaminaSchedulerLoop();
    resetDreaminaStartupStatusCheckForTests();
    resetDreaminaEnablementForTests();
    invalidateDreaminaCapabilityCache();
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await runWithUserStorage(OTHER, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
