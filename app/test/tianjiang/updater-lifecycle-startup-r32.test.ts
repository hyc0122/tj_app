import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";

import { CancellationError, type CancellationToken } from "builder-util-runtime";
import express from "express";

import { ManualUpdaterService } from "../../scripts/manual-updater";
import { classifyStartupError } from "../../scripts/runtime-startup";
import { ShutdownGate } from "../../src/tianjiang/runtime/shutdown-gate";
import downloadAppRouter, {
  bindManualDownloadUpdater,
} from "../../src/routes/setting/about/downloadApp";
import {
  isRetryableSQLiteStartupError,
  runWithSQLiteStartupRetry,
} from "../../src/utils/sqlite-connection";
import type { PlatformReleaseEntry } from "../../src/tianjiang/update/platform-release-catalog";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function releaseEntry(version = "1.1.14"): PlatformReleaseEntry {
  const installerName = `tianjiang-${version}-win-x64-setup.exe`;
  return {
    latest: {
      schemaVersion: 2,
      channel: "stable",
      platform: "windows",
      arch: "x64",
      version,
      release: `desktop/stable/windows/x64/catalog/releases/${version}/release.json`,
    },
    release: {
      schemaVersion: 2,
      channel: "stable",
      sourceChannel: "stable",
      platform: "windows",
      arch: "x64",
      version,
      tag: `v${version}`,
      commitSha: "a".repeat(40),
      nativeMetadata: "desktop/stable/windows/x64/latest.yml",
      artifacts: [
        {
          path: `desktop/stable/windows/x64/${installerName}`,
          fileName: installerName,
          kind: "installer",
          size: 3,
          sha256: sha256("abc"),
        },
      ],
    },
  };
}

function updaterDeps(options: {
  download?: (token?: CancellationToken) => Promise<string[]>;
  check?: () => Promise<unknown>;
  events?: EventEmitter;
  order?: string[];
  prepareInstallShutdown?: () => Promise<void>;
  shutdownCancelTimeoutMs?: number;
} = {}) {
  const events = options.events ?? new EventEmitter();
  const order = options.order ?? [];
  const entry = releaseEntry();
  return {
    autoUpdater: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      disableDifferentialDownload: false,
      setFeedURL() {},
      async checkForUpdates() {
        if (options.check) return options.check();
        return { updateInfo: { version: "1.1.14", files: [{ size: 3 }] } };
      },
      downloadUpdate: options.download ?? (async () => ["C:\\fake\\candidate.exe"]),
      on: events.on.bind(events),
      removeListener: events.removeListener.bind(events),
    },
    currentVersion: "1.1.13",
    loadUpdatePolicy: async () => ({
      enabled: true,
      channel: "stable" as const,
      manualDownloadOnly: true as const,
    }),
    catalogClient: {
      async fetchChannel(channel: "stable" | "beta") {
        if (channel === "stable") return entry;
        throw new Error("测试不提供 Beta");
      },
    },
    updateCache: {
      read: () => null,
      writeValidated: () => ({
        cacheVersion: 1 as const,
        currentVersion: "1.1.13",
        checkedAt: "2026-08-25T00:00:00.000Z",
        stable: entry,
      }),
    },
    verifyDownloadedArtifact: async () => true,
    prepareInstall: async () => { order.push("protect"); },
    ...(options.prepareInstallShutdown
      ? { prepareInstallShutdown: options.prepareInstallShutdown }
      : {}),
    finalizeInstallShutdown: async () => { order.push("close"); },
    launchVerifiedInstaller: async () => { order.push("launch"); },
    scheduleApplicationQuit: () => { order.push("quit"); },
    shutdownCancelTimeoutMs: options.shutdownCancelTimeoutMs,
  };
}

test("更新下载必须后台受理、持续暴露字节进度，并允许退出前取消", async () => {
  const events = new EventEmitter();
  let capturedToken: CancellationToken | undefined;
  const service = new ManualUpdaterService(updaterDeps({
    events,
    download: async (token) => {
      capturedToken = token;
      if (!token) throw new Error("下载必须携带取消令牌");
      return token.createPromise<string[]>((_resolve, reject, onCancel) => {
        onCancel(() => reject(new CancellationError()));
      });
    },
  }));

  await service.runAction({ action: "check" });
  const accepted = await (service as any).startAction({
    action: "download-full",
    channel: "stable",
  });
  assert.equal(accepted.state, "downloading");
  assert.equal(service.getSnapshot().state, "downloading");

  await new Promise<void>((resolve) => setImmediate(resolve));
  events.emit("download-progress", {
    percent: 25,
    transferred: 256,
    total: 1024,
    bytesPerSecond: 128,
  });
  assert.deepEqual(
    {
      progress: service.getSnapshot().progress,
      transferredBytes: (service.getSnapshot() as any).transferredBytes,
      totalBytes: (service.getSnapshot() as any).totalBytes,
      bytesPerSecond: (service.getSnapshot() as any).bytesPerSecond,
    },
    { progress: 25, transferredBytes: 256, totalBytes: 1024, bytesPerSecond: 128 },
  );

  const cancelled = await service.runAction({ action: "cancel-download" } as any);
  assert.equal(capturedToken?.cancelled, true);
  assert.equal(cancelled.state, "available");
  assert.equal(service.getSnapshot().state, "available");
});

test("下载 HTTP 入口必须立即 202，GET 状态不得等待后台下载结束", async () => {
  let releaseDownload!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseDownload = resolve; });
  const snapshot = {
    state: "downloading",
    currentVersion: "1.1.13",
    stable: { status: "available", source: "network", required: true, downloadAllowed: true },
    beta: { status: "idle", source: "none", required: false, downloadAllowed: false },
    stableRequired: true,
    loginAllowed: false,
    selectedChannel: "stable",
    progress: 0,
  };
  const acceptedActions: string[] = [];
  bindManualDownloadUpdater({
    getSnapshot: () => snapshot,
    startAction: async (body: { action: string }) => {
      acceptedActions.push(body.action);
      return body.action === "install" ? { ...snapshot, state: "preparing_install" } : snapshot;
    },
    runAction: async () => {
      await blocked;
      return snapshot;
    },
  } as any);
  const app = express();
  app.use(express.json());
  app.use("/download", downloadAppRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务监听失败");
  const url = `http://127.0.0.1:${address.port}/download`;

  try {
    const post = fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "download-full", channel: "stable" }),
    });
    const first = await Promise.race([
      post,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);
    assert.notEqual(first, "timeout", "下载受理请求不得等待完整安装包下载");
    assert.equal((first as Response).status, 202);

    const status = await fetch(url);
    assert.equal(status.status, 200);
    const payload = await status.json() as { data?: { state?: string } };
    assert.equal(payload.data?.state, "downloading");

    const install = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "install" }),
    });
    assert.equal(install.status, 202);
    const installPayload = await install.json() as { data?: { state?: string } };
    assert.equal(installPayload.data?.state, "preparing_install");
    assert.deepEqual(acceptedActions, ["download-full", "install"]);
  } finally {
    releaseDownload();
    bindManualDownloadUpdater(null);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("安装 HTTP 入口必须先返回 202 preparing_install，再进入关闭流程", async () => {
  let closeStarted = false;
  let releaseClose!: () => void;
  const closeBlocked = new Promise<void>((resolve) => { releaseClose = resolve; });
  const service = new ManualUpdaterService(updaterDeps({
    prepareInstallShutdown: async () => {
      closeStarted = true;
      await closeBlocked;
    },
  }));
  await service.runAction({ action: "check" });
  await service.runAction({ action: "download-full", channel: "stable" });

  const accepted = await service.startAction({ action: "install" });
  assert.equal(accepted.state, "preparing_install");
  assert.equal(closeStarted, false, "受理响应产生前不得进入运行时关闭");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeStarted, true);
  releaseClose();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("安装受理后若普通退出先完成，必须拒绝跳过数据保护并禁止 launcher", async () => {
  const order: string[] = [];
  const gate = new ShutdownGate({
    closeRuntime: async () => { order.push("runtime:closed"); },
    relaunch: () => { order.push("app:relaunch"); },
    quit: () => { order.push("app:quit"); },
    onFailure: async () => { order.push("failure"); },
  });
  const service = new ManualUpdaterService(updaterDeps({
    order,
    prepareInstallShutdown: () => gate.prepareForInstaller(async () => {
      order.push("backup:verified");
    }),
  }));
  await service.runAction({ action: "check" });
  await service.runAction({ action: "download-full", channel: "stable" });

  const accepted = await service.startAction({ action: "install" });
  assert.equal(accepted.state, "preparing_install");
  await gate.request(false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(service.getSnapshot().state, "error");
  assert.equal(order.includes("backup:verified"), false);
  assert.equal(order.includes("launch"), false);
});

test("退出取消在原生 metadata 检查阶段也必须自然结束", async () => {
  const service = new ManualUpdaterService(updaterDeps({
    check: () => new Promise<never>(() => undefined),
  }));
  await service.runAction({ action: "check" });
  await service.startAction({ action: "download-full", channel: "stable" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await service.prepareForApplicationShutdown();
  assert.equal(service.getSnapshot().state, "available");
});

test("取消 metadata 后必须等待底层检查排空，禁止立即创建下一次 feed 操作", async () => {
  let releaseStableMetadata!: (value: unknown) => void;
  const stableMetadata = new Promise<unknown>((resolve) => { releaseStableMetadata = resolve; });
  let metadataCalls = 0;
  const service = new ManualUpdaterService(updaterDeps({
    check: async () => {
      metadataCalls += 1;
      if (metadataCalls === 1) return stableMetadata;
      return { updateInfo: { version: "1.1.14", files: [{ size: 3 }] } };
    },
  }));
  await service.runAction({ action: "check" });
  await service.startAction({ action: "download-full", channel: "stable" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await service.runAction({ action: "cancel-download" });

  await assert.rejects(
    () => service.startAction({ action: "download-full", channel: "stable" }),
    /上一次.*metadata|原生.*检查.*结束|更新检查.*排空/i,
  );
  assert.equal(metadataCalls, 1);

  releaseStableMetadata({ updateInfo: { version: "1.1.14", files: [{ size: 3 }] } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const accepted = await service.startAction({ action: "download-full", channel: "stable" });
  assert.equal(accepted.state, "downloading");
});

test("下载忽略取消并超过退出看门狗时必须失败关闭", async () => {
  let releaseDownload!: () => void;
  const service = new ManualUpdaterService(updaterDeps({
    shutdownCancelTimeoutMs: 10,
    download: async () => new Promise<string[]>((resolve) => {
      releaseDownload = () => resolve(["C:\\fake\\candidate.exe"]);
    }),
  }));
  await service.runAction({ action: "check" });
  await service.startAction({ action: "download-full", channel: "stable" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => service.prepareForApplicationShutdown(),
    /未能及时取消/,
  );
  assert.equal(service.getSnapshot().state, "error");
  releaseDownload();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("安装器只能在 SQLite 等本地运行时关闭并完成保护后启动", async () => {
  const order: string[] = [];
  const service = new ManualUpdaterService(updaterDeps({ order }));
  await service.runAction({ action: "check" });
  await service.runAction({ action: "download-full", channel: "stable" });
  await service.runAction({ action: "install" });
  assert.deepEqual(order, ["close", "protect", "launch", "quit"]);
});

test("普通 disk I/O error 只做有限重试，并显示数据库读写诊断", async () => {
  const ioError = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
  assert.equal(isRetryableSQLiteStartupError(ioError), true);
  let attempts = 0;
  const delays: number[] = [];
  const result = await runWithSQLiteStartupRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw ioError;
      return "ready";
    },
    async (delayMs) => { delays.push(delayMs); },
  );
  assert.equal(result, "ready");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [50, 150]);

  const ioClassified = classifyStartupError(ioError);
  assert.equal(ioClassified.code, "LOCAL_DATABASE_IO_FAILED");
  assert.match(ioClassified.message, /数据库.*读写/);

  const busyClassified = classifyStartupError(
    Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
  );
  assert.equal(busyClassified.code, "LOCAL_DATABASE_BUSY");
  assert.match(busyClassified.message, /关闭重复运行的客户端/);
});
