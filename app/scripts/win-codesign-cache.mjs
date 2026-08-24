import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { appBuilderPath } = require("app-builder-bin");
const sevenZipPackageRoot = path.dirname(require.resolve("7zip-bin/package.json"));

const legacyWinCodeSignVersion = "2.6.0";
const legacyWinCodeSignArtifact = `winCodeSign-${legacyWinCodeSignVersion}`;
const legacyWinCodeSignUrl =
  `https://github.com/electron-userland/electron-builder-binaries/releases/download/` +
  `${legacyWinCodeSignArtifact}/${legacyWinCodeSignArtifact}.7z`;
// 摘要来自当前锁定 app-builder-bin 内置元数据，并在官方归档下载后再次独立复核。
const legacyWinCodeSignSha512 =
  "6LQI2d9BPC3Xs0ZoTQe1o3tPiA28c7+PY69Q9i/pD8lY45psMtHuLwv3vRckiVr3Zx1cbNyLlBR8STwCdcHwtA==";
const integrityFileName = ".tianjiang-integrity.json";
// 固定排除 darwin 后的逐文件清单摘要，任何缺失、增加或篡改都会使缓存失效。
const expectedIntegritySha256 =
  "7c7c551c6c6e369badbe1d826e6c0e5a390e27f793c071edbb3ccaa0cda4db69";
const lockWaitMilliseconds = 50;
const lockTimeoutMilliseconds = 2 * 60 * 1000;
const staleLockMilliseconds = 10 * 60 * 1000;
const renameTimeoutMilliseconds = 10 * 1000;
const downloadRetryWaitMilliseconds = [250, 500];

const compareOrdinal = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function hashBuffer(algorithm, value, encoding) {
  return createHash(algorithm).update(value).digest(encoding);
}

function hashFile(algorithm, filePath, encoding) {
  return hashBuffer(algorithm, readFileSync(filePath), encoding);
}

function pathEntryExists(filePath) {
  return lstatSync(filePath, { throwIfNoEntry: false }) !== undefined;
}

function resolveBundled7za(hostPlatform = process.platform, hostArch = process.arch) {
  const platformDirectory = {
    darwin: "mac",
    linux: "linux",
    win32: "win",
  }[hostPlatform];
  if (!platformDirectory) {
    throw new Error(`7zip-bin 不支持当前平台：${hostPlatform}`);
  }
  const executableName = hostPlatform === "win32" ? "7za.exe" : "7za";
  const bundled7za = path.resolve(
    sevenZipPackageRoot,
    platformDirectory,
    hostArch,
    executableName,
  );
  if (!existsSync(bundled7za) || !lstatSync(bundled7za).isFile()) {
    throw new Error(`仓库锁定的 7za 不存在：${bundled7za}`);
  }
  return bundled7za;
}

export function createElectronBuilderEnvironment(
  environment = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
) {
  if (hostPlatform !== "win32") {
    // legacy winCodeSign 修复仅限 Windows，其他平台保持原有工具链环境。
    return { ...environment };
  }
  return {
    ...environment,
    // 禁止继承 USE_SYSTEM_7ZA=true，确保 app-builder 不依赖宿主机 PATH。
    USE_SYSTEM_7ZA: "false",
    SZA_PATH: resolveBundled7za(hostPlatform, hostArch),
  };
}

export function verifyLegacyWinCodeSignArchive(archivePath) {
  if (
    !existsSync(archivePath) ||
    lstatSync(archivePath).isSymbolicLink() ||
    !lstatSync(archivePath).isFile()
  ) {
    throw new Error("legacy winCodeSign 归档不存在或文件类型不安全");
  }
  const actualSha512 = hashFile("sha512", archivePath, "base64");
  if (actualSha512 !== legacyWinCodeSignSha512) {
    throw new Error(
      `legacy winCodeSign SHA512 不匹配：期望 ${legacyWinCodeSignSha512}，实际 ${actualSha512}`,
    );
  }
  return actualSha512;
}

function collectIntegrityFiles(rootDirectory, relativeDirectory = "") {
  const directory = relativeDirectory
    ? path.join(rootDirectory, ...relativeDirectory.split("/"))
    : rootDirectory;
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareOrdinal(left.name, right.name));
  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (relativePath === integrityFileName) continue;
    const fullPath = path.join(directory, entry.name);
    const metadata = lstatSync(fullPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`legacy winCodeSign 缓存禁止符号链接或 Junction：${relativePath}`);
    }
    if (metadata.isDirectory()) {
      files.push(...collectIntegrityFiles(rootDirectory, relativePath));
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`legacy winCodeSign 缓存含非普通文件：${relativePath}`);
    }
    files.push({
      path: relativePath,
      size: metadata.size,
      sha256: hashFile("sha256", fullPath, "hex"),
    });
  }
  return files.sort((left, right) => compareOrdinal(left.path, right.path));
}

function createIntegrityContents(cacheDirectory) {
  const manifest = {
    schemaVersion: 1,
    artifact: legacyWinCodeSignArtifact,
    source: legacyWinCodeSignUrl,
    archiveSha512: legacyWinCodeSignSha512,
    excludedEntries: ["darwin"],
    files: collectIntegrityFiles(cacheDirectory),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function verifyLegacyWinCodeSignCache(cacheDirectory) {
  try {
    if (
      !existsSync(cacheDirectory) ||
      lstatSync(cacheDirectory).isSymbolicLink() ||
      !lstatSync(cacheDirectory).isDirectory()
    ) {
      return false;
    }
    if (existsSync(path.join(cacheDirectory, "darwin"))) return false;
    const integrityPath = path.join(cacheDirectory, integrityFileName);
    if (
      !existsSync(integrityPath) ||
      lstatSync(integrityPath).isSymbolicLink() ||
      !lstatSync(integrityPath).isFile()
    ) {
      return false;
    }
    const integrityContents = readFileSync(integrityPath, "utf8");
    if (
      hashBuffer("sha256", integrityContents, "hex") !== expectedIntegritySha256
    ) {
      return false;
    }
    const expected = JSON.parse(integrityContents);
    const actual = JSON.parse(createIntegrityContents(cacheDirectory));
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function resolveElectronBuilderCacheRoot(environment) {
  const configured = environment.ELECTRON_BUILDER_CACHE?.trim();
  if (configured) return path.resolve(configured);
  const localAppData = environment.LOCALAPPDATA?.trim();
  return localAppData
    ? path.join(localAppData, "electron-builder", "Cache")
    : path.join(os.tmpdir(), "electron-builder-cache");
}

function waitForLock() {
  // 同步打包入口不能异步等待；Atomics.wait 不忙轮询，也不占用额外系统工具。
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    lockWaitMilliseconds,
  );
}

function waitForDownloadRetry(milliseconds) {
  // 下载重试使用固定短等待，总等待上限为 750ms，禁止演变为无限退避。
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

function renameDirectoryAtomic(source, destination) {
  const startedAt = Date.now();
  while (true) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const retryable = ["EACCES", "EBUSY", "EPERM"].includes(error?.code);
      if (!retryable || Date.now() - startedAt >= renameTimeoutMilliseconds) {
        throw error;
      }
      // Windows Defender 可能短暂持有刚下载的 EXE；保持原子 rename 并有界等待。
      waitForLock();
    }
  }
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function recoverStaleLock(lockPath) {
  let lockAge;
  try {
    lockAge = Date.now() - statSync(lockPath).mtimeMs;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  let owner;
  try {
    owner = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    owner = null;
  }
  // 活进程持有的锁不能仅因文件超龄被夺取，否则会出现两个进程同时替换缓存。
  if (owner !== null && isProcessAlive(owner.pid)) {
    return false;
  }
  if (owner === null && lockAge < staleLockMilliseconds) {
    return false;
  }

  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
  rmSync(stalePath, { force: true });
  return true;
}

function acquireCacheLock(lockPath, cacheDirectory) {
  const token = randomUUID();
  const startedAt = Date.now();
  while (true) {
    let descriptor;
    let created = false;
    try {
      descriptor = openSync(lockPath, "wx");
      created = true;
      writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      closeSync(descriptor);
      return { lockPath, token };
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // descriptor 可能已在 closeSync 报错前关闭；原始错误更有诊断价值。
        }
      }
      if (created && error?.code !== "EEXIST") {
        rmSync(lockPath, { force: true });
      }
      if (error?.code !== "EEXIST") throw error;
      if (verifyLegacyWinCodeSignCache(cacheDirectory)) return null;
      recoverStaleLock(lockPath);
      if (Date.now() - startedAt >= lockTimeoutMilliseconds) {
        throw new Error("等待 legacy winCodeSign 缓存跨进程锁超时");
      }
      waitForLock();
    }
  }
}

function releaseCacheLock(lock) {
  if (!lock) return;
  try {
    const owner = JSON.parse(readFileSync(lock.lockPath, "utf8"));
    if (owner.token === lock.token) unlinkSync(lock.lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function assertCommandSucceeded(name, result) {
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .slice(0, 8_000);
    throw new Error(`${name}失败（退出码 ${result.status ?? "无法启动"}）：${detail}`);
  }
}

function sanitizeDownloadFailureDetail(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) => {
      try {
        const parsed = new URL(candidate);
        if (!parsed.search && !parsed.hash) return candidate;
        parsed.search = "";
        parsed.hash = "";
        return `${parsed.toString()}[查询参数已脱敏]`;
      } catch {
        return "[下载地址已脱敏]";
      }
    })
    .replace(
      /\b(jwt|sig|signature|token)=([^\s&"']+)/giu,
      "$1=[已脱敏]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      "[JWT 已脱敏]",
    );
}

function summarizeDownloadFailure(result) {
  const detail = [result?.error?.message, result?.stderr, result?.stdout]
    .filter(Boolean)
    .join("\n")
    .slice(0, 8_000);
  return sanitizeDownloadFailureDetail(detail || "未提供错误详情");
}

export function downloadLegacyWinCodeSignArchive(
  stageRoot,
  environment = process.env,
  {
    commandExecutor = spawnSync,
    retryWaiter = waitForDownloadRetry,
  } = {},
) {
  const archivePath = path.join(stageRoot, `${legacyWinCodeSignArtifact}.7z`);
  let lastFailure;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      // 只清理本次 Electron Builder 暂存目录中的归档，不触碰已验证缓存。
      rmSync(archivePath, { force: true });
      retryWaiter(downloadRetryWaitMilliseconds[attempt - 2]);
    }

    try {
      lastFailure = commandExecutor(
        appBuilderPath,
        [
          "download",
          "--url",
          legacyWinCodeSignUrl,
          "--output",
          archivePath,
          "--sha512",
          legacyWinCodeSignSha512,
        ],
        {
          encoding: "utf8",
          env: createElectronBuilderEnvironment(environment),
          maxBuffer: 10 * 1024 * 1024,
          shell: false,
        },
      );
    } catch (error) {
      // spawnSync 无法启动通常返回 result.error；同步抛错也按同一传输失败处理。
      lastFailure = { error, status: null, stderr: "", stdout: "" };
    }

    if (!lastFailure?.error && lastFailure?.status === 0) {
      // 重试只包住传输；SHA-512 安全复核失败必须立即关闭，绝不再次下载。
      verifyLegacyWinCodeSignArchive(archivePath);
      return archivePath;
    }
  }

  rmSync(archivePath, { force: true });
  throw new Error(
    `legacy winCodeSign 官方归档下载失败（已尝试 3/3 次，退出码 ${lastFailure?.status ?? "无法启动"}）：${summarizeDownloadFailure(lastFailure)}`,
  );
}

function stageTrustedCache(stageRoot, environment) {
  const payloadDirectory = path.join(stageRoot, "payload");
  mkdirSync(payloadDirectory, { recursive: false });

  const archivePath = downloadLegacyWinCodeSignArchive(stageRoot, environment);

  const extraction = spawnSync(
    createElectronBuilderEnvironment(environment).SZA_PATH,
    [
      "x",
      "-bd",
      "-y",
      archivePath,
      `-o${payloadDirectory}`,
      // combo 归档中的 macOS dylib 链接与 Windows rcedit 无关，且普通用户无创建权限。
      "-xr!darwin",
    ],
    {
      encoding: "utf8",
      env: createElectronBuilderEnvironment(environment),
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
    },
  );
  assertCommandSucceeded("legacy winCodeSign Windows 安全解压", extraction);
  if (existsSync(path.join(payloadDirectory, "darwin"))) {
    throw new Error("legacy winCodeSign 安全解压未排除 darwin 内容");
  }

  const integrityContents = createIntegrityContents(payloadDirectory);
  const integritySha256 = hashBuffer("sha256", integrityContents, "hex");
  if (integritySha256 !== expectedIntegritySha256) {
    throw new Error(
      `legacy winCodeSign 完整清单 SHA256 不匹配：期望 ${expectedIntegritySha256}，实际 ${integritySha256}`,
    );
  }
  writeFileSync(
    path.join(payloadDirectory, integrityFileName),
    integrityContents,
    { encoding: "utf8", flag: "wx" },
  );
  if (!verifyLegacyWinCodeSignCache(payloadDirectory)) {
    throw new Error("legacy winCodeSign 暂存缓存完整性复核失败");
  }
  return payloadDirectory;
}

export function prepareLegacyWinCodeSignCache(
  environment = process.env,
  hostPlatform = process.platform,
) {
  if (hostPlatform !== "win32") {
    return { prepared: false, cacheDirectory: null, reason: "non-windows" };
  }

  const cacheRoot = resolveElectronBuilderCacheRoot(environment);
  const cacheParent = path.join(cacheRoot, "winCodeSign");
  const cacheDirectory = path.join(cacheParent, legacyWinCodeSignArtifact);
  if (verifyLegacyWinCodeSignCache(cacheDirectory)) {
    return { prepared: false, cacheDirectory, reason: "verified-cache" };
  }

  mkdirSync(cacheParent, { recursive: true });
  const lockPath = path.join(
    cacheParent,
    `.tianjiang-${legacyWinCodeSignArtifact}.lock`,
  );
  const lock = acquireCacheLock(lockPath, cacheDirectory);
  if (!lock) {
    return { prepared: false, cacheDirectory, reason: "prepared-by-peer" };
  }

  const stageRoot = path.join(
    cacheParent,
    `.tianjiang-${legacyWinCodeSignArtifact}-stage-${process.pid}-${randomUUID()}`,
  );
  let invalidDirectory = null;
  try {
    if (verifyLegacyWinCodeSignCache(cacheDirectory)) {
      return { prepared: false, cacheDirectory, reason: "verified-after-lock" };
    }
    mkdirSync(stageRoot, { recursive: false });
    const payloadDirectory = stageTrustedCache(stageRoot, environment);

    if (pathEntryExists(cacheDirectory)) {
      invalidDirectory = `${cacheDirectory}.invalid-${randomUUID()}`;
      renameDirectoryAtomic(cacheDirectory, invalidDirectory);
    }
    renameDirectoryAtomic(payloadDirectory, cacheDirectory);
    if (!verifyLegacyWinCodeSignCache(cacheDirectory)) {
      const rejectedDirectory = `${cacheDirectory}.rejected-${randomUUID()}`;
      renameDirectoryAtomic(cacheDirectory, rejectedDirectory);
      throw new Error("legacy winCodeSign 原子落盘后完整性复核失败");
    }
    if (invalidDirectory) {
      rmSync(invalidDirectory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
      invalidDirectory = null;
    }
    return { prepared: true, cacheDirectory, reason: "prepared" };
  } finally {
    rmSync(stageRoot, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
    releaseCacheLock(lock);
  }
}
