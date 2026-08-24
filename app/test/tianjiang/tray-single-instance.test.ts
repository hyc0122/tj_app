import assert from "node:assert/strict";
import test from "node:test";

import {
  createTrayController,
  handleTitlebarClose,
  handleWindowClose,
  QuitIntent,
} from "../../scripts/tray-controller";
import {
  createProtocolShutdownHandlers,
  createShutdownRequester,
} from "../../scripts/shutdown-request";
import {
  installSingleInstanceGuard,
  restoreMainWindow,
} from "../../scripts/single-instance";

test("关闭窗口默认隐藏且不请求退出", () => {
  const quitIntent = new QuitIntent();
  const preventDefault = { called: false, preventDefault() { this.called = true; } };
  const window = { hideCalls: 0, hide() { this.hideCalls += 1; } };
  let requestQuit = 0;
  handleWindowClose(preventDefault, window, quitIntent);
  assert.equal(preventDefault.called, true);
  assert.equal(window.hideCalls, 1);
  assert.equal(requestQuit, 0);
  assert.equal(quitIntent.isExplicit(), false);
});

test("托盘不可用时关闭窗口必须进入退出门而不是隐藏为无入口后台进程", async () => {
  const quitIntent = new QuitIntent();
  const preventDefault = { called: false, preventDefault() { this.called = true; } };
  const window = { hideCalls: 0, hide() { this.hideCalls += 1; } };
  let requestQuit = 0;

  // 通过 any 调用待实现契约，使 RED 阶段表现为行为断言失败而不是类型错误。
  (handleWindowClose as any)(preventDefault, window, quitIntent, {
    canHideToTray: false,
    requestShutdown: async () => { requestQuit += 1; },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(preventDefault.called, true);
  assert.equal(window.hideCalls, 0);
  assert.equal(requestQuit, 1);
});

test("标题栏关闭复用托盘策略且无托盘时统一进入 shutdown requester", async () => {
  const quitIntent = new QuitIntent();
  const window = { hideCalls: 0, hide() { this.hideCalls += 1; } };
  let shutdownCalls = 0;

  handleTitlebarClose(window, quitIntent, {
    canHideToTray: true,
    requestShutdown: async () => { shutdownCalls += 1; },
  });
  assert.equal(window.hideCalls, 1);
  assert.equal(shutdownCalls, 0);

  handleTitlebarClose(window, quitIntent, {
    canHideToTray: false,
    requestShutdown: async () => { shutdownCalls += 1; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(window.hideCalls, 1);
  assert.equal(shutdownCalls, 1);
});

test("restart 在请求 ShutdownGate 前先标记显式退出", async () => {
  const events: string[] = [];
  const requestShutdown = createShutdownRequester({
    markExplicitQuit: () => events.push("intent"),
    request: async (relaunch) => { events.push(relaunch ? "restart" : "quit"); },
  });

  await requestShutdown(true);
  assert.deepEqual(events, ["intent", "restart"]);
});

test("appQuit 协议必须显式进入退出门且不得复用标题栏隐藏语义", async () => {
  const scheduled: Array<() => void> = [];
  const requests: boolean[] = [];
  const handlers = createProtocolShutdownHandlers({
    requestShutdown: async (relaunch) => { requests.push(relaunch); },
    defer: (callback) => { scheduled.push(callback); },
  });

  assert.deepEqual(handlers.appquit(), {
    ok: true,
    message: "应用即将退出",
  });
  assert.deepEqual(requests, []);
  assert.equal(scheduled.length, 1);

  scheduled[0]!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, [false]);
});

test("显式退出与托盘退出会请求退出门", async () => {
  const quitIntent = new QuitIntent();
  let requestQuit = 0;
  const clicks: Array<() => void> = [];
  const tray = createTrayController({
    Tray: class {
      setToolTip() {}
      setContextMenu(menu: { items?: Array<{ click?: () => void }> }) {
        for (const item of (menu as any).items ?? []) {
          if (item.click) clicks.push(item.click);
        }
      }
      on() {}
      destroy() {}
    } as any,
    Menu: {
      buildFromTemplate(template: any[]) {
        return { items: template };
      },
    },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => false, setTemplateImage() {} }),
    },
    appName: "天将漫创",
    resourcesRoot: process.cwd(),
    platform: "win32",
    getWindow: () => null,
    requestShutdown: () => {
      quitIntent.markExplicitQuit();
      requestQuit += 1;
    },
  });
  assert.ok(clicks.length >= 2);
  await clicks[1]!();
  assert.equal(requestQuit, 1);
  assert.equal(quitIntent.isExplicit(), true);
  tray.dispose();
});

test("第二实例触发恢复且不启动第二套服务", () => {
  let restoreCount = 0;
  let quitCount = 0;
  let secondListener: (() => void) | undefined;
  const app = {
    requestSingleInstanceLock: () => true,
    on(event: string, listener: () => void) {
      if (event === "second-instance") secondListener = listener;
    },
    quit() { quitCount += 1; },
  };
  const ok = installSingleInstanceGuard({
    app,
    restore: () => { restoreCount += 1; },
  });
  assert.equal(ok, true);
  secondListener?.();
  assert.equal(restoreCount, 1);
  assert.equal(quitCount, 0);

  const denied = installSingleInstanceGuard({
    app: {
      requestSingleInstanceLock: () => false,
      on() {},
      quit() { quitCount += 1; },
    },
    restore: () => { restoreCount += 1; },
  });
  assert.equal(denied, false);
  assert.equal(quitCount, 1);
});

test("restoreMainWindow 显示并聚焦", () => {
  const calls: string[] = [];
  restoreMainWindow({
    isMinimized: () => true,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  });
  assert.deepEqual(calls, ["restore", "show", "focus"]);
});
