import fs from "node:fs";
import path from "node:path";

import { DEFAULT_DREAMINA_EXECUTABLE, DREAMINA_ERROR } from "./contracts";
import {
  DreaminaProcessError,
  assertSafeExecutable,
  findDreaminaInSafePath,
  runDreaminaCommand,
} from "./process-runner";
import { currentUserStorage } from "@/tianjiang/runtime/user-storage-context";
import { readDreaminaCliSettings, writeDreaminaCliSettings } from "./session-store";
import { writeDreaminaRuntimeState } from "./runtime-state-store";
import {
  assertDreaminaProbeIdentity,
  currentDreaminaProbeToken,
  dreaminaProbePathKey,
  isDreaminaEnablementStaleError,
  readDreaminaEnablementRevision,
  readDreaminaProbeEpoch,
  runSerializedDreaminaEnablement,
  sameDreaminaExecutionTarget,
  sameDreaminaProbePath,
} from "./dreamina-enablement";

export interface DreaminaSelfCheckResult {
  install: {
    state: "installed" | "not_installed" | "failed";
    resolvedExecutablePath: string | null;
    version: string | null;
    reason?: string;
    checkedAt: number;
  };
  account: {
    state: "logged_in" | "logged_out" | "unknown" | "failed";
    points?: string;
    reason?: string;
    checkedAt: number;
  };
}

function isUncPath(value: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(value);
}

/**
 * 只接受单个可执行文件路径或单个命令名，禁止参数串、UNC 和控制字符。
 */
export function normalizeDreaminaExecutableInput(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const value = raw.trim();
  if (!value) return null;
  if (/[\n\r\0]/.test(value)) {
    throw new DreaminaProcessError(DREAMINA_ERROR.pathRejected, "可执行路径包含非法控制字符", false);
  }
  if (isUncPath(value)) {
    throw new DreaminaProcessError(DREAMINA_ERROR.pathRejected, "可执行路径不能是 UNC 网络路径", false);
  }
  if (/^[\w.-]+(\s+-+)/.test(value)) {
    throw new DreaminaProcessError(DREAMINA_ERROR.pathRejected, "可执行路径不能包含命令参数", false);
  }
  const looksLikePath = /[\\/]/.test(value) || /\.(exe|cmd|bat|cjs|mjs|js)$/i.test(value);
  if (looksLikePath) {
    const resolved = path.resolve(value);
    if (fs.existsSync(resolved)) {
      const stat = fs.lstatSync(resolved);
      if (stat.isSymbolicLink()) {
        throw new DreaminaProcessError(DREAMINA_ERROR.pathRejected, "拒绝通过符号链接配置即梦 CLI", false);
      }
      if (!stat.isFile()) {
        throw new DreaminaProcessError(DREAMINA_ERROR.notInstalled, "即梦 CLI 路径不是可执行文件", false);
      }
    }
    return resolved;
  }
  if (/\s/.test(value)) {
    throw new DreaminaProcessError(DREAMINA_ERROR.pathRejected, "命令名不能包含空格或参数", false);
  }
  return value;
}

/**
 * 唯一 CLI 解析入口：空配置/裸命令走安全 PATH，成功后只返回已存在的绝对文件。
 * 检测、授权、登录、积分、能力探测和正式调度都必须调用这里，禁止各自再猜路径。
 */
export async function resolveDreaminaExecutable(
  explicit?: string | null,
): Promise<string> {
  if (process.env.NODE_TEST_CONTEXT && process.env.DREAMINA_TEST_EXECUTABLE) {
    return assertSafeExecutable(process.env.DREAMINA_TEST_EXECUTABLE);
  }
  let configured = explicit;
  if (configured === undefined) {
    try {
      configured = (await readDreaminaCliSettings()).executablePath;
    } catch {
      configured = DEFAULT_DREAMINA_EXECUTABLE;
    }
  }
  const normalized = normalizeDreaminaExecutableInput(configured) ?? DEFAULT_DREAMINA_EXECUTABLE;
  if (normalized && /[\\/]/.test(normalized)) {
    return assertSafeExecutable(normalized);
  }
  const fromPath = findDreaminaInSafePath();
  if (fromPath) return assertSafeExecutable(fromPath);
  throw new DreaminaProcessError(DREAMINA_ERROR.notInstalled, "未在安全 PATH 中找到即梦 CLI", false);
}

export const resolveConfiguredDreaminaExecutable = resolveDreaminaExecutable;

function extractVersion(result: {
  stdout: string;
  parsed: Record<string, unknown> | null;
}): string | null {
  // 中文注释：真实 dreamina version 返回 JSON，版本值可能是提交哈希而非语义版本号。
  const parsedVersion = result.parsed?.version;
  if (typeof parsedVersion === "string") {
    const value = parsedVersion.trim();
    if (value && value.length <= 80 && !/[\r\n\0]/.test(value)) return value;
  }
  return result.stdout.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
}

function numberish(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return value.trim();
  return undefined;
}

export async function probeDreaminaCliAvailability(
  explicit?: string | null,
): Promise<DreaminaSelfCheckResult["install"]> {
  const checkedAt = Date.now();
  try {
    // 中文注释：打开探测每次真正执行 CLI 前都要确认 token 与当前路径仍有效。
    await assertDreaminaProbeIdentity(explicit ?? undefined);
    const resolved = await resolveDreaminaExecutable(explicit);
    await assertDreaminaProbeIdentity(resolved);
    const versionResult = await runDreaminaCommand({
      executablePath: resolved,
      args: ["version"],
      timeoutKind: "probe",
    });
    await assertDreaminaProbeIdentity(resolved);
    if (versionResult.timedOut) {
      return {
        state: "failed",
        resolvedExecutablePath: resolved,
        version: null,
        reason: "CLI 版本探测超时",
        checkedAt,
      };
    }
    if (versionResult.exitCode !== 0) {
      await assertDreaminaProbeIdentity(resolved);
      const help = await runDreaminaCommand({
        executablePath: resolved,
        args: ["-h"],
        timeoutKind: "probe",
      });
      await assertDreaminaProbeIdentity(resolved);
      if (help.timedOut || help.exitCode !== 0) {
        return {
          state: "failed",
          resolvedExecutablePath: resolved,
          version: null,
          reason: "CLI 不可执行",
          checkedAt,
        };
      }
    }
    return {
      state: "installed",
      resolvedExecutablePath: resolved,
      version: extractVersion(versionResult) ?? "unknown",
      checkedAt,
    };
  } catch (error) {
    if (isDreaminaEnablementStaleError(error)) throw error;
    const message = error instanceof DreaminaProcessError
      ? error.message
      : "未安装即梦 CLI 或无法执行";
    const state = error instanceof DreaminaProcessError && error.code === DREAMINA_ERROR.pathRejected
      ? "failed"
      : "not_installed";
    return {
      state,
      resolvedExecutablePath: null,
      version: null,
      reason: message,
      checkedAt,
    };
  }
}

export async function inspectDreaminaAccountTruth(
  executablePath: string,
): Promise<DreaminaSelfCheckResult["account"]> {
  const checkedAt = Date.now();
  try {
    await assertDreaminaProbeIdentity(executablePath);
    const result = await runDreaminaCommand({
      executablePath,
      args: ["user_credit"],
      timeoutKind: "credit",
    });
    await assertDreaminaProbeIdentity(executablePath);
    if (result.timedOut) {
      return { state: "failed", reason: "积分自检超时", checkedAt };
    }
    // 中文注释：登录真值只认 user_credit 退出码，禁止用缓存或缺失积分字段反推。
    if (result.exitCode !== 0) {
      return { state: "logged_out", reason: "未登录即梦账号", checkedAt };
    }
    const parsed = result.parsed ?? {};
    // 中文注释：参考实现与当前本机 CLI 使用 total_credit，兼容旧版字段但不猜登录状态。
    const points = numberish(parsed.total_credit ?? parsed.credit_balance ?? parsed.credit ?? parsed.balance);
    return {
      state: "logged_in",
      points,
      reason: points ? undefined : "CLI 未返回积分",
      checkedAt,
    };
  } catch (error) {
    if (isDreaminaEnablementStaleError(error)) throw error;
    if (error instanceof DreaminaProcessError && (
      error.code === DREAMINA_ERROR.notInstalled || error.code === DREAMINA_ERROR.pathRejected
    )) {
      return { state: "unknown", reason: error.message, checkedAt };
    }
    return { state: "failed", reason: "登录检测失败", checkedAt };
  }
}

export async function performDreaminaTruthCheck(options: {
  includeLogin?: boolean;
} = {}): Promise<DreaminaSelfCheckResult> {
  const includeLogin = options.includeLogin !== false;
  await assertDreaminaProbeIdentity();
  const install = await probeDreaminaCliAvailability();
  if (install.state !== "installed" || !install.resolvedExecutablePath) {
    return {
      install,
      account: {
        state: "unknown",
        reason: install.reason || "未找到可执行文件",
        checkedAt: Date.now(),
      },
    };
  }
  if (!includeLogin) {
    return {
      install,
      account: {
        state: "unknown",
        reason: "尚未检测登录",
        checkedAt: Date.now(),
      },
    };
  }
  await assertDreaminaProbeIdentity(install.resolvedExecutablePath);
  const account = await inspectDreaminaAccountTruth(install.resolvedExecutablePath);
  return { install, account };
}

let persistAfterIdentityHookForTests: (() => Promise<void> | void) | null = null;
let persistAfterLockedCheckHookForTests: (() => Promise<void> | void) | null = null;

export function setDreaminaPersistAfterIdentityHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  persistAfterIdentityHookForTests = hook;
}

export function setDreaminaPersistAfterLockedCheckHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  persistAfterLockedCheckHookForTests = hook;
}

export async function persistDreaminaTruthCheck(
  result: DreaminaSelfCheckResult,
): Promise<DreaminaSelfCheckResult> {
  const token = currentDreaminaProbeToken();
  await assertDreaminaProbeIdentity(result.install.resolvedExecutablePath, token);
  if (persistAfterIdentityHookForTests) await persistAfterIdentityHookForTests();
  // 中文注释：身份校验与写入必须在同一串行临界区，禁止校验后再无条件写。
  return runSerializedDreaminaEnablement(async () => {
    await assertDreaminaProbeIdentity(result.install.resolvedExecutablePath, token);
    const current = await readDreaminaCliSettings();
    if (token?.executablePath
      && !(await sameDreaminaExecutionTarget(token.executablePath, current.executablePath))) {
      throw Object.assign(new Error("即梦 CLI 启停状态已变化"), {
        status: 409,
        code: "DREAMINA_CLI_ENABLEMENT_STALE",
      });
    }
    const resolved = result.install.resolvedExecutablePath;
    let persistPath = current.executablePath;
    if (resolved && await sameDreaminaExecutionTarget(current.executablePath, resolved)) {
      persistPath = resolved;
    } else if (resolved && !(await sameDreaminaExecutionTarget(current.executablePath, resolved))) {
      throw Object.assign(new Error("即梦 CLI 启停状态已变化"), {
        status: 409,
        code: "DREAMINA_CLI_ENABLEMENT_STALE",
      });
    }
    // 中文注释：锁内最终身份校验已通过、尚未写 settings/runtime。此钩子只给测试插窗口。
    if (persistAfterLockedCheckHookForTests) await persistAfterLockedCheckHookForTests();
    const latest = await readDreaminaCliSettings();
    await assertDreaminaProbeIdentity(result.install.resolvedExecutablePath, token);
    if (token?.executablePath
      && !(await sameDreaminaExecutionTarget(token.executablePath, latest.executablePath))) {
      throw Object.assign(new Error("即梦 CLI 启停状态已变化"), {
        status: 409,
        code: "DREAMINA_CLI_ENABLEMENT_STALE",
      });
    }
    persistPath = latest.executablePath;
    if (resolved && await sameDreaminaExecutionTarget(latest.executablePath, resolved)) {
      persistPath = resolved;
    } else if (resolved && !(await sameDreaminaExecutionTarget(latest.executablePath, resolved))) {
      throw Object.assign(new Error("即梦 CLI 启停状态已变化"), {
        status: 409,
        code: "DREAMINA_CLI_ENABLEMENT_STALE",
      });
    }
    if (resolved && persistPath === resolved
      && String(latest.executablePath ?? "") !== String(resolved)) {
      // 中文注释：裸命令与 PATH 绝对路径视为同一目标，成功后按合同落下绝对路径。
      await writeDreaminaCliSettings(
        { executablePath: resolved },
        { expectedUpdatedAt: latest.updatedAt },
      );
    }
    await writeDreaminaRuntimeState({
      executablePath: persistPath,
      install: {
        state: result.install.state,
        version: result.install.version,
        executablePath: persistPath,
        managed: false,
        checkedAt: result.install.checkedAt,
        reason: result.install.reason,
      },
      account: {
        state: result.account.state,
        points: result.account.points,
        reason: result.account.reason,
        refreshedAt: result.account.checkedAt,
      },
    }, { replaceAccount: true });
    return result;
  });
}

const STARTUP_STATUS_TTL_MS = 60_000;

interface SegmentStartupCache {
  result: DreaminaSelfCheckResult | null;
  at: number;
  inFlight: Promise<DreaminaSelfCheckResult> | null;
}

const startupCaches = new Map<string, SegmentStartupCache>();

function requireCurrentUserSegment(): string {
  const context = currentUserStorage();
  if (!context?.segment) {
    throw new Error("缺少账号上下文，无法检测即梦 CLI");
  }
  return context.segment;
}

let startupCheckBeforeProbeHookForTests: (() => Promise<void> | void) | null = null;

export function setDreaminaStartupCheckBeforeProbeHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  startupCheckBeforeProbeHookForTests = hook;
}

export function resetDreaminaStartupStatusCheckForTests(): void {
  startupCaches.clear();
  persistAfterIdentityHookForTests = null;
  persistAfterLockedCheckHookForTests = null;
  startupCheckBeforeProbeHookForTests = null;
}

function startupCacheKey(
  segment: string,
  revision: number,
  epoch: number,
  executablePath: string | null,
): string {
  return `${segment}:${revision}:${epoch}:${dreaminaProbePathKey(executablePath)}`;
}

export function invalidateCurrentUserDreaminaStartupStatusCheck(): void {
  const segment = currentUserStorage()?.segment;
  if (!segment) return;
  for (const key of [...startupCaches.keys()]) {
    if (key === segment || key.startsWith(`${segment}:`)) startupCaches.delete(key);
  }
}

function emptyDisabledCheck(): DreaminaSelfCheckResult {
  return {
    install: {
      state: "not_installed",
      resolvedExecutablePath: null,
      version: null,
      reason: "即梦 CLI 已关闭",
      checkedAt: Date.now(),
    },
    account: {
      state: "unknown",
      reason: "即梦 CLI 已关闭",
      checkedAt: Date.now(),
    },
  };
}

/**
 * 用户数据与本地服务就绪后的非付费状态检查：只跑 version/-h 与 user_credit。
 * 探测、TTL 和并发合并按 currentUserStorage.segment 隔离；缓存命中也必须写回当前账号库。
 */
function unavailable(): never {
  throw Object.assign(new Error("即梦 CLI 不可用"), {
    status: 400,
    code: "STORYBOARD_DREAMINA_CLI_UNAVAILABLE",
  });
}

/**
 * 正式生成前等待同一用户的启动检测与能力探测，禁止另起一套 CLI 服务。
 */
export async function ensureDreaminaExecuteReady() {
  const { DREAMINA_CLI_DISABLED_CODE, DREAMINA_CLI_DISABLED_MESSAGE, readDreaminaCliSettings } = await import(
    "./session-store"
  );
  const settings = await readDreaminaCliSettings();
  if (settings.enabled === false) {
    throw Object.assign(new Error(DREAMINA_CLI_DISABLED_MESSAGE), {
      status: 400,
      code: DREAMINA_CLI_DISABLED_CODE,
    });
  }
  const {
    endDreaminaEnablementProbe,
    isDreaminaEnablementStaleError: isStale,
    reserveDreaminaProbeForCurrentSettings,
    runWithDreaminaProbeToken,
  } = await import("./dreamina-enablement");
  const token = await reserveDreaminaProbeForCurrentSettings({
    executablePath: settings.executablePath,
    updatedAt: settings.updatedAt,
  });
  if (!token) {
    throw Object.assign(new Error(DREAMINA_CLI_DISABLED_MESSAGE), {
      status: 400,
      code: DREAMINA_CLI_DISABLED_CODE,
    });
  }
  try {
    return await runWithDreaminaProbeToken(token, async () => {
      await assertDreaminaProbeIdentity(token.executablePath, token);
      const {
        capabilityCacheMatchesCurrentProbe,
        readDreaminaCapabilityCache,
        refreshDreaminaCapabilities,
      } = await import("./capability-cache");
      const existing = readDreaminaCapabilityCache();
      // 中文注释：ready 快路径也必须核对 path/revision/epoch，禁止只因 state=ready 就返回。
      if (capabilityCacheMatchesCurrentProbe(existing)) {
        await assertDreaminaProbeIdentity(token.executablePath, token);
        return existing;
      }
      const check = await ensureDreaminaStartupStatusCheck();
      await assertDreaminaProbeIdentity(token.executablePath, token);
      // 中文注释：只有明确未安装才是 NOT_INSTALLED；路径已解析但 version/-h 超时/失败必须是 UNAVAILABLE。
      if (check.install.state === "not_installed") {
        throw Object.assign(new Error("未安装即梦 CLI 或无法执行"), {
          status: 400,
          code: DREAMINA_ERROR.notInstalled,
        });
      }
      if (check.install.state !== "installed" || !check.install.resolvedExecutablePath) unavailable();
      if (check.account.state === "logged_out") {
        throw Object.assign(new Error("未登录即梦账号"), {
          status: 400,
          code: DREAMINA_ERROR.notLoggedIn,
        });
      }
      if (check.account.state !== "logged_in") unavailable();
      const { probeDreaminaCapabilities } = await import("./capability-probe");
      let refreshed;
      try {
        refreshed = await refreshDreaminaCapabilities({
          probe: async () => {
            await assertDreaminaProbeIdentity(check.install.resolvedExecutablePath, token);
            const snapshot = await probeDreaminaCapabilities(check.install.resolvedExecutablePath!);
            await assertDreaminaProbeIdentity(check.install.resolvedExecutablePath, token);
            return snapshot;
          },
        });
      } catch (error) {
        if (isStale(error)) throw error;
        unavailable();
      }
      await assertDreaminaProbeIdentity(token.executablePath, token);
      // 中文注释：启动检测已确认安装且登录后，能力探测失败/异常不得再伪装成未安装。
      if (refreshed.state === "failed" || refreshed.state !== "ready" || refreshed.snapshot?.installed !== true) {
        unavailable();
      }
      return refreshed;
    });
  } finally {
    endDreaminaEnablementProbe(token);
  }
}

export async function ensureDreaminaStartupStatusCheck(): Promise<DreaminaSelfCheckResult> {
  const segment = requireCurrentUserSegment();
  const settings = await readDreaminaCliSettings();
  if (settings.enabled === false) {
    return emptyDisabledCheck();
  }
  const revision = readDreaminaEnablementRevision();
  const epoch = readDreaminaProbeEpoch();
  const executablePath = settings.executablePath;
  const key = startupCacheKey(segment, revision, epoch, executablePath);
  const cache = startupCaches.get(key) ?? { result: null, at: 0, inFlight: null };
  const now = Date.now();
  if (cache.result && now - cache.at < STARTUP_STATUS_TTL_MS) {
    const latest = await readDreaminaCliSettings();
    if (
      readDreaminaEnablementRevision() !== revision
      || readDreaminaProbeEpoch() !== epoch
      || !sameDreaminaProbePath(latest.executablePath, executablePath)
    ) {
      throw Object.assign(new Error("即梦 CLI 启停状态已变化"), {
        status: 409,
        code: "DREAMINA_CLI_ENABLEMENT_STALE",
      });
    }
    try {
      await persistDreaminaTruthCheck(cache.result);
    } catch (error) {
      // 中文注释：身份过期不得把 TTL 旧结果当成当前返回。
      if (!isDreaminaEnablementStaleError(error)) throw error;
      throw error;
    }
    return cache.result;
  }
  if (cache.inFlight) return cache.inFlight;
  cache.inFlight = (async () => {
    // 中文注释：测试钩子覆盖“A 的启动检测 inFlight 已挂上、尚未跑 CLI”的窗口。
    if (startupCheckBeforeProbeHookForTests) await startupCheckBeforeProbeHookForTests();
    const probed = await performDreaminaTruthCheck({ includeLogin: true });
    const latest = await readDreaminaCliSettings();
    if (
      readDreaminaEnablementRevision() !== revision
      || readDreaminaProbeEpoch() !== epoch
      || !sameDreaminaProbePath(latest.executablePath, executablePath)
    ) {
      throw Object.assign(new Error("即梦 CLI 启停状态已变化"), {
        status: 409,
        code: "DREAMINA_CLI_ENABLEMENT_STALE",
      });
    }
    try {
      await persistDreaminaTruthCheck(probed);
    } catch (error) {
      if (!isDreaminaEnablementStaleError(error)) throw error;
      throw error;
    }
    cache.result = probed;
    cache.at = Date.now();
    return probed;
  })().finally(() => {
    cache.inFlight = null;
  });
  startupCaches.set(key, cache);
  return cache.inFlight;
}

export function presentSelfCheckPayload(result: DreaminaSelfCheckResult) {
  const creditBalance = result.account.points == null ? undefined : Number(result.account.points);
  return {
    loggedIn: result.account.state === "logged_in",
    creditBalance: Number.isFinite(creditBalance) ? creditBalance : undefined,
    reason: result.account.reason,
    install: result.install,
    account: {
      ...result.account,
      verified: result.account.state === "logged_in" || result.account.state === "logged_out",
    },
  };
}
