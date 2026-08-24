import assert from "node:assert/strict";
import test from "node:test";

import { ShutdownGate } from "../../src/tianjiang/runtime/shutdown-gate";

test("退出门必须等待最终同步完成后才退出或重启", async () => {
  let finishSync: (() => void) | undefined;
  const events: string[] = [];
  const gate = new ShutdownGate({
    closeRuntime: () => new Promise<void>((resolve) => {
      events.push("sync:start");
      finishSync = () => {
        events.push("sync:done");
        resolve();
      };
    }),
    relaunch: () => events.push("relaunch"),
    quit: () => events.push("quit"),
    onFailure: async () => {
      events.push("failure");
    },
  });

  const closing = gate.request(true);
  assert.equal(gate.canQuit(), false);
  assert.deepEqual(events, ["sync:start"]);
  finishSync?.();
  await closing;
  assert.equal(gate.canQuit(), true);
  assert.deepEqual(events, ["sync:start", "sync:done", "relaunch", "quit"]);
});

test("普通退出：closeRuntime 致命失败仍可提示后重试；可恢复失败不得阻断", async () => {
  let attempts = 0;
  const events: string[] = [];
  const gate = new ShutdownGate({
    closeRuntime: async () => {
      attempts += 1;
      // 仅模拟不可恢复的装配错误；可恢复同步失败应在 closeRuntime 内部吞掉。
      if (attempts === 1) throw new Error("runtime handle destroy failed");
    },
    relaunch: () => events.push("relaunch"),
    quit: () => events.push("quit"),
    onFailure: async () => {
      events.push("failure");
    },
  });

  await gate.request(false);
  assert.equal(gate.canQuit(), false);
  assert.deepEqual(events, ["failure"]);
  await gate.request(false);
  assert.equal(gate.canQuit(), true);
  assert.deepEqual(events, ["failure", "quit"]);
});

test("普通退出：closeRuntime 成功完成（含内部 pending 持久化）必须允许 quit", async () => {
  const events: string[] = [];
  const gate = new ShutdownGate({
    closeRuntime: async () => {
      events.push("close:pending-persisted");
    },
    relaunch: () => events.push("relaunch"),
    quit: () => events.push("quit"),
    onFailure: async () => {
      events.push("failure");
    },
  });
  await gate.request(false);
  assert.equal(gate.canQuit(), true);
  assert.deepEqual(events, ["close:pending-persisted", "quit"]);
});

test("更新安装准备只关闭一次运行时且不提前 app.quit", async () => {
  const events: string[] = [];
  const gate = new ShutdownGate({
    closeRuntime: async () => { events.push("runtime:closed"); },
    relaunch: () => events.push("relaunch"),
    quit: () => events.push("quit"),
    onFailure: async () => { events.push("failure"); },
  });

  await gate.prepareForInstaller(async () => {
    events.push("backup:verified");
  });

  assert.equal(gate.canQuit(), true);
  assert.deepEqual(events, ["runtime:closed", "backup:verified"]);
});

test("安装器已受理后的专用入口只执行不可逆关闭，不重复可失败备份或提前退出", async () => {
  const events: string[] = [];
  const gate = new ShutdownGate({
    closeRuntime: async () => { events.push("runtime:closed"); },
    relaunch: () => events.push("relaunch"),
    quit: () => events.push("quit"),
    onFailure: async () => { events.push("failure"); },
  });

  await gate.finalizeAcceptedInstaller();

  assert.equal(gate.canQuit(), true);
  assert.deepEqual(events, ["runtime:closed"]);
});

test("运行时已关闭后备份失败必须受控重启整个应用，禁止恢复失效窗口", async () => {
  const events: string[] = [];
  const gate = new ShutdownGate({
    closeRuntime: async () => { events.push("runtime:closed"); },
    relaunch: () => events.push("relaunch"),
    quit: () => events.push("quit"),
    onFailure: async () => { events.push("failure"); },
    onInstallerPreparationFailure: async () => {
      events.push("installer:failure");
    },
  });

  await assert.rejects(
    () => gate.prepareForInstaller(async () => {
      throw new Error("hash mismatch");
    }),
    /hash mismatch/,
  );
  assert.equal(gate.canQuit(), true);
  assert.deepEqual(events, [
    "runtime:closed",
    "installer:failure",
    "relaunch",
    "quit",
  ]);
});

test("运行时关闭本身失败时保持原进程并走普通失败恢复", async () => {
  const events: string[] = [];
  const gate = new ShutdownGate({
    closeRuntime: async () => {
      events.push("runtime:close-failed");
      throw new Error("publish failed");
    },
    relaunch: () => events.push("relaunch"),
    quit: () => events.push("quit"),
    onFailure: async () => { events.push("failure"); },
    onInstallerPreparationFailure: async () => {
      events.push("installer:failure");
    },
  });

  await assert.rejects(
    () => gate.prepareForInstaller(async () => {
      events.push("backup");
    }),
    /publish failed/,
  );
  assert.equal(gate.canQuit(), false);
  assert.deepEqual(events, ["runtime:close-failed", "failure"]);
});

test("普通退出先到达时，后到的安装准备仍必须在基础关闭后独立执行", async () => {
  let finishClose!: () => void;
  const events: string[] = [];
  const gate = new ShutdownGate({
    closeRuntime: () => new Promise<void>((resolve) => {
      events.push("runtime:start");
      finishClose = () => {
        events.push("runtime:closed");
        resolve();
      };
    }),
    relaunch: () => events.push("relaunch"),
    quit: () => events.push("quit"),
    onFailure: async () => { events.push("failure"); },
  });

  const ordinary = gate.request(false);
  const installer = gate.prepareForInstaller(async () => {
    events.push("backup:verified");
  });
  finishClose();
  await Promise.all([ordinary, installer]);

  assert.equal(gate.canQuit(), true);
  assert.deepEqual(events, ["runtime:start", "runtime:closed", "backup:verified"]);
});

test("并发退出意图可由 quit 升级为 relaunch，再由 installer 抢占且保护只执行一次", async () => {
  let finishClose!: () => void;
  const events: string[] = [];
  const gate = new ShutdownGate({
    closeRuntime: () => new Promise<void>((resolve) => {
      events.push("runtime:start");
      finishClose = resolve;
    }),
    relaunch: () => events.push("relaunch"),
    quit: () => events.push("quit"),
    onFailure: async () => { events.push("failure"); },
  });

  const quit = gate.request(false);
  const relaunch = gate.request(true);
  const protect = async () => { events.push("backup:verified"); };
  const installerA = gate.prepareForInstaller(protect);
  const installerB = gate.prepareForInstaller(protect);
  finishClose();
  await Promise.all([quit, relaunch, installerA, installerB]);

  assert.deepEqual(events, ["runtime:start", "backup:verified"]);
});

test("普通退出执行期间可升级为重启且最终只执行最高优先级意图", async () => {
  let finishClose!: () => void;
  const events: string[] = [];
  const gate = new ShutdownGate({
    closeRuntime: () => new Promise<void>((resolve) => {
      events.push("runtime:start");
      finishClose = resolve;
    }),
    relaunch: () => events.push("relaunch"),
    quit: () => events.push("quit"),
    onFailure: async () => { events.push("failure"); },
  });

  const quit = gate.request(false);
  const relaunch = gate.request(true);
  finishClose();
  await Promise.all([quit, relaunch]);

  assert.deepEqual(events, ["runtime:start", "relaunch", "quit"]);
});
