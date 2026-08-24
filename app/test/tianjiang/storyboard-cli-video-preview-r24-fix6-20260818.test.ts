/**
 * R24-fix6 RED：getStatus/checkCli/runSelfCheck 先读 settings=A，再拼当前 revision/epoch。
 * token 为空时旧路径 A 可以贴上 B 的代际，错误创建混合 token。
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
import type { DreaminaProbeToken } from "../../src/tianjiang/model-providers/dreamina-cli/dreamina-enablement";
import {
  readDreaminaEnablementRevision,
  readDreaminaProbeEpoch,
  readDreaminaProbeGuardForTests,
  resetDreaminaEnablementForTests,
} from "../../src/tianjiang/model-providers/dreamina-cli/dreamina-enablement";
import {
  readDreaminaRuntimeState,
  writeDreaminaRuntimeState,
} from "../../src/tianjiang/model-providers/dreamina-cli/runtime-state-store";
import {
  readDreaminaSchedulerWakeCountForTests,
  stopDreaminaSchedulerLoop,
} from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import {
  readDreaminaCliSettings,
  writeDreaminaCliSettings,
} from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 3129 };
const OTHER = { issuer: "https://api.j11.com.cn", userId: 3130 };
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function jsonRequest(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch (err) {
    return { status: 0, body: { message: err instanceof Error ? err.message : String(err) } };
  }
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

type Entry = "getStatus" | "checkCli" | "runSelfCheck";

async function withServer(
  name: string,
  run: (input: {
    updateUrl: string;
    entryUrl: string;
    pathA: string;
    pathB: string;
    logFile: string;
    timeline: string[];
    setAfterSettingsRead: (hook: (() => Promise<void> | void) | null) => void;
    setBeginCreated: (hook: ((token: DreaminaProbeToken) => void) | null) => void;
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
  const timeline: string[] = [];
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
      await writeDreaminaCliSettings({
        enabled: true,
        executablePath: FAKE_CLI,
        pauseNewClaims: false,
        maxConcurrency: 1,
      });
      await writeDreaminaRuntimeState({
        executablePath: FAKE_CLI,
        preferredExecutionTarget: "windows_native",
        install: { state: "not_installed", executablePath: FAKE_CLI, reason: "seed-A" },
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
    const getStatusMod = await import("../../src/routes/setting/dreaminaCli/getStatus");
    const checkCliMod = await import("../../src/routes/setting/dreaminaCli/checkCli");
    const runSelfCheckMod = await import("../../src/routes/setting/dreaminaCli/runSelfCheck");
    const updateSettingsMod = await import("../../src/routes/setting/dreaminaCli/updateSettings");
    getStatusMod.setDreaminaAfterSettingsReadBeforeBeginHookForTests(null);
    getStatusMod.setDreaminaBeginCreatedHookForTests(null);
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => {
      enterUserStorage(IDENTITY);
      next();
    });
    app.use("/api/setting/dreaminaCli/getStatus", getStatusMod.default);
    app.use("/api/setting/dreaminaCli/checkCli", checkCliMod.default);
    app.use("/api/setting/dreaminaCli/runSelfCheck", runSelfCheckMod.default);
    app.use("/api/setting/dreaminaCli/updateSettings", updateSettingsMod.default);
    const { server, port } = await listen(app);
    try {
      await run({
        updateUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/updateSettings`,
        entryUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/${name.includes("checkCli") ? "checkCli" : name.includes("runSelfCheck") ? "runSelfCheck" : "getStatus"}`,
        pathA: FAKE_CLI,
        pathB,
        logFile,
        timeline,
        setAfterSettingsRead: getStatusMod.setDreaminaAfterSettingsReadBeforeBeginHookForTests,
        setBeginCreated: getStatusMod.setDreaminaBeginCreatedHookForTests,
      });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        const closer = server as http.Server & { closeAllConnections?: () => void };
        closer.closeAllConnections?.();
        setTimeout(resolve, 500);
      });
    }
  } finally {
    getStatusModSafeReset();
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

function getStatusModSafeReset(): void {
  void import("../../src/routes/setting/dreaminaCli/getStatus").then((mod) => {
    mod.setDreaminaAfterSettingsReadBeforeBeginHookForTests(null);
    mod.setDreaminaBeginCreatedHookForTests(null);
  }).catch(() => undefined);
}

async function raceEntry(entry: Entry): Promise<void> {
  await withServer(`r24-fix6-${entry}`, async ({
    updateUrl,
    entryUrl,
    pathA,
    pathB,
    logFile,
    timeline,
    setAfterSettingsRead,
    setBeginCreated,
  }) => {
    const created: DreaminaProbeToken[] = [];
    setBeginCreated((token) => {
      created.push(token);
    });
    let releaseR1!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseR1 = resolve;
    });
    let hookHits = 0;
    setAfterSettingsRead(async () => {
      hookHits += 1;
      if (hookHits !== 1) return;
      timeline.push("R1-paused-after-settings-A");
      await hold;
    });

    timeline.push(`start-R1-${entry}`);
    const r1Promise = entry === "getStatus"
      ? jsonRequest(entryUrl)
      : jsonRequest(entryUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const started = Date.now();
    while (Date.now() - started < 4000 && !timeline.includes("R1-paused-after-settings-A")) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(timeline.includes("R1-paused-after-settings-A"), "R1 必须在读完 settings=A 后、begin 前暂停");
    const beforeR2 = await runWithUserStorage(IDENTITY, async () => ({
      settings: await readDreaminaCliSettings(),
      epoch: readDreaminaProbeEpoch(),
      revision: readDreaminaEnablementRevision(),
      guard: readDreaminaProbeGuardForTests(),
    }));
    assert.equal(samePath(beforeR2.settings.executablePath, pathA), true);
    assert.equal(beforeR2.guard.token, undefined);
    assert.equal(beforeR2.guard.refCount, 0);

    fs.writeFileSync(logFile, "");
    const wakesBefore = readDreaminaSchedulerWakeCountForTests();
    const cacheBeforeB = readDreaminaCapabilityCache();
    timeline.push("start-R2-A-to-B");
    const r2 = await jsonRequest(updateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: pathB }),
    });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    const afterR2Wait = Date.now();
    while (Date.now() - afterR2Wait < 2000) {
      const guard = runWithUserStorage(IDENTITY, () => readDreaminaProbeGuardForTests());
      if (!guard.token && guard.refCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const afterR2 = await runWithUserStorage(IDENTITY, async () => ({
      settings: await readDreaminaCliSettings(),
      runtime: await readDreaminaRuntimeState(),
      epoch: readDreaminaProbeEpoch(),
      revision: readDreaminaEnablementRevision(),
      guard: readDreaminaProbeGuardForTests(),
    }));
    assert.equal(samePath(afterR2.settings.executablePath, pathB), true, "R2 必须把 settings 迁到 B");
    assert.equal(samePath(afterR2.runtime.executablePath, pathB), true, "R2 必须把 runtime 迁到 B");
    assert.equal(afterR2.guard.token, undefined, "R2 探测结束后 token 必须释放为 null");
    assert.equal(afterR2.guard.refCount, 0);
    assert.ok(afterR2.epoch > beforeR2.epoch || afterR2.settings.updatedAt !== beforeR2.settings.updatedAt, "B 必须推进代际或 updatedAt");
    timeline.push("R2-finished-token-null");
    const logAfterR2 = commandLines(logFile).length;
    const runtimeUpdatedAt = afterR2.runtime.updatedAt;
    const cacheAfterR2 = readDreaminaCapabilityCache();
    void cacheBeforeB;

    const createdBeforeR1 = created.length;
    timeline.push("release-R1");
    releaseR1();
    const r1 = await r1Promise;
    timeline.push("R1-finished");

    const mixed = created.slice(createdBeforeR1).filter((token) =>
      samePath(token.executablePath, pathA)
      && token.epoch === afterR2.epoch
      && token.revision === afterR2.revision);
    assert.equal(
      mixed.length,
      0,
      `禁止用 settings=A 拼 B 的 revision/epoch 建 token: ${JSON.stringify({
        mixed: mixed.map((token) => ({
          path: token.executablePath,
          epoch: token.epoch,
          revision: token.revision,
        })),
        epochB: afterR2.epoch,
        revisionB: afterR2.revision,
        r1,
        timeline,
      })}`,
    );
    if (r1.body?.code === "DREAMINA_CLI_ENABLEMENT_STALE" || r1.status === 409) {
      const text = JSON.stringify(r1.body ?? {});
      assert.equal(/[A-Za-z]:\\/.test(text), false, "STALE 不得回显路径");
      assert.equal(/SELECT /i.test(text), false);
      assert.equal(/cookie/i.test(text), false);
    }
    const afterR1 = await runWithUserStorage(IDENTITY, async () => ({
      settings: await readDreaminaCliSettings(),
      runtime: await readDreaminaRuntimeState(),
      guard: readDreaminaProbeGuardForTests(),
    }));
    assert.equal(samePath(afterR1.settings.executablePath, pathB), true);
    assert.equal(samePath(afterR1.runtime.executablePath, pathB), true);
    assert.equal(samePath(afterR1.runtime.executablePath, pathA), false, "R1 不得把 runtime 写回 A");
    assert.equal(afterR1.runtime.updatedAt, runtimeUpdatedAt, "R1 不得写 runtime");
    assert.equal(afterR1.guard.refCount, 0, "R1 不得改 refcount");
    assert.equal(afterR1.guard.token, undefined, "R1 被拒绝后 token 必须仍为空");
    assert.equal(commandLines(logFile).length, logAfterR2, "R1 不得再跑 CLI（含 A 路径命令）");
    assert.equal(readDreaminaSchedulerWakeCountForTests(), wakesBefore, "R1 不得唤醒调度器");
    assert.notEqual(readDreaminaCapabilityCache().snapshot?.version, "mine-before-A");
    assert.equal(readDreaminaCapabilityCache().snapshot?.version, cacheAfterR2.snapshot?.version);

    const createdBeforeB = created.length;
    const r3 = entry === "getStatus"
      ? await jsonRequest(entryUrl)
      : await jsonRequest(entryUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const reservedB = created.slice(createdBeforeB).some((token) => samePath(token.executablePath, pathB));
    assert.ok(
      reservedB || r3.status === 200,
      `R1 被拒绝后当前 B 请求必须能立即预留 token: ${JSON.stringify({ r3, created: created.slice(createdBeforeB) })}`,
    );
    assert.equal(
      created.slice(createdBeforeB).some((token) => samePath(token.executablePath, pathA)),
      false,
      "B 请求不得被旧 A 短暂阻断或建成 A token",
    );
    assert.deepEqual(timeline, [
      `start-R1-${entry}`,
      "R1-paused-after-settings-A",
      "start-R2-A-to-B",
      "R2-finished-token-null",
      "release-R1",
      "R1-finished",
    ]);
  });
}

test("getStatus 读到 A 后暂停，R2 迁到 B 并释放 token，R1 不得用 A+B 代际建 token", async () => {
  await raceEntry("getStatus");
});

test("checkCli 读到 A 后暂停，R2 迁到 B 并释放 token，R1 不得用 A+B 代际建 token", async () => {
  await raceEntry("checkCli");
});

test("runSelfCheck 读到 A 后暂停，R2 迁到 B 并释放 token，R1 不得用 A+B 代际建 token", async () => {
  await raceEntry("runSelfCheck");
});
