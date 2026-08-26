import { createHash } from "node:crypto";
import fs from "node:fs";

import { ClientConfigCache } from "../src/tianjiang/client-config/cache";
import { PublicClientConfigClient } from "../src/tianjiang/client-config/client";
import { PlatformReleaseCatalogClient } from "../src/tianjiang/update/platform-release-catalog";
import { PlatformUpdateCache } from "../src/tianjiang/update/platform-update-cache";
import {
  ManualUpdaterService,
  UnsupportedManualUpdaterService,
  type ManualUpdaterDeps,
  type ManualUpdateService,
} from "./manual-updater";

export interface DesktopManualUpdaterOptions
  extends Omit<ManualUpdaterDeps, "loadUpdatePolicy" | "catalogClient" | "updateCache" | "verifyDownloadedArtifact"> {
  dataRoot: string;
  fetcher?: typeof fetch;
  catalogClient?: ManualUpdaterDeps["catalogClient"];
  updateCache?: ManualUpdaterDeps["updateCache"];
  verifyDownloadedArtifact?: ManualUpdaterDeps["verifyDownloadedArtifact"];
  platform?: string;
  arch?: string;
}

export function isWindowsX64UpdatePlatform(platform: string = process.platform, arch: string = process.arch): boolean {
  return platform === "win32" && arch === "x64";
}

export function createUnsupportedManualUpdater(
  currentVersion: string,
  platform: string = process.platform,
  arch: string = process.arch,
): ManualUpdateService {
  return new UnsupportedManualUpdaterService(currentVersion, platform, arch);
}

/** Electron shell.openPath 返回空串才表示操作系统已受理启动。 */
export async function launchVerifiedInstallerWithShell(
  filePath: string,
  openPath: (verifiedPath: string) => Promise<string>,
): Promise<void> {
  const launchError = await openPath(filePath);
  if (launchError.length > 0) {
    throw new Error(`安装器启动失败：${launchError}`);
  }
}

async function verifyDownloadedArtifact(candidate: {
  filePath: string;
  size: number;
  sha256: string;
}): Promise<boolean> {
  try {
    if (fs.statSync(candidate.filePath).size !== candidate.size) return false;
    const digest = createHash("sha256");
    for await (const chunk of fs.createReadStream(candidate.filePath)) digest.update(chunk);
    return digest.digest("hex") === candidate.sha256;
  } catch {
    return false;
  }
}

/** 主进程唯一 updater 装配：策略只能来自固定中央 client-config 与合法本地缓存。 */
export function createDesktopManualUpdater(
  options: DesktopManualUpdaterOptions,
): ManualUpdateService {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  // 中文注释：平台门禁必须先于 client-config、Catalog 和缓存装配，其他平台保持零 Windows 更新副作用。
  if (!isWindowsX64UpdatePlatform(platform, arch)) {
    return createUnsupportedManualUpdater(options.currentVersion, platform, arch);
  }
  const client = new PublicClientConfigClient(
    new ClientConfigCache(options.dataRoot),
    options.fetcher,
  );
  const catalogClient = options.catalogClient ?? new PlatformReleaseCatalogClient({ fetcher: options.fetcher });
  const updateCache = options.updateCache ?? new PlatformUpdateCache(options.dataRoot);
  return new ManualUpdaterService({
    autoUpdater: options.autoUpdater,
    currentVersion: options.currentVersion,
    prepareInstall: options.prepareInstall,
    // 中文注释：工厂必须完整透传统一退出门及安装器启动失败恢复回调。
    prepareInstallShutdown: options.prepareInstallShutdown,
    launchVerifiedInstaller: options.launchVerifiedInstaller,
    recoverAfterInstallerLaunchFailure: options.recoverAfterInstallerLaunchFailure,
    finalizeInstallShutdown: options.finalizeInstallShutdown,
    scheduleApplicationQuit: options.scheduleApplicationQuit,
    showDownloadedFile: options.showDownloadedFile,
    catalogClient,
    updateCache,
    verifyDownloadedArtifact: options.verifyDownloadedArtifact ?? verifyDownloadedArtifact,
    loadUpdatePolicy: async () => (await client.getLatest()).config.updatePolicy,
  });
}
