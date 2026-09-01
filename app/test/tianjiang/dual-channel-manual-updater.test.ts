import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createDesktopManualUpdater } from "../../scripts/desktop-updater";
import * as desktopUpdaterModule from "../../scripts/desktop-updater";
import { ManualUpdaterService } from "../../scripts/manual-updater";
import checkUpdateRouter, { bindManualUpdater } from "../../src/routes/setting/about/checkUpdate";
import {
  MANUAL_UPDATE_ACTIONS,
  parseManualUpdateActionBody,
} from "../../src/tianjiang/update/manual-update-contracts";
import type { PlatformReleaseEntry } from "../../src/tianjiang/update/platform-release-catalog";
import type { PlatformUpdateCacheRecord } from "../../src/tianjiang/update/platform-update-cache";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function entry(channel: "stable" | "beta", version: string): PlatformReleaseEntry {
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
      commitSha: "c".repeat(40),
      nativeMetadata: `${prefix}/latest.yml`,
      artifacts: [
        { path: `${prefix}/${installerName}`, fileName: installerName, kind: "installer", size: 18, sha256: sha256("installer-content") },
        { path: `${prefix}/${installerName}.blockmap`, fileName: `${installerName}.blockmap`, kind: "blockmap", size: 16, sha256: sha256("blockmap-content") },
      ],
    },
  };
}

function fakeUpdater(options: { version?: string; size?: number; path?: string } = {}) {
  const calls: string[] = [];
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    disableDifferentialDownload: false,
    setFeedURL({ url }: { url: string }) { calls.push(`feed:${url}`); },
    async checkForUpdates() {
      calls.push("native-check");
      return {
        updateInfo: {
          version: options.version ?? "1.1.11",
          files: [{ size: options.size ?? 18 }],
        },
      };
    },
    async downloadUpdate() {
      calls.push("download");
      return [options.path ?? "C:\\fake-downloads\\candidate.exe"];
    },
    quitAndInstall() { calls.push("install"); },
    on() {},
  };
  return { updater, calls };
}

function eventUpdater(mode: "none" | "sync-error" | "delayed-error" = "none") {
  const emitter = new EventEmitter();
  const calls: string[] = [];
  let delayedThrown: unknown;
  let settleDelayed!: () => void;
  const delayedSettled = new Promise<void>((resolve) => { settleDelayed = resolve; });
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    disableDifferentialDownload: false,
    setFeedURL({ url }: { url: string }) { calls.push(`feed:${url}`); },
    async checkForUpdates() {
      calls.push("native-check");
      return { updateInfo: { version: "1.1.11", files: [{ size: 18 }] } };
    },
    async downloadUpdate() {
      calls.push("download");
      return ["C:\\fake-downloads\\candidate.exe"];
    },
    quitAndInstall() {
      calls.push("install");
      if (mode === "sync-error") emitter.emit("error", new Error("安装器同步启动失败"));
      if (mode === "delayed-error") {
        setImmediate(() => {
          try {
            emitter.emit("error", new Error("安装器异步启动失败"));
          } catch (error) {
            delayedThrown = error;
          } finally {
            settleDelayed();
          }
        });
      }
    },
    on: emitter.on.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
  };
  return {
    updater,
    calls,
    emitter,
    delayedSettled,
    getDelayedThrown: () => delayedThrown,
  };
}

function installReadyService(
  autoUpdater: ReturnType<typeof eventUpdater>["updater"],
  prepareInstall: () => Promise<void> = async () => undefined,
  installerRuntime: {
    launchVerifiedInstaller?: (filePath: string) => Promise<void>;
    finalizeInstallShutdown?: () => Promise<void>;
    recoverAfterInstallerLaunchFailure?: (error: unknown) => Promise<void>;
    scheduleApplicationQuit?: () => void;
    verifyDownloadedArtifact?: (candidate: {
      filePath: string;
      channel: "stable" | "beta";
      size: number;
      sha256: string;
    }) => Promise<boolean>;
  } = {},
) {
  return new ManualUpdaterService({
    autoUpdater,
    currentVersion: "1.1.10-beta.14",
    loadUpdatePolicy: enabledPolicy,
    catalogClient: {
      async fetchChannel(channel: "stable" | "beta") {
        return channel === "stable" ? entry("stable", "1.1.11") : entry("beta", "1.1.10-beta.14");
      },
    },
    updateCache: memoryCache(),
    prepareInstall,
    verifyDownloadedArtifact: installerRuntime.verifyDownloadedArtifact ?? (async () => true),
    launchVerifiedInstaller: installerRuntime.launchVerifiedInstaller ?? (async () => undefined),
    finalizeInstallShutdown: installerRuntime.finalizeInstallShutdown ?? (async () => undefined),
    recoverAfterInstallerLaunchFailure: installerRuntime.recoverAfterInstallerLaunchFailure,
    scheduleApplicationQuit: installerRuntime.scheduleApplicationQuit ?? (() => undefined),
  } as any);
}

async function downloadStableCandidate(service: ManualUpdaterService): Promise<void> {
  await service.runAction({ action: "check" });
  await service.runAction({ action: "download-full", channel: "stable" });
}

function memoryCache(cached: { stable?: PlatformReleaseEntry; beta?: PlatformReleaseEntry } | null = null) {
  let value = cached;
  return {
    read() {
      if (!value) return null;
      return {
        cacheVersion: 1 as const,
        currentVersion: "1.1.10-beta.14",
        checkedAt: "2026-08-24T00:00:00.000Z",
        stableRequiredVersion: value.stable?.latest.version,
        ...value,
      };
    },
    writeValidated(_currentVersion: string, updates: { stable?: PlatformReleaseEntry; beta?: PlatformReleaseEntry }) {
      value = { ...(value ?? {}), ...updates };
      return {
        cacheVersion: 1 as const,
        currentVersion: "1.1.10-beta.14",
        checkedAt: "2026-08-24T00:00:00.000Z",
        stableRequiredVersion: value.stable?.latest.version,
        ...value,
      } satisfies PlatformUpdateCacheRecord;
    },
  };
}

const enabledPolicy = async () => ({
  enabled: true,
  channel: "beta" as const,
  manualDownloadOnly: true as const,
});

const fakeInstallerRuntime = {
  launchVerifiedInstaller: async (_filePath: string) => undefined,
  finalizeInstallShutdown: async () => undefined,
  scheduleApplicationQuit: () => undefined,
};

async function invokeCheckRoute(body: unknown): Promise<{ status: number; payload: any }> {
  const handler = (checkUpdateRouter as any).stack[0].route.stack[0].handle;
  let status = 200;
  let payload: any;
  const response = {
    status(next: number) { status = next; return response; },
    send(next: any) { payload = next; return response; },
  };
  await handler({ body }, response, () => undefined);
  return { status, payload };
}

test("支持平台绑定前或初始化失败时登录检查 fail-closed", async () => {
  (bindManualUpdater as Function)(null, {
    state: "initializing",
    platform: "win32",
    arch: "x64",
    currentVersion: "9.8.7",
  });
  const initializing = await invokeCheckRoute({ action: "check-login-stable" });
  assert.equal(initializing.status, 503);
  assert.equal(initializing.payload.data?.loginAllowed, false);
  assert.equal(initializing.payload.data?.currentVersion, "9.8.7");
  assert.match(initializing.payload.message, /未就绪|初始化/);

  (bindManualUpdater as Function)({
    getSnapshot: () => ({ state: "checking", loginAllowed: true }),
    runAction: async () => { throw new Error("初始化检查失败"); },
  });
  const rejected = await invokeCheckRoute({ action: "check-login-stable" });
  assert.equal(rejected.status, 503);
  assert.equal(rejected.payload.data?.loginAllowed, false);
  assert.match(rejected.payload.message, /未完成|重试/);

  (bindManualUpdater as Function)(null, {
    state: "failed",
    platform: "win32",
    arch: "x64",
    currentVersion: "9.8.6",
    message: "cache unavailable",
  });
  const failed = await invokeCheckRoute({ action: "check-login-stable" });
  assert.equal(failed.status, 503);
  assert.equal(failed.payload.data?.loginAllowed, false);
  assert.equal(failed.payload.data?.currentVersion, "9.8.6");
  assert.match(failed.payload.message, /失败|重试/);
});

test("unsupported 绑定快照也必须使用主进程显式版本", async () => {
  (bindManualUpdater as Function)(null, {
    state: "unsupported",
    platform: "linux",
    arch: "x64",
    currentVersion: "9.8.5",
  });
  const result = await invokeCheckRoute({ action: "check-login-stable" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.data?.loginAllowed, true);
  assert.equal(result.payload.data?.currentVersion, "9.8.5");
});

test("非 Windows x64 平台明确 unsupported、零 Catalog 请求且不设置 Windows feed", async (t) => {
  for (const runtime of [
    { platform: "darwin", arch: "x64" },
    { platform: "linux", arch: "x64" },
    { platform: "win32", arch: "arm64" },
  ] as const) {
    await t.test(`${runtime.platform}-${runtime.arch}`, async () => {
      let fetches = 0;
      const { updater, calls } = fakeUpdater();
      const service = createDesktopManualUpdater({
        autoUpdater: updater,
        currentVersion: "1.1.10-beta.14",
        dataRoot: "C:\\fake-user-data\\data",
        platform: runtime.platform,
        arch: runtime.arch,
        fetcher: (async () => { fetches += 1; throw new Error("禁止请求 Windows Catalog"); }) as typeof fetch,
        prepareInstall: async () => undefined,
      } as any);
      const snapshot = await service.runAction({ action: "check-login-stable" });
      assert.equal(snapshot.state, "unsupported");
      assert.equal(snapshot.loginAllowed, true);
      assert.equal(snapshot.stableRequired, false);
      assert.match(snapshot.warningMessage ?? "", /不支持|unsupported/i);
      assert.equal(fetches, 0);
      assert.equal(calls.some((call) => call.startsWith("feed:")), false);
    });
  }
});

test("手动更新 body 冻结显式 action，下载必须显式 channel 且禁止 URL", () => {
  assert.deepEqual(MANUAL_UPDATE_ACTIONS, [
    "check",
    "check-login-stable",
    "download-differential",
    "download-full",
    "cancel-download",
    "install",
    "show-file",
  ]);
  assert.deepEqual(parseManualUpdateActionBody({ action: "check" }), { action: "check" });
  assert.deepEqual(parseManualUpdateActionBody({ action: "download-full", channel: "stable" }), {
    action: "download-full", channel: "stable",
  });
  assert.throws(() => parseManualUpdateActionBody({ action: "download-full" }));
  assert.throws(() => parseManualUpdateActionBody({ action: "download-full", channel: "nightly" }));
  assert.throws(() => parseManualUpdateActionBody({ action: "check", channel: "stable" }));
  assert.throws(() => parseManualUpdateActionBody({ action: "check", url: "https://evil.example" }));
});

test("Stable 高于本机时阻断登录并成为唯一可下载通道，检查阶段不触发原生 updater", async () => {
  const { updater, calls } = fakeUpdater();
  const service = new ManualUpdaterService({
    ...fakeInstallerRuntime,
    autoUpdater: updater,
    currentVersion: "1.1.10-beta.14",
    loadUpdatePolicy: enabledPolicy,
    catalogClient: {
      async fetchChannel(channel: "stable" | "beta") {
        return channel === "stable" ? entry("stable", "1.1.11") : entry("beta", "1.1.12-beta.1");
      },
    },
    updateCache: memoryCache(),
    prepareInstall: async () => undefined,
    verifyDownloadedArtifact: async () => true,
  });

  const snapshot = await service.runAction({ action: "check-login-stable" });
  assert.equal(snapshot.stable.required, true);
  assert.equal(snapshot.stableRequired, true);
  assert.equal(snapshot.loginAllowed, false);
  assert.equal(snapshot.stable.downloadAllowed, true);
  assert.equal(snapshot.beta.downloadAllowed, false);
  assert.equal(snapshot.selectedChannel, "stable");
  assert.deepEqual(calls, []);
  await assert.rejects(
    () => service.runAction({ action: "download-full", channel: "beta" }),
    /Stable|正式版|测试版/,
  );
});

test("离线时有效 Stable 强制缓存继续阻断；无有效缓存则放行并显示明确警告", async () => {
  const unavailableCatalog = {
    async fetchChannel() { throw new Error("offline"); },
  };
  const withCache = new ManualUpdaterService({
    ...fakeInstallerRuntime,
    autoUpdater: fakeUpdater().updater,
    currentVersion: "1.1.10-beta.14",
    loadUpdatePolicy: enabledPolicy,
    catalogClient: unavailableCatalog,
    updateCache: memoryCache({ stable: entry("stable", "1.1.11") }),
    prepareInstall: async () => undefined,
    verifyDownloadedArtifact: async () => true,
  });
  const blocked = await withCache.runAction({ action: "check-login-stable" });
  assert.equal(blocked.stable.source, "cache");
  assert.equal(blocked.stableRequired, true);
  assert.equal(blocked.loginAllowed, false);

  const noCache = new ManualUpdaterService({
    ...fakeInstallerRuntime,
    autoUpdater: fakeUpdater().updater,
    currentVersion: "1.1.10-beta.14",
    loadUpdatePolicy: enabledPolicy,
    catalogClient: unavailableCatalog,
    updateCache: memoryCache(),
    prepareInstall: async () => undefined,
    verifyDownloadedArtifact: async () => true,
  });
  const allowed = await noCache.runAction({ action: "check-login-stable" });
  assert.equal(allowed.stableRequired, false);
  assert.equal(allowed.loginAllowed, true);
  assert.match(allowed.warningMessage ?? "", /正式版检查失败.*稍后重试/);
});

test("Stable 网络失败且缓存版本不高于当前版本时放行，但仍显示重试警告", async () => {
  const service = new ManualUpdaterService({
    ...fakeInstallerRuntime,
    autoUpdater: fakeUpdater().updater,
    currentVersion: "1.1.11",
    loadUpdatePolicy: enabledPolicy,
    catalogClient: { async fetchChannel() { throw new Error("offline"); } },
    updateCache: memoryCache({ stable: entry("stable", "1.1.11") }),
    prepareInstall: async () => undefined,
    verifyDownloadedArtifact: async () => true,
  });
  const snapshot = await service.runAction({ action: "check-login-stable" });
  assert.equal(snapshot.loginAllowed, true);
  assert.equal(snapshot.stableRequired, false);
  assert.equal(snapshot.stable.source, "cache");
  assert.match(snapshot.warningMessage ?? "", /正式版检查失败.*稍后重试/);
});

test("没有强制 Stable 时可显式选择 Beta，原生版本、大小与 SHA 验证后才形成候选", async () => {
  const { updater, calls } = fakeUpdater({ version: "1.1.12-beta.1", size: 18 });
  const verified: Array<{ filePath: string; channel: string; sha256: string }> = [];
  const service = new ManualUpdaterService({
    ...fakeInstallerRuntime,
    autoUpdater: updater,
    currentVersion: "1.1.11",
    loadUpdatePolicy: enabledPolicy,
    catalogClient: {
      async fetchChannel(channel: "stable" | "beta") {
        return channel === "stable" ? entry("stable", "1.1.11") : entry("beta", "1.1.12-beta.1");
      },
    },
    updateCache: memoryCache(),
    prepareInstall: async () => undefined,
    verifyDownloadedArtifact: async (candidate: { filePath: string; channel: string; sha256: string }) => {
      verified.push(candidate);
      return true;
    },
  });

  await service.runAction({ action: "check" });
  const downloaded = await service.runAction({ action: "download-differential", channel: "beta" });
  assert.equal(downloaded.selectedChannel, "beta");
  assert.equal(downloaded.state, "downloaded");
  assert.equal(downloaded.downloadedPath, "C:\\fake-downloads\\candidate.exe");
  assert.equal(updater.disableDifferentialDownload, false);
  assert.deepEqual(calls, [
    "feed:https://cdn.j11.com.cn/desktop/beta/windows/x64",
    "native-check",
    "download",
  ]);
  assert.equal(verified.length, 1);
  assert.equal(verified[0].channel, "beta");
  assert.equal(verified[0].sha256, entry("beta", "1.1.12-beta.1").release.artifacts[0].sha256);
});

test("缓存原子写失败不丢失本轮已验证 Catalog，下载仍绑定内存中的同一候选", async () => {
  const { updater } = fakeUpdater({ version: "1.1.11", size: 18 });
  const service = new ManualUpdaterService({
    ...fakeInstallerRuntime,
    autoUpdater: updater,
    currentVersion: "1.1.10-beta.14",
    loadUpdatePolicy: enabledPolicy,
    catalogClient: {
      async fetchChannel(channel: "stable" | "beta") {
        return channel === "stable" ? entry("stable", "1.1.11") : entry("beta", "1.1.10-beta.14");
      },
    },
    updateCache: {
      read() { return null; },
      writeValidated() { throw new Error("disk full"); },
    },
    prepareInstall: async () => undefined,
    verifyDownloadedArtifact: async () => true,
  });

  await service.runAction({ action: "check" });
  const snapshot = await service.runAction({ action: "download-full", channel: "stable" });
  assert.equal(snapshot.state, "downloaded");
  assert.equal(snapshot.selectedChannel, "stable");
});

test("较高 Stable 缓存优先于较低合法网络，缓存写成功或失败都持续阻断并绑定高版本候选", async (t) => {
  for (const writeFails of [false, true]) {
    await t.test(writeFails ? "cache-write-failed" : "cache-write-succeeded", async () => {
      const verified: Array<{ channel: string; filePath: string }> = [];
      const { updater } = fakeUpdater({ version: "1.1.12", size: 18 });
      const cachedStable = entry("stable", "1.1.12");
      const service = new ManualUpdaterService({
        ...fakeInstallerRuntime,
        autoUpdater: updater,
        currentVersion: "1.1.11",
        loadUpdatePolicy: enabledPolicy,
        catalogClient: {
          async fetchChannel(channel: "stable" | "beta") {
            return channel === "stable" ? entry("stable", "1.1.11") : entry("beta", "1.1.11");
          },
        },
        updateCache: {
          read() {
            return {
              cacheVersion: 1 as const,
              currentVersion: "1.1.11",
              checkedAt: "2026-08-24T00:00:00.000Z",
              stableRequiredVersion: "1.1.12",
              stable: cachedStable,
            };
          },
          writeValidated() {
            if (writeFails) throw new Error("disk full");
            return {
              cacheVersion: 1 as const,
              currentVersion: "1.1.11",
              checkedAt: "2026-08-24T00:01:00.000Z",
              stable: entry("stable", "1.1.11"),
            };
          },
        },
        prepareInstall: async () => undefined,
        verifyDownloadedArtifact: async (candidate) => {
          verified.push({ channel: candidate.channel, filePath: candidate.filePath });
          return true;
        },
      });

      const checked = await service.runAction({ action: "check-login-stable" });
      assert.equal(checked.loginAllowed, false);
      assert.equal(checked.stableRequired, true);
      assert.equal(checked.stable.source, "cache");
      assert.equal(checked.stable.latestVersion, "1.1.12");
      assert.equal(checked.selectedChannel, "stable");
      assert.equal(checked.latestVersion, "1.1.12");

      const downloaded = await service.runAction({ action: "download-full", channel: "stable" });
      assert.equal(downloaded.state, "downloaded");
      assert.equal(downloaded.latestVersion, "1.1.12");
      assert.equal(downloaded.selectedChannel, "stable");
      assert.deepEqual(verified, [{
        channel: "stable",
        filePath: "C:\\fake-downloads\\candidate.exe",
      }]);
    });
  }
});

test("同版本 Stable 发布身份冲突时，缓存写成功或失败都保留并绑定缓存身份", async (t) => {
  for (const writeFails of [false, true]) {
    await t.test(writeFails ? "cache-write-failed" : "cache-write-succeeded", async () => {
      const cachedStable = entry("stable", "1.1.12");
      const networkStable = entry("stable", "1.1.12");
      networkStable.release.commitSha = "d".repeat(40);
      networkStable.release.artifacts[0].sha256 = sha256("network-installer-b");
      const verifiedSha256: string[] = [];
      const { updater } = fakeUpdater({ version: "1.1.12", size: 18 });
      const cacheRecord = {
        cacheVersion: 1 as const,
        currentVersion: "1.1.11",
        checkedAt: "2026-08-24T00:00:00.000Z",
        stableRequiredVersion: "1.1.12",
        stable: cachedStable,
      };
      const service = new ManualUpdaterService({
        ...fakeInstallerRuntime,
        autoUpdater: updater,
        currentVersion: "1.1.11",
        loadUpdatePolicy: enabledPolicy,
        catalogClient: {
          async fetchChannel(channel: "stable" | "beta") {
            return channel === "stable" ? networkStable : entry("beta", "1.1.11");
          },
        },
        updateCache: {
          read() { return cacheRecord; },
          writeValidated() {
            if (writeFails) throw new Error("same-version conflict");
            return cacheRecord;
          },
        },
        prepareInstall: async () => undefined,
        verifyDownloadedArtifact: async (candidate) => {
          verifiedSha256.push(candidate.sha256);
          return true;
        },
      });

      const checked = await service.runAction({ action: "check-login-stable" });
      assert.equal(checked.loginAllowed, false);
      assert.equal(checked.stable.source, "cache");
      assert.equal(checked.stable.latestVersion, "1.1.12");

      await service.runAction({ action: "download-full", channel: "stable" });
      assert.deepEqual(verifiedSha256, [cachedStable.release.artifacts[0].sha256]);
      assert.notEqual(cachedStable.release.artifacts[0].sha256, networkStable.release.artifacts[0].sha256);
    });
  }
});

test("首次读取为空但 writeValidated 返回更高有效 Stable 时仍阻断登录并绑定返回记录", async () => {
  const effectiveStable = entry("stable", "1.1.12");
  effectiveStable.release.commitSha = "e".repeat(40);
  effectiveStable.release.artifacts[0].sha256 = sha256("effective-cache-installer");
  const verifiedSha256: string[] = [];
  const { updater } = fakeUpdater({ version: "1.1.12", size: 18 });
  let reads = 0;
  const service = new ManualUpdaterService({
    ...fakeInstallerRuntime,
    autoUpdater: updater,
    currentVersion: "1.1.11",
    loadUpdatePolicy: enabledPolicy,
    catalogClient: {
      async fetchChannel(channel: "stable" | "beta") {
        return channel === "stable" ? entry("stable", "1.1.11") : entry("beta", "1.1.11");
      },
    },
    updateCache: {
      read() { reads += 1; return null; },
      writeValidated() {
        return {
          cacheVersion: 1 as const,
          currentVersion: "1.1.11",
          checkedAt: "2026-08-24T00:01:00.000Z",
          stableRequiredVersion: "1.1.12",
          stable: effectiveStable,
          beta: entry("beta", "1.1.11"),
        };
      },
    },
    prepareInstall: async () => undefined,
    verifyDownloadedArtifact: async (candidate) => {
      verifiedSha256.push(candidate.sha256);
      return true;
    },
  });

  const checked = await service.runAction({ action: "check-login-stable" });
  assert.equal(reads, 1);
  assert.equal(checked.loginAllowed, false);
  assert.equal(checked.stableRequired, true);
  assert.equal(checked.stable.source, "cache");
  assert.equal(checked.stable.latestVersion, "1.1.12");

  await service.runAction({ action: "download-full", channel: "stable" });
  assert.deepEqual(verifiedSha256, [effectiveStable.release.artifacts[0].sha256]);
});

test("Catalog 与原生 updater 版本或安装包大小不一致时拒绝下载", async (t) => {
  for (const [name, updaterOptions, expected] of [
    ["version", { version: "1.1.10", size: 18 }, /版本.*不一致/],
    ["size", { version: "1.1.11", size: 99 }, /大小.*不一致/],
  ] as const) {
    await t.test(name, async () => {
      const { updater, calls } = fakeUpdater(updaterOptions);
      const service = new ManualUpdaterService({
        ...fakeInstallerRuntime,
        autoUpdater: updater,
        currentVersion: "1.1.10-beta.14",
        loadUpdatePolicy: enabledPolicy,
        catalogClient: {
          async fetchChannel(channel: "stable" | "beta") {
            return channel === "stable" ? entry("stable", "1.1.11") : entry("beta", "1.1.10-beta.14");
          },
        },
        updateCache: memoryCache(),
        prepareInstall: async () => undefined,
        verifyDownloadedArtifact: async () => true,
      });
      await service.runAction({ action: "check" });
      await assert.rejects(
        () => service.runAction({ action: "download-full", channel: "stable" }),
        expected,
      );
      assert.equal(calls.includes("download"), false);
    });
  }
});

test("安装包 SHA 验证失败或候选不属于当前选择时拒绝安装和 show-file", async () => {
  const shown: string[] = [];
  const { updater, calls } = fakeUpdater();
  const service = new ManualUpdaterService({
    ...fakeInstallerRuntime,
    autoUpdater: updater,
    currentVersion: "1.1.10-beta.14",
    loadUpdatePolicy: enabledPolicy,
    catalogClient: {
      async fetchChannel(channel: "stable" | "beta") {
        return channel === "stable" ? entry("stable", "1.1.11") : entry("beta", "1.1.10-beta.14");
      },
    },
    updateCache: memoryCache(),
    prepareInstall: async () => undefined,
    showDownloadedFile: (filePath) => shown.push(filePath),
    verifyDownloadedArtifact: async () => false,
  });

  await service.runAction({ action: "check" });
  await assert.rejects(
    () => service.runAction({ action: "download-full", channel: "stable" }),
    /SHA|摘要|校验/,
  );
  await assert.rejects(() => service.runAction({ action: "install" }), /已验证|下载/);
  await assert.rejects(() => service.runAction({ action: "show-file" }), /已验证|显示/);
  assert.equal(calls.includes("install"), false);
  assert.deepEqual(shown, []);
});

test("新检查即使策略禁用也先清除旧候选、下载路径和进度", async () => {
  let enabled = true;
  const shown: string[] = [];
  const { updater, calls } = fakeUpdater();
  const service = new ManualUpdaterService({
    ...fakeInstallerRuntime,
    autoUpdater: updater,
    currentVersion: "1.1.10-beta.14",
    loadUpdatePolicy: async () => ({ enabled, channel: "stable", manualDownloadOnly: true as const }),
    catalogClient: {
      async fetchChannel(channel: "stable" | "beta") {
        return channel === "stable" ? entry("stable", "1.1.11") : entry("beta", "1.1.10-beta.14");
      },
    },
    updateCache: memoryCache(),
    prepareInstall: async () => undefined,
    showDownloadedFile: (filePath) => shown.push(filePath),
    verifyDownloadedArtifact: async () => true,
  });
  await service.runAction({ action: "check" });
  await service.runAction({ action: "download-full", channel: "stable" });
  enabled = false;
  await assert.rejects(() => service.runAction({ action: "check" }), /禁用/);
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.downloadedPath, undefined);
  assert.equal(snapshot.progress, undefined);
  await assert.rejects(() => service.runAction({ action: "show-file" }), /候选|显示|策略|禁用/);
  await assert.rejects(() => service.runAction({ action: "install" }), /候选|下载|策略|禁用/);
  assert.deepEqual(shown, []);
  assert.equal(calls.includes("install"), false);
});

test("策略指纹改变后 install/show-file 不能复用旧通道候选", async () => {
  let policyChannel: "stable" | "beta" = "stable";
  const shown: string[] = [];
  const { updater, calls } = fakeUpdater();
  const service = new ManualUpdaterService({
    ...fakeInstallerRuntime,
    autoUpdater: updater,
    currentVersion: "1.1.10-beta.14",
    loadUpdatePolicy: async () => ({ enabled: true, channel: policyChannel, manualDownloadOnly: true as const }),
    catalogClient: {
      async fetchChannel(channel: "stable" | "beta") {
        return channel === "stable" ? entry("stable", "1.1.11") : entry("beta", "1.1.10-beta.14");
      },
    },
    updateCache: memoryCache(),
    prepareInstall: async () => undefined,
    showDownloadedFile: (filePath) => shown.push(filePath),
    verifyDownloadedArtifact: async () => true,
  });
  await service.runAction({ action: "check" });
  await service.runAction({ action: "download-full", channel: "stable" });
  policyChannel = "beta";
  await assert.rejects(() => service.runAction({ action: "show-file" }), /策略|候选|配置/);
  await assert.rejects(() => service.runAction({ action: "install" }), /策略|候选|配置/);
  assert.deepEqual(shown, []);
  assert.equal(calls.includes("install"), false);
});

test("下载监听器绑定操作 phase，旧 error 不污染安全 launcher 安装结果且完成后清理", async () => {
  const emitter = new EventEmitter();
  const { updater, calls } = fakeUpdater();
  (updater as any).on = emitter.on.bind(emitter);
  (updater as any).removeListener = emitter.removeListener.bind(emitter);
  const launchedPaths: string[] = [];
  let quitCalls = 0;
  const service = new ManualUpdaterService({
    autoUpdater: updater,
    currentVersion: "1.1.10-beta.14",
    loadUpdatePolicy: enabledPolicy,
    catalogClient: {
      async fetchChannel(channel: "stable" | "beta") {
        return channel === "stable" ? entry("stable", "1.1.11") : entry("beta", "1.1.10-beta.14");
      },
    },
    updateCache: memoryCache(),
    prepareInstall: async () => { emitter.emit("error", new Error("旧下载延迟 error")); },
    verifyDownloadedArtifact: async () => true,
    launchVerifiedInstaller: async (filePath: string) => { launchedPaths.push(filePath); },
    finalizeInstallShutdown: async () => undefined,
    scheduleApplicationQuit: () => { quitCalls += 1; },
  } as any);
  await service.runAction({ action: "check" });
  await service.runAction({ action: "download-full", channel: "stable" });
  assert.equal(emitter.listenerCount("download-progress"), 0);
  const installed = await service.runAction({ action: "install" });
  assert.equal(installed.state, "installing");
  assert.equal(installed.errorMessage, undefined);
  assert.deepEqual(launchedPaths, ["C:\\fake-downloads\\candidate.exe"]);
  assert.equal(quitCalls, 1);
  assert.equal(calls.includes("install"), false);
  assert.equal(emitter.listenerCount("download-progress"), 0);
});

test("安全 launcher 抛错时 install 拒绝、状态可见且绝不退出或调用 quitAndInstall", async () => {
  const { updater, calls, emitter } = eventUpdater();
  let quitCalls = 0;
  const service = installReadyService(updater, async () => undefined, {
    launchVerifiedInstaller: async () => { throw new Error("安装器启动失败"); },
    scheduleApplicationQuit: () => { quitCalls += 1; },
  });
  await downloadStableCandidate(service);
  await assert.rejects(() => service.runAction({ action: "install" }), /安装器启动失败/);
  assert.equal(calls.filter((call) => call === "install").length, 0);
  assert.equal(quitCalls, 0);
  assert.equal(service.getSnapshot().state, "error");
  assert.match(service.getSnapshot().errorMessage ?? "", /安装器启动失败/);
  assert.equal(emitter.listenerCount("error"), 1);
});

test("launcher 成功后才调度退出，并只接收内部验证候选路径", async () => {
  const { updater, calls } = eventUpdater();
  const launchedPaths: string[] = [];
  let quitCalls = 0;
  const service = installReadyService(updater, async () => undefined, {
    launchVerifiedInstaller: async (filePath) => { launchedPaths.push(filePath); },
    scheduleApplicationQuit: () => { quitCalls += 1; },
  });
  await downloadStableCandidate(service);
  const returned = await service.runAction({ action: "install" });
  assert.equal(returned.state, "installing");
  assert.deepEqual(launchedPaths, ["C:\\fake-downloads\\candidate.exe"]);
  assert.equal(quitCalls, 1);
  assert.equal(calls.filter((call) => call === "install").length, 0);
});

test("安装请求必须先关闭运行时并保护数据，launcher 失败时恢复应用且绝不退出", async (t) => {
  for (const mode of ["verify-false", "open-path-error", "open-path-throw", "accepted"] as const) {
    await t.test(mode, async () => {
      const runtime = eventUpdater();
      const events: string[] = [];
      let verifyCalls = 0;
      const service = installReadyService(runtime.updater, async () => {
        events.push("data-protection");
      }, {
        verifyDownloadedArtifact: async () => {
          verifyCalls += 1;
          events.push(verifyCalls === 1 ? "download-verify" : "install-verify");
          return mode !== "verify-false" || verifyCalls === 1;
        },
        launchVerifiedInstaller: async (filePath) => {
          events.push(`open-path:${filePath}`);
          await desktopUpdaterModule.launchVerifiedInstallerWithShell(filePath, async () => {
            if (mode === "open-path-throw") throw new Error("shell 抛错");
            return mode === "open-path-error" ? "系统拒绝" : "";
          });
        },
        finalizeInstallShutdown: async () => { events.push("irreversible-shutdown"); },
        recoverAfterInstallerLaunchFailure: async () => { events.push("recover-application"); },
        scheduleApplicationQuit: () => { events.push("quit"); },
      });
      await downloadStableCandidate(service);

      if (mode === "accepted") {
        const installed = await service.runAction({ action: "install" });
        assert.equal(installed.state, "installing");
        assert.deepEqual(events, [
          "download-verify",
          "install-verify",
          "irreversible-shutdown",
          "data-protection",
          "open-path:C:\\fake-downloads\\candidate.exe",
          "quit",
        ]);
      } else {
        await assert.rejects(() => service.runAction({ action: "install" }), /校验|验证|拒绝|抛错|启动失败/);
        if (mode === "verify-false") {
          assert.equal(events.includes("irreversible-shutdown"), false);
          assert.equal(events.includes("recover-application"), false);
        } else {
          assert.equal(events.includes("irreversible-shutdown"), true);
          assert.equal(events.at(-1), "recover-application");
        }
        assert.equal(events.includes("quit"), false);
        assert.equal(service.getSnapshot().state, "error");
      }
    });
  }
});

test("下载验证后文件被替换时，install 二次校验失败并禁止 launcher 与退出", async () => {
  const runtime = eventUpdater();
  let artifactBytes = "valid";
  const verified: Array<{ filePath: string; channel: string; size: number; sha256: string }> = [];
  let launchCalls = 0;
  let quitCalls = 0;
  const service = installReadyService(runtime.updater, async () => undefined, {
    verifyDownloadedArtifact: async (candidate) => {
      verified.push({ ...candidate });
      return artifactBytes === "valid";
    },
    launchVerifiedInstaller: async () => { launchCalls += 1; },
    scheduleApplicationQuit: () => { quitCalls += 1; },
  });
  await downloadStableCandidate(service);
  artifactBytes = "replaced";

  await assert.rejects(() => service.runAction({ action: "install" }), /SHA|大小|校验|验证/);
  assert.equal(verified.length, 2);
  assert.deepEqual(verified[1], verified[0]);
  assert.equal(launchCalls, 0);
  assert.equal(quitCalls, 0);
  assert.equal(service.getSnapshot().state, "error");
});

test("install 二次验证抛错时 fail-closed，且不会启动安装器", async () => {
  const runtime = eventUpdater();
  let verifyCalls = 0;
  let launchCalls = 0;
  let quitCalls = 0;
  const service = installReadyService(runtime.updater, async () => undefined, {
    verifyDownloadedArtifact: async () => {
      verifyCalls += 1;
      if (verifyCalls === 2) throw new Error("二次验证读取失败");
      return true;
    },
    launchVerifiedInstaller: async () => { launchCalls += 1; },
    scheduleApplicationQuit: () => { quitCalls += 1; },
  });
  await downloadStableCandidate(service);

  await assert.rejects(() => service.runAction({ action: "install" }), /二次验证读取失败/);
  assert.equal(verifyCalls, 2);
  assert.equal(launchCalls, 0);
  assert.equal(quitCalls, 0);
  assert.equal(service.getSnapshot().state, "error");
});

test("launcher 路径与紧邻二次验证的 channel/version 候选完全一致", async () => {
  const runtime = eventUpdater();
  const verified: Array<{ filePath: string; channel: string; size: number; sha256: string }> = [];
  const launchedPaths: string[] = [];
  const service = installReadyService(runtime.updater, async () => undefined, {
    verifyDownloadedArtifact: async (candidate) => {
      verified.push({ ...candidate });
      return true;
    },
    launchVerifiedInstaller: async (filePath) => { launchedPaths.push(filePath); },
  });
  await downloadStableCandidate(service);
  const installed = await service.runAction({ action: "install" });

  assert.equal(verified.length, 2);
  assert.deepEqual(verified[1], verified[0]);
  assert.equal(launchedPaths[0], verified[1].filePath);
  assert.equal(verified[1].channel, "stable");
  assert.equal(installed.selectedChannel, verified[1].channel);
  assert.equal(installed.latestVersion, "1.1.11");
});

test("旧 updater 延迟 error 不会改变 launcher 安装结果或成为 uncaught", async () => {
  const runtime = eventUpdater();
  let stateDuringPrepare = "";
  let quitCalls = 0;
  const service = installReadyService(
    runtime.updater,
    async () => {
      stateDuringPrepare = service.getSnapshot().state;
      runtime.emitter.emit("error", new Error("旧下载延迟 error"));
    },
    {
      launchVerifiedInstaller: async () => undefined,
      scheduleApplicationQuit: () => { quitCalls += 1; },
    },
  );
  await downloadStableCandidate(service);
  const installed = await service.runAction({ action: "install" });
  runtime.emitter.emit("error", new Error("安装启动后的旧 updater error"));
  assert.equal(stateDuringPrepare, "downloaded");
  assert.equal(installed.state, "installing");
  assert.equal(service.getSnapshot().state, "installing");
  assert.equal(installed.errorMessage, undefined);
  assert.equal(runtime.calls.filter((call) => call === "install").length, 0);
  assert.equal(quitCalls, 1);
  assert.equal(runtime.emitter.listenerCount("error"), 1);
});

test("主进程 shell.openPath 必须被 await，非空 Electron 错误与异常均 fail-closed", async () => {
  const launchWithShell = (desktopUpdaterModule as any).launchVerifiedInstallerWithShell as
    ((filePath: string, openPath: (filePath: string) => Promise<string>) => Promise<void>);
  let resolveOpen!: (value: string) => void;
  let settled = false;
  const accepted = launchWithShell(
    "C:\\fake-downloads\\candidate.exe",
    async () => new Promise<string>((resolve) => { resolveOpen = resolve; }),
  ).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  resolveOpen("");
  await accepted;
  assert.equal(settled, true);

  await assert.rejects(
    () => launchWithShell("C:\\fake-downloads\\candidate.exe", async () => "被系统拒绝"),
    /被系统拒绝|启动失败/,
  );
  await assert.rejects(
    () => launchWithShell("C:\\fake-downloads\\candidate.exe", async () => { throw new Error("shell error"); }),
    /shell error/,
  );
});

test("连续检查和下载不会增长 updater listener 数量", async () => {
  const runtime = eventUpdater();
  const service = installReadyService(runtime.updater);
  assert.equal(runtime.emitter.listenerCount("error"), 1);
  for (let round = 0; round < 3; round += 1) {
    await downloadStableCandidate(service);
    assert.equal(runtime.emitter.listenerCount("error"), 1);
    assert.equal(runtime.emitter.listenerCount("download-progress"), 0);
  }
});

test("并发检查共享单飞请求，旧调用不能覆盖同一轮的新快照", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = new ManualUpdaterService({
    ...fakeInstallerRuntime,
    autoUpdater: fakeUpdater().updater,
    currentVersion: "1.1.11",
    loadUpdatePolicy: enabledPolicy,
    catalogClient: {
      async fetchChannel(channel: "stable" | "beta") {
        calls += 1;
        await gate;
        return channel === "stable" ? entry("stable", "1.1.11") : entry("beta", "1.1.12-beta.1");
      },
    },
    updateCache: memoryCache(),
    prepareInstall: async () => undefined,
    verifyDownloadedArtifact: async () => true,
  });

  const first = service.runAction({ action: "check" });
  const second = service.runAction({ action: "check-login-stable" });
  await Promise.resolve();
  assert.equal(calls, 2);
  release();
  const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
  assert.deepEqual(secondSnapshot, firstSnapshot);
  assert.equal(service.getSnapshot().beta.latestVersion, "1.1.12-beta.1");
});

test("显式失效创建新 epoch，旧检查延迟完成不能覆盖新检查", async () => {
  let round = 0;
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  const service = new ManualUpdaterService({
    ...fakeInstallerRuntime,
    autoUpdater: fakeUpdater().updater,
    currentVersion: "1.1.11",
    loadUpdatePolicy: enabledPolicy,
    catalogClient: {
      async fetchChannel(channel: "stable" | "beta") {
        const currentRound = round;
        if (currentRound === 0) await oldGate;
        const version = currentRound === 0 ? "1.1.12-beta.1" : "1.1.13-beta.1";
        return channel === "stable" ? entry("stable", "1.1.11") : entry("beta", version);
      },
    },
    updateCache: memoryCache(),
    prepareInstall: async () => undefined,
    verifyDownloadedArtifact: async () => true,
  });
  const oldCheck = service.runAction({ action: "check" });
  await Promise.resolve();
  round = 1;
  (service as any).invalidate("config-change");
  const fresh = await service.runAction({ action: "check" });
  assert.equal(fresh.beta.latestVersion, "1.1.13-beta.1");
  releaseOld();
  await oldCheck;
  assert.equal(service.getSnapshot().beta.latestVersion, "1.1.13-beta.1");
});
