/**
 * R9 RED：打包验收必须使用当前工作树 .local\\profile\\独立目录，
 * 不得把 resources/../../profile 或 --user-data-dir 当成业务隔离。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { resolveAcceptanceProfileRoot } from "../../src/tianjiang/acceptance/isolation";

const appRoot = path.resolve(__dirname, "../..");
const repositoryRoot = path.resolve(appRoot, "..");
const projectTmp = path.join(repositoryRoot, ".tmp");
const builtMain = path.join(appRoot, "build", "main.js");

interface ProbeEvent {
  name: string;
  key?: string;
  value?: string;
}

interface PackagedFixture {
  root: string;
  workspaceRoot: string;
  resourcesPath: string;
  profileRoot: string;
  validUserData: string;
  fakeRealUserData: string;
  wrongPackProfile: string;
  preloadPath: string;
  eventFile: string;
}

test("打包 win-unpacked 入口必须把验收根解析到工作树 .local\\profile", () => {
  const fixture = createPackagedFixture();
  try {
    const resolved = resolveAcceptanceProfileRoot({
      isPackaged: true,
      resourcesPath: fixture.resourcesPath,
      cwd: path.join(fixture.workspaceRoot, "app"),
    });
    assert.equal(path.win32.resolve(resolved).toLowerCase(), path.win32.resolve(fixture.profileRoot).toLowerCase());
    assert.notEqual(
      path.win32.resolve(resolved).toLowerCase(),
      path.win32.resolve(fixture.wrongPackProfile).toLowerCase(),
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("打包验收 setPath 必须写入 .local\\profile 子目录，禁止 --user-data-dir 冒充隔离", () => {
  const fixture = createPackagedFixture();
  try {
    const result = runMainProbe(fixture, {
      TIANJIANG_ACCEPTANCE_MODE: "1",
      TIANJIANG_ACCEPTANCE_USER_DATA_DIR: fixture.validUserData,
      ELECTRON_EXTRA_ARGV: `--user-data-dir=${fixture.fakeRealUserData}`,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const setPath = result.events.find((event) => event.name === "setPath" && event.key === "userData");
    assert.equal(setPath?.value, fixture.validUserData);
    assert.notEqual(setPath?.value, fixture.fakeRealUserData);
    assert.notEqual(setPath?.value, fixture.wrongPackProfile);
    assert.equal(
      result.events.some((event) => event.name === "appendSwitch" && event.key === "user-data-dir"),
      false,
      "验收不得用 commandLine --user-data-dir 冒充业务隔离",
    );
    const userDataRead = result.events.find((event) => event.name === "getPath" && event.key === "userData");
    assert.equal(userDataRead?.value, fixture.validUserData);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("非验收打包入口完全忽略隔离变量，继续使用真实 userData", () => {
  const fixture = createPackagedFixture();
  try {
    const result = runMainProbe(fixture, {
      TIANJIANG_ACCEPTANCE_MODE: undefined,
      TIANJIANG_ACCEPTANCE_USER_DATA_DIR: fixture.validUserData,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.events.some((event) => event.name === "setPath"), false);
    assert.equal(
      result.events.find((event) => event.name === "getPath" && event.key === "userData")?.value,
      fixture.fakeRealUserData,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createPackagedFixture(): PackagedFixture {
  const root = fs.mkdtempSync(path.join(resolveSafeProjectTmp(), "tj-r9-pack-profile-"));
  const workspaceRoot = path.join(root, "worktree");
  const resourcesPath = path.join(workspaceRoot, "app", "dist", "win-unpacked", "resources");
  const profileRoot = path.join(workspaceRoot, ".local", "profile");
  const validUserData = path.join(profileRoot, "r9-acceptance");
  const fakeRealUserData = path.join(root, "simulated-appdata", "天将漫创");
  const wrongPackProfile = path.join(workspaceRoot, "app", "dist", "profile");
  const webRoot = path.join(resourcesPath, "data", "web");
  const serveRoot = path.join(resourcesPath, "data", "serve");
  const eventFile = path.join(root, "events.jsonl");
  const preloadPath = path.join(root, "fake-electron.cjs");

  fs.mkdirSync(validUserData, { recursive: true });
  fs.mkdirSync(fakeRealUserData, { recursive: true });
  fs.mkdirSync(wrongPackProfile, { recursive: true });
  fs.mkdirSync(webRoot, { recursive: true });
  fs.mkdirSync(serveRoot, { recursive: true });
  fs.writeFileSync(path.join(fakeRealUserData, "untouched-sentinel.txt"), "不得读取现有账号", "utf8");

  const indexBytes = Buffer.from("<!doctype html><title>R9 打包验收</title>", "utf8");
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
    wrongPackProfile,
    preloadPath,
    eventFile,
  };
}

function resolveSafeProjectTmp(): string {
  fs.mkdirSync(projectTmp, { recursive: true });
  if (fs.lstatSync(projectTmp).isSymbolicLink()) {
    throw new Error(`验收夹具 .tmp 不得是 Junction 或符号链接：${projectTmp}`);
  }
  return fs.realpathSync.native(projectTmp);
}

function runMainProbe(
  fixture: PackagedFixture,
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
  getVersion() { return "1.1.10-beta.14"; },
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
