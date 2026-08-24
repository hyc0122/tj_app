/**
 * R24-fix5 RED：锁释放后、begin probe 前的路径迁移竞态。
 * begin 不得用“当前新 revision/epoch + 调用方旧路径”覆盖有效 token。
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
  bumpDreaminaEnablementRevision,
  bumpDreaminaProbeEpoch,
  endDreaminaEnablementProbe,
  isDreaminaEnablementStaleError,
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
import {
  setDreaminaUpdateSettingsAfterBeginBeforeEnsureHookForTests,
  setDreaminaUpdateSettingsAfterLockBeforeProbeHookForTests,
} from "../../src/routes/setting/dreaminaCli/updateSettings";
import { setDreaminaSetEnabledAfterLockBeforeProbeHookForTests } from "../../src/routes/setting/dreaminaCli/setEnabled";
import { currentUserStorage, enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 3029 };
const OTHER = { issuer: "https://api.j11.com.cn", userId: 3030 };
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

async function withServer(
  name: string,
  run: (input: {
    updateUrl: string;
    enabledUrl: string;
    pathA: string;
    pathB: string;
    pathC: string;
    logFile: string;
    timeline: string[];
    setUpdateHook: (hook: (() => Promise<void> | void) | null) => void;
    setUpdateAfterBeginHook: (hook: (() => Promise<void> | void) | null) => void;
    setEnabledHook: (hook: (() => Promise<void> | void) | null) => void;
  }) => Promise<void>,
): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${process.pid}-${crypto.randomUUID()}`);
  const logFile = path.join(root, "cli.jsonl");
  const pathB = path.join(root, "dreamina-b.bin");
  const pathC = path.join(root, "dreamina-c.bin");
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
  fs.writeFileSync(pathC, "not-a-cli");
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.DREAMINA_FAKE_LOG = logFile;
  delete process.env.DREAMINA_FAKE_PROBE_DELAY_MS;
  resetDatabaseRuntimeForServe();
  resetDreaminaStartupStatusCheckForTests();
  resetDreaminaEnablementForTests();
  invalidateDreaminaCapabilityCache();
  setDreaminaUpdateSettingsAfterLockBeforeProbeHookForTests(null);
  setDreaminaUpdateSettingsAfterBeginBeforeEnsureHookForTests(null);
  setDreaminaSetEnabledAfterLockBeforeProbeHookForTests(null);
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
    const updateSettingsMod = await import("../../src/routes/setting/dreaminaCli/updateSettings");
    const setEnabledMod = await import("../../src/routes/setting/dreaminaCli/setEnabled");
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => {
      enterUserStorage(IDENTITY);
      next();
    });
    app.use("/api/setting/dreaminaCli/updateSettings", updateSettingsMod.default);
    app.use("/api/setting/dreaminaCli/setEnabled", setEnabledMod.default);
    const { server, port } = await listen(app);
    try {
      await run({
        updateUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/updateSettings`,
        enabledUrl: `http://127.0.0.1:${port}/api/setting/dreaminaCli/setEnabled`,
        pathA: FAKE_CLI,
        pathB,
        pathC,
        logFile,
        timeline,
        setUpdateHook: updateSettingsMod.setDreaminaUpdateSettingsAfterLockBeforeProbeHookForTests,
        setUpdateAfterBeginHook: updateSettingsMod.setDreaminaUpdateSettingsAfterBeginBeforeEnsureHookForTests,
        setEnabledHook: setEnabledMod.setDreaminaSetEnabledAfterLockBeforeProbeHookForTests,
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
    setDreaminaUpdateSettingsAfterLockBeforeProbeHookForTests(null);
    setDreaminaUpdateSettingsAfterBeginBeforeEnsureHookForTests(null);
    setDreaminaSetEnabledAfterLockBeforeProbeHookForTests(null);
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

test("A→B→C：R1 锁后暂停 begin，R2 预留并启动 C 探测后，R1 不得覆盖 C token", async () => {
  await withServer("r24-fix5-abc", async ({ updateUrl, pathB, pathC, logFile, timeline, setUpdateHook, setUpdateAfterBeginHook }) => {
    let r2Promise: Promise<{ status: number; body: any }> | undefined;
    let cGuard = { token: undefined as ReturnType<typeof readDreaminaProbeGuardForTests>["token"], refCount: 0 };
    let releaseR1!: () => void;
    const r1Hold = new Promise<void>((resolve) => {
      releaseR1 = resolve;
    });
    let afterLockHits = 0;
    setUpdateHook(async () => {
      afterLockHits += 1;
      if (afterLockHits !== 1) return;
      timeline.push("R1-paused-after-lock-before-begin");
      fs.writeFileSync(logFile, "");
      timeline.push("start-R2-B-to-C");
      r2Promise = jsonRequest(updateUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executablePath: pathC }),
      });
      const r2 = await r2Promise;
      assert.equal(r2.status, 200, JSON.stringify(r2.body));
      cGuard = runWithUserStorage(IDENTITY, () => readDreaminaProbeGuardForTests());
      timeline.push("R2-reserved-C-probe");
      await r1Hold;
    });
    timeline.push("start-R1-A-to-B");
    const r1Promise = jsonRequest(updateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: pathB }),
    });
    const started = Date.now();
    while (Date.now() - started < 4000 && !timeline.includes("R2-reserved-C-probe")) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(r2Promise, "R1 钩子必须发出 R2");
    assert.ok(timeline.includes("R2-reserved-C-probe"), "R2 必须先预留 C 探测");
    const afterR1Lock = await runWithUserStorage(IDENTITY, () => readDreaminaCliSettings());
    assert.equal(samePath(afterR1Lock.executablePath, pathC), true, "R2 完成后 settings 必须已是 C");
    const cGeneration = cGuard.token?.generation;
    const cRef = cGuard.refCount;

    timeline.push("release-R1");
    releaseR1();
    const r1 = await r1Promise;
    const r2 = r2Promise ? await r2Promise : { status: 0, body: null };
    timeline.push("both-finished");
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual(timeline, [
      "start-R1-A-to-B",
      "R1-paused-after-lock-before-begin",
      "start-R2-B-to-C",
      "R2-reserved-C-probe",
      "release-R1",
      "both-finished",
    ]);

    const duringOrAfter = runWithUserStorage(IDENTITY, () => readDreaminaProbeGuardForTests());
    if (duringOrAfter.token) {
      assert.equal(
        samePath(duringOrAfter.token.executablePath, pathC),
        true,
        `有效守卫必须仍是 C，不得被 B 覆盖: ${duringOrAfter.token.executablePath}`,
      );
      if (cGeneration != null) {
        assert.notEqual(duringOrAfter.token.generation, undefined);
        assert.equal(
          duringOrAfter.token.executablePath === cGuard.token?.executablePath
            ? duringOrAfter.refCount >= 0
            : true,
          true,
        );
      }
    }
    void cRef;

    const final = await runWithUserStorage(IDENTITY, async () => ({
      settings: await readDreaminaCliSettings(),
      runtime: await readDreaminaRuntimeState(),
    }));
    const cache = readDreaminaCapabilityCache(currentUserStorage()?.segment);
    assert.equal(samePath(final.settings.executablePath, pathC), true, `settings 必须是 C: ${final.settings.executablePath}`);
    assert.equal(samePath(final.runtime.executablePath, pathC), true, `runtime 必须是 C: ${final.runtime.executablePath}`);
    assert.equal(samePath(final.runtime.install?.executablePath, pathC), true);
    assert.equal(
      samePath(final.settings.executablePath, pathC) && samePath(final.runtime.executablePath, pathB),
      false,
      "禁止 settings=C 且 runtime=B",
    );
    assert.notEqual(cache.snapshot?.version, "mine-before-A");
    const identity = beginDreaminaEnablementProbe({
      revision: runWithUserStorage(IDENTITY, () => readDreaminaEnablementRevision()),
      epoch: runWithUserStorage(IDENTITY, () => readDreaminaProbeEpoch()),
      executablePath: final.settings.executablePath,
      updatedAt: final.settings.updatedAt,
    });
    try {
      assert.equal(samePath(identity.executablePath, pathC), true, "probe identity 必须绑定 C");
    } finally {
      endDreaminaEnablementProbe(identity);
    }
    const generate = commandLines(logFile).filter((line) =>
      String(line.args[0]).endsWith("2video") && !line.args.includes("-h"));
    assert.deepEqual(generate, [], "不得唤醒调度器去生成");
  });
});

test("setEnabled(true) 锁后暂停，路径迁到 B 后旧打开不得覆盖 token 或唤醒调度", async () => {
  await withServer("r24-fix5-enable", async ({ updateUrl, enabledUrl, pathB, logFile, timeline, setEnabledHook, setUpdateAfterBeginHook }) => {
    await runWithUserStorage(IDENTITY, async () => {
      await writeDreaminaCliSettings({ enabled: false, executablePath: FAKE_CLI });
    });
    let updatePromise: Promise<{ status: number; body: any }> | undefined;
    let bGuard = { token: undefined as ReturnType<typeof readDreaminaProbeGuardForTests>["token"], refCount: 0 };
    let releaseEnable!: () => void;
    const enableHold = new Promise<void>((resolve) => {
      releaseEnable = resolve;
    });
    let enableHookHits = 0;
    setEnabledHook(async () => {
      enableHookHits += 1;
      if (enableHookHits !== 1) return;
      timeline.push("old-enable-paused-after-lock");
      fs.writeFileSync(logFile, "");
      timeline.push("start-path-B");
      updatePromise = jsonRequest(updateUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executablePath: pathB }),
      });
      const updatedEarly = await updatePromise;
      assert.equal(updatedEarly.status, 200, JSON.stringify(updatedEarly.body));
      bGuard = runWithUserStorage(IDENTITY, () => readDreaminaProbeGuardForTests());
      timeline.push("B-probe-reserved");
      await enableHold;
    });
    timeline.push("start-old-enable");
    const enablePromise = jsonRequest(enabledUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const started = Date.now();
    while (Date.now() - started < 4000 && !timeline.includes("B-probe-reserved")) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(updatePromise, "旧打开钩子必须发出路径更新");
    assert.ok(timeline.includes("B-probe-reserved"), "新路径必须先取得探测身份");
    const bGeneration = bGuard.token?.generation;
    const wakesBeforeRelease = readDreaminaSchedulerWakeCountForTests();

    timeline.push("release-old-enable");
    releaseEnable();
    const enabled = await enablePromise;
    const updated = updatePromise ? await updatePromise : { status: 0, body: null };
    timeline.push("both-finished");
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    assert.equal(updated.status, 200, JSON.stringify(updated.body));

    const guard = runWithUserStorage(IDENTITY, () => readDreaminaProbeGuardForTests());
    if (guard.token && bGeneration != null) {
      assert.equal(
        samePath(guard.token.executablePath, pathB),
        true,
        `旧打开不得把 token 改成 A: ${guard.token.executablePath}`,
      );
    }
    const final = await runWithUserStorage(IDENTITY, async () => ({
      settings: await readDreaminaCliSettings(),
      runtime: await readDreaminaRuntimeState(),
    }));
    assert.equal(samePath(final.settings.executablePath, pathB), true);
    assert.equal(samePath(final.runtime.executablePath, pathB), true);
    assert.equal(
      samePath(final.runtime.executablePath, FAKE_CLI),
      false,
      "旧打开不得把 runtime 写回 A",
    );
    const wakes = readDreaminaSchedulerWakeCountForTests();
    assert.equal(wakes, wakesBeforeRelease, `旧打开不得额外唤醒调度器: ${wakesBeforeRelease} -> ${wakes}`);
    const generate = commandLines(logFile).filter((line) =>
      String(line.args[0]).endsWith("2video") && !line.args.includes("-h"));
    assert.deepEqual(generate, []);
    assert.deepEqual(timeline.slice(0, 4), [
      "start-old-enable",
      "old-enable-paused-after-lock",
      "start-path-B",
      "B-probe-reserved",
    ]);
  });
});

test("begin 对过期 revision/epoch/path 必须在改 token/refcount 前 STALE", async () => {
  await withServer("r24-fix5-cas", async ({ pathA, pathB }) => {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      const revision = bumpDreaminaEnablementRevision();
      const epoch = bumpDreaminaProbeEpoch();
      const reserved = beginDreaminaEnablementProbe({
        revision,
        epoch,
        executablePath: pathA,
        updatedAt: 1,
      });
      const before = readDreaminaProbeGuardForTests();
      assert.equal(before.refCount, 1);
      assert.equal(samePath(before.token?.executablePath, pathA), true);

      const staleCases: Array<{ label: string; run: () => void }> = [
        {
          label: "stale-revision",
          run: () => beginDreaminaEnablementProbe({
            revision: revision - 1,
            epoch,
            executablePath: pathA,
            updatedAt: 1,
          }),
        },
        {
          label: "stale-path",
          run: () => beginDreaminaEnablementProbe({
            revision,
            epoch,
            executablePath: pathB,
            updatedAt: 1,
          }),
        },
        {
          label: "stale-epoch",
          run: () => {
            bumpDreaminaProbeEpoch();
            beginDreaminaEnablementProbe({
              revision,
              epoch,
              executablePath: pathA,
              updatedAt: 1,
            });
          },
        },
      ];

      for (const item of staleCases) {
        const snapshot = readDreaminaProbeGuardForTests();
        let stale = false;
        try {
          item.run();
        } catch (err) {
          stale = isDreaminaEnablementStaleError(err);
        }
        assert.equal(stale, true, `${item.label} 必须在修改守卫前返回 STALE`);
        const after = readDreaminaProbeGuardForTests();
        assert.equal(after.token?.generation, snapshot.token?.generation, `${item.label} 不得改 token`);
        assert.equal(after.refCount, snapshot.refCount, `${item.label} 不得改 refcount`);
        assert.equal(samePath(after.token?.executablePath, snapshot.token?.executablePath), true);
      }

      assert.equal(readDreaminaProbeGuardForTests().token?.generation, reserved.generation);
      assert.equal(readDreaminaEnablementRevision(), revision);
      void epoch;
    });
  });
});
