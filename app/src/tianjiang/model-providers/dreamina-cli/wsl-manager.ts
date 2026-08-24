import { spawn } from "node:child_process";

import { writeDreaminaRuntimeState } from "./runtime-state-store";

export type DreaminaNativeFailureClass =
  | "platform_incompatible"
  | "network"
  | "authentication"
  | "account"
  | "arguments"
  | "integrity"
  | "unknown";

export interface WslEnvironmentStatus {
  windowsFeatureAvailable: boolean;
  installed: boolean;
  version: 1 | 2 | null;
  defaultDistribution: string | null;
  distributions: Array<{ name: string; version: 1 | 2; state: string }>;
  rebootRequired: boolean;
  pendingOperation: "none" | "feature_install" | "distribution_install" | "cli_install";
}

type WslExecutor = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

let boundExecutor: WslExecutor | undefined;

export function bindWslExecutor(executor?: WslExecutor): void {
  boundExecutor = executor;
}

export function classifyDreaminaNativeFailure(input: {
  kind?: string;
  message?: string;
  peMachine?: number;
}): { class: DreaminaNativeFailureClass; suggestWsl: boolean } {
  const message = String(input.message ?? "").toLowerCase();
  if (input.peMachine && input.peMachine !== 0x8664) {
    return { class: "platform_incompatible", suggestWsl: true };
  }
  if (input.kind === "platform" || message.includes("not a valid win32") || message.includes("platform")) {
    return { class: "platform_incompatible", suggestWsl: true };
  }
  if (input.kind === "network" || /timeout|econnreset|enotfound|network/.test(message)) {
    return { class: "network", suggestWsl: false };
  }
  if (input.kind === "authentication" || /login|oauth|unauthorized/.test(message)) {
    return { class: "authentication", suggestWsl: false };
  }
  if (input.kind === "account" || /user_credit|balance/.test(message)) {
    return { class: "account", suggestWsl: false };
  }
  if (input.kind === "arguments" || /argument|参数/.test(message)) {
    return { class: "arguments", suggestWsl: false };
  }
  if (input.kind === "integrity" || /checksum|sha-256|sha256/.test(message)) {
    return { class: "integrity", suggestWsl: false };
  }
  return { class: "unknown", suggestWsl: false };
}

async function runWsl(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const file = process.platform === "win32" ? "wsl.exe" : "wsl";
  if (boundExecutor) return boundExecutor(file, args);
  if (process.env.NODE_TEST_CONTEXT) {
    // 中文注释：测试必须显式绑定无害 executor；漏绑时在 child_process.spawn 前失败关闭。
    return { stdout: "", stderr: "test WSL executor is not bound", exitCode: 1 };
  }
  return await new Promise((resolve) => {
    const child = spawn(file, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    child.on("error", () => resolve({ stdout: "", stderr: "wsl unavailable", exitCode: 1 }));
  });
}

export async function probeWslEnvironment(): Promise<WslEnvironmentStatus> {
  const status = await runWsl(["--status"]);
  const list = await runWsl(["-l", "-v"]);
  const text = `${status.stdout}\n${list.stdout}`;
  return {
    windowsFeatureAvailable: status.exitCode === 0 || text.includes("Default"),
    installed: /Ubuntu|Debian|WSL/.test(text),
    version: text.includes("2") ? 2 : text.includes("1") ? 1 : null,
    defaultDistribution: null,
    distributions: [],
    rebootRequired: /reboot|restart/i.test(text),
    pendingOperation: "none",
  };
}

export async function prepareWslInstall(confirm: boolean): Promise<{
  ok: boolean;
  reason?: string;
}> {
  if (confirm !== true) {
    return { ok: false, reason: "安装 WSL 必须由用户二次确认" };
  }
  await writeDreaminaRuntimeState({ pendingOperation: "feature_install" });
  const result = await runWsl(["--install"]);
  if (result.exitCode !== 0) {
    return { ok: false, reason: result.stderr || "WSL 安装未完成" };
  }
  return { ok: true };
}

export async function continueWslInstall(): Promise<{
  repeatedInstall: boolean;
  status: WslEnvironmentStatus;
}> {
  // 中文注释：重启后续办只重新检测，不得再次执行 --install 或改默认发行版。
  const status = await probeWslEnvironment();
  if (!status.rebootRequired) {
    await writeDreaminaRuntimeState({ pendingOperation: "none" });
  }
  return { repeatedInstall: false, status };
}
