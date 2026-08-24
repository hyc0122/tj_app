import assert from "node:assert/strict";
import test from "node:test";

import {
  attemptPersonalProjectClose,
  type PersonalCloseDeps,
  type PersonalCloseRuntime,
} from "../../src/tianjiang/sync/personal-close-coordinator";

test("requireCentralSuccess 时 offline_pending/入队不得 allowSafeQuit", async () => {
  const runtime: PersonalCloseRuntime = {
    kind: "personal",
    local: { dirty: true, close() { /* noop */ } },
    sync: {
      close: async () => ({ state: "offline_pending" as const }),
      rollbackCloseAttempt() { /* noop */ },
      resumeOpen() { /* noop */ },
    } as PersonalCloseRuntime["sync"],
  };
  const deps: PersonalCloseDeps = {
    projectUuid: "018f3d6e-2d9e-7b6c-8a9b-0000000000b1",
    runtime,
    identity: { issuer: "https://api.example.invalid", userId: 1 },
    sessionExpiresAt: Date.now() + 60_000,
    dataRoot: "E:/unused",
    surface: "closeProject",
    requireCentralSuccess: true,
    openQueue: () => {
      throw new Error("不得打开队列");
    },
    consumeSyncCloseResult: () => undefined,
    deleteFromProjects: () => undefined,
  };
  const attempt = await attemptPersonalProjectClose(deps);
  assert.equal(attempt.allowSafeQuit, false);
  assert.equal(attempt.allowAccountSwitch, false);
  assert.equal(attempt.disposed, false);
  assert.match(String(attempt.message), /中央同步|网络不可用|取消/);
});

test("中央 synced 时允许关闭", async () => {
  const runtime: PersonalCloseRuntime = {
    kind: "personal",
    local: { dirty: true, close() { /* noop */ } },
    sync: {
      close: async () => ({ state: "synced" as const, capturedMutationGeneration: 1 }),
      rollbackCloseAttempt() { /* noop */ },
      resumeOpen() { /* noop */ },
      disposeTerminal() { /* noop */ },
      commitTerminalDispose() { /* noop */ },
    } as PersonalCloseRuntime["sync"],
  };
  let finalized = false;
  const deps: PersonalCloseDeps = {
    projectUuid: "018f3d6e-2d9e-7b6c-8a9b-0000000000b2",
    runtime,
    identity: { issuer: "https://api.example.invalid", userId: 1 },
    sessionExpiresAt: Date.now() + 60_000,
    dataRoot: "E:/unused",
    surface: "ordinaryShutdown",
    requireCentralSuccess: true,
    openQueue: () => {
      throw new Error("synced 不得入队");
    },
    consumeSyncCloseResult: () => {
      finalized = true;
    },
    deleteFromProjects: () => undefined,
  };
  const attempt = await attemptPersonalProjectClose(deps);
  assert.equal(attempt.allowSafeQuit, true);
  assert.equal(attempt.state, "synced");
  assert.equal(finalized, true);
});
