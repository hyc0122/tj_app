import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const appRoot = path.resolve(__dirname, "../..");
const repositoryRoot = path.resolve(appRoot, "..");
const projectTmp = path.join(repositoryRoot, ".tmp");
const builtMain = path.join(appRoot, "build", "main.js");

interface ProbeEvent {
  name: string;
  key?: string;
  value?: string;
}

interface MainFixture {
  root: string;
  workspaceRoot: string;
  resourcesPath: string;
  profileRoot: string;
  validUserData: string;
  fakeRealUserData: string;
  preloadPath: string;
  eventFile: string;
}

test("显式验收模式在 whenReady 和首次 getPath 前设置隔离 userData", () => {
  const fixture = createMainFixture();
  try {
    assert.equal(
      fs.lstatSync(projectTmp).isSymbolicLink(),
      false,
      "项目 .tmp 不得是 Junction 或符号链接",
    );
    assert.equal(
      isPathInside(
        fs.realpathSync.native(projectTmp),
        fs.realpathSync.native(fixture.root),
      ),
      true,
      "fixture.root 必须位于当前工作树 .tmp，不能由系统临时目录决定",
    );
    assert.equal(
      isPathInside(fixture.root, fixture.fakeRealUserData),
      true,
      "模拟真实 AppData 必须位于本次 .tmp 夹具内，禁止读取真实用户目录",
    );
    const realBefore = snapshotDirectory(fixture.fakeRealUserData);
    const result = runMainProbe(fixture, {
      TIANJIANG_ACCEPTANCE_MODE: "1",
      TIANJIANG_ACCEPTANCE_USER_DATA_DIR: fixture.validUserData,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const setPathIndex = result.events.findIndex((event) =>
      event.name === "setPath" && event.key === "userData");
    const whenReadyIndex = result.events.findIndex((event) => event.name === "whenReady");
    const firstGetPathIndex = result.events.findIndex((event) => event.name === "getPath");
    assert.notEqual(setPathIndex, -1, "验收入口必须调用 app.setPath");
    assert.ok(setPathIndex < whenReadyIndex, "app.setPath 必须早于 app.whenReady");
    assert.ok(setPathIndex < firstGetPathIndex, "app.setPath 必须早于首次 app.getPath");
    assert.equal(result.events[setPathIndex]?.value, fixture.validUserData);

    const userDataRead = result.events.find((event) =>
      event.name === "getPath" && event.key === "userData");
    assert.equal(userDataRead?.value, fixture.validUserData);
    // 打包生产必须同源 loadURL，禁止 loadFile(webEntry) 导致 file:// 跨来源 Cookie 失效。
    assert.equal(
      result.events.find((event) => event.name === "loadURL")?.value,
      "http://127.0.0.1:18181/",
    );
    assert.equal(
      result.events.some((event) => event.name === "loadFile"),
      false,
      "打包生产不得 loadFile 安装包 HTML",
    );
    // Round9：新进程 ready-to-show 必须 maximize → show，避免小窗闪烁
    const maximizeIndex = result.events.findIndex((event) => event.name === "maximize");
    const showIndex = result.events.findIndex((event) => event.name === "show");
    assert.notEqual(maximizeIndex, -1, "首次显示前必须 maximize");
    assert.notEqual(showIndex, -1, "首次显示必须 show");
    assert.ok(maximizeIndex < showIndex, "maximize 必须早于 show");
    assert.deepEqual(
      snapshotDirectory(fixture.fakeRealUserData),
      realBefore,
      "真实 AppData 只读摘要不得因入口探针发生变化",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("正常生产和非精确验收标记完全忽略隔离变量", () => {
  for (const mode of [undefined, "true", "0", "01"]) {
    const fixture = createMainFixture();
    try {
      const result = runMainProbe(fixture, {
        TIANJIANG_ACCEPTANCE_MODE: mode,
        TIANJIANG_ACCEPTANCE_USER_DATA_DIR: fixture.validUserData,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(
        result.events.some((event) => event.name === "setPath"),
        false,
        `mode=${String(mode)} 不得覆盖 userData`,
      );
      assert.equal(
        result.events.find((event) =>
          event.name === "getPath" && event.key === "userData")?.value,
        fixture.fakeRealUserData,
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("验收 userData 拒绝 C盘、真实 AppData、相对路径、UNC 和工作树越界", () => {
  const fixture = createMainFixture();
  const rejected = [
    "C:\\acceptance\\profile",
    fixture.fakeRealUserData,
    ".\\.local\\profile",
    path.relative(appRoot, fixture.validUserData),
    "\\\\server\\share\\profile",
    "//server/share/profile",
    path.join(fixture.workspaceRoot, ".local", "other-profile"),
  ];
  try {
    for (const candidate of rejected) {
      const result = runMainProbe(fixture, {
        TIANJIANG_ACCEPTANCE_MODE: "1",
        TIANJIANG_ACCEPTANCE_USER_DATA_DIR: candidate,
      });
      assert.notEqual(result.status, 0, `必须拒绝：${candidate}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /验收.*(?:路径|userData|用户数据)/i);
      assert.equal(
        result.events.some((event) =>
          event.name === "whenReady" || event.name === "getPath" || event.name === "setPath"),
        false,
        "无效路径必须在 Electron ready、读路径和写路径之前失败关闭",
      );
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("验收 userData 拒绝直接使用允许根 .local profile 本身", () => {
  const fixture = createMainFixture();
  try {
    const result = runMainProbe(fixture, {
      TIANJIANG_ACCEPTANCE_MODE: "1",
      TIANJIANG_ACCEPTANCE_USER_DATA_DIR: fixture.profileRoot,
    });
    assertProbeRejectedBeforeElectronPaths(result, "允许根本身不得作为 userData");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("验收允许根自身为 Junction 时在 Electron 路径调用前失败关闭", () => {
  const fixture = createMainFixture();
  const realProfileRoot = path.join(fixture.workspaceRoot, ".local", "profile-target");
  try {
    fs.renameSync(fixture.profileRoot, realProfileRoot);
    fs.symlinkSync(realProfileRoot, fixture.profileRoot, "junction");

    const result = runMainProbe(fixture, {
      TIANJIANG_ACCEPTANCE_MODE: "1",
      TIANJIANG_ACCEPTANCE_USER_DATA_DIR: fixture.validUserData,
    });
    assertProbeRejectedBeforeElectronPaths(result, "允许根 Junction 必须失败关闭");
  } finally {
    removeJunction(fixture.profileRoot);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("验收候选路径任一中间组成部分为 Junction 时失败关闭", () => {
  const fixture = createMainFixture();
  const safeTarget = path.join(fixture.profileRoot, "safe-target");
  const linkedParent = path.join(fixture.profileRoot, "linked-parent");
  const nestedCandidate = path.join(linkedParent, "nested");
  try {
    fs.mkdirSync(path.join(safeTarget, "nested"), { recursive: true });
    fs.symlinkSync(safeTarget, linkedParent, "junction");

    const result = runMainProbe(fixture, {
      TIANJIANG_ACCEPTANCE_MODE: "1",
      TIANJIANG_ACCEPTANCE_USER_DATA_DIR: nestedCandidate,
    });
    assertProbeRejectedBeforeElectronPaths(result, "候选中间 Junction 必须失败关闭");
  } finally {
    removeJunction(linkedParent);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("验收候选 Junction 指向 C盘、真实 AppData 或工作树外时失败关闭", () => {
  const targets = [
    { label: "C盘", resolve: () => "C:\\Windows" },
    {
      label: "真实 AppData",
      resolve: (fixture: MainFixture) => fixture.fakeRealUserData,
    },
    {
      label: "工作树外",
      resolve: (fixture: MainFixture) => {
        const target = path.join(fixture.root, "outside-worktree");
        fs.mkdirSync(target, { recursive: true });
        return target;
      },
    },
  ];

  for (const targetCase of targets) {
    const fixture = createMainFixture();
    try {
      fs.rmSync(fixture.validUserData, { recursive: true, force: true });
      const target = targetCase.resolve(fixture);
      assert.equal(fs.existsSync(target), true, `${targetCase.label}夹具目标必须存在`);
      fs.symlinkSync(target, fixture.validUserData, "junction");

      const result = runMainProbe(fixture, {
        TIANJIANG_ACCEPTANCE_MODE: "1",
        TIANJIANG_ACCEPTANCE_USER_DATA_DIR: fixture.validUserData,
      });
      assertProbeRejectedBeforeElectronPaths(
        result,
        `候选 Junction 指向${targetCase.label}必须失败关闭`,
      );
    } finally {
      removeJunction(fixture.validUserData);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("验收模式缺少 userData 路径时在入口失败关闭", () => {
  const fixture = createMainFixture();
  try {
    const result = runMainProbe(fixture, {
      TIANJIANG_ACCEPTANCE_MODE: "1",
      TIANJIANG_ACCEPTANCE_USER_DATA_DIR: undefined,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /验收.*userData|验收.*用户数据/i);
    assert.equal(result.events.some((event) => event.name === "whenReady"), false);
    assert.equal(result.events.some((event) => event.name === "getPath"), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function assertProbeRejectedBeforeElectronPaths(
  result: ReturnType<typeof runMainProbe>,
  message: string,
): void {
  assert.notEqual(result.status, 0, message);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /验收.*(?:路径|userData|用户数据|profile|Junction|reparse)/i,
  );
  assert.equal(
    result.events.some((event) =>
      event.name === "setPath" || event.name === "whenReady" || event.name === "getPath"),
    false,
    message,
  );
}

function removeJunction(targetPath: string): void {
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink()) {
      // 必须先删除 Junction 本身，禁止递归清理跟随到真实 AppData 或工作树外。
      fs.unlinkSync(targetPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function createMainFixture(): MainFixture {
  const root = fs.mkdtempSync(
    path.join(resolveSafeProjectTmp(), "tj-acceptance-main-"),
  );
  const workspaceRoot = path.join(root, "worktree");
  const resourcesPath = path.join(workspaceRoot, ".local", "install", "resources");
  const profileRoot = path.join(workspaceRoot, ".local", "profile");
  const validUserData = path.join(profileRoot, "entry-test");
  // 只在本次 .tmp 夹具中模拟真实 AppData，测试永远不得枚举用户实际目录。
  const fakeRealUserData = path.join(root, "simulated-appdata", "天将漫创");
  const webRoot = path.join(resourcesPath, "data", "web");
  const serveRoot = path.join(resourcesPath, "data", "serve");
  const eventFile = path.join(root, "events.jsonl");
  const preloadPath = path.join(root, "fake-electron.cjs");

  fs.mkdirSync(validUserData, { recursive: true });
  fs.mkdirSync(fakeRealUserData, { recursive: true });
  fs.mkdirSync(webRoot, { recursive: true });
  fs.mkdirSync(serveRoot, { recursive: true });
  fs.writeFileSync(
    path.join(fakeRealUserData, "untouched-sentinel.txt"),
    "模拟真实用户数据不得被验收探针修改",
    "utf8",
  );

  const indexBytes = Buffer.from("<!doctype html><title>验收入口</title>", "utf8");
  fs.writeFileSync(path.join(webRoot, "index.html"), indexBytes);
  fs.writeFileSync(
    path.join(webRoot, ".tianjiang-web-package.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceFiles: [{
        path: "index.html",
        size: indexBytes.length,
        sha256: crypto.createHash("sha256").update(indexBytes).digest("hex"),
      }],
    }),
  );
  fs.writeFileSync(
    path.join(serveRoot, "app.js"),
    [
      "module.exports = {",
      "  default: async () => 18181,",
      "  closeServe: async () => undefined,",
      "};",
    ].join("\n"),
  );
  fs.writeFileSync(preloadPath, fakeElectronPreload(), "utf8");
  return {
    root,
    workspaceRoot,
    resourcesPath,
    profileRoot,
    validUserData,
    fakeRealUserData,
    preloadPath,
    eventFile,
  };
}

function resolveSafeProjectTmp(): string {
  fs.mkdirSync(projectTmp, { recursive: true });
  if (fs.lstatSync(projectTmp).isSymbolicLink()) {
    throw new Error(`验收夹具 .tmp 不得是 Junction 或符号链接：${projectTmp}`);
  }

  const realRepositoryRoot = fs.realpathSync.native(repositoryRoot);
  const realProjectTmp = fs.realpathSync.native(projectTmp);
  if (!isPathInside(realRepositoryRoot, realProjectTmp)) {
    throw new Error(`验收夹具 .tmp 真实路径必须位于当前工作树：${realProjectTmp}`);
  }
  return realProjectTmp;
}

function runMainProbe(
  fixture: MainFixture,
  overrides: Record<string, string | undefined>,
): { status: number | null; stdout: string; stderr: string; events: ProbeEvent[] } {
  fs.rmSync(fixture.eventFile, { force: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "prod",
    TIANJIANG_FAKE_RESOURCES_PATH: fixture.resourcesPath,
    TIANJIANG_FAKE_REAL_USER_DATA: fixture.fakeRealUserData,
    TIANJIANG_ACCEPTANCE_EVENT_FILE: fixture.eventFile,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(
    process.execPath,
    ["--require", fixture.preloadPath, builtMain],
    {
      cwd: appRoot,
      encoding: "utf8",
      timeout: 20_000,
      env,
    },
  );
  const events = fs.existsSync(fixture.eventFile)
    ? fs.readFileSync(fixture.eventFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProbeEvent)
    : [];
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    events,
  };
}

function snapshotDirectory(root: string): Record<string, string> {
  if (!fs.existsSync(root)) return {};
  const snapshot: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        snapshot[relative] = crypto.createHash("sha256")
          .update(fs.readFileSync(absolute))
          .digest("hex");
      }
    }
  };
  visit(root);
  return snapshot;
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    )
  );
}

function fakeElectronPreload(): string {
  return String.raw`
const fs = require("node:fs");
const Module = require("node:module");

const eventFile = process.env.TIANJIANG_ACCEPTANCE_EVENT_FILE;
function record(name, details = {}) {
  fs.appendFileSync(eventFile, JSON.stringify({ name, ...details }) + "\n", "utf8");
}

Object.defineProperty(process, "resourcesPath", {
  configurable: true,
  value: process.env.TIANJIANG_FAKE_RESOURCES_PATH,
});

const paths = new Map([
  ["userData", process.env.TIANJIANG_FAKE_REAL_USER_DATA],
]);

const app = {
  isPackaged: true,
  commandLine: {
    appendSwitch(name, value) { record("appendSwitch", { key: name, value }); },
  },
  setName(value) { record("setName", { value }); },
  setPath(key, value) {
    paths.set(key, value);
    record("setPath", { key, value });
  },
  getPath(key) {
    const value = paths.get(key) || "";
    record("getPath", { key, value });
    return value;
  },
  whenReady() {
    record("whenReady");
    return Promise.resolve();
  },
  getVersion() { return "1.1.9"; },
  getLocale() { return "zh-CN"; },
  on(name) { record("app.on", { key: name }); },
  quit() { record("quit"); },
  relaunch() { record("relaunch"); },
};

class BrowserWindow {
  constructor() {
    record("BrowserWindow");
    this.webContents = {
      getUserAgent: () => "FakeElectron",
      setUserAgent: (value) => record("setUserAgent", { value }),
      openDevTools: () => record("openDevTools"),
    };
  }
  setMenuBarVisibility() {}
  removeMenu() {}
  on() {}
  once(name, listener) {
    if (name === "ready-to-show") setImmediate(listener);
  }
  show() { record("show"); }
  loadFile(value) {
    record("loadFile", { value });
    return Promise.resolve();
  }
  loadURL(value) {
    record("loadURL", { value });
    return Promise.resolve();
  }
  minimize() {}
  maximize() { record("maximize"); }
  unmaximize() {}
  isMaximized() { return false; }
  static getAllWindows() { return []; }
}

const fakeElectron = {
  app,
  BrowserWindow,
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  protocol: {
    handle: () => record("protocol.handle"),
    registerSchemesAsPrivileged: () => record("protocol.register"),
  },
  shell: {
    showItemInFolder: () => undefined,
    openPath: async () => "",
    openExternal: async () => undefined,
  },
  systemPreferences: {
    getUserDefault: () => "zh-CN",
  },
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "electron") return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};
`;
}
