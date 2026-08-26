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
import { fileURLToPath } from "node:url";

import {
  syncWeb,
  validateWebRoot,
  verifyPackage,
  verifySync,
} from "./package-web-assets.mjs";
import {
  prepareVcRuntime,
  verifyVcRuntimeArtifact,
} from "./prepare-vc-runtime.mjs";
import { assertUnsignedBuilderContract } from "./electron-builder-unsigned-contract.mjs";
import {
  resolveReleaseTarget,
  resolveReleaseTargetId,
} from "./release-targets.mjs";
import { verifyInstallerArchiveStructure } from "./verify-installer-structure.mjs";
import {
  normalizeReleaseTargetArtifacts,
  verifyReleaseTarget,
} from "./verify-release-target.mjs";
import { verifyWindowsArtifactMetadata } from "./verify-windows-artifact-metadata.mjs";
import {
  createElectronBuilderEnvironment,
  downloadLegacyWinCodeSignArchive,
  prepareLegacyWinCodeSignCache,
  verifyLegacyWinCodeSignArchive,
  verifyLegacyWinCodeSignCache,
} from "./win-codesign-cache.mjs";

export {
  createElectronBuilderEnvironment,
  downloadLegacyWinCodeSignArchive,
  prepareLegacyWinCodeSignCache,
  verifyLegacyWinCodeSignArchive,
  verifyLegacyWinCodeSignCache,
};

const require = createRequire(import.meta.url);
const { appBuilderPath } = require("app-builder-bin");
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(appRoot, "..");
const webRoot = path.join(projectRoot, "web");
const defaultWebDist = path.join(webRoot, "dist");
const electronWeb = path.join(appRoot, "data", "web");
const defaultElectronDist = path.join(appRoot, "dist");
const projectTemporaryRoot = path.join(projectRoot, ".tmp");
const packageVersion = JSON.parse(
  readFileSync(path.join(appRoot, "package.json"), "utf8"),
).version;

function assertFixedLayout() {
  if (path.basename(appRoot) !== "app") {
    throw new Error(`Electron 项目目录不符合固定布局：${appRoot}`);
  }
  if (path.basename(webRoot) !== "web" || path.dirname(webRoot) !== projectRoot) {
    throw new Error(`业务前端目录不符合固定布局：${webRoot}`);
  }
  if (
    path.dirname(defaultElectronDist) !== appRoot
    || path.basename(defaultElectronDist) !== "dist"
  ) {
    throw new Error(`拒绝清理不安全的 Electron 输出目录：${defaultElectronDist}`);
  }
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
    throw new Error("打包临时目录必须是当前工作树的直接 .tmp 子目录");
  }
  return realTemporaryRoot;
}

function resolveElectronOutput() {
  const override = process.env.TJ_PACKAGE_DIST_OVERRIDE;
  if (!override) return defaultElectronDist;
  if (process.env.NODE_ENV !== "test-only") {
    throw new Error("Electron dist 覆盖仅允许在显式 test-only 模式使用");
  }

  const requested = path.resolve(override);
  if (path.basename(requested) !== "dist") {
    throw new Error("测试 Electron 输出目录必须以 dist 命名");
  }

  let realTempRoot;
  let realParent;
  try {
    realTempRoot = resolveProjectTemporaryRoot();
    realParent = realpathSync(path.dirname(requested));
  } catch {
    throw new Error("测试 Electron 输出目录的父目录必须已存在且可解析");
  }
  if (!isStrictDescendant(realTempRoot, realParent)) {
    throw new Error("测试 Electron 输出目录必须位于当前工作树 .tmp 的独立子目录内");
  }
  if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) {
    throw new Error("测试 Electron 输出目录不得为符号链接或目录联接");
  }

  const resolved = path.join(realParent, "dist");
  if (
    resolved === realTempRoot
    || resolved === appRoot
    || resolved === projectRoot
    || resolved === defaultElectronDist
  ) {
    throw new Error("拒绝使用项目目录、临时根或上级目录作为测试 Electron 输出");
  }
  return resolved;
}

function resolveWebDist(electronOutput) {
  const override = process.env.TJ_PACKAGE_WEB_DIST_OVERRIDE;
  if (!override) return { path: defaultWebDist, testOverride: false };
  if (process.env.NODE_ENV !== "test-only") {
    throw new Error("业务前端 dist 覆盖仅允许在显式 test-only 模式使用");
  }
  if (electronOutput === defaultElectronDist) {
    throw new Error("业务前端测试覆盖必须同时使用隔离的 Electron dist");
  }

  const requested = path.resolve(override);
  if (!existsSync(requested) || lstatSync(requested).isSymbolicLink()) {
    throw new Error("业务前端测试覆盖必须是已存在的普通目录");
  }

  let realTempRoot;
  let realWebDist;
  try {
    realTempRoot = resolveProjectTemporaryRoot();
    realWebDist = realpathSync(requested);
  } catch {
    throw new Error("业务前端测试覆盖目录必须可解析");
  }
  if (!isStrictDescendant(realTempRoot, realWebDist)) {
    throw new Error("业务前端测试覆盖必须位于当前工作树 .tmp");
  }
  if (path.dirname(realWebDist) !== path.dirname(electronOutput)) {
    throw new Error("业务前端与 Electron 测试覆盖必须属于同一临时测试根");
  }
  return { path: realWebDist, testOverride: true };
}

function resolveCommandInvocation(command, args) {
  const isWindowsBatch = process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
  if (!isWindowsBatch) {
    return { executable: command, executableArgs: args, windowsVerbatimArguments: false };
  }
  if (!process.env.ComSpec) throw new Error("Windows 批处理缺少 ComSpec");

  const quotedTokens = [command, ...args].map((value) => {
    if (/[\0\r\n"%]/.test(value)) {
      throw new Error("Windows 批处理命令或参数含不支持的百分号、控制字符或双引号");
    }
    // 每个 token 单独引用，空格及 &、| 等 cmd 元字符只作为参数内容传递。
    return `"${value}"`;
  });
  // cmd /s /c 需要包住整段余下参数的外层引号；首尾分置可保持参数数组边界。
  quotedTokens[0] = `"${quotedTokens[0]}`;
  quotedTokens[quotedTokens.length - 1] = `${quotedTokens[quotedTokens.length - 1]}"`;
  return {
    executable: process.env.ComSpec,
    executableArgs: ["/d", "/v:off", "/s", "/c", ...quotedTokens],
    windowsVerbatimArguments: true,
  };
}

function run(name, cwd, command, args) {
  process.stdout.write(`\n[Electron 打包链] ${name}\n`);
  const environment = createElectronBuilderEnvironment(process.env);
  prepareLegacyWinCodeSignCache(environment);
  // Node 24 在 Windows 不能直接 spawn .cmd；仅批处理经参数化 ComSpec 启动。
  const invocation = resolveCommandInvocation(command, args);
  const result = spawnSync(invocation.executable, invocation.executableArgs, {
    cwd,
    env: environment,
    stdio: "inherit",
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) throw new Error(`${name} 无法启动：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${name} 失败，退出码 ${result.status}`);
}

// 导出真实命令入口供发布合同执行受控的 Windows 批处理参数回归。
export { run as runCommand };

export function resolveYarnCommand(hostPlatform = process.platform) {
  // Windows 需要批处理入口；macOS 与 Linux 直接执行无后缀的 Yarn 可执行文件。
  return hostPlatform === "win32" ? "yarn.cmd" : "yarn";
}

function removeElectronOutput(electronOutput) {
  assertFixedLayout();
  // 只删除本项目明确的 Electron 输出目录，失败后不会遗留旧 EXE 冒充新产物。
  rmSync(electronOutput, { recursive: true, force: true });
}

function resolveInstallerArtifact(electronOutput) {
  const candidates = readdirSync(electronOutput)
    .filter((name) => /-setup\.exe$/i.test(name));
  if (candidates.length !== 1) {
    throw new Error(`最终 NSIS 安装包数量异常：${candidates.length}`);
  }
  return path.join(electronOutput, candidates[0]);
}

export function parsePackageTarget(
  argv,
  hostPlatform = process.platform,
  hostArch = process.arch,
) {
  let installer = false;
  let targetId;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--installer") {
      if (installer) throw new Error("--installer 不得重复");
      installer = true;
      continue;
    }
    if (argument === "--target") {
      if (targetId || !argv[index + 1]) throw new Error("--target 必须且只能声明一次");
      targetId = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`不支持的打包参数：${argument}`);
  }
  if (!installer) throw new Error("原生发布目标必须使用 --installer");
  const resolvedTargetId = targetId ?? resolveReleaseTargetId(hostPlatform, hostArch);
  const target = resolveReleaseTarget(resolvedTargetId);
  if (target.processPlatform !== hostPlatform) {
    throw new Error(`Runner 本机平台不能构建目标 ${resolvedTargetId}`);
  }
  if (target.arch !== hostArch) {
    throw new Error(`Runner 本机架构不能构建目标 ${resolvedTargetId}`);
  }
  return {
    targetId: target.id,
    builderPlatform: target.builderPlatform,
    arch: target.arch,
    installer: true,
  };
}

export function resolveNativePackageLayout(targetId, electronOutput) {
  const target = resolveReleaseTarget(targetId);
  if (target.platform === "windows") {
    return {
      packageRoot: path.join(electronOutput, "win-unpacked"),
      resourcesRelativePath: "resources",
      executableRelativePath: "天将漫创.exe",
    };
  }
  if (target.platform === "linux") {
    return {
      // electron-builder 仅给非 x64 Linux unpacked 目录追加架构后缀。
      packageRoot: path.join(
        electronOutput,
        target.arch === "x64" ? "linux-unpacked" : `linux-${target.arch}-unpacked`,
      ),
      resourcesRelativePath: "resources",
      // LinuxPackager 默认用 package.json 的 name 生成内部可执行文件名。
      executableRelativePath: "tianjiang",
    };
  }

  const candidates = readdirSync(electronOutput, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
    .map((entry) => path.join(
      electronOutput,
      entry.name,
      "天将漫创.app",
      "Contents",
    ))
    .filter((candidate) => existsSync(candidate));
  if (candidates.length !== 1) {
    throw new Error(`macOS .app Contents 目录数量异常：${candidates.length}`);
  }
  return {
    packageRoot: candidates[0],
    resourcesRelativePath: "Resources",
    executableRelativePath: "MacOS/天将漫创",
  };
}

/**
 * 生成单一矩阵目标的 electron-builder 参数。
 * Linux 必须显式固定公开架构名；builder 默认会把 x64 展开为 x86_64，
 * 与发布 metadata、blockmap 和下载合同使用的 x64 名称不一致。
 */
export function resolveElectronBuilderArguments({
  targetId,
  outputDirectory,
  signingMode = "unsigned",
} = {}) {
  const target = resolveReleaseTarget(targetId);
  if (typeof outputDirectory !== "string" || !path.isAbsolute(outputDirectory)) {
    throw new Error("Electron builder 输出目录必须是绝对路径");
  }
  if (signingMode !== "signed" && signingMode !== "unsigned") {
    throw new Error("Electron builder 签名模式只允许 signed 或 unsigned");
  }
  const argumentsList = [
    "electron-builder",
    `--${target.builderPlatform}`,
    `--${target.arch}`,
    "--config.directories.output",
    outputDirectory,
  ];
  if (target.platform === "linux") {
    argumentsList.push(
      "--config.linux.artifactName",
      `\${productName}-\${version}-linux-${target.arch}.\${ext}`,
    );
  }
  if (target.platform === "macos" && signingMode === "signed") {
    // 凭据只存在环境变量；命令行仅启用签名与公证能力，绝不携带证书或口令内容。
    argumentsList.push(
      "--config.mac.identity=Developer ID Application",
      "--config.mac.hardenedRuntime=true",
      "--config.mac.notarize=true",
    );
  }
  return argumentsList;
}

export function resolveSigningMode(environment = process.env, targetId) {
  const target = resolveReleaseTarget(targetId);
  const signingMode = String(environment.TIANJIANG_SIGNING_MODE ?? "unsigned").trim().toLowerCase();
  if (signingMode !== "signed" && signingMode !== "unsigned") {
    throw new Error("Electron builder 签名模式只允许 signed 或 unsigned");
  }
  if (signingMode === "signed") {
    const required = target.platform === "windows"
      ? ["CSC_LINK", "CSC_KEY_PASSWORD"]
      : target.platform === "macos"
        ? ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]
        : [];
    const missing = required.filter((name) => !String(environment[name] ?? "").trim());
    if (missing.length > 0) throw new Error(`签名凭据缺失：${missing.join(", ")}`);
  }
  return signingMode;
}

/**
 * 从最终 NSIS setup.exe 反向提取运行库并复算摘要，禁止只验证旁边的 win-unpacked。
 */
export function verifyInstallerRuntime(setupPath, expectedSha256) {
  if (!existsSync(setupPath) || path.extname(setupPath).toLowerCase() !== ".exe") {
    throw new Error("最终 NSIS 安装包不存在");
  }
  const temporaryRoot = resolveProjectTemporaryRoot();
  const extractionRoot = mkdtempSync(
    path.join(temporaryRoot, "tj-nsis-runtime-"),
  );
  try {
    const archiveEntry = "resources\\prerequisites\\vc_redist.x64.exe";
    const result = spawnSync(
      createElectronBuilderEnvironment(process.env).SZA_PATH,
      ["x", "-y", `-o${extractionRoot}`, setupPath, archiveEntry],
      {
        encoding: "utf8",
        shell: false,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `最终 NSIS 安装包运行库提取失败：${result.status ?? result.error?.message}`,
      );
    }
    const extractedPath = path.join(
      extractionRoot,
      "resources",
      "prerequisites",
      "vc_redist.x64.exe",
    );
    const extractedRuntime = verifyVcRuntimeArtifact(extractedPath);
    if (extractedRuntime.sha256 !== expectedSha256) {
      throw new Error("最终 NSIS 安装包内 VC++ 运行库摘要与已验证官方文件不一致");
    }
    return extractedRuntime;
  } finally {
    const realTempRoot = resolveProjectTemporaryRoot();
    const realExtractionRoot = realpathSync(extractionRoot);
    if (
      isStrictDescendant(realTempRoot, realExtractionRoot)
      && path.basename(realExtractionRoot).startsWith("tj-nsis-runtime-")
    ) {
      rmSync(realExtractionRoot, { recursive: true, force: true });
    }
  }
}

export async function packageElectron({ targetId, installer = true } = {}) {
  assertFixedLayout();
  if (installer !== true) throw new Error("原生发布链只允许生成 installer 产物");
  const resolvedTargetId = targetId ?? resolveReleaseTargetId(process.platform, process.arch);
  const target = resolveReleaseTarget(resolvedTargetId);
  if (target.processPlatform !== process.platform || target.arch !== process.arch) {
    throw new Error(`只允许 Runner 构建本机平台和声明架构：${resolvedTargetId}`);
  }
  const electronOutput = resolveElectronOutput();
  const webSource = resolveWebDist(electronOutput);
  // 全链路只解析一次，确保每个 Yarn 子命令遵循同一平台规则。
  const yarnCommand = resolveYarnCommand();
  const signingMode = resolveSigningMode(process.env, target.id);
  try {
    removeElectronOutput(electronOutput);
    if (signingMode === "unsigned") {
      const unsignedContract = assertUnsignedBuilderContract({ targetId: target.id });
      process.stdout.write(
        `[Electron 打包链] 产品未签名合同通过：${JSON.stringify(unsignedContract)}\n`,
      );
    } else {
      process.stdout.write(`[Electron 打包链] ${target.platform} 已启用云端签名模式\n`);
    }
    if (webSource.testOverride) {
      // 负向夹具先完成真实 Web 门禁，失败时绝不运行或改写正式业务前端构建。
      validateWebRoot(webSource.path);
    }
    run("业务前端 Node 合同测试", webRoot, process.execPath, [
      "--test",
      "test/tianjiang/*.test.mjs",
    ]);
    run("业务前端 Vue 行为测试", webRoot, yarnCommand, ["test:tianjiang-ui"]);
    run("业务前端类型检查", webRoot, yarnCommand, ["type-check"]);
    run("业务前端严格 i18n 门禁", webRoot, yarnCommand, ["i18n:check"]);
    run("业务前端生产构建", webRoot, yarnCommand, ["build"]);

    const webDist = webSource.path;
    syncWeb(webDist, electronWeb);
    verifySync(webDist, electronWeb);

    run("Electron Node 与主进程构建", appRoot, yarnCommand, ["build"]);
    // router.ts 属于受控生成物且不入库，干净工作树必须先生成再做完整类型检查。
    run("Electron 类型检查", appRoot, yarnCommand, ["lint"]);
    // Web 联合门禁需要 Node ABI；进入 Electron 原生产物阶段前再显式切换原生模块 ABI。
    run("Electron 原生 ABI 重建", appRoot, yarnCommand, ["native:electron"]);
    run("Electron 原生 ABI 验证", appRoot, yarnCommand, ["native:verify:electron"]);
    if (!existsSync(path.join(appRoot, "data", "serve", "app.js"))) {
      throw new Error("Electron 构建未生成 data/serve/app.js");
    }
    let preparedRuntime = null;
    if (target.id === "windows-x64") {
      // 只有 Windows 产物携带微软官方 VC++ 前置包，并保留既有 Authenticode 验证。
      const preparedRuntimePath = await prepareVcRuntime();
      preparedRuntime = verifyVcRuntimeArtifact(preparedRuntimePath);
    }
    run(
      `Electron ${target.id} 原生产物构建`,
      appRoot,
      yarnCommand,
      resolveElectronBuilderArguments({
        targetId: target.id,
        outputDirectory: electronOutput,
        signingMode,
      }),
    );
    if (target.platform === "linux") {
      const appImage = path.join(
        electronOutput,
        `天将漫创-${packageVersion}-linux-${target.arch}.AppImage`,
      );
      // electron-builder 的 AppImage 默认使用内嵌 blockmap；发布合同另需外置文件。
      run("Linux 外置 blockmap 生成", appRoot, appBuilderPath, [
        "blockmap",
        "--input",
        appImage,
        "--output",
        `${appImage}.blockmap`,
      ]);
    }
    const normalizationEvidence = normalizeReleaseTargetArtifacts({
      targetId: target.id,
      outputDirectory: electronOutput,
      version: packageVersion,
    });
    process.stdout.write(
      `[Electron 打包链] builder 差异产物归一化完成：${JSON.stringify(normalizationEvidence)}\n`,
    );
    const releaseEvidence = verifyReleaseTarget({
      targetId: target.id,
      outputDirectory: electronOutput,
      version: packageVersion,
    });
    process.stdout.write(
      `[Electron 打包链] 原生产物集合硬门通过：${JSON.stringify(releaseEvidence)}\n`,
    );

    const packageLayout = resolveNativePackageLayout(target.id, electronOutput);
    if (target.id === "windows-x64") {
      const embeddedRuntime = verifyVcRuntimeArtifact(
        path.join(
          packageLayout.packageRoot,
          packageLayout.resourcesRelativePath,
          "prerequisites",
          "vc_redist.x64.exe",
        ),
      );
      if (!preparedRuntime || embeddedRuntime.sha256 !== preparedRuntime.sha256) {
        throw new Error("最终 Electron 产物中的 VC++ 运行库与已验证官方文件摘要不一致");
      }
      const setupPath = resolveInstallerArtifact(electronOutput);
      verifyInstallerRuntime(setupPath, preparedRuntime.sha256);
      process.stdout.write(`[Electron 打包链] 最终 NSIS 运行库反向提取验证通过：${setupPath}\n`);
      const structureEvidence = verifyInstallerArchiveStructure(
        setupPath,
        packageLayout.packageRoot,
      );
      process.stdout.write(
        `[Electron 打包链] 最终 NSIS 不提权结构验证通过：${JSON.stringify(structureEvidence)}\n`,
      );
      const metadataEvidence = verifyWindowsArtifactMetadata({
        mainExecutable: path.join(packageLayout.packageRoot, "天将漫创.exe"),
        installerExecutable: setupPath,
        expectedVersion: packageVersion,
      });
      process.stdout.write(
        `[Electron 打包链] Windows EXE 元数据、图标与签名状态验证通过：${JSON.stringify(metadataEvidence)}\n`,
      );
    }
    await verifyPackage(packageLayout.packageRoot, webDist, {
      resourcesRelativePath: packageLayout.resourcesRelativePath,
      executableRelativePath: packageLayout.executableRelativePath,
    });
    process.stdout.write(`[Electron 打包链] 完整产物验证通过：${packageLayout.packageRoot}\n`);
  } catch (error) {
    // 任一步失败都清除本轮不完整输出，禁止留下看似可运行的陈旧 EXE。
    removeElectronOutput(electronOutput);
    throw error;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const target = parsePackageTarget(process.argv.slice(2));
    packageElectron(target).catch((error) => {
      process.stderr.write(
        `[Electron 打包链] ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
  } catch (error) {
    process.stderr.write(
      `[Electron 打包链] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
