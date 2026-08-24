import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import { ManualUpdaterService } from "../../scripts/manual-updater";
import { createDesktopManualUpdater } from "../../scripts/desktop-updater";
import { assertNoZipUserDataOverwrite } from "../../src/tianjiang/update/update-data-protection";
import { parseManualUpdateActionBody } from "../../src/tianjiang/update/manual-update-contracts";
import { resolveDesktopUpdateFeed } from "../../src/tianjiang/update/update-policy";
import type { PlatformReleaseEntry } from "../../src/tianjiang/update/platform-release-catalog";

const loadEnabledStablePolicy = async () => ({
  enabled: true,
  channel: "stable" as const,
  manualDownloadOnly: true as const,
});

const fakeInstallerRuntime = {
  launchVerifiedInstaller: async (_filePath: string) => undefined,
  finalizeInstallShutdown: async () => undefined,
  scheduleApplicationQuit: () => undefined,
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function catalogEntry(channel: "stable" | "beta", version: string): PlatformReleaseEntry {
  const prefix = `desktop/${channel}/windows/x64`;
  const installerName = `tianjiang-${version}-win-x64-setup.exe`;
  return {
    latest: {
      schemaVersion: 2,
      channel,
      platform: "windows",
      arch: "x64",
      version,
      release: `${prefix}/catalog/releases/${version}/release.json`,
    },
    release: {
      schemaVersion: 2,
      channel,
      sourceChannel: channel,
      platform: "windows",
      arch: "x64",
      version,
      tag: `v${version}`,
      commitSha: "d".repeat(40),
      nativeMetadata: `${prefix}/latest.yml`,
      artifacts: [
        { path: `${prefix}/${installerName}`, fileName: installerName, kind: "installer", size: 18, sha256: sha256("installer-content") },
        { path: `${prefix}/${installerName}.blockmap`, fileName: `${installerName}.blockmap`, kind: "blockmap", size: 16, sha256: sha256("blockmap-content") },
      ],
    },
  };
}

function memoryUpdateDeps(stableVersion = "1.2.0", betaVersion = "1.2.0-beta.1") {
  let cached: { stable?: PlatformReleaseEntry; beta?: PlatformReleaseEntry } = {};
  return {
    catalogClient: {
      async fetchChannel(channel: "stable" | "beta") {
        return channel === "stable"
          ? catalogEntry("stable", stableVersion)
          : catalogEntry("beta", betaVersion);
      },
    },
    updateCache: {
      read() {
        return Object.keys(cached).length === 0
          ? null
          : {
            cacheVersion: 1 as const,
            currentVersion: "1.1.9",
            checkedAt: "2026-08-24T00:00:00.000Z",
            ...cached,
          };
      },
      writeValidated(_currentVersion: string, updates: { stable?: PlatformReleaseEntry; beta?: PlatformReleaseEntry }) {
        cached = { ...cached, ...updates };
        return this.read()!;
      },
    },
    verifyDownloadedArtifact: async () => true,
  };
}

const CURRENT_FEED_TARGETS = {
  "win32:x64": "windows/x64",
  "darwin:x64": "macos/x64",
  "darwin:arm64": "macos/arm64",
  "linux:x64": "linux/x64",
  "linux:arm64": "linux/arm64",
} as const;

const currentFeedTarget = CURRENT_FEED_TARGETS[
  `${process.platform}:${process.arch}` as keyof typeof CURRENT_FEED_TARGETS
];
assert.ok(
  currentFeedTarget,
  `测试进程必须使用受支持的平台架构：${process.platform}/${process.arch}`,
);

const expectedCurrentFeed = (channel: "stable" | "beta") =>
  `https://api.j11.com.cn/desktop/${channel}/${currentFeedTarget}`;

test("桌面 updater 装配从固定 client-config 客户端读取严格策略", async () => {
  const requested: string[] = [];
  const feeds: string[] = [];
  const updateDeps = memoryUpdateDeps("1.1.9", "1.1.9-beta.1");
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    disableDifferentialDownload: false,
    setFeedURL(options: { url: string }) { feeds.push(options.url); },
    async checkForUpdates() {},
    async downloadUpdate() {},
    quitAndInstall() {},
    on() {},
  };
  const service = createDesktopManualUpdater({
    autoUpdater,
    currentVersion: "1.1.9",
    dataRoot: "C:\\fake-user-data\\data",
    prepareInstall: async () => undefined,
    launchVerifiedInstaller: async () => undefined,
    finalizeInstallShutdown: async () => undefined,
    scheduleApplicationQuit: () => undefined,
    ...updateDeps,
    fetcher: async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response(JSON.stringify({
        code: 0,
        data: {
          configVersion: 2,
          updatedAt: "2026-08-01T12:00:00+08:00",
          onboarding: {
            guideRevision: 1,
            supportQrCodeUrl: "https://cdn.j11.com.cn/tianjiang/guide-qr.png",
          },
          featureFlags: {
            uiSettings: true, languageSettings: true, modelServices: true,
            modelMapping: true, agentConfig: true, promptManagement: true,
            skillsManagement: true, agentMemory: true, databaseOperations: true,
            fileManagement: true, otherConfiguration: true, developerOptions: false,
            checkUpdates: true, logout: true,
          },
          updatePolicy: { enabled: true, channel: "beta", manualDownloadOnly: true },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await service.runAction({ action: "check" });
  assert.deepEqual(requested, ["https://api.j11.com.cn/api/tianjiang/v1/public/client-config"]);
  assert.deepEqual(feeds, []);
});

test("主进程 updatePolicy 禁用时阻止 check/download/install 且 channel 只走内部映射", async () => {
  const events = new Map<string, Function[]>();
  const calls: string[] = [];
  let policy: { enabled: boolean; channel: "stable" | "beta"; manualDownloadOnly: true } = {
    enabled: true,
    channel: "beta",
    manualDownloadOnly: true,
  };
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    disableDifferentialDownload: false,
    setFeedURL(options: { provider: string; url: string }) { calls.push(`feed:${options.provider}:${options.url}`); },
    async checkForUpdates() {
      calls.push("check");
      return { updateInfo: { version: "1.2.0-beta.1", files: [{ size: 18 }] } };
    },
    async downloadUpdate() {
      calls.push("download");
      return ["C:\\fake-downloads\\x.exe"];
    },
    quitAndInstall() { calls.push("install"); },
    on(event: string, listener: Function) {
      events.set(event, [...(events.get(event) ?? []), listener]);
    },
  };
  const service = new ManualUpdaterService({
    ...fakeInstallerRuntime,
    autoUpdater,
    currentVersion: "1.1.9",
    loadUpdatePolicy: async () => policy,
    ...memoryUpdateDeps("1.1.9", "1.2.0-beta.1"),
    prepareInstall: async () => { calls.push("prepare"); },
  });

  await service.runAction({ action: "check" });
  assert.equal(service.getSnapshot().beta.downloadAllowed, true);
  assert.equal(calls.length, 0);
  policy = { ...policy, enabled: false };
  await assert.rejects(() => service.runAction({ action: "download-full", channel: "beta" }), /更新策略已禁用/);
  assert.equal(calls.includes("download"), false);
  policy = { ...policy, enabled: true };
  await service.runAction({ action: "check" });
  await service.runAction({ action: "download-full", channel: "beta" });
  policy = { ...policy, enabled: false };
  await assert.rejects(() => service.runAction({ action: "install" }), /更新策略已禁用/);
  assert.equal(calls.includes("prepare"), false);
  assert.equal(calls.includes("install"), false);

  assert.equal(resolveDesktopUpdateFeed("stable"), expectedCurrentFeed("stable"));
  assert.equal(resolveDesktopUpdateFeed("beta"), expectedCurrentFeed("beta"));
  assert.equal(
    resolveDesktopUpdateFeed("stable", "win32", "x64"),
    "https://api.j11.com.cn/desktop/stable/windows/x64",
  );
  assert.equal(
    resolveDesktopUpdateFeed("beta", "win32", "x64"),
    "https://api.j11.com.cn/desktop/beta/windows/x64",
  );
  assert.equal(
    resolveDesktopUpdateFeed("beta", "darwin", "arm64"),
    "https://api.j11.com.cn/desktop/beta/macos/arm64",
  );
  assert.equal(
    resolveDesktopUpdateFeed("stable", "linux", "x64"),
    "https://api.j11.com.cn/desktop/stable/linux/x64",
  );
  assert.throws(
    () => resolveDesktopUpdateFeed("beta", "win32", "arm64"),
    /不支持的更新平台或架构/,
  );
  assert.throws(
    () => resolveDesktopUpdateFeed("beta", "freebsd" as NodeJS.Platform, "x64"),
    /不支持的更新平台或架构/,
  );
  assert.throws(() => resolveDesktopUpdateFeed("evil" as never), /更新通道无效/);
});

test("manual updater 默认禁用自动安装，只把已验证路径交给安全 launcher", async () => {
  const events = new Map<string, Function[]>();
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    disableDifferentialDownload: true,
    setFeedURL() {},
    checkForUpdates: async () => {
      return { updateInfo: { version: "1.2.0", files: [{ size: 18 }] } };
    },
    downloadUpdate: async () => {
      return ["C:\\fake-downloads\\x.exe"];
    },
    quitAndInstallCalls: 0,
    quitAndInstall() { this.quitAndInstallCalls += 1; },
    on(event: string, listener: Function) {
      const list = events.get(event) ?? [];
      list.push(listener);
      events.set(event, list);
    },
  };
  let didPrepareInstall = false;
  const launchedPaths: string[] = [];
  let scheduledQuitCalls = 0;
  const service = new ManualUpdaterService({
    autoUpdater: autoUpdater as any,
    currentVersion: "1.1.9",
    loadUpdatePolicy: loadEnabledStablePolicy,
    ...memoryUpdateDeps("1.2.0", "1.1.9-beta.1"),
    prepareInstall: async () => { didPrepareInstall = true; },
    launchVerifiedInstaller: async (filePath: string) => { launchedPaths.push(filePath); },
    finalizeInstallShutdown: async () => undefined,
    scheduleApplicationQuit: () => { scheduledQuitCalls += 1; },
  } as any);
  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);

  await service.runAction({ action: "check" });
  assert.equal(service.getSnapshot().state, "available");
  await service.runAction({ action: "download-differential", channel: "stable" });
  assert.equal(service.getSnapshot().state, "downloaded");
  assert.equal(autoUpdater.disableDifferentialDownload, false);
  await service.runAction({ action: "download-full", channel: "stable" });
  assert.equal(autoUpdater.disableDifferentialDownload, true);
  await service.runAction({ action: "install" });
  assert.equal(didPrepareInstall, true);
  assert.deepEqual(launchedPaths, ["C:\\fake-downloads\\x.exe"]);
  assert.equal(scheduledQuitCalls, 1);
  assert.equal(autoUpdater.quitAndInstallCalls, 0);
});

test("更新前保护失败时绝不调用 launcher、退出调度或 quitAndInstall", async () => {
  const events = new Map<string, Function[]>();
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    disableDifferentialDownload: false,
    setFeedURL() {},
    checkForUpdates: async () => {
      return { updateInfo: { version: "1.2.0", files: [{ size: 18 }] } };
    },
    downloadUpdate: async () => {
      return ["C:\\fake-downloads\\candidate.exe"];
    },
    quitAndInstallCalls: 0,
    quitAndInstall() { this.quitAndInstallCalls += 1; },
    on(event: string, listener: Function) {
      const listeners = events.get(event) ?? [];
      listeners.push(listener);
      events.set(event, listeners);
    },
  };
  let launchCalls = 0;
  let scheduledQuitCalls = 0;
  const service = new ManualUpdaterService({
    autoUpdater,
    currentVersion: "1.1.9",
    loadUpdatePolicy: loadEnabledStablePolicy,
    ...memoryUpdateDeps("1.2.0", "1.1.9-beta.1"),
    prepareInstall: async () => {
      throw new Error("backup failed");
    },
    launchVerifiedInstaller: async () => { launchCalls += 1; },
    finalizeInstallShutdown: async () => undefined,
    scheduleApplicationQuit: () => { scheduledQuitCalls += 1; },
  } as any);

  await service.runAction({ action: "check" });
  await service.runAction({ action: "download-full", channel: "stable" });
  await assert.rejects(() => service.runAction({ action: "install" }), /backup failed/);
  assert.equal(autoUpdater.quitAndInstallCalls, 0);
  assert.equal(launchCalls, 0);
  assert.equal(scheduledQuitCalls, 0);
  assert.equal(service.getSnapshot().state, "error");
  assert.match(service.getSnapshot().errorMessage ?? "", /backup failed/);
});

test("未完成下载时 install 必须在准备备份前被状态机拒绝", async () => {
  let prepareInstallCalls = 0;
  let launchCalls = 0;
  let scheduledQuitCalls = 0;
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    disableDifferentialDownload: false,
    setFeedURL() {},
    checkForUpdates: async () => undefined,
    downloadUpdate: async () => undefined,
    quitAndInstallCalls: 0,
    quitAndInstall() { this.quitAndInstallCalls += 1; },
    on() {},
  };
  const service = new ManualUpdaterService({
    autoUpdater,
    currentVersion: "1.1.9",
    loadUpdatePolicy: loadEnabledStablePolicy,
    ...memoryUpdateDeps("1.2.0", "1.1.9-beta.1"),
    prepareInstall: async () => { prepareInstallCalls += 1; },
    launchVerifiedInstaller: async () => { launchCalls += 1; },
    finalizeInstallShutdown: async () => undefined,
    scheduleApplicationQuit: () => { scheduledQuitCalls += 1; },
  } as any);

  await assert.rejects(() => service.runAction({ action: "install" }), /仅允许安装.*已验证/);
  assert.equal(prepareInstallCalls, 0);
  assert.equal(autoUpdater.quitAndInstallCalls, 0);
  assert.equal(launchCalls, 0);
  assert.equal(scheduledQuitCalls, 0);
});

test("禁止 ZIP 覆盖用户数据且 body 不得含 URL", () => {
  const downloadSource = fs.readFileSync(
    path.join(process.cwd(), "src/routes/setting/about/downloadApp.ts"),
    "utf8",
  );
  assert.doesNotMatch(downloadSource, /compressing\.zip\.uncompress/);
  assert.doesNotMatch(downloadSource, /fs\.cpSync\(rootDir,\s*dataDir/);
  assertNoZipUserDataOverwrite(downloadSource);
  assert.throws(() => parseManualUpdateActionBody({ action: "check", url: "https://evil" }));
  assert.throws(() => parseManualUpdateActionBody({ action: "download-full", channel: "stable", feedBaseUrl: "x" }));
});
