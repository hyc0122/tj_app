/**
 * R24-fix4 RED：不带 executablePath 的辅助设置仍绕过路径迁移锁，
 * 可在 writeDreaminaRuntimeState 读到 A 后被整行写回，覆盖已经迁到 B 的 runtime。
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
  beginDreaminaEnablementProbe,
  endDreaminaEnablementProbe,
  readDreaminaEnablementRevision,
  readDreaminaProbeEpoch,
  resetDreaminaEnablementForTests,
} from "../../src/tianjiang/model-providers/dreamina-cli/dreamina-enablement";
import {
  readDreaminaRuntimeState,
  setDreaminaRuntimeStateAfterReadHookForTests,
  writeDreaminaRuntimeState,
} from "../../src/tianjiang/model-providers/dreamina-cli/runtime-state-store";
import { stopDreaminaSchedulerLoop } from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import {
  readDreaminaCliSettings,
  writeDreaminaCliSettings,
} from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { currentUserStorage, enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2929 };
const OTHER = { issuer: "https://api.j11.com.cn", userId: 2930 };
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

type Timeline = string[];

function installRuntimeReadGate(): {
  firstReached: Promise<void>;
  releaseFirst: () => void;
} {
  let markReached!: () => void;
  let releaseFirst!: () => void;
  const firstReached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let hits = 0;
  setDreaminaRuntimeStateAfterReadHookForTests(async () => {
    hits += 1;
    if (hits === 1) {
      markReached();
      await hold;
    }
  });
  return { firstReached, releaseFirst };
}

async function withUpdateServer(
  name: string,
  run: (input: {
    updateUrl: string;
    pathA: string;
    pathB: string;
    timeline: Timeline;
  }) => Promise<void>,
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${process.pid}-${crypto.randomUUID()}`);
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
  process.env.DREAMINA_FAKE_LOG = path.join(root, "cli.jsonl");
  delete process.env.DREAMINA_FAKE_PROBE_DELAY_MS;
  resetDatabaseRuntimeForServe();
  resetDreaminaStartupStatusCheckForTests();
  resetDreaminaEnablementForTests();
  invalidateDreaminaCapabilityCache();
  setDreaminaRuntimeStateAfterReadHookForTests(null);
  stopDreaminaSchedulerLoop();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await writeDreaminaCliSettings({
        enabled: true,
        executablePath: FAKE_CLI,
        pauseNewClaims: false,
        maxConcurrency: 1,
      });
      await writeDreaminaRuntimeState({
        executablePath: FAKE_CLI,
        preferredExecutionTarget: "windows_native",
        install: {
          state: "not_installed",
          executablePath: FAKE_CLI,
          reason: "seed-A",
        },
      });
    });
    enterUserStorage(IDENTITY);
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
        pathA: FAKE_CLI,
        pathB,
        timeline,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    setDreaminaRuntimeStateAfterReadHookForTests(null);
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

async function snapshotState(): Promise<{
  settings: Awaited<ReturnType<typeof readDreaminaCliSettings>>;
  runtime: Awaited<ReturnType<typeof readDreaminaRuntimeState>>;
}> {
  return runWithUserStorage(IDENTITY, async () => ({
    settings: await readDreaminaCliSettings(),
    runtime: await readDreaminaRuntimeState(),
  }));
}

async function waitUntil(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = 800,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  void label;
  return false;
}

async function assertFinalBWithHelpers(pathB: string): Promise<void> {
  const final = await runWithUserStorage(IDENTITY, async () => ({
    settings: await readDreaminaCliSettings(),
    runtime: await readDreaminaRuntimeState(),
    epoch: readDreaminaProbeEpoch(),
  }));
  const cache = readDreaminaCapabilityCache(currentUserStorage()?.segment);
  const token = beginDreaminaEnablementProbe({
    revision: readDreaminaEnablementRevision(),
    epoch: readDreaminaProbeEpoch(),
    executablePath: final.settings.executablePath,
    updatedAt: final.settings.updatedAt,
  });
  try {
    assert.equal(samePath(final.settings.executablePath, pathB), true, `settings 必须是 B: ${final.settings.executablePath}`);
    assert.equal(samePath(final.runtime.executablePath, pathB), true, `runtime 必须是 B: ${final.runtime.executablePath}`);
    assert.equal(
      samePath(final.runtime.install?.executablePath, pathB),
      true,
      `install 必须对应 B: ${final.runtime.install?.executablePath}`,
    );
    assert.equal(
      samePath(final.settings.executablePath, pathB) && samePath(final.runtime.executablePath, FAKE_CLI),
      false,
      "不得出现 settings=B、runtime=A",
    );
    assert.equal(final.settings.maxConcurrency, 3);
    assert.equal(final.settings.pauseNewClaims, true);
    assert.equal(final.runtime.preferredExecutionTarget, "wsl");
    assert.notEqual(cache.snapshot?.version, "mine-before-A", "cache 不得仍对应 A");
    assert.equal(samePath(token.executablePath, pathB), true, `probe token 必须绑定 B: ${token.executablePath}`);
    assert.equal(token.epoch, final.epoch);
  } finally {
    endDreaminaEnablementProbe(token);
  }
}

test("R1 辅助设置读到 runtime A 后暂停，R2 迁到 B，禁止 settings=B 且 runtime=A", async () => {
  await withUpdateServer("r24-fix4-helper-stale", async ({ updateUrl, pathA, pathB, timeline }) => {
    const seeded = await runWithUserStorage(IDENTITY, async () => ({
      settings: await readDreaminaCliSettings(),
      runtime: await readDreaminaRuntimeState(),
    }));
    assert.equal(samePath(seeded.settings.executablePath, pathA), true);
    assert.equal(samePath(seeded.runtime.executablePath, pathA), true);

    const { firstReached, releaseFirst } = installRuntimeReadGate();
    timeline.push("start-R1-helpers");
    const r1Promise = jsonRequest(updateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        preferredExecutionTarget: "wsl",
        maxConcurrency: 3,
        pauseNewClaims: true,
      }),
    });
    await firstReached;
    timeline.push("R1-paused-after-runtime-read-A");
    const paused = await runWithUserStorage(IDENTITY, () => readDreaminaRuntimeState());
    assert.equal(samePath(paused.executablePath, pathA), true, "暂停时 runtime 仍必须是 A");

    timeline.push("start-R2-post-B");
    const r2Promise = jsonRequest(updateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: pathB }),
    });
    const r2MigratedWhileHeld = await waitUntil("r2-migrated", async () => {
      const snap = await snapshotState();
      return samePath(snap.settings.executablePath, pathB)
        && samePath(snap.runtime.executablePath, pathB);
    });
    if (r2MigratedWhileHeld) {
      const r2Early = await r2Promise;
      timeline.push("R2-finished-before-R1");
      assert.equal(r2Early.status, 200, JSON.stringify(r2Early.body));
    } else {
      timeline.push("R2-waiting-on-serial-lock");
    }

    timeline.push("release-R1");
    releaseFirst();
    const r1 = await r1Promise;
    timeline.push("R1-finished");
    const r2 = r2MigratedWhileHeld ? await r2Promise : await r2Promise;
    if (!r2MigratedWhileHeld) timeline.push("R2-finished-after-R1");
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual(timeline.slice(0, 3), [
      "start-R1-helpers",
      "R1-paused-after-runtime-read-A",
      "start-R2-post-B",
    ]);
    assert.ok(
      timeline.includes("R2-finished-before-R1") || timeline.includes("R2-waiting-on-serial-lock"),
      `时序必须记录 R2 在 R1 暂停窗口的状态: ${JSON.stringify(timeline)}`,
    );

    const final = await runWithUserStorage(IDENTITY, async () => ({
      settings: await readDreaminaCliSettings(),
      runtime: await readDreaminaRuntimeState(),
    }));
    assert.equal(
      samePath(final.settings.executablePath, pathB) && samePath(final.runtime.executablePath, pathA),
      false,
      `禁止 settings=B 且 runtime=A: ${JSON.stringify({
        settings: final.settings.executablePath,
        runtime: final.runtime.executablePath,
        install: final.runtime.install,
        preferred: final.runtime.preferredExecutionTarget,
        timeline,
      })}`,
    );
    await assertFinalBWithHelpers(pathB);
  });
});

test("相反到达：R2 路径迁移读到 A 后暂停，R1 辅助设置先完成，后写不得丢 B 或辅助字段", async () => {
  await withUpdateServer("r24-fix4-reverse", async ({ updateUrl, pathA, pathB, timeline }) => {
    const { firstReached, releaseFirst } = installRuntimeReadGate();
    timeline.push("start-R2-post-B");
    const r2Promise = jsonRequest(updateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: pathB }),
    });
    await firstReached;
    timeline.push("R2-paused-after-runtime-read-A");
    const paused = await runWithUserStorage(IDENTITY, () => readDreaminaRuntimeState());
    assert.equal(samePath(paused.executablePath, pathA), true, "R2 暂停时 runtime 仍必须是 A");

    timeline.push("start-R1-helpers");
    const r1Promise = jsonRequest(updateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        preferredExecutionTarget: "wsl",
        maxConcurrency: 3,
        pauseNewClaims: true,
      }),
    });
    const r1AppliedWhileHeld = await waitUntil("r1-helpers", async () => {
      const snap = await snapshotState();
      return snap.settings.maxConcurrency === 3
        && snap.settings.pauseNewClaims === true
        && snap.runtime.preferredExecutionTarget === "wsl";
    });
    if (r1AppliedWhileHeld) {
      const r1Early = await r1Promise;
      timeline.push("R1-finished-before-R2");
      assert.equal(r1Early.status, 200, JSON.stringify(r1Early.body));
    } else {
      timeline.push("R1-waiting-on-serial-lock");
    }

    timeline.push("release-R2");
    releaseFirst();
    const r2 = await r2Promise;
    timeline.push("R2-finished");
    const r1 = r1AppliedWhileHeld ? await r1Promise : await r1Promise;
    if (!r1AppliedWhileHeld) timeline.push("R1-finished-after-R2");
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual(timeline.slice(0, 3), [
      "start-R2-post-B",
      "R2-paused-after-runtime-read-A",
      "start-R1-helpers",
    ]);
    assert.ok(
      timeline.includes("R1-finished-before-R2") || timeline.includes("R1-waiting-on-serial-lock"),
      `时序必须记录相反到达: ${JSON.stringify(timeline)}`,
    );

    const final = await runWithUserStorage(IDENTITY, async () => ({
      settings: await readDreaminaCliSettings(),
      runtime: await readDreaminaRuntimeState(),
    }));
    assert.equal(
      samePath(final.settings.executablePath, pathB) && samePath(final.runtime.executablePath, pathA),
      false,
      "后写优先也不得出现 settings=B、runtime=A",
    );
    await assertFinalBWithHelpers(pathB);
  });
});
