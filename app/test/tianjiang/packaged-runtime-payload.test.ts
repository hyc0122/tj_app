import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import {
  syncWeb,
  verifyPackage,
  verifyPackagedBuiltinSkills,
  verifyPackagedSharedModels,
} from "../../scripts/package-web-assets.mjs";

const fixtureRoot = path.resolve("..", ".tmp", "packaged-runtime-payload-fixture");
const require = createRequire(path.join(process.cwd(), "package.json"));
const { createPackage } = require("@electron/asar") as {
  createPackage: (source: string, destination: string) => Promise<void>;
};

const VALID_UPDATER_MAIN_SOURCE = `
"electron-updater";
const disableDifferentialDownload = true;
function bindManualUpdateService() {}
class ManualUpdaterService {
  async performAction(body) {
    switch (body.action) {
      case "install": {
        const candidate = this.downloadedCandidate;
        const installVerified = await this.deps.verifyDownloadedArtifact({
          filePath: candidate.filePath,
          channel: candidate.channel,
          size: candidate.size,
          sha256: candidate.sha256,
        });
        if (!installVerified) throw new Error("安装前二次校验失败");
        if (this.deps.prepareInstallShutdown) {
          await this.deps.prepareInstallShutdown();
        } else {
          await this.deps.finalizeInstallShutdown();
          await this.deps.prepareInstall();
        }
        const installerPath = candidate.filePath;
        try {
          await this.deps.launchVerifiedInstaller(installerPath);
        } catch (error) {
          await this.deps.recoverAfterInstallerLaunchFailure?.(error);
          throw error;
        }
        this.deps.scheduleApplicationQuit();
        break;
      }
    }
  }
}
async function launchVerifiedInstallerWithShell(filePath, openPath) {
  const launchError = await openPath(filePath);
  if (launchError.length > 0) throw new Error(launchError);
}
const service = createDesktopManualUpdater({
  prepareInstall: async () => undefined,
  prepareInstallShutdown: async () => {
    detachCurrentServeRequest();
    quitIntent.markInstallUpdate();
    await shutdownGate.prepareForInstaller(async () => {
      await protectUserDataBeforeUpdate({ userDataRoot: app.getPath("userData") });
    });
  },
  launchVerifiedInstaller: async (filePath) => {
    await launchVerifiedInstallerWithShell(filePath, (verifiedPath) => shell.openPath(verifiedPath));
  },
  recoverAfterInstallerLaunchFailure: async () => {
    console.error("launch failed");
    await dialog.showMessageBox({ message: "重新启动" });
    app.relaunch();
    app.quit();
  },
  finalizeInstallShutdown: async () => {
    throw new Error("安装关闭流程未使用统一退出门");
  },
  scheduleApplicationQuit: () => {
    setImmediate(() => app.quit());
  },
});
void disableDifferentialDownload;
void bindManualUpdateService;
void ManualUpdaterService;
void service;
`;

test("实包内置 Skills 必须按非空清单逐文件反向校验 SHA-256", () => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  const skillRoot = path.join(
    fixtureRoot,
    "resources",
    "data",
    "builtin-skills",
    "workflow",
  );
  fs.mkdirSync(skillRoot, { recursive: true });
  const content = "# 工作流\n";
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), content, "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  fs.writeFileSync(
    path.join(fixtureRoot, "resources", "data", "builtin-skills-manifest.json"),
    `${JSON.stringify({
      version: 1,
      files: [{ path: "workflow/SKILL.md", version: "1.0.0", sha256 }],
    })}\n`,
    "utf8",
  );

  try {
    assert.deepEqual(verifyPackagedBuiltinSkills(fixtureRoot), {
      manifestVersion: 1,
      fileCount: 1,
      verifiedSha256Count: 1,
    });
    fs.writeFileSync(path.join(skillRoot, "SKILL.md"), "已篡改", "utf8");
    assert.throws(
      () => verifyPackagedBuiltinSkills(fixtureRoot),
      /SHA-256 不一致/,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("实包更新源必须落在版本化 native metadata 发布目录", async () => {
  const packageVerifier = await import("../../scripts/package-web-assets.mjs");
  const parsePackagedUpdateFeedURL = (packageVerifier as any).parsePackagedUpdateFeedURL;
  assert.equal(typeof parsePackagedUpdateFeedURL, "function");
  assert.equal(
    parsePackagedUpdateFeedURL([
      "provider: generic",
      "url: https://updates.example.test/desktop/stable/windows/x64",
    ].join("\n")),
    "https://updates.example.test/desktop/stable/windows/x64",
  );
  assert.equal(
    parsePackagedUpdateFeedURL(
      "provider: generic\nurl: https://updates.example.test/desktop/beta/macos/arm64\n",
    ),
    "https://updates.example.test/desktop/beta/macos/arm64",
  );
  assert.equal(
    parsePackagedUpdateFeedURL(
      "provider: generic\nurl: https://updates.example.test/desktop/beta/linux/x64\n",
    ),
    "https://updates.example.test/desktop/beta/linux/x64",
  );
  assert.throws(
    () => parsePackagedUpdateFeedURL("provider: generic\nurl: https://api.j11.com.cn/client-updates\n"),
    /desktop\/(?:stable|beta)\/windows\/x64|发布目录/,
  );
  assert.throws(
    () => parsePackagedUpdateFeedURL(
      "provider: generic\nurl: https://updates.example.test/archive/desktop/stable/windows/x64\n",
    ),
    /发布目录/,
  );
});

async function createPackageLayoutFixture(
  name: string,
  resourcesRelativePath: string,
  executableRelativePath: string,
  mainSource: string = VALID_UPDATER_MAIN_SOURCE,
): Promise<{ packageRoot: string; webSource: string }> {
  const packageRoot = path.join(fixtureRoot, name, "package");
  const webSource = path.join(fixtureRoot, name, "web-source");
  const resourcesRoot = path.join(packageRoot, ...resourcesRelativePath.split("/"));
  const executable = path.join(packageRoot, ...executableRelativePath.split("/"));
  fs.mkdirSync(webSource, { recursive: true });
  fs.writeFileSync(path.join(webSource, "index.html"), "<main>天将漫创</main>", "utf8");
  fs.mkdirSync(resourcesRoot, { recursive: true });
  syncWeb(webSource, path.join(resourcesRoot, "data", "web"));

  const skillContent = "# 工作流\n";
  const skillPath = path.join(resourcesRoot, "data", "builtin-skills", "workflow", "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, skillContent, "utf8");
  fs.writeFileSync(
    path.join(resourcesRoot, "data", "builtin-skills-manifest.json"),
    `${JSON.stringify({
      version: 1,
      files: [{
        path: "workflow/SKILL.md",
        version: "1.0.0",
        size: Buffer.byteLength(skillContent),
        sha256: createHash("sha256").update(skillContent).digest("hex"),
      }],
    })}\n`,
    "utf8",
  );

  // 共享模型六件套夹具（不拷贝真实 45MB ONNX，使用同名小文件满足结构门）。
  const modelFiles = [
    "all-MiniLM-L6-v2/config.json",
    "all-MiniLM-L6-v2/special_tokens_map.json",
    "all-MiniLM-L6-v2/tokenizer_config.json",
    "all-MiniLM-L6-v2/tokenizer.json",
    "all-MiniLM-L6-v2/vocab.txt",
    "all-MiniLM-L6-v2/onnx/model_fp16.onnx",
  ];
  for (const relative of modelFiles) {
    const absolute = path.join(resourcesRoot, "data", "models", ...relative.split("/"));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `fixture:${relative}`, "utf8");
  }

  const serverPath = path.join(resourcesRoot, "data", "serve", "app.js");
  fs.mkdirSync(path.dirname(serverPath), { recursive: true });
  fs.writeFileSync(
    serverPath,
    [
      "bindManualUpdateService",
      "/api/setting/about/checkUpdate",
      "/api/setting/about/downloadApp",
      "download-differential",
      "download-full",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(resourcesRoot, "app-update.yml"),
    "provider: generic\nurl: https://updates.example.test/desktop/beta/windows/x64\n",
    "utf8",
  );

  const asarSource = path.join(fixtureRoot, name, "asar-source");
  const updaterPackagePath = path.join(asarSource, "node_modules", "electron-updater", "package.json");
  const mainPath = path.join(asarSource, "build", "main.js");
  fs.mkdirSync(path.dirname(updaterPackagePath), { recursive: true });
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.writeFileSync(updaterPackagePath, '{"version":"6.8.9"}\n', "utf8");
  fs.writeFileSync(
    mainPath,
    mainSource,
    "utf8",
  );
  await createPackage(asarSource, path.join(resourcesRoot, "app.asar"));
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "native-executable", "utf8");
  return { packageRoot, webSource };
}

test("实包共享模型六件套门禁", () => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  const packageRoot = path.join(fixtureRoot, "models-only");
  const modelsRoot = path.join(packageRoot, "resources", "data", "models");
  const required = [
    "all-MiniLM-L6-v2/config.json",
    "all-MiniLM-L6-v2/special_tokens_map.json",
    "all-MiniLM-L6-v2/tokenizer_config.json",
    "all-MiniLM-L6-v2/tokenizer.json",
    "all-MiniLM-L6-v2/vocab.txt",
    "all-MiniLM-L6-v2/onnx/model_fp16.onnx",
  ];
  try {
    for (const relative of required) {
      const absolute = path.join(modelsRoot, ...relative.split("/"));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, relative, "utf8");
    }
    const evidence = verifyPackagedSharedModels(packageRoot);
    assert.equal(evidence.fileCount, 6);
    fs.rmSync(path.join(modelsRoot, "all-MiniLM-L6-v2", "onnx", "model_fp16.onnx"), { force: true });
    assert.throws(() => verifyPackagedSharedModels(packageRoot), /共享模型|不存在/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("包内容门支持 Windows、macOS 与 Linux 的受控资源布局", async () => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  const layouts = [
    { name: "windows", resources: "resources", executable: "天将漫创.exe" },
    { name: "macos", resources: "Resources", executable: "MacOS/天将漫创" },
    { name: "linux", resources: "resources", executable: "天将漫创" },
  ];
  try {
    for (const layout of layouts) {
      const fixture = await createPackageLayoutFixture(
        layout.name,
        layout.resources,
        layout.executable,
      );
      const evidence = await verifyPackage(fixture.packageRoot, fixture.webSource, {
        resourcesRelativePath: layout.resources,
        executableRelativePath: layout.executable,
      });
      assert.equal(
        evidence.executable,
        path.join(fixture.packageRoot, ...layout.executable.split("/")),
      );
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("实包更新结构门拒绝关键词伪装和不安全调用关系", async (t) => {
  const keywordOnly = `console.info("electron-updater disableDifferentialDownload launchVerifiedInstaller openPath bindManualUpdateService");`;
  const unsafeQuitAndInstall = VALID_UPDATER_MAIN_SOURCE.replace(
    "          await this.deps.launchVerifiedInstaller(installerPath);",
    "this.deps.autoUpdater.quitAndInstall();",
  );
  const launchWithoutAwait = VALID_UPDATER_MAIN_SOURCE.replace(
    "const launchError = await openPath(filePath);",
    "const launchError = openPath(filePath);",
  );
  const mainLauncherWithoutAwait = VALID_UPDATER_MAIN_SOURCE.replace(
    "await launchVerifiedInstallerWithShell(filePath, (verifiedPath) => shell.openPath(verifiedPath));",
    "launchVerifiedInstallerWithShell(filePath, (verifiedPath) => shell.openPath(verifiedPath));",
  );
  const quitBeforeLaunch = VALID_UPDATER_MAIN_SOURCE.replace(
    "        try {\n          await this.deps.launchVerifiedInstaller(installerPath);",
    "        this.deps.scheduleApplicationQuit();\n        try {\n          await this.deps.launchVerifiedInstaller(installerPath);",
  );
  const missingOpenPathRejection = VALID_UPDATER_MAIN_SOURCE.replace(
    "if (launchError.length > 0) throw new Error(launchError);",
    "if (launchError.length > 0) console.error(launchError);",
  );
  const deadBranchLaunch = VALID_UPDATER_MAIN_SOURCE.replace(
    "          await this.deps.launchVerifiedInstaller(installerPath);",
    "if (false) await this.deps.launchVerifiedInstaller(installerPath);",
  );
  const nestedDeadThrow = VALID_UPDATER_MAIN_SOURCE.replace(
    "if (launchError.length > 0) throw new Error(launchError);",
    "if (launchError.length > 0) { if (false) throw new Error(launchError); }",
  );
  const conditionalQuit = VALID_UPDATER_MAIN_SOURCE.replace(
    "this.deps.scheduleApplicationQuit();",
    "if (installVerified) this.deps.scheduleApplicationQuit();",
  );
  const swallowedLaunch = VALID_UPDATER_MAIN_SOURCE.replace(
    /        try \{[\s\S]*?        \}\n        this\.deps\.scheduleApplicationQuit\(\);/,
    "        try { await this.deps.launchVerifiedInstaller(installerPath); } catch {}\n        this.deps.scheduleApplicationQuit();",
  );
  const earlyReturnBeforeLaunch = VALID_UPDATER_MAIN_SOURCE.replace(
    "          await this.deps.launchVerifiedInstaller(installerPath);",
    "          if (shouldAbort) return;\n          await this.deps.launchVerifiedInstaller(installerPath);",
  );
  const earlyBreakBeforeLaunch = VALID_UPDATER_MAIN_SOURCE.replace(
    "          await this.deps.launchVerifiedInstaller(installerPath);",
    "          break;\n          await this.deps.launchVerifiedInstaller(installerPath);",
  );
  const earlyContinueBeforeLaunch = VALID_UPDATER_MAIN_SOURCE.replace(
    "          await this.deps.launchVerifiedInstaller(installerPath);",
    "          continue;\n          await this.deps.launchVerifiedInstaller(installerPath);",
  );
  const wrongVerifyCandidateArgument = VALID_UPDATER_MAIN_SOURCE.replace(
    "size: candidate.size,",
    "size: candidate.size + 1,",
  );
  const unreachableFailureThrow = VALID_UPDATER_MAIN_SOURCE.replace(
    'if (!installVerified) throw new Error("安装前二次校验失败");',
    'if (!installVerified) { break; throw new Error("安装前二次校验失败"); }',
  );
  const missingSecondVerify = VALID_UPDATER_MAIN_SOURCE.replace(
    /        const installVerified = await this\.deps\.verifyDownloadedArtifact\(\{[\s\S]*?        if \(!installVerified\) throw new Error\("安装前二次校验失败"\);\n/,
    "",
  );
  const quitWithoutIrreversibleShutdown = VALID_UPDATER_MAIN_SOURCE.replace(
    "          await this.deps.prepareInstallShutdown();\n",
    "",
  );
  const unreachableMainLauncher = VALID_UPDATER_MAIN_SOURCE.replace(
    "    await launchVerifiedInstallerWithShell(filePath, (verifiedPath) => shell.openPath(verifiedPath));",
    "    return;\n    await launchVerifiedInstallerWithShell(filePath, (verifiedPath) => shell.openPath(verifiedPath));",
  );
  const unreachableDeferredQuit = VALID_UPDATER_MAIN_SOURCE.replace(
    "    setImmediate(() => app.quit());",
    "    return;\n    setImmediate(() => app.quit());",
  );
  const unreachablePrepareInstallShutdown = VALID_UPDATER_MAIN_SOURCE.replace(
    "    detachCurrentServeRequest();\n    quitIntent.markInstallUpdate();",
    "    return;\n    detachCurrentServeRequest();\n    quitIntent.markInstallUpdate();",
  );
  const unreachableUserDataProtection = VALID_UPDATER_MAIN_SOURCE.replace(
    "      await protectUserDataBeforeUpdate({ userDataRoot: app.getPath(\"userData\") });",
    "      return;\n      await protectUserDataBeforeUpdate({ userDataRoot: app.getPath(\"userData\") });",
  );
  const invalidFixtures = [
    ["keyword-only", keywordOnly],
    ["quit-and-install", unsafeQuitAndInstall],
    ["launch-without-await", launchWithoutAwait],
    ["main-launcher-without-await", mainLauncherWithoutAwait],
    ["quit-before-launch", quitBeforeLaunch],
    ["missing-open-path-rejection", missingOpenPathRejection],
    ["dead-branch-launch", deadBranchLaunch],
    ["nested-dead-throw", nestedDeadThrow],
    ["conditional-quit", conditionalQuit],
    ["swallowed-launch-error", swallowedLaunch],
    ["early-return-before-launch", earlyReturnBeforeLaunch],
    ["early-break-before-launch", earlyBreakBeforeLaunch],
    ["early-continue-before-launch", earlyContinueBeforeLaunch],
    ["wrong-verify-candidate-argument", wrongVerifyCandidateArgument],
    ["unreachable-failure-throw", unreachableFailureThrow],
    ["missing-second-verify", missingSecondVerify],
    ["missing-irreversible-shutdown", quitWithoutIrreversibleShutdown],
    ["unreachable-main-launcher", unreachableMainLauncher],
    ["unreachable-deferred-quit", unreachableDeferredQuit],
    ["unreachable-prepare-install-shutdown", unreachablePrepareInstallShutdown],
    ["unreachable-user-data-protection", unreachableUserDataProtection],
    ["class-name-drift", VALID_UPDATER_MAIN_SOURCE.replace(/ManualUpdaterService/g, "RenamedUpdaterService")],
    ["parse-failure", "class ManualUpdaterService {"],
  ] as const;

  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  try {
    for (const [name, mainSource] of invalidFixtures) {
      await t.test(name, async () => {
        const fixture = await createPackageLayoutFixture(
          `invalid-${name}`,
          "resources",
          "天将漫创.exe",
          mainSource,
        );
        await assert.rejects(
          verifyPackage(fixture.packageRoot, fixture.webSource),
          /结构|安装|launcher|openPath|退出|解析/i,
        );
      });
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("macOS framework 包内安全内链允许但逃逸链接失败关闭", async () => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  try {
    const safeFixture = await createPackageLayoutFixture(
      "mac-framework-safe",
      "Resources",
      "MacOS/天将漫创",
    );
    const versionsRoot = path.join(
      safeFixture.packageRoot,
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
    );
    const versionA = path.join(versionsRoot, "A");
    fs.mkdirSync(path.join(versionA, "Resources"), { recursive: true });
    fs.writeFileSync(path.join(versionA, "Resources", "Info.plist"), "fixture", "utf8");
    // Windows 测试用 junction 模拟 macOS framework 的 Current -> A 目录内链。
    fs.symlinkSync(versionA, path.join(versionsRoot, "Current"), "junction");
    await assert.doesNotReject(
      verifyPackage(safeFixture.packageRoot, safeFixture.webSource, {
        resourcesRelativePath: "Resources",
        executableRelativePath: "MacOS/天将漫创",
      }),
    );

    const escapeFixture = await createPackageLayoutFixture(
      "mac-framework-escape",
      "Resources",
      "MacOS/天将漫创",
    );
    const outsideFramework = path.join(fixtureRoot, "outside-framework");
    const frameworkRoot = path.join(escapeFixture.packageRoot, "Frameworks");
    fs.mkdirSync(outsideFramework, { recursive: true });
    fs.mkdirSync(frameworkRoot, { recursive: true });
    fs.writeFileSync(path.join(outsideFramework, "payload"), "escape", "utf8");
    fs.symlinkSync(
      outsideFramework,
      path.join(frameworkRoot, "Escape.framework"),
      "junction",
    );
    await assert.rejects(
      verifyPackage(escapeFixture.packageRoot, escapeFixture.webSource, {
        resourcesRelativePath: "Resources",
        executableRelativePath: "MacOS/天将漫创",
      }),
      /PKG_PATH_SYMLINK_ESCAPE/,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("包内容门拒绝绝对路径、父目录穿越和符号链接可执行文件", async () => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
  try {
    await assert.rejects(
      verifyPackage(fixtureRoot, fixtureRoot, { resourcesRelativePath: "../resources" }),
      /受控相对路径|父目录|越界/,
    );
    await assert.rejects(
      verifyPackage(fixtureRoot, fixtureRoot, { executableRelativePath: path.resolve("outside.exe") }),
      /受控相对路径|绝对路径|越界/,
    );

    const fixture = await createPackageLayoutFixture("symlink", "resources", "天将漫创.exe");
    const executable = path.join(fixture.packageRoot, "天将漫创.exe");
    const source = path.join(fixture.packageRoot, "native-source");
    fs.mkdirSync(source);
    fs.rmSync(executable);
    fs.symlinkSync(source, executable, "junction");
    await assert.rejects(
      verifyPackage(fixture.packageRoot, fixture.webSource),
      /符号链接/,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
