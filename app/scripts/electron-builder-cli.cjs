"use strict";

const path = require("node:path");

/**
 * 只识别 electron-builder 为 Windows NSIS 生成的内部应用归档。
 */
function isWindowsNsisArchive(format, outFile, hostPlatform) {
  return hostPlatform === "win32"
    && format === "7z"
    && /\.nsis\.7z$/i.test(path.basename(outFile));
}

/**
 * 保留 electron-builder 原始归档行为，仅在 Windows NSIS 内部 7z 上关闭多线程。
 */
function createWindowsNsisArchive({
  archiveModule,
  builderUtil,
  hostPlatform = process.platform,
}) {
  const originalArchive = archiveModule.archive;

  return async function archive(format, outFile, dirToArchive, options = {}) {
    if (!isWindowsNsisArchive(format, outFile, hostPlatform)) {
      return originalArchive(format, outFile, dirToArchive, options);
    }

    const outFileStat = await builderUtil.statOrNull(outFile);
    const dirStat = await builderUtil.statOrNull(dirToArchive);
    if (outFileStat && dirStat && outFileStat.mtime > dirStat.mtime) {
      builderUtil.log.info(
        { reason: "Archive file is up to date", outFile },
        "skipped archiving",
      );
      return outFile;
    }

    const args = archiveModule.compute7zCompressArgs(format, options);
    // 7za 21.07 在当前 Windows x64 大型 ASAR 负载下会写出随机错误 CRC；串行归档消除该竞态。
    if (!args.includes("-mmt=off")) args.push("-mmt=off");
    await builderUtil.unlinkIfExists(outFile);
    args.push(outFile, options.withoutDir ? "." : path.basename(dirToArchive));
    if (options.excluded != null) {
      for (const mask of options.excluded) args.push(`-xr!${mask}`);
    }

    try {
      await builderUtil.exec(
        await builderUtil.getPath7za(),
        args,
        {
          cwd: options.withoutDir ? dirToArchive : path.dirname(dirToArchive),
        },
        builderUtil.debug7z.enabled,
      );
    } catch (error) {
      if (
        error.code === "ENOENT"
        && !(await builderUtil.exists(dirToArchive))
      ) {
        throw new Error(`Cannot create archive: "${dirToArchive}" doesn't exist`);
      }
      throw error;
    }
    return outFile;
  };
}

function patchWindowsNsisArchive({ hostPlatform = process.platform } = {}) {
  if (hostPlatform !== "win32") return false;
  const archiveModule = require("app-builder-lib/out/targets/archive");
  const builderUtil = require("builder-util");
  archiveModule.archive = createWindowsNsisArchive({
    archiveModule,
    builderUtil,
    hostPlatform,
  });
  return true;
}

module.exports = {
  createWindowsNsisArchive,
  isWindowsNsisArchive,
  patchWindowsNsisArchive,
};

if (require.main === module) {
  // 必须在加载 electron-builder CLI 前替换归档入口，NSIS Target 才会取得受控实现。
  patchWindowsNsisArchive();
  require("electron-builder/out/cli/cli");
}
