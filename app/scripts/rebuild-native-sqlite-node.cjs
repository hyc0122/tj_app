const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const verifyScript = path.join(__dirname, "verify-native-sqlite.cjs");
const yarnCommand = process.platform === "win32" ? "yarn.cmd" : "yarn";

const requiredPackages = Object.freeze({
  "better-sqlite3": Object.freeze({
    version: "12.9.0",
    installScript: "prebuild-install || node-gyp rebuild --release",
  }),
  sqlite3: Object.freeze({
    version: "6.0.1",
    installScript: "prebuild-install -r napi || node-gyp rebuild",
  }),
});

function resolveCommandInvocation(command, args) {
  const isWindowsBatch =
    process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
  if (!isWindowsBatch) {
    return {
      executable: command,
      executableArgs: args,
      windowsVerbatimArguments: false,
    };
  }
  if (!process.env.ComSpec) throw new Error("Windows 批处理缺少 ComSpec");

  const quotedTokens = [command, ...args].map((value) => {
    if (/\0|\r|\n|%|"/.test(value)) {
      throw new Error("原生模块恢复命令含不支持的控制字符、百分号或双引号");
    }
    return `"${value}"`;
  });
  // Node 24 不能直接 spawn .cmd；外层引号仅交给参数化 ComSpec 解析。
  quotedTokens[0] = `"${quotedTokens[0]}`;
  quotedTokens[quotedTokens.length - 1] =
    `${quotedTokens[quotedTokens.length - 1]}"`;
  return {
    executable: process.env.ComSpec,
    executableArgs: ["/d", "/v:off", "/s", "/c", ...quotedTokens],
    windowsVerbatimArguments: true,
  };
}

function executeCommand(command) {
  let executable;
  let args;
  let cwd = appRoot;

  switch (command.kind) {
    case "full-install":
      executable = yarnCommand;
      args = ["install", "--force", "--frozen-lockfile", "--non-interactive"];
      break;
    case "verify-all":
      executable = process.execPath;
      args = [verifyScript, "node"];
      break;
    case "verify-one":
      executable = process.execPath;
      args = [verifyScript, "node", command.packageName];
      break;
    case "targeted-rebuild":
      executable = yarnCommand;
      args = ["run", "install"];
      cwd = path.join(appRoot, "node_modules", command.packageName);
      break;
    default:
      throw new Error(`未知原生模块恢复步骤：${command.kind}`);
  }

  process.stdout.write(`\n[Node ABI 137 恢复] ${command.name}\n`);
  const invocation = resolveCommandInvocation(executable, args);
  const result = spawnSync(invocation.executable, invocation.executableArgs, {
    cwd,
    env: process.env,
    stdio: "inherit",
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) {
    throw new Error(`${command.name} 无法启动：${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`${command.name} 被信号终止：${result.signal}`);
  }
  return result.status ?? 1;
}

function readInstalledPackage(packageName) {
  const manifestPath = path.join(
    appRoot,
    "node_modules",
    packageName,
    "package.json",
  );
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function assertPinnedInstallContract(packageName, manifest) {
  const expected = requiredPackages[packageName];
  if (!expected) throw new Error(`拒绝恢复非固定原生依赖：${packageName}`);
  if (manifest.version !== expected.version) {
    throw new Error(
      `${packageName} 固定版本漂移：期望 ${expected.version}，实际 ${manifest.version ?? "缺失"}`,
    );
  }
  if (manifest.scripts?.install !== expected.installScript) {
    throw new Error(
      `${packageName} install 脚本漂移，拒绝执行目标化恢复`,
    );
  }
}

function runNativeNodeRecovery({
  runCommand = executeCommand,
  readInstalledPackage: readPackage = readInstalledPackage,
} = {}) {
  const installStatus = runCommand({
    kind: "full-install",
    name: "Yarn 1 frozen 强制安装",
  });
  if (installStatus !== 0) {
    throw new Error(`Yarn 1 frozen 强制安装失败，退出码 ${installStatus}`);
  }

  const initialVerifyStatus = runCommand({
    kind: "verify-all",
    name: "首次实际加载 better-sqlite3 与 sqlite3",
  });
  if (initialVerifyStatus === 0) return 0;

  // Yarn 1 只观察生命周期子进程退出码，不保证预构建产物仍存在或 ABI 可加载。
  const failedPackages = Object.keys(requiredPackages).filter(
    (packageName) =>
      runCommand({
        kind: "verify-one",
        name: `定位 ${packageName} Node ABI 137`,
        packageName,
      }) !== 0,
  );
  if (failedPackages.length === 0) {
    throw new Error(
      `双模块首次验证失败（退出码 ${initialVerifyStatus}），但固定依赖单项验证均通过，拒绝盲目重建`,
    );
  }

  for (const packageName of failedPackages) {
    const manifest = readPackage(packageName);
    assertPinnedInstallContract(packageName, manifest);
    const rebuildStatus = runCommand({
      kind: "targeted-rebuild",
      name: `目标化恢复 ${packageName}（最多一次）`,
      packageName,
    });
    if (rebuildStatus !== 0) {
      throw new Error(
        `${packageName} 目标化恢复失败，退出码 ${rebuildStatus}；已停止，不会无限重试`,
      );
    }
  }

  const finalVerifyStatus = runCommand({
    kind: "verify-all",
    name: "有界恢复后再次实际加载双模块",
  });
  if (finalVerifyStatus !== 0) {
    throw new Error(
      `有界恢复后仍无法由 Node ABI 137 实际加载：${failedPackages.join(", ")}；退出码 ${finalVerifyStatus}`,
    );
  }
  return 0;
}

module.exports = {
  assertPinnedInstallContract,
  runNativeNodeRecovery,
};

if (require.main === module) {
  try {
    process.exitCode = runNativeNodeRecovery();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
