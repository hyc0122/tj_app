import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verificationScript = path.join(
  appRoot,
  "scripts",
  "verify-windows-artifact-metadata.ps1",
);
const iconPath = path.join(appRoot, "scripts", "logo.ico");
const packageVersion = JSON.parse(
  readFileSync(path.join(appRoot, "package.json"), "utf8"),
).version;

/**
 * 通过 Windows 原生版本资源和图标 API 验证最终主程序、安装器与卸载器。
 */
export function verifyWindowsArtifactMetadata({
  mainExecutable,
  installerExecutable,
  uninstallerExecutable = "",
  expectedVersion = packageVersion,
}) {
  const argumentsList = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    verificationScript,
    "-MainExecutable",
    mainExecutable,
    "-InstallerExecutable",
    installerExecutable,
    "-ExpectedVersion",
    expectedVersion,
    "-IconPath",
    iconPath,
  ];
  if (uninstallerExecutable) {
    argumentsList.push("-UninstallerExecutable", uninstallerExecutable);
  }
  const result = spawnSync(
    "pwsh.exe",
    argumentsList,
    {
      cwd: appRoot,
      encoding: "utf8",
      shell: false,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    const summary = result.stderr.trim().split(/\r?\n/)[0] || result.error?.message;
    throw new Error(`Windows EXE 元数据与图标验证失败：${summary}`);
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Windows EXE 元数据验证未返回有效 JSON");
  }
}
