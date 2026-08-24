/**
 * R24-fix2 RED：裸 dreamina 持久化、校验后写回 TOCTOU、getStatus 混态、分段缓存。
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
  setDreaminaPersistAfterIdentityHookForTests,
} from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import {
  bumpDreaminaProbeEpoch,
  resetDreaminaEnablementForTests,
} from "../../src/tianjiang/model-providers/dreamina-cli/dreamina-enablement";
import { readDreaminaRuntimeState, writeDreaminaRuntimeState } from "../../src/tianjiang/model-providers/dreamina-cli/runtime-state-store";
import { stopDreaminaSchedulerLoop } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import {
  readDreaminaCliSettings,
  writeDreaminaCliSettings,
} from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { currentUserStorage, enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2525 };
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

async function withServer(
  name: string,
  run: (input: { statusUrl: string; updateUrl: string; checkUrl: string; logFile: string; pathB: string }) => Promise<void>,
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${process.pid}-${crypto.randomUUID()}`);
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
  setDreaminaPersistAfterIdentityHookForTests(null);
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
    app.use("/api/setting/dreaminaCli/checkCli", (await import("../../src/routes/setting/dreaminaCli/checkCli")).default);
    const { server, port } = await listen(app);
    try {
      await run({
        statusUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/getStatus`,
        updateUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/updateSettings`,
        checkUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/checkCli`,
        logFile,
        pathB,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    setDreaminaPersistAfterIdentityHookForTests(null);
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
}

test("P1-1 裸 dreamina 检测成功后必须持久化绝对路径", async () => {
  await withServer("r24-fix2-bare", async ({ checkUrl, updateUrl }) => {
    const saved = await jsonRequest(updateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: "dreamina" }),
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const checked = await jsonRequest(checkUrl, { method: "POST" });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    const settings = await runWithUserStorage(IDENTITY, () => readDreaminaCliSettings());
    assert.equal(
      samePath(settings.executablePath, FAKE_CLI),
      true,
      `检测成功后必须写入绝对路径，不能停留在裸命令: ${settings.executablePath}`,
    );
  });
});

test("P1-2 最终校验后改成 B，旧探测 A 不得写回 settings/runtime", async () => {
  await withServer("r24-fix2-toc tou", async ({ statusUrl, pathB, logFile }) => {
    process.env.DREAMINA_FAKE_PROBE_DELAY_MS = "400";
    fs.writeFileSync(logFile, "");
    setDreaminaPersistAfterIdentityHookForTests(async () => {
      await writeDreaminaCliSettings({ executablePath: pathB });
      bumpDreaminaProbeEpoch();
      await writeDreaminaRuntimeState({
        executablePath: pathB,
        install: { checkedAt: null, reason: "待检测", executablePath: pathB },
        account: { state: "unknown", reason: "待检测", refreshedAt: Date.now() },
      }, { replaceAccount: true });
    });
    const statusA = await jsonRequest(statusUrl);
    void statusA;
    const settings = await runWithUserStorage(IDENTITY, () => readDreaminaCliSettings());
    const runtime = await runWithUserStorage(IDENTITY, () => readDreaminaRuntimeState());
    assert.equal(samePath(settings.executablePath, pathB), true, `设置必须保持 B: ${settings.executablePath}`);
    assert.equal(samePath(runtime.executablePath, FAKE_CLI), false, `runtime 不得写回 A: ${runtime.executablePath}`);
    assert.equal(samePath(runtime.install?.executablePath, FAKE_CLI), false, `install 不得写回 A`);
    const generate = commandLines(logFile).filter((line) =>
      String(line.args[0]).endsWith("2video") && !line.args.includes("-h"));
    assert.deepEqual(generate, [], "旧探测不得唤醒调度去生成");
  });
});

test("P1-3 慢探测 A 遇到路径 B 后不得返回 A/B 混合状态", async () => {
  await withServer("r24-fix2-mix", async ({ statusUrl, updateUrl, pathB, logFile }) => {
    process.env.DREAMINA_FAKE_PROBE_DELAY_MS = "700";
    fs.writeFileSync(logFile, "");
    const pending = jsonRequest(statusUrl);
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
    const late = await pending;
    const settings = await runWithUserStorage(IDENTITY, () => readDreaminaCliSettings());
    assert.equal(samePath(settings.executablePath, pathB), true, String(settings.executablePath));
    if (late.status === 200) {
      const payload = late.body?.data ?? late.body;
      const mixedAccount = payload?.account?.state === "logged_in" && samePath(payload?.install?.executablePath, pathB);
      const mixedInstall = samePath(payload?.install?.executablePath, FAKE_CLI);
      assert.equal(mixedAccount, false, `不得把 A 的登录叠到 B: ${JSON.stringify(payload?.account)}`);
      assert.equal(mixedInstall, false, `不得返回 A 的 install: ${payload?.install?.executablePath}`);
      if (payload?.account?.points) {
        assert.notEqual(payload?.install?.reason, "待检测");
      }
    } else {
      assert.equal(late.body?.code, "DREAMINA_CLI_ENABLEMENT_STALE");
    }
  });
});

test("P2 改路径只能作废当前账号 capability cache", async () => {
  await withServer("r24-fix2-cache", async ({ updateUrl, pathB }) => {
    enterUserStorage(IDENTITY);
    const currentScope = currentUserStorage()?.segment;
    assert.ok(currentScope, "测试必须有当前账号 segment");
    const otherScope = "other-account-segment";
    writeDreaminaCapabilityCache({
      state: "ready",
      snapshot: {
        installed: true,
        version: "keep",
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
        version: "mine",
        probedAt: 1,
        loggedIn: true,
        modes: {} as never,
        capabilities: [],
        videoModels: [],
      },
      checkedAt: 1,
    }, currentScope);
    const updated = await jsonRequest(updateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: pathB }),
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(readDreaminaCapabilityCache(otherScope).state, "ready");
    assert.equal(readDreaminaCapabilityCache(otherScope).snapshot?.version, "keep");
    const mine = readDreaminaCapabilityCache(currentUserStorage()?.segment);
    assert.notEqual(mine.snapshot?.version, "mine");
  });
});
