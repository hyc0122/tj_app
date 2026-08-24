import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import getPath from "@/utils/getPath";
import {
  type DreaminaApprovedRelease,
  type DreaminaApprovedReleaseManifest,
  approvedReleaseDirectoryName,
  approvedReleaseIdentity,
  assertApprovedDreaminaUrl,
  findApprovedRelease,
  isSemverReleaseVersion,
  readApprovedReleaseManifest,
} from "./approved-release-manifest";
import { runDreaminaCommand, type DreaminaRunResult } from "./process-runner";
import { writeDreaminaRuntimeState } from "./runtime-state-store";

const MAX_DOWNLOAD_BYTES = 120 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "application/octet-stream",
  "application/x-msdownload",
  "application/exe",
  "",
]);
const TRANSIENT_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const RENAME_RETRY_DELAYS_MS = [100, 200, 400, 800, 1_000] as const;
const renameRetryWaitState = new Int32Array(new SharedArrayBuffer(4));

export type DreaminaDownloadTransport = (url: string) => Promise<Response>;
export type DreaminaCommandRunner = (input: {
  executablePath: string;
  args: readonly string[];
}) => Promise<DreaminaRunResult>;

let boundManifest: DreaminaApprovedReleaseManifest | undefined;
let boundTransport: DreaminaDownloadTransport | undefined;
let boundRunner: DreaminaCommandRunner | undefined;

export function bindDreaminaApprovedManifest(manifest?: DreaminaApprovedReleaseManifest): void {
  boundManifest = manifest;
}

export function bindDreaminaInstallTestTransport(transport?: DreaminaDownloadTransport): void {
  boundTransport = transport;
}

export function bindDreaminaCommandRunner(runner?: DreaminaCommandRunner): void {
  boundRunner = runner;
}

export interface DreaminaInstallResult {
  ok: boolean;
  executablePath?: string;
  version?: string;
  reason?: string;
}

function renameSyncWithTransientRetry(source: string, destination: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code ?? "")
        : "";
      if (!TRANSIENT_RENAME_ERRORS.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        throw error;
      }
      // Windows 实时扫描器可能短暂占用新 EXE；保持 rename 原子语义，禁止降级为 copy 覆盖。
      Atomics.wait(renameRetryWaitState, 0, 0, RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function managedRoot(): string {
  return path.join(getPath(), "managed-tools", "dreamina");
}

function pointerPath(): string {
  return path.join(managedRoot(), "current.json");
}

function readPointer(): { version: string; platform: string; executablePath: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(pointerPath(), "utf8")) as {
      version?: string;
      platform?: string;
      executablePath?: string;
    };
    if (!raw.version || !raw.executablePath) return null;
    return {
      version: raw.version,
      platform: raw.platform || "windows-x64",
      executablePath: raw.executablePath,
    };
  } catch {
    return null;
  }
}

function writePointer(input: { version: string; platform: string; executablePath: string }): void {
  fs.mkdirSync(managedRoot(), { recursive: true });
  const payload = JSON.stringify({
    version: input.version,
    platform: input.platform,
    executablePath: input.executablePath,
    updatedAt: Date.now(),
  });
  const temporary = `${pointerPath()}.${process.pid}.tmp`;
  const handle = fs.openSync(temporary, "w");
  try {
    fs.writeSync(handle, payload);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  renameSyncWithTransientRetry(temporary, pointerPath());
}

function listPointerTemporaryFiles(): string[] {
  const root = managedRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => name.startsWith("current.json.") && name.endsWith(".tmp"))
    .map((name) => path.join(root, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
}

export function recoverManagedDreaminaInstall(): { ok: boolean; reason?: string } {
  const root = managedRoot();
  const staging = path.join(root, "staging");
  if (fs.existsSync(staging)) {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  if (fs.existsSync(root)) {
    for (const name of fs.readdirSync(root)) {
      if (name.endsWith(".candidate")) {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      }
    }
  }
  const pointer = readPointer();
  if (!pointer) {
    // 中文注释：崩溃后 PID 已变，必须扫描同目录任意 current.json.*.tmp。
    for (const leftover of listPointerTemporaryFiles()) {
      try {
        const parsed = JSON.parse(fs.readFileSync(leftover, "utf8")) as {
          version?: string;
          executablePath?: string;
        };
        if (!parsed.version || !parsed.executablePath || !fs.existsSync(parsed.executablePath)) {
          fs.rmSync(leftover, { force: true });
          continue;
        }
        renameSyncWithTransientRetry(leftover, pointerPath());
        break;
      } catch {
        try {
          fs.rmSync(leftover, { force: true });
        } catch {
          // 单个损坏临时文件清理失败不得阻断后续恢复。
        }
      }
    }
  }
  const current = readPointer();
  if (!current) {
    return { ok: false, reason: "pointer 缺失或损坏" };
  }
  if (!fs.existsSync(current.executablePath) || !fs.statSync(current.executablePath).isFile()) {
    return { ok: false, reason: "pointer 指向的可执行文件缺失" };
  }
  return { ok: true };
}

export function inspectPeMachine(buffer: Buffer): number | null {
  if (buffer.length < 0x88 || buffer.toString("ascii", 0, 2) !== "MZ") return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length) return null;
  if (buffer.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") return null;
  return buffer.readUInt16LE(peOffset + 4);
}

async function downloadApproved(url: string, expectedSize: number): Promise<Buffer> {
  assertApprovedDreaminaUrl(url);
  const transport = boundTransport ?? (async (target) => fetch(target, { redirect: "manual" }));
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    assertApprovedDreaminaUrl(current);
    const response = await transport(current);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location");
      if (!next) throw new Error("重定向缺少 Location");
      current = new URL(next, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
    const type = String(response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(type)) throw new Error("下载内容类型不受信任");
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_DOWNLOAD_BYTES || expectedSize > MAX_DOWNLOAD_BYTES) {
      throw new Error("下载体积超过上限");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("下载体积超过上限");
    return bytes;
  }
  throw new Error("重定向次数过多");
}

async function verifyInstalledBinary(executablePath: string, release: DreaminaApprovedRelease): Promise<string> {
  const runner = boundRunner ?? (async (input) => runDreaminaCommand({
    executablePath: input.executablePath,
    args: input.args,
    timeoutKind: "probe",
  }));
  const version = await runner({ executablePath, args: ["version"] });
  if (version.timedOut || version.exitCode !== 0) throw new Error("安装后 version 自检失败");
  const help = await runner({ executablePath, args: ["-h"] });
  if (help.timedOut || help.exitCode !== 0) throw new Error("安装后 -h 自检失败");
  if (isSemverReleaseVersion(release.version)) {
    const probed = version.stdout.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/)?.[1];
    if (!probed || probed === "unknown") throw new Error("安装后无法可靠取得版本");
    if (probed !== release.version) {
      throw new Error(`自检版本 ${probed} 与批准版本 ${release.version} 不一致`);
    }
    return probed;
  }
  // 中文注释：官方 CLI 没有语义版本时，身份以内容 SHA 为准；只要求 version/-h 能启动。
  if (/\bunknown\b/i.test(version.stdout) && !/"version"\s*:/.test(version.stdout)) {
    throw new Error("安装后无法可靠取得版本");
  }
  return approvedReleaseIdentity(release);
}

export async function installApprovedDreaminaRelease(input: {
  confirm: true;
  platform?: "windows-x64" | "linux-x64";
  url?: string;
}): Promise<DreaminaInstallResult> {
  if (input.confirm !== true) return { ok: false, reason: "必须由用户明确确认后安装" };
  const platform = input.platform ?? "windows-x64";
  const previous = readPointer();
  const previousRuntimePath = previous?.executablePath;
  const operationId = crypto.randomUUID();
  const stagingDir = path.join(managedRoot(), "staging", operationId);
  try {
    const manifest = boundManifest ?? readApprovedReleaseManifest();
    const release = findApprovedRelease(manifest, platform);
    if (!release) return { ok: false, reason: "批准发行物暂不可用" };
    if (input.url && input.url !== release.url) {
      return { ok: false, reason: "拒绝非批准发行地址" };
    }
    assertApprovedDreaminaUrl(release.url);

    const identity = approvedReleaseIdentity(release);
    await writeDreaminaRuntimeState({
      install: { state: "installing", version: identity, executablePath: previousRuntimePath ?? null, managed: true, checkedAt: Date.now() },
    });

    fs.mkdirSync(stagingDir, { recursive: true });
    const stagingFile = path.join(stagingDir, platform === "windows-x64" ? "dreamina.exe" : "dreamina");
    const bytes = await downloadApproved(release.url, release.size);
    if (bytes.length !== release.size) throw new Error("下载 size 与批准清单不一致");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== release.sha256) throw new Error("下载 SHA-256 与批准清单不一致");
    if (platform === "windows-x64") {
      const machine = inspectPeMachine(bytes);
      if (machine !== 0x8664) throw new Error("PE 架构不是 Windows x64");
    }
    fs.writeFileSync(stagingFile, bytes);
    if (platform === "windows-x64") {
      const stagedMachine = inspectPeMachine(fs.readFileSync(stagingFile));
      if (stagedMachine !== 0x8664) throw new Error("候选 PE 架构不是 Windows x64");
    }
    const version = await verifyInstalledBinary(stagingFile, release);

    // 中文注释：正式目录按内容 SHA 隔离；有语义版本时保留 version-sha12 以兼容既有测试。
    const finalDir = path.join(managedRoot(), approvedReleaseDirectoryName(release, digest), platform);
    const candidateDir = `${finalDir}.candidate`;
    fs.rmSync(candidateDir, { recursive: true, force: true });
    fs.mkdirSync(candidateDir, { recursive: true });
    const candidateFile = path.join(candidateDir, path.basename(stagingFile));
    renameSyncWithTransientRetry(stagingFile, candidateFile);
    const candidateVersion = await verifyInstalledBinary(candidateFile, release);
    if (candidateVersion !== version) {
      throw new Error(`候选自检身份 ${candidateVersion} 与批准身份 ${version} 不一致`);
    }
    if (!fs.existsSync(finalDir)) {
      renameSyncWithTransientRetry(candidateDir, finalDir);
    } else {
      const existing = path.join(finalDir, path.basename(stagingFile));
      if (fs.existsSync(existing)) {
        const existingSha = crypto.createHash("sha256").update(fs.readFileSync(existing)).digest("hex");
        if (existingSha !== digest) {
          fs.rmSync(finalDir, { recursive: true, force: true });
          renameSyncWithTransientRetry(candidateDir, finalDir);
        } else {
          fs.rmSync(candidateDir, { recursive: true, force: true });
        }
      } else {
        fs.rmSync(finalDir, { recursive: true, force: true });
        renameSyncWithTransientRetry(candidateDir, finalDir);
      }
    }
    const finalFile = path.join(finalDir, path.basename(stagingFile));
    if (!fs.existsSync(finalFile)) throw new Error("正式版本目录缺少可执行文件");
    writePointer({ version: identity, platform, executablePath: finalFile });
    await writeDreaminaRuntimeState({
      executablePath: finalFile,
      install: {
        state: "installed",
        version,
        executablePath: finalFile,
        managed: true,
        checkedAt: Date.now(),
      },
    });
    fs.rmSync(stagingDir, { recursive: true, force: true });
    const { bumpModelCatalogVersion } = await import("../model-catalog-invalidation");
    const { invalidateDreaminaCapabilityCache } = await import("./capability-cache");
    invalidateDreaminaCapabilityCache();
    bumpModelCatalogVersion("dreamina-install");
    return { ok: true, executablePath: finalFile, version };
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    try {
      for (const name of fs.readdirSync(managedRoot())) {
        if (name.endsWith(".candidate")) {
          fs.rmSync(path.join(managedRoot(), name), { recursive: true, force: true });
        }
      }
    } catch {
      // 清理失败不得覆盖上一版本。
    }
    if (previousRuntimePath && fs.existsSync(previousRuntimePath)) {
      await writeDreaminaRuntimeState({
        executablePath: previousRuntimePath,
        install: {
          state: "installed",
          version: previous?.version ?? null,
          executablePath: previousRuntimePath,
          managed: true,
          checkedAt: Date.now(),
          reason: error instanceof Error ? error.message : "安装失败，已保留上一版本",
        },
      });
    } else {
      await writeDreaminaRuntimeState({
        install: {
          state: "failed",
          version: null,
          executablePath: null,
          managed: true,
          checkedAt: Date.now(),
          reason: error instanceof Error ? error.message : "安装失败",
        },
      });
    }
    return { ok: false, reason: error instanceof Error ? error.message : "安装失败" };
  }
}

export async function repairApprovedDreaminaRelease(): Promise<DreaminaInstallResult> {
  return installApprovedDreaminaRelease({ confirm: true });
}
