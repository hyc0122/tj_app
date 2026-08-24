/**
 * R24-fix3 RED：updateSettings 不得用锁外 previous 决定是否进锁。
 * 覆盖「初始读取完成后暂停」窗口：R1 显式提交 A 暂停、R2 完成 A→B、释放 R1，
 * 禁止最终 settings=A 且 runtime/cache=B。
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
import { resetDreaminaStartupStatusCheckForTests } from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import {
  readDreaminaProbeEpoch,
  resetDreaminaEnablementForTests,
} from "../../src/tianjiang/model-providers/dreamina-cli/dreamina-enablement";
import { readDreaminaRuntimeState } from "../../src/tianjiang/model-providers/dreamina-cli/runtime-state-store";
import { stopDreaminaSchedulerLoop } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import {
  readDreaminaCliSettings,
  writeDreaminaCliSettings,
} from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { setDreaminaUpdateSettingsAfterInitialReadHookForTests } from "../../src/routes/setting/dreaminaCli/updateSettings";
import { currentUserStorage, enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2829 };
const OTHER = { issuer: "https://api.j11.com.cn", userId: 2830 };
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

function assertSanitizedSettingsError(body: unknown): void {
  const text = JSON.stringify(body ?? {});
  assert.equal(/[A-Za-z]:\\/.test(text), false, `不得回显路径: ${text}`);
  assert.equal(/SELECT /i.test(text), false, `不得回显 SQL: ${text}`);
  assert.equal(/cookie/i.test(text), false, `不得回显 Cookie: ${text}`);
  assert.equal(/sk-/.test(text), false, `不得回显令牌: ${text}`);
  assert.equal(/at\s+\S+\.(ts|js)/i.test(text), false, `不得回显堆栈: ${text}`);
  assert.equal(/SQLITE/i.test(text), false, `不得回显 SQLITE: ${text}`);
}

type Timeline = string[];

async function withUpdateServer(
  name: string,
  run: (input: {
    updateUrl: string;
    logFile: string;
    pathA: string;
    pathB: string;
    timeline: Timeline;
  }) => Promise<void>,
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
  const timeline: Timeline = [];
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
  setDreaminaUpdateSettingsAfterInitialReadHookForTests(null);
  stopDreaminaSchedulerLoop();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await writeDreaminaCliSettings({ enabled: true, executablePath: FAKE_CLI, pauseNewClaims: false, maxConcurrency: 1 });
    });
    enterUserStorage(IDENTITY);
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
    }, "other-account-segment-r24-fix3");
    writeDreaminaCapabilityCache({
      state: "ready",
      snapshot: {
        installed: true,
        version: "mine-before-A",
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
    app.use(
      "/api/setting/dreaminaCli/updateSettings",
      (await import("../../src/routes/setting/dreaminaCli/updateSettings")).default,
    );
    const { server, port } = await listen(app);
    try {
      await run({
        updateUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/updateSettings`,
        logFile,
        pathA: FAKE_CLI,
        pathB,
        timeline,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    setDreaminaUpdateSettingsAfterInitialReadHookForTests(null);
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
}

function installInitialReadGate(): {
  r1Reached: Promise<void>;
  releaseR1: () => void;
} {
  let markReached!: () => void;
  let releaseR1!: () => void;
  const r1Reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    releaseR1 = resolve;
  });
  let hits = 0;
  setDreaminaUpdateSettingsAfterInitialReadHookForTests(async () => {
    hits += 1;
    if (hits === 1) {
      markReached();
      await hold;
    }
  });
  return { r1Reached, releaseR1 };
}

test("R1 显式提交未变路径 A 暂停期间 R2 迁到 B，禁止 settings=A 且 runtime/cache=B", async () => {
  await withUpdateServer("r24-fix3-stale-a", async ({ updateUrl, logFile, pathA, pathB, timeline }) => {
    const { r1Reached, releaseR1 } = installInitialReadGate();
    timeline.push("start-R1-post-A");
    const r1Promise = jsonRequest(updateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: pathA }),
    });
    await r1Reached;
    timeline.push("R1-paused-after-initial-read");

    timeline.push("start-R2-post-B");
    const r2 = await jsonRequest(updateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: pathB }),
    });
    timeline.push("R2-finished");
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    const afterR2 = await runWithUserStorage(IDENTITY, async () => ({
      settings: await readDreaminaCliSettings(),
      runtime: await readDreaminaRuntimeState(),
      epoch: readDreaminaProbeEpoch(),
    }));
    assert.equal(samePath(afterR2.settings.executablePath, pathB), true, "R2 完成后 settings 必须是 B");
    assert.equal(
      samePath(afterR2.runtime.executablePath, pathB)
        || afterR2.runtime.install?.reason === "待检测",
      true,
      `R2 完成后 runtime 必须跟随 B: ${JSON.stringify({
        path: afterR2.runtime.executablePath,
        reason: afterR2.runtime.install?.reason,
      })}`,
    );
    let cacheAfterR2 = readDreaminaCapabilityCache(currentUserStorage()?.segment);
    if (cacheAfterR2.state !== "ready" || !cacheAfterR2.snapshot) {
      writeDreaminaCapabilityCache({
        state: "ready",
        snapshot: {
          installed: true,
          version: "from-B-r2",
          probedAt: Date.now(),
          loggedIn: true,
          modes: {} as never,
          capabilities: [],
          videoModels: [],
        },
        checkedAt: Date.now(),
      });
      cacheAfterR2 = readDreaminaCapabilityCache(currentUserStorage()?.segment);
    }
    const bCacheVersion = String(cacheAfterR2.snapshot?.version ?? "");

    timeline.push("release-R1");
    releaseR1();
    const r1 = await r1Promise;
    timeline.push("R1-finished");
    assert.deepEqual(timeline, [
      "start-R1-post-A",
      "R1-paused-after-initial-read",
      "start-R2-post-B",
      "R2-finished",
      "release-R1",
      "R1-finished",
    ]);

    const final = await runWithUserStorage(IDENTITY, async () => ({
      settings: await readDreaminaCliSettings(),
      runtime: await readDreaminaRuntimeState(),
      epoch: readDreaminaProbeEpoch(),
    }));
    const cacheFinal = readDreaminaCapabilityCache(currentUserStorage()?.segment);
    const settingsIsA = samePath(final.settings.executablePath, pathA);
    const runtimeIsB = samePath(final.runtime.executablePath, pathB)
      || samePath(final.runtime.install?.executablePath, pathB);
    const cacheIsB = cacheFinal.snapshot?.version === bCacheVersion
      || cacheFinal.snapshot?.version === "from-B-r2";
    assert.equal(
      settingsIsA && (runtimeIsB || cacheIsB),
      false,
      `禁止 settings=A 且 runtime/cache=B: ${JSON.stringify({
        settings: final.settings.executablePath,
        runtime: final.runtime.executablePath,
        install: final.runtime.install,
        cache: cacheFinal,
        r1,
        timeline,
      })}`,
    );

    if (r1.status === 409) {
      assertSanitizedSettingsError(r1.body);
      assert.equal(samePath(final.settings.executablePath, pathB), true, "409 后 settings 必须保持 B");
      assert.equal(runtimeIsB, true, "409 后 runtime 必须保持 B");
    } else {
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      assert.equal(settingsIsA, true, "后写优先时最终 settings 必须是 A");
      assert.equal(samePath(final.runtime.executablePath, pathA), true, "后写优先时 runtime 必须迁回 A");
      assert.equal(samePath(final.runtime.install?.executablePath, pathA), true, "后写优先时 install 必须对应 A");
      assert.notEqual(cacheFinal.snapshot?.version, bCacheVersion, "后写优先写回 A 必须失效 B 缓存");
      assert.notEqual(cacheFinal.snapshot?.version, "from-B-r2");
      assert.ok(final.epoch > afterR2.epoch, `写回 A 必须递增 probeEpoch: ${afterR2.epoch} -> ${final.epoch}`);
      assert.ok(
        final.runtime.install?.reason === "待检测"
          || samePath(final.runtime.executablePath, pathA),
        JSON.stringify(final.runtime.install),
      );
    }
    assert.equal(
      readDreaminaCapabilityCache("other-account-segment-r24-fix3").snapshot?.version,
      "other-keep",
    );
    const generate = commandLines(logFile).filter((line) =>
      String(line.args[0]).endsWith("2video") && !line.args.includes("-h"));
    assert.deepEqual(generate, [], "不得唤醒调度器去生成");
  });
});

test("进入锁后 latest 已等于目标路径时仍必须保存 preferredExecutionTarget", async () => {
  await withUpdateServer("r24-fix3-same-path-pref", async ({ updateUrl, pathB, timeline }) => {
    const { r1Reached, releaseR1 } = installInitialReadGate();
    timeline.push("start-R1-post-B-wsl");
    const r1Promise = jsonRequest(updateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        executablePath: pathB,
        preferredExecutionTarget: "wsl",
        maxConcurrency: 3,
        pauseNewClaims: true,
      }),
    });
    await r1Reached;
    timeline.push("R1-paused-after-initial-read");

    timeline.push("start-R2-post-B");
    const r2 = await jsonRequest(updateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: pathB }),
    });
    timeline.push("R2-finished");
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    const afterR2 = await runWithUserStorage(IDENTITY, async () => ({
      settings: await readDreaminaCliSettings(),
      runtime: await readDreaminaRuntimeState(),
    }));
    assert.equal(samePath(afterR2.settings.executablePath, pathB), true);
    assert.equal(afterR2.runtime.preferredExecutionTarget, "windows_native");

    timeline.push("release-R1");
    releaseR1();
    const r1 = await r1Promise;
    timeline.push("R1-finished");
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.deepEqual(timeline, [
      "start-R1-post-B-wsl",
      "R1-paused-after-initial-read",
      "start-R2-post-B",
      "R2-finished",
      "release-R1",
      "R1-finished",
    ]);

    const final = await runWithUserStorage(IDENTITY, async () => ({
      settings: await readDreaminaCliSettings(),
      runtime: await readDreaminaRuntimeState(),
    }));
    assert.equal(samePath(final.settings.executablePath, pathB), true, "目标路径必须保持 B");
    assert.equal(final.settings.maxConcurrency, 3, "锁内同路径不得丢失 maxConcurrency");
    assert.equal(final.settings.pauseNewClaims, true, "锁内同路径不得丢失 pauseNewClaims");
    assert.equal(
      final.runtime.preferredExecutionTarget,
      "wsl",
      "锁内发现 latest 已等于目标路径时仍必须保存 preferredExecutionTarget",
    );
  });
});
