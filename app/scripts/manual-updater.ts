/**
 * 完全由用户触发的 electron-updater 封装。
 * autoDownload=false、autoInstallOnAppQuit=false；禁止 ZIP 覆盖用户数据。
 */
import { compareDesktopVersions } from "./platform-release-contract.mjs";
import {
  parseManualUpdateActionBody,
  type ManualUpdateActionBody,
  type ManualUpdateSnapshot,
  type UpdateChannel,
} from "../src/tianjiang/update/manual-update-contracts";
import type {
  PlatformReleaseEntry,
  PlatformUpdateChannel,
} from "../src/tianjiang/update/platform-release-catalog";
import {
  samePlatformReleaseIdentity,
  type PlatformUpdateCacheRecord,
} from "../src/tianjiang/update/platform-update-cache";
import {
  resolveWindowsX64UpdateFeed,
  type DesktopUpdatePolicy,
} from "../src/tianjiang/update/update-policy";

export interface ManualUpdaterDeps {
  autoUpdater: {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    disableDifferentialDownload: boolean;
    allowDowngrade?: boolean;
    setFeedURL(options: { provider: "generic"; url: string }): void;
    checkForUpdates(): Promise<unknown>;
    downloadUpdate(): Promise<unknown>;
    on(event: string, listener: (...args: any[]) => void): void;
    removeListener?(event: string, listener: (...args: any[]) => void): void;
  };
  currentVersion: string;
  loadUpdatePolicy: () => Promise<DesktopUpdatePolicy>;
  catalogClient: {
    fetchChannel(channel: PlatformUpdateChannel): Promise<PlatformReleaseEntry>;
  };
  updateCache: {
    read(currentVersion: string): PlatformUpdateCacheRecord | null;
    writeValidated(
      currentVersion: string,
      updates: Partial<Record<PlatformUpdateChannel, PlatformReleaseEntry>>,
    ): PlatformUpdateCacheRecord;
  };
  verifyDownloadedArtifact(candidate: {
    filePath: string;
    channel: PlatformUpdateChannel;
    size: number;
    sha256: string;
  }): Promise<boolean>;
  prepareInstall: () => Promise<void>;
  launchVerifiedInstaller: (filePath: string) => Promise<void>;
  finalizeInstallShutdown: () => Promise<void>;
  scheduleApplicationQuit: () => void;
  showDownloadedFile?: (filePath: string) => void;
}

export interface ManualUpdateService {
  getSnapshot(): ManualUpdateSnapshot;
  runAction(body: ManualUpdateActionBody): Promise<ManualUpdateSnapshot>;
}

/** 非 Windows x64 明确返回不支持，且不会接触 Catalog 或原生 updater。 */
export class UnsupportedManualUpdaterService implements ManualUpdateService {
  private readonly snapshot: ManualUpdateSnapshot;

  constructor(currentVersion: string, platform: string, arch: string) {
    const unsupported = {
      status: "unsupported" as const,
      source: "none" as const,
      required: false,
      downloadAllowed: false,
      errorCode: "PLATFORM_UNSUPPORTED",
    };
    this.snapshot = {
      state: "unsupported",
      currentVersion,
      stable: unsupported,
      beta: { ...unsupported },
      stableRequired: false,
      loginAllowed: true,
      selectedChannel: null,
      warningMessage: `当前平台 ${platform}/${arch} 不支持 Windows x64 桌面更新`,
    };
  }

  getSnapshot(): ManualUpdateSnapshot {
    return { ...this.snapshot, stable: { ...this.snapshot.stable }, beta: { ...this.snapshot.beta } };
  }

  async runAction(rawBody: ManualUpdateActionBody): Promise<ManualUpdateSnapshot> {
    const body = parseManualUpdateActionBody(rawBody);
    if (body.action !== "check" && body.action !== "check-login-stable") {
      throw new Error("当前平台不支持 Windows x64 桌面更新动作");
    }
    return this.getSnapshot();
  }
}

export class ManualUpdaterService {
  private snapshot: ManualUpdateSnapshot;
  private downloadedCandidate: {
    filePath: string;
    channel: UpdateChannel;
    version: string;
    size: number;
    sha256: string;
    checkEpoch: number;
    candidateEpoch: number;
    policyFingerprint: string;
  } | null = null;
  private actionInFlight = false;
  private checkInFlight: Promise<ManualUpdateSnapshot> | null = null;
  private checkEpoch = 0;
  private candidateEpoch = 0;
  private operationEpoch = 0;
  private activeOperation: { epoch: number; phase: "download" | "install" | "show-file" } | null = null;
  private checkedPolicyFingerprint: string | null = null;
  private validatedEntries: Partial<Record<PlatformUpdateChannel, PlatformReleaseEntry>> = {};
  private readonly updaterErrorListener = (_error: unknown) => undefined;

  constructor(private readonly deps: ManualUpdaterDeps) {
    this.deps.autoUpdater.autoDownload = false;
    this.deps.autoUpdater.autoInstallOnAppQuit = false;
    // 中文注释：底层事件没有 request id；常驻单监听器只负责防止旧 check/download error 无人接收，绝不改写安装状态。
    this.deps.autoUpdater.on("error", this.updaterErrorListener);
    this.snapshot = {
      state: "idle",
      currentVersion: deps.currentVersion,
      stable: this.emptyChannelSnapshot(),
      beta: this.emptyChannelSnapshot(),
      stableRequired: false,
      loginAllowed: true,
      selectedChannel: null,
    };
  }

  getSnapshot(): ManualUpdateSnapshot {
    return { ...this.snapshot };
  }

  runAction(rawBody: ManualUpdateActionBody): Promise<ManualUpdateSnapshot> {
    const body = parseManualUpdateActionBody(rawBody);
    if (this.snapshot.state === "installing") {
      // 中文注释：系统已受理安装器后保持终态，禁止退出前的新动作清空候选或覆盖状态。
      return Promise.reject(new Error("安装程序已启动，不能开始新的更新操作"));
    }
    if (body.action === "check" || body.action === "check-login-stable") {
      // 中文注释：启动、登录和设置页共享同一个检查 Promise，避免重复请求和旧请求回写。
      if (this.checkInFlight) return this.checkInFlight;
      if (this.actionInFlight) return Promise.reject(new Error("已有更新操作正在进行"));
      const epoch = this.beginCheck();
      const operation = this.performCheck(epoch).finally(() => {
        if (this.checkInFlight === operation) this.checkInFlight = null;
      });
      this.checkInFlight = operation;
      return operation;
    }
    if (this.actionInFlight || this.checkInFlight) {
      return Promise.reject(new Error("已有更新操作正在进行"));
    }
    try {
      this.assertActionAllowed(body);
    } catch (error) {
      return Promise.reject(error);
    }
    this.actionInFlight = true;
    return this.performAction(body).finally(() => {
      this.actionInFlight = false;
    });
  }

  /** 配置切换或显式刷新使旧检查和旧候选立即失效，延迟结果只能读取新状态。 */
  invalidate(_reason: "config-change" | "refresh" | string = "refresh"): void {
    this.checkEpoch += 1;
    this.candidateEpoch += 1;
    this.operationEpoch += 1;
    this.checkInFlight = null;
    this.activeOperation = null;
    this.checkedPolicyFingerprint = null;
    this.validatedEntries = {};
    this.clearDownloadedCandidate();
  }

  private async performAction(body: Exclude<ManualUpdateActionBody, { action: "check" | "check-login-stable" }>): Promise<ManualUpdateSnapshot> {
    const phase = body.action.startsWith("download-")
      ? "download"
      : body.action === "install" ? "install" : "show-file";
    const operation = { epoch: ++this.operationEpoch, phase } as const;
    this.activeOperation = operation;
    try {
      await this.withUpdaterPhase(operation, async () => {
        const policy = await this.deps.loadUpdatePolicy();
        this.assertOperationCurrent(operation);
        const fingerprint = this.policyFingerprint(policy);
        if (!policy.enabled) {
          this.clearDownloadedCandidate();
          throw new Error("客户端更新策略已禁用");
        }
        if (this.checkedPolicyFingerprint !== fingerprint) {
          this.clearDownloadedCandidate();
          throw new Error("更新策略或配置已变更，请重新检查");
        }
        switch (body.action) {
          case "download-differential":
          case "download-full":
            await this.download(body.channel, body.action === "download-full", fingerprint, operation);
            break;
          case "install":
            this.assertCandidateForPolicy(fingerprint);
            await this.deps.prepareInstall();
            this.assertOperationCurrent(operation);
            this.assertCandidateForPolicy(fingerprint);
            const candidate = this.downloadedCandidate!;
            const installVerified = await this.deps.verifyDownloadedArtifact({
              filePath: candidate.filePath,
              channel: candidate.channel,
              size: candidate.size,
              sha256: candidate.sha256,
            });
            this.assertOperationCurrent(operation);
            this.assertCandidateForPolicy(fingerprint);
            if (!installVerified) {
              this.clearDownloadedCandidate();
              throw new Error("安装前安装包 SHA-256 摘要或大小二次校验失败");
            }
            // 中文注释：路径式二次校验仅缩小替换窗口，无法消除校验到 shell.openPath 间的同用户竞态，也不伪称句柄绑定启动。
            const installerPath = candidate.filePath;
            await this.deps.launchVerifiedInstaller(installerPath);
            this.assertOperationCurrent(operation);
            // 中文注释：只有 OS 已受理安装器后，才允许进入不可逆的服务关闭阶段。
            await this.deps.finalizeInstallShutdown();
            this.assertOperationCurrent(operation);
            this.snapshot = { ...this.snapshot, state: "installing", errorMessage: undefined };
            // launcher 成功只表示操作系统已受理启动安装包；此后才允许主进程受控安排退出。
            this.deps.scheduleApplicationQuit();
            break;
          case "show-file":
            this.assertCandidateForPolicy(fingerprint);
            if (this.downloadedCandidate && this.deps.showDownloadedFile) {
              this.deps.showDownloadedFile(this.downloadedCandidate.filePath);
            }
            break;
          default:
            break;
        }
      });
    } catch (error) {
      if (this.activeOperation === operation) {
        this.snapshot = {
          ...this.snapshot,
          state: "error",
          errorMessage: error instanceof Error ? error.message : "更新失败",
        };
      }
      throw error;
    } finally {
      if (this.activeOperation === operation) this.activeOperation = null;
    }
    return this.getSnapshot();
  }

  private async performCheck(epoch: number): Promise<ManualUpdateSnapshot> {
    let policy: DesktopUpdatePolicy;
    try {
      policy = await this.deps.loadUpdatePolicy();
      if (epoch !== this.checkEpoch) return this.getSnapshot();
      if (!policy.enabled) throw new Error("客户端更新策略已禁用");
    } catch (error) {
      if (epoch === this.checkEpoch) {
        this.snapshot = {
          ...this.snapshot,
          state: "error",
          errorMessage: error instanceof Error ? error.message : "更新策略读取失败",
        };
      }
      throw error;
    }
    this.checkedPolicyFingerprint = this.policyFingerprint(policy);
    const cached = this.deps.updateCache.read(this.deps.currentVersion);
    const [stableResult, betaResult] = await Promise.allSettled([
      this.deps.catalogClient.fetchChannel("stable"),
      this.deps.catalogClient.fetchChannel("beta"),
    ]);
    if (epoch !== this.checkEpoch) return this.getSnapshot();
    const updates: Partial<Record<PlatformUpdateChannel, PlatformReleaseEntry>> = {};
    if (stableResult.status === "fulfilled") updates.stable = stableResult.value;
    if (betaResult.status === "fulfilled") updates.beta = betaResult.value;
    let writtenCache: PlatformUpdateCacheRecord | null = null;
    if (updates.stable || updates.beta) {
      try {
        writtenCache = this.deps.updateCache.writeValidated(this.deps.currentVersion, updates);
      } catch {
        // 缓存写失败不改变本轮已验证网络真值，也绝不能回写半条记录。
      }
    }
    const networkStable = stableResult.status === "fulfilled" ? stableResult.value : undefined;
    const cachedStable = this.preferredCachedStable(cached?.stable, writtenCache?.stable);
    // 中文注释：成功写入时采用 writeValidated 返回的并发有效记录；失败时仍保留检查前缓存。
    const stableUsesCache = Boolean(
      cachedStable
      && (
        !networkStable
        || compareDesktopVersions(cachedStable.latest.version, networkStable.latest.version) > 0
        || (
          compareDesktopVersions(cachedStable.latest.version, networkStable.latest.version) === 0
          && !samePlatformReleaseIdentity(cachedStable, networkStable)
        )
      ),
    );
    const stableEntry = stableUsesCache ? cachedStable : networkStable ?? cachedStable;
    const betaEntry = betaResult.status === "fulfilled"
      ? betaResult.value
      : writtenCache?.beta ?? cached?.beta;
    // 中文注释：下载绑定本轮网络或离线缓存的已验证对象，缓存写失败不能迫使再次信任可变文件。
    this.validatedEntries = {
      ...(stableEntry ? { stable: stableEntry } : {}),
      ...(betaEntry ? { beta: betaEntry } : {}),
    };
    const stableSource = stableEntry ? (stableUsesCache ? "cache" : "network") : "none";
    const betaSource = betaResult.status === "fulfilled" ? "network" : betaEntry ? "cache" : "none";
    const stableRequired = stableEntry
      ? compareDesktopVersions(stableEntry.latest.version, this.deps.currentVersion) > 0
      : false;
    const stableNewer = stableRequired;
    const betaNewer = betaEntry
      ? compareDesktopVersions(betaEntry.latest.version, this.deps.currentVersion) > 0
      : false;
    const stable = this.channelSnapshot(stableEntry, stableSource, stableRequired, stableNewer, stableResult);
    const beta = this.channelSnapshot(betaEntry, betaSource, false, betaNewer && !stableRequired, betaResult);
    const selectedChannel = stableRequired
      ? "stable"
      : this.snapshot.selectedChannel && (this.snapshot.selectedChannel === "stable" ? stable.downloadAllowed : beta.downloadAllowed)
        ? this.snapshot.selectedChannel
        : null;
    this.snapshot = {
      ...this.snapshot,
      state: stable.downloadAllowed || beta.downloadAllowed ? "available" : "idle",
      stable,
      beta,
      stableRequired,
      loginAllowed: !stableRequired,
      selectedChannel,
      channel: selectedChannel ?? undefined,
      latestVersion: selectedChannel === "stable"
        ? stable.latestVersion
        : selectedChannel === "beta" ? beta.latestVersion : undefined,
      warningMessage: stableResult.status === "rejected"
        ? "正式版检查失败，将稍后重试"
        : undefined,
    };
    return this.getSnapshot();
  }

  private preferredCachedStable(
    firstRead: PlatformReleaseEntry | undefined,
    written: PlatformReleaseEntry | undefined,
  ): PlatformReleaseEntry | undefined {
    if (!firstRead) return written;
    if (!written) return firstRead;
    const comparison = compareDesktopVersions(written.latest.version, firstRead.latest.version);
    if (comparison > 0) return written;
    if (comparison < 0) return firstRead;
    // 中文注释：同版本身份冲突时保留首次已验证对象，禁止写返回值反向替换本轮绑定。
    return samePlatformReleaseIdentity(firstRead, written) ? written : firstRead;
  }

  private channelSnapshot(
    entry: PlatformReleaseEntry | undefined,
    source: "network" | "cache" | "none",
    required: boolean,
    downloadAllowed: boolean,
    result: PromiseSettledResult<PlatformReleaseEntry>,
  ): ManualUpdateSnapshot["stable"] {
    if (!entry) {
      return {
        status: "error",
        source,
        required,
        downloadAllowed: false,
        errorCode: "CATALOG_UNAVAILABLE",
      };
    }
    const installer = entry.release.artifacts.find((artifact) => artifact.kind === "installer");
    return {
      status: downloadAllowed ? "available" : "current",
      source,
      latestVersion: entry.latest.version,
      sourceChannel: entry.release.sourceChannel,
      packageSizeBytes: installer?.size,
      required,
      downloadAllowed,
      ...(result.status === "rejected" ? { errorCode: "CATALOG_STALE_CACHE" } : {}),
    };
  }

  private async download(
    channel: UpdateChannel,
    full: boolean,
    policyFingerprint: string,
    operation: { epoch: number; phase: "download" | "install" | "show-file" },
  ): Promise<void> {
    if (this.snapshot.stableRequired && channel !== "stable") {
      throw new Error("必须先完成 Stable 正式版更新，不能下载测试版");
    }
    const channelSnapshot = this.snapshot[channel];
    if (!channelSnapshot.downloadAllowed) throw new Error(`当前 ${channel} 通道没有可下载更新`);
    const releaseEntry = this.validatedEntries[channel];
    if (!releaseEntry || releaseEntry.latest.version !== channelSnapshot.latestVersion) {
      throw new Error("当前选择缺少已验证 Catalog 候选");
    }
    const installer = releaseEntry.release.artifacts.find((artifact) => artifact.kind === "installer");
    if (!installer) throw new Error("Catalog 缺少安装包");
    this.downloadedCandidate = null;
    const candidateEpoch = ++this.candidateEpoch;
    this.snapshot = {
      ...this.snapshot,
      state: "downloading",
      progress: 0,
      selectedChannel: channel,
      channel,
      latestVersion: releaseEntry.latest.version,
      downloadedPath: undefined,
    };
    this.deps.autoUpdater.disableDifferentialDownload = full;
    this.deps.autoUpdater.setFeedURL({
      provider: "generic",
      url: resolveWindowsX64UpdateFeed(channel),
    });
    // 中文注释：下载前重查固定原生 metadata，必须与 Catalog 版本和安装包大小逐字一致。
    const nativeResult = await this.deps.autoUpdater.checkForUpdates();
    this.assertOperationCurrent(operation);
    const nativeInfo = this.extractNativeUpdateInfo(nativeResult);
    if (nativeInfo.version !== releaseEntry.latest.version) {
      throw new Error("原生 updater 版本与 Catalog 版本不一致");
    }
    const nativeSizes = Array.isArray(nativeInfo.files)
      ? nativeInfo.files.map((file) => Number(file?.size)).filter(Number.isSafeInteger)
      : [];
    if (!nativeSizes.includes(installer.size)) {
      throw new Error("原生 updater 安装包大小与 Catalog 不一致");
    }
    const downloaded = await this.deps.autoUpdater.downloadUpdate();
    this.assertOperationCurrent(operation);
    const filePath = Array.isArray(downloaded)
      ? downloaded.find((value): value is string => typeof value === "string" && value.length > 0)
      : undefined;
    if (!filePath) throw new Error("原生 updater 未返回下载文件");
    const verified = await this.deps.verifyDownloadedArtifact({
      filePath,
      channel,
      size: installer.size,
      sha256: installer.sha256,
    });
    this.assertOperationCurrent(operation);
    if (!verified) throw new Error("安装包 SHA-256 摘要或大小校验失败");
    if (candidateEpoch !== this.candidateEpoch) throw new Error("下载候选已失效");
    this.downloadedCandidate = {
      filePath,
      channel,
      version: releaseEntry.latest.version,
      size: installer.size,
      sha256: installer.sha256,
      checkEpoch: this.checkEpoch,
      candidateEpoch,
      policyFingerprint,
    };
    this.snapshot = {
      ...this.snapshot,
      state: "downloaded",
      progress: 100,
      downloadedPath: filePath,
    };
  }

  private extractNativeUpdateInfo(raw: unknown): { version: string; files?: Array<{ size?: number }> } {
    if (!raw || typeof raw !== "object") throw new Error("原生 updater 未返回版本信息");
    const updateInfo = (raw as { updateInfo?: unknown }).updateInfo;
    if (!updateInfo || typeof updateInfo !== "object") throw new Error("原生 updater 未返回版本信息");
    const version = (updateInfo as { version?: unknown }).version;
    if (typeof version !== "string") throw new Error("原生 updater 版本无效");
    return updateInfo as { version: string; files?: Array<{ size?: number }> };
  }

  private assertActionAllowed(body: Exclude<ManualUpdateActionBody, { action: "check" | "check-login-stable" }>): void {
    if (
      (body.action === "download-differential" || body.action === "download-full")
      && this.snapshot.stableRequired
      && body.channel !== "stable"
    ) {
      throw new Error("必须先完成 Stable 正式版更新，不能下载测试版");
    }
    if (body.action === "install" && !this.isCurrentCandidate()) {
      throw new Error("仅允许安装属于当前选择且已验证的下载候选");
    }
    if (
      (body.action === "download-differential" || body.action === "download-full")
      && !this.snapshot[body.channel].downloadAllowed
    ) {
      throw new Error("仅允许在发现新版本后下载更新包");
    }
    if (body.action === "show-file" && !this.isCurrentCandidate()) {
      throw new Error("当前没有属于所选通道的已验证文件可显示");
    }
  }

  private isCurrentCandidate(): boolean {
    return this.snapshot.state === "downloaded"
      && this.downloadedCandidate !== null
      && this.snapshot.selectedChannel === this.downloadedCandidate.channel
      && this.snapshot.latestVersion === this.downloadedCandidate.version
      && this.downloadedCandidate.checkEpoch === this.checkEpoch
      && this.downloadedCandidate.candidateEpoch === this.candidateEpoch;
  }

  private emptyChannelSnapshot(): ManualUpdateSnapshot["stable"] {
    return {
      status: "idle",
      source: "none",
      required: false,
      downloadAllowed: false,
    };
  }

  private beginCheck(): number {
    const epoch = ++this.checkEpoch;
    this.candidateEpoch += 1;
    this.operationEpoch += 1;
    this.checkedPolicyFingerprint = null;
    this.validatedEntries = {};
    this.clearDownloadedCandidate();
    this.snapshot = {
      ...this.snapshot,
      state: "checking",
      stable: { ...this.snapshot.stable, status: "checking", errorCode: undefined },
      beta: { ...this.snapshot.beta, status: "checking", errorCode: undefined },
      errorMessage: undefined,
      warningMessage: undefined,
    };
    return epoch;
  }

  private clearDownloadedCandidate(): void {
    this.downloadedCandidate = null;
    const {
      downloadedPath: _downloadedPath,
      progress: _progress,
      channel: _channel,
      latestVersion: _latestVersion,
      ...rest
    } = this.snapshot;
    this.snapshot = {
      ...rest,
      state: rest.stable.downloadAllowed || rest.beta.downloadAllowed ? "available" : "idle",
      selectedChannel: null,
    };
  }

  private policyFingerprint(policy: DesktopUpdatePolicy): string {
    return JSON.stringify({
      enabled: policy.enabled,
      channel: policy.channel,
      manualDownloadOnly: policy.manualDownloadOnly,
    });
  }

  private assertCandidateForPolicy(policyFingerprint: string): void {
    if (!this.isCurrentCandidate() || this.downloadedCandidate?.policyFingerprint !== policyFingerprint) {
      this.clearDownloadedCandidate();
      throw new Error("当前下载候选与更新策略、通道或版本不一致");
    }
  }

  private assertOperationCurrent(operation: { epoch: number; phase: "download" | "install" | "show-file" }): void {
    if (this.activeOperation !== operation || operation.epoch !== this.operationEpoch) {
      throw new Error("更新操作已失效");
    }
  }

  private async withUpdaterPhase<T>(
    operation: { epoch: number; phase: "download" | "install" | "show-file" },
    run: () => Promise<T>,
  ): Promise<T> {
    const removeListener = this.deps.autoUpdater.removeListener?.bind(this.deps.autoUpdater);
    if (!removeListener) return run();
    const onProgress = (progress: { percent?: number }) => {
      if (this.activeOperation !== operation || operation.phase !== "download" || this.snapshot.state !== "downloading") return;
      this.snapshot = {
        ...this.snapshot,
        progress: Math.max(0, Math.min(100, Number(progress.percent ?? 0))),
      };
    };
    if (operation.phase === "download") this.deps.autoUpdater.on("download-progress", onProgress);
    try {
      return await run();
    } finally {
      if (operation.phase === "download") removeListener("download-progress", onProgress);
    }
  }

}
