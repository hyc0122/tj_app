/**
 * 主进程协议动态夹具：替换 Electron，但直接执行 scripts/main.ts 并调用其真实 protocol callback。
 */
const fs = require("node:fs");
const Module = require("node:module");

const eventFile = process.env.TIANJIANG_PROTOCOL_PROBE_EVENT_FILE;
const scenario = process.env.TIANJIANG_PROTOCOL_PROBE_SCENARIO || "success";
let probeScheduled = false;

function record(name, details = {}) {
  fs.appendFileSync(eventFile, `${JSON.stringify({ name, ...details })}\n`, "utf8");
}

Object.defineProperty(process, "resourcesPath", {
  configurable: true,
  value: process.env.TIANJIANG_PROTOCOL_PROBE_RESOURCES_PATH,
});

const app = {
  isPackaged: true,
  commandLine: { appendSwitch() {} },
  setName() {},
  getPath(key) {
    if (key === "userData") return process.env.TIANJIANG_PROTOCOL_PROBE_USER_DATA_PATH;
    return process.cwd();
  },
  setPath() {},
  whenReady() { return Promise.resolve(); },
  getVersion() { return "1.1.10"; },
  getLocale() {
    if (scenario === "sync_error") {
      throw new Error("C:\\Users\\secret\\profile?user_code=ABCD https://evil.example/auth");
    }
    return "zh-CN";
  },
  on() {},
  quit() {},
  relaunch() {},
};

class BrowserWindow {
  constructor() {
    // 中文注释：主启动流程与协议探针并发；伪窗口需覆盖真实入口会调用的最小 Electron 契约。
    this.webContents = {
      getUserAgent: () => "FakeElectron",
      setUserAgent() {},
      openDevTools() {},
    };
  }
  setMenuBarVisibility() {}
  removeMenu() {}
  on() {}
  once(name, listener) {
    if (name === "ready-to-show") setImmediate(listener);
  }
  show() {}
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  minimize() {}
  maximize() {}
  unmaximize() {}
  isMaximized() { return false; }
  static getAllWindows() { return []; }
}

function probeRequests() {
  if (scenario === "external_reject") {
    const target = encodeURIComponent(
      "https://jimeng.jianying.com/auth?user_code=ABCD-1234",
    );
    return [{
      key: "external_reject",
      url: `tianjiang://openDreaminaExternal?kind=authorization&url=${target}`,
    }];
  }
  if (scenario === "sync_error") {
    return [{ key: "sync_error", url: "tianjiang://getlocallanguage" }];
  }
  const authorization = encodeURIComponent("https://jimeng.jianying.com/auth?x=1");
  return [
    { key: "official_docs", url: "tianjiang://openDreaminaExternal?kind=official_docs" },
    {
      key: "authorization",
      url: `tianjiang://openDreaminaExternal?kind=authorization&url=${authorization}`,
    },
    { key: "windowismaximized", url: "tianjiang://windowismaximized" },
    { key: "getlocallanguage", url: "tianjiang://getlocallanguage" },
  ];
}

const protocol = {
  registerSchemesAsPrivileged() {},
  handle(scheme, handler) {
    record("protocol.handle", { scheme });
    if (probeScheduled) return;
    probeScheduled = true;
    queueMicrotask(async () => {
      try {
        for (const request of probeRequests()) {
          const startedAt = Date.now();
          const response = await handler({ url: request.url });
          record("protocol.response", {
            key: request.key,
            status: response.status,
            body: await response.text(),
            elapsedMs: Date.now() - startedAt,
          });
        }
        process.exit(0);
      } catch (error) {
        record("probe.failure", {
          message: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      }
    });
  },
};

const shell = {
  showItemInFolder() {},
  async openPath() { return ""; },
  async openExternal(url) {
    // 中文注释：证据只保存 origin，不把授权查询参数写进测试日志。
    record("openExternal", { origin: new URL(url).origin });
    if (scenario === "external_reject") {
      await new Promise((resolve) => setTimeout(resolve, 60));
      throw new Error("底层浏览器失败且包含 C:\\Users\\secret\\profile");
    }
  },
};

const fakeElectron = {
  app,
  BrowserWindow,
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  protocol,
  shell,
  systemPreferences: { getUserDefault: () => "zh-CN" },
  Tray: class Tray {
    setToolTip() {}
    setContextMenu() {}
    on() {}
    destroy() {}
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};
