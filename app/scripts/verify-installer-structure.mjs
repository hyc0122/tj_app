import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyWindowsArtifactMetadata } from "./verify-windows-artifact-metadata.mjs";

const require = createRequire(import.meta.url);
const { path7za } = require("7zip-bin");
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(appRoot, "..");
const projectTemporaryRoot = path.join(projectRoot, ".tmp");
const formalUnpackedRoot = path.join(appRoot, "dist", "win-unpacked");
const packageVersion = JSON.parse(
  readFileSync(path.join(appRoot, "package.json"), "utf8"),
).version;

const requiredEntries = [
  "天将漫创.exe",
  "resources/app.asar",
  "resources/data/web/index.html",
  "resources/data/serve/app.js",
  "resources/data/builtin-skills-manifest.json",
  "resources/dreamina-cli/approved-releases.json",
  "resources/prerequisites/vc_redist.x64.exe",
];
const extractionRetryWaitMilliseconds = [250, 500];

/**
 * 标准安装器校验不接收版本参数，文件名只由 package.json.version 构造。
 */
export function resolveDefaultInstallerVerificationInputs() {
  return {
    setupPath: path.join(
      appRoot,
      "dist",
      `天将漫创-${packageVersion}-win-x64-setup.exe`,
    ),
    unpackedRoot: formalUnpackedRoot,
  };
}

function isStrictDescendant(root, target) {
  const relative = path.relative(root, target);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function resolveProjectTemporaryRoot() {
  mkdirSync(projectTemporaryRoot, { recursive: true });
  if (lstatSync(projectTemporaryRoot).isSymbolicLink()) {
    throw new Error("工作树 .tmp 不得为符号链接或目录联接");
  }
  const realProjectRoot = realpathSync(projectRoot);
  const realTemporaryRoot = realpathSync(projectTemporaryRoot);
  if (path.dirname(realTemporaryRoot) !== realProjectRoot) {
    throw new Error("安装包结构验证临时目录必须是当前工作树的直接 .tmp 子目录");
  }
  return realTemporaryRoot;
}

function assertRegularFile(filePath, label) {
  if (!existsSync(filePath) || !lstatSync(filePath).isFile()) {
    throw new Error(`${label}不存在或不是普通文件`);
  }
}

function resolveInputs(setupPath, unpackedRoot) {
  const resolvedSetup = path.resolve(setupPath);
  const resolvedUnpacked = path.resolve(unpackedRoot);
  assertRegularFile(resolvedSetup, "最终 NSIS 安装包");
  if (path.extname(resolvedSetup).toLowerCase() !== ".exe") {
    throw new Error("最终 NSIS 安装包扩展名必须为 .exe");
  }
  if (
    !existsSync(resolvedUnpacked)
    || !lstatSync(resolvedUnpacked).isDirectory()
    || lstatSync(resolvedUnpacked).isSymbolicLink()
  ) {
    throw new Error("Electron 解包对照目录不存在或不安全");
  }

  const realTemporaryRoot = resolveProjectTemporaryRoot();
  const realUnpacked = realpathSync(resolvedUnpacked);
  const realFormalUnpacked = existsSync(formalUnpackedRoot)
    ? realpathSync(formalUnpackedRoot)
    : formalUnpackedRoot;
  if (
    realUnpacked !== realFormalUnpacked
    && !isStrictDescendant(realTemporaryRoot, realUnpacked)
  ) {
    throw new Error("Electron 解包对照目录必须是正式 dist 或当前工作树 .tmp 夹具");
  }
  return {
    setupPath: resolvedSetup,
    unpackedRoot: realUnpacked,
    testFixture: isStrictDescendant(realTemporaryRoot, realUnpacked),
  };
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function listFiles(root, relativeRoot = "") {
  const directory = path.join(root, relativeRoot);
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(
      relativeRoot.split(path.sep).join("/"),
      entry.name,
    );
    if (entry.isSymbolicLink()) {
      throw new Error(`安装包解包结果包含符号链接：${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relativePath.split("/").join(path.sep)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function directoryManifest(root, relativeDirectory) {
  const directoryRoot = path.join(root, ...relativeDirectory.split("/"));
  if (!existsSync(directoryRoot) || !lstatSync(directoryRoot).isDirectory()) {
    throw new Error(`安装包缺少目录：${relativeDirectory}`);
  }
  return listFiles(directoryRoot).map((relativePath) => ({
    path: relativePath,
    sha256: sha256File(
      path.join(directoryRoot, ...relativePath.split("/")),
    ),
  }));
}

function assertSameFile(extractedRoot, unpackedRoot, relativePath) {
  const extractedPath = path.join(extractedRoot, ...relativePath.split("/"));
  const unpackedPath = path.join(unpackedRoot, ...relativePath.split("/"));
  assertRegularFile(extractedPath, `安装包内 ${relativePath}`);
  assertRegularFile(unpackedPath, `解包对照 ${relativePath}`);
  if (sha256File(extractedPath) !== sha256File(unpackedPath)) {
    throw new Error(`安装包内文件与 Electron 解包对照不一致：${relativePath}`);
  }
}

function assertNoRuntimeData(extractedRoot) {
  const forbidden = listFiles(extractedRoot).filter((relativePath) => {
    const basename = path.posix.basename(relativePath).toLowerCase();
    return /^(?:db2|profile|project)\.sqlite(?:-(?:wal|shm))?$/.test(basename)
      || basename.endsWith(".log")
      || basename === ".env"
      || basename.startsWith(".env.");
  });
  if (forbidden.length > 0) {
    throw new Error(`安装包包含用户数据或运行文件：${forbidden[0]}`);
  }
}

function waitForExtractionRetry(milliseconds) {
  // 同步打包门只等待两个固定短窗口，总等待上限为 750ms。
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

function summarizeExtractionFailure(result) {
  const detail = [result?.error?.message, result?.stderr, result?.stdout]
    .filter(Boolean)
    .join("\n")
    .slice(0, 8_000);
  // 诊断保留 7-Zip 原始错误，但不向共享日志暴露本机工作树绝对路径。
  return (detail || "未提供错误详情").split(projectRoot).join("<project>");
}

function isRetryableWindowsSharingFailure(result, hostPlatform) {
  if (
    hostPlatform !== "win32"
    || result?.error
    || result?.status !== 2
  ) {
    return false;
  }
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  const outputOperation = /ERROR:\s+Cannot (?:create|open|delete) output file\b/iu;
  const sharingViolation = /(?:另一个程序正在使用此文件，进程无法访问|The process cannot access the file because it is being used by another process)/iu;
  return outputOperation.test(detail) && sharingViolation.test(detail);
}

/**
 * 只对 7-Zip 明确报告的 Windows 文件共享占用做两次短恢复；
 * 归档损坏、权限错误、无法启动及其他退出码全部立即失败关闭。
 */
export function extractInstallerArchiveWithRecovery(
  setupPath,
  extractionRoot,
  {
    commandExecutor = spawnSync,
    retryWaiter = waitForExtractionRetry,
    diagnosticWriter = (message) => process.stderr.write(message),
    hostPlatform = process.platform,
  } = {},
) {
  const args = ["x", "-y", `-o${extractionRoot}`, setupPath];
  const maximumAttempts = extractionRetryWaitMilliseconds.length + 1;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    let result;
    try {
      result = commandExecutor(path7za, args, {
        encoding: "utf8",
        shell: false,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      result = { error, status: null, stdout: "", stderr: "" };
    }
    if (!result?.error && result?.status === 0) {
      return { attemptCount: attempt };
    }

    const retryable = isRetryableWindowsSharingFailure(result, hostPlatform);
    if (!retryable || attempt === maximumAttempts) {
      throw new Error(
        `最终 NSIS 安装包只读解包失败（已尝试 ${attempt}/${maximumAttempts}，退出码 ${result?.status ?? "无法启动"}）：${summarizeExtractionFailure(result)}`,
      );
    }

    const waitMilliseconds = extractionRetryWaitMilliseconds[attempt - 1];
    // 可恢复路径只记录 stderr，避免把 7-Zip 的完整归档清单重复写入 Gate 日志。
    const retryDetail = summarizeExtractionFailure({ ...result, stdout: "" });
    diagnosticWriter(
      `[安装包结构验证] 第 ${attempt}/${maximumAttempts} 次全量解包遇到可识别的 Windows 文件共享占用；等待 ${waitMilliseconds}ms 后尝试 ${attempt + 1}/${maximumAttempts}：${retryDetail}\n`,
    );
    retryWaiter(waitMilliseconds);
  }

  throw new Error("最终 NSIS 安装包只读解包进入不可达状态");
}

/**
 * 只读解包最终 NSIS，不运行安装器；验证归档根布局和不可变资源与 win-unpacked 一致。
 */
export function verifyInstallerArchiveStructure(setupPath, unpackedRoot) {
  const inputs = resolveInputs(setupPath, unpackedRoot);
  const temporaryRoot = resolveProjectTemporaryRoot();
  const extractionRoot = mkdtempSync(
    path.join(temporaryRoot, "tj-nsis-structure-"),
  );
  try {
    const extractionEvidence = extractInstallerArchiveWithRecovery(
      inputs.setupPath,
      extractionRoot,
    );

    // 主程序直接位于解包根，证明归档本身没有 tianjiang 等额外包装层。
    const mainExecutable = path.join(extractionRoot, "天将漫创.exe");
    if (!existsSync(mainExecutable) || !lstatSync(mainExecutable).isFile()) {
      throw new Error("主程序必须直接位于安装根目录");
    }
    for (const relativePath of requiredEntries) {
      assertRegularFile(
        path.join(extractionRoot, ...relativePath.split("/")),
        `安装包内 ${relativePath}`,
      );
    }

    for (const relativePath of [
      "天将漫创.exe",
      "resources/app.asar",
      "resources/data/builtin-skills-manifest.json",
      "resources/dreamina-cli/approved-releases.json",
      "resources/prerequisites/vc_redist.x64.exe",
    ]) {
      assertSameFile(extractionRoot, inputs.unpackedRoot, relativePath);
    }
    for (const relativeDirectory of [
      "resources/data/web",
      "resources/data/serve",
      "resources/data/builtin-skills",
    ]) {
      const extractedManifest = directoryManifest(
        extractionRoot,
        relativeDirectory,
      );
      const unpackedManifest = directoryManifest(
        inputs.unpackedRoot,
        relativeDirectory,
      );
      if (
        JSON.stringify(extractedManifest)
        !== JSON.stringify(unpackedManifest)
      ) {
        throw new Error(`安装包资源树与 Electron 解包对照不一致：${relativeDirectory}`);
      }
    }
    assertNoRuntimeData(extractionRoot);

    let executableMetadata = null;
    if (inputs.testFixture) {
      if (process.env.NODE_ENV !== "test-only") {
        throw new Error("安装包结构测试夹具必须显式使用 test-only 模式");
      }
    } else {
      const builderConfig = readFileSync(
        path.join(appRoot, "electron-builder.yml"),
        "utf8",
      );
      if (!/uninstallerIcon:\s*['"]\.\/scripts\/logo\.ico['"]/.test(builderConfig)) {
        throw new Error("NSIS 卸载器图标未锁定到品牌 ICO");
      }
      executableMetadata = verifyWindowsArtifactMetadata({
        mainExecutable: path.join(
          inputs.unpackedRoot,
          "天将漫创.exe",
        ),
        installerExecutable: inputs.setupPath,
      });
    }

    return {
      mode: "archive-structure-only",
      elevatedInstallExecuted: false,
      mainExecutable: "天将漫创.exe",
      requiredEntriesVerified: requiredEntries.length,
      immutableTreesCompared: 3,
      forbiddenRuntimeFileCount: 0,
      extractionAttempts: extractionEvidence.attemptCount,
      executableMetadata,
    };
  } finally {
    // extractionRoot 由已 realpath 校验的 temporaryRoot 直接 mkdtemp 创建，
    // 清理阶段不再 realpath 刚解包目录，避免实时扫描器短暂锁定目录元数据。
    const realTemporaryRoot = temporaryRoot;
    const realExtractionRoot = path.resolve(extractionRoot);
    if (
      isStrictDescendant(realTemporaryRoot, realExtractionRoot)
      && path.basename(realExtractionRoot).startsWith("tj-nsis-structure-")
    ) {
      // Windows Defender 等进程可能短暂占用刚解包的文件；只在已校验目录内有限重试。
      rmSync(realExtractionRoot, {
        recursive: true,
        force: true,
        maxRetries: 60,
        retryDelay: 250,
      });
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const cliArguments = process.argv.slice(2);
  if (cliArguments.length !== 0 && cliArguments.length !== 2) {
    process.stderr.write(
      "用法：node scripts/verify-installer-structure.mjs [<setup.exe> <win-unpacked>]\n",
    );
    process.exitCode = 2;
  } else {
    try {
      const defaults = resolveDefaultInstallerVerificationInputs();
      const [setupPath = defaults.setupPath, unpackedRoot = defaults.unpackedRoot] = cliArguments;
      const evidence = verifyInstallerArchiveStructure(setupPath, unpackedRoot);
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
    } catch (error) {
      process.stderr.write(
        `[安装包结构验证] ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
