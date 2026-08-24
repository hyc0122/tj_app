import fs from "node:fs";
import { findApprovedRelease, readApprovedReleaseManifest } from "./approved-release-manifest";
import { readDreaminaRuntimeState } from "./runtime-state-store";
import { readDreaminaCliSettings } from "./session-store";

export interface EnvironmentDependencyStatus {
  id: "dreamina_binary" | "wsl" | "wsl_distribution";
  label: string;
  required: boolean;
  installed: boolean;
  compatible: boolean;
  version?: string;
  path?: string;
  reason?: string;
}

export interface DreaminaEnvironmentSnapshot {
  target: "windows_native" | "wsl";
  dependencies: EnvironmentDependencyStatus[];
  suggestWsl: boolean;
  linuxReleaseAvailable: boolean;
}

/** 中文注释：Windows 原生只声明 dreamina_binary；不得把 Node/Git 写成依赖。 */
export async function probeDreaminaEnvironment(
  target: "windows_native" | "wsl" = "windows_native",
): Promise<DreaminaEnvironmentSnapshot> {
  const runtime = await readDreaminaRuntimeState();
  const settings = await readDreaminaCliSettings().catch(() => null);
  const { recoverManagedDreaminaInstall } = await import("./managed-installer");
  recoverManagedDreaminaInstall();
  const executablePath = runtime.executablePath ?? settings?.executablePath ?? null;
  const pathExists = Boolean(executablePath && fs.existsSync(executablePath) && fs.statSync(executablePath).isFile());
  const installed = runtime.install.state === "installed" && pathExists;
  let linuxReleaseAvailable = false;
  try {
    linuxReleaseAvailable = Boolean(findApprovedRelease(readApprovedReleaseManifest(), "linux-x64"));
  } catch {
    linuxReleaseAvailable = false;
  }
  const binary: EnvironmentDependencyStatus = {
    id: "dreamina_binary",
    label: "即梦 CLI",
    required: true,
    installed,
    compatible: runtime.install.state !== "failed",
    version: runtime.install.version ?? undefined,
    path: executablePath ?? undefined,
    reason: runtime.install.reason,
  };
  if (target === "windows_native") {
    return {
      target,
      dependencies: [binary],
      // 中文注释：未分类为 platform_incompatible 时禁止建议 WSL。
      suggestWsl: false,
      linuxReleaseAvailable,
    };
  }
  return {
    target,
    dependencies: [
      binary,
      {
        id: "wsl",
        label: "WSL",
        required: true,
        installed: false,
        compatible: false,
        reason: "尚未检测 WSL",
      },
    ],
    suggestWsl: false,
    linuxReleaseAvailable,
  };
}
