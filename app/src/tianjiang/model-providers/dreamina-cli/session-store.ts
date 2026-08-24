import { accountDb } from "@/utils/db";

import {
  DEFAULT_DREAMINA_EXECUTABLE,
  DREAMINA_ERROR,
  type DreaminaCliSettings,
  type DreaminaPauseReason,
  type DreaminaStoredPauseReason,
} from "./contracts";

function configuredExecutable(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || DEFAULT_DREAMINA_EXECUTABLE;
}

let settingsReadHookForTests: (() => void | Promise<void>) | null = null;

function normalizeStoredPauseReason(value: unknown, pauseNewClaims: unknown): DreaminaStoredPauseReason {
  if (value === "manual_pause" || value === "lifecycle_drain") return value;
  return Number(pauseNewClaims) === 1 ? "manual_pause" : "none";
}

/** disabled 是启停状态的有效原因；数据库仅持久化三种领取门原因。 */
export function resolveDreaminaPauseReason(
  settings: Pick<DreaminaCliSettings, "enabled" | "pauseReason" | "pauseNewClaims">,
): DreaminaPauseReason {
  if (!settings.enabled) return "disabled";
  return settings.pauseReason;
}

export function setDreaminaCliSettingsReadHookForTests(
  hook: (() => void | Promise<void>) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  settingsReadHookForTests = hook;
}

export async function readDreaminaCliSettings(): Promise<DreaminaCliSettings> {
  if (settingsReadHookForTests) await settingsReadHookForTests();
  const row = await accountDb("o_dreaminaCliSettings").where({ id: 1 }).first();
  if (!row) {
    throw new Error("账号库缺少即梦 CLI 设置表");
  }
  return {
    // 中文注释：兼容旧账号库 NULL；空配置表示恢复默认 dreamina 命令，而不是未安装。
    executablePath: configuredExecutable(row.executablePath),
    maxConcurrency: Number(row.maxConcurrency) || 1,
    pollSeconds: Number(row.pollSeconds) || 30,
    pauseNewClaims: Number(row.pauseNewClaims) === 1,
    pauseReason: normalizeStoredPauseReason(row.pauseReason, row.pauseNewClaims),
    enabled: row.enabled == null ? true : Number(row.enabled) !== 0,
    updatedAt: Number(row.updatedAt) || 0,
  };
}

export const DREAMINA_CLI_DISABLED_CODE = "DREAMINA_CLI_DISABLED";
export const DREAMINA_CLI_DISABLED_MESSAGE = "即梦 CLI 已关闭";

export async function assertDreaminaCliEnabled(): Promise<void> {
  const settings = await readDreaminaCliSettings();
  if (settings.enabled === false) {
    throw Object.assign(new Error(DREAMINA_CLI_DISABLED_MESSAGE), {
      status: 400,
      code: DREAMINA_CLI_DISABLED_CODE,
    });
  }
}

let settingsWriteHookForTests: (() => void | Promise<void>) | null = null;

export function setDreaminaCliSettingsWriteHookForTests(
  hook: (() => void | Promise<void>) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  settingsWriteHookForTests = hook;
}

export async function writeDreaminaCliSettings(patch: {
  executablePath?: string | null;
  maxConcurrency?: number;
  pollSeconds?: number;
  pauseNewClaims?: boolean;
  pauseReason?: DreaminaStoredPauseReason;
  enabled?: boolean;
}, options: { expectedUpdatedAt?: number } = {}): Promise<DreaminaCliSettings> {
  if (settingsWriteHookForTests) await settingsWriteHookForTests();
  if (patch.maxConcurrency !== undefined
    && (!Number.isInteger(patch.maxConcurrency) || patch.maxConcurrency < 1 || patch.maxConcurrency > 8)) {
    throw Object.assign(new Error("即梦并发上限必须是 1 到 8 的整数"), {
      status: 400,
      code: "DREAMINA_CLI_INVALID_CONCURRENCY",
    });
  }
  if (patch.pollSeconds !== undefined
    && (!Number.isInteger(patch.pollSeconds) || patch.pollSeconds < 5 || patch.pollSeconds > 300)) {
    throw Object.assign(new Error("即梦轮询间隔必须是 5 到 300 秒的整数"), {
      status: 400,
      code: DREAMINA_ERROR.invalidPollSeconds,
    });
  }
  return accountDb.transaction(async (trx) => {
    const row = await trx("o_dreaminaCliSettings").where({ id: 1 }).first();
    if (!row) throw new Error("账号库缺少即梦 CLI 设置表");
    const currentUpdatedAt = Number(row.updatedAt) || 0;
    if (options.expectedUpdatedAt != null && currentUpdatedAt !== options.expectedUpdatedAt) {
      throw Object.assign(new Error("即梦 CLI 启停状态已变化"), {
        status: 409,
        code: "DREAMINA_CLI_ENABLEMENT_STALE",
      });
    }
    // 中文注释：同一账号写事务内产生严格递增 updatedAt，禁止 read 后再无保护地整行覆盖。
    const nextUpdatedAt = Math.max(Date.now(), currentUpdatedAt + 1);
    const update: Record<string, unknown> = { updatedAt: nextUpdatedAt };
    if (patch.executablePath !== undefined) update.executablePath = configuredExecutable(patch.executablePath);
    if (patch.maxConcurrency !== undefined) update.maxConcurrency = patch.maxConcurrency;
    if (patch.pollSeconds !== undefined) update.pollSeconds = patch.pollSeconds;
    if (patch.pauseReason !== undefined) {
      // 中文注释：原因与领取门同事务写入，禁止出现 reason=none 但仍暂停的混态。
      update.pauseReason = patch.pauseReason;
      update.pauseNewClaims = patch.pauseReason === "none" ? 0 : 1;
    } else if (patch.pauseNewClaims !== undefined) {
      update.pauseNewClaims = patch.pauseNewClaims ? 1 : 0;
      update.pauseReason = patch.pauseNewClaims ? "manual_pause" : "none";
    }
    if (patch.enabled !== undefined) update.enabled = patch.enabled ? 1 : 0;
    await trx("o_dreaminaCliSettings").where({ id: 1 }).update(update);
    const next = await trx("o_dreaminaCliSettings").where({ id: 1 }).first();
    const settings: DreaminaCliSettings = {
      executablePath: configuredExecutable(next?.executablePath),
      maxConcurrency: Number(next?.maxConcurrency) || 1,
      pollSeconds: Number(next?.pollSeconds) || 30,
      pauseNewClaims: Number(next?.pauseNewClaims) === 1,
      pauseReason: normalizeStoredPauseReason(next?.pauseReason, next?.pauseNewClaims),
      enabled: next?.enabled == null ? true : Number(next.enabled) !== 0,
      updatedAt: Number(next?.updatedAt) || nextUpdatedAt,
    };
    const { syncDreaminaAuthoritativeProbeIdentity } = await import("./dreamina-enablement");
    // 中文注释：成功写入后同步权威路径，能力缓存与空 token begin 都按当前 settings 身份隔离。
    syncDreaminaAuthoritativeProbeIdentity({
      executablePath: settings.executablePath,
      updatedAt: settings.updatedAt,
    });
    return settings;
  });
}

export async function readProjectSession(projectUuid: string): Promise<{
  sessionId: string;
  sessionName: string;
  cliVersion: string;
} | null> {
  const row = await accountDb("o_dreaminaCliSession").where({ projectUuid }).first();
  if (!row) return null;
  return {
    sessionId: String(row.sessionId),
    sessionName: String(row.sessionName),
    cliVersion: String(row.cliVersion),
  };
}

export async function writeProjectSession(input: {
  projectUuid: string;
  sessionId: string;
  sessionName: string;
  cliVersion: string;
}): Promise<void> {
  const updatedAt = Date.now();
  const existing = await accountDb("o_dreaminaCliSession").where({ projectUuid: input.projectUuid }).first();
  if (existing) {
    await accountDb("o_dreaminaCliSession").where({ projectUuid: input.projectUuid }).update({
      sessionId: input.sessionId,
      sessionName: input.sessionName,
      cliVersion: input.cliVersion,
      updatedAt,
    });
    return;
  }
  await accountDb("o_dreaminaCliSession").insert({
    projectUuid: input.projectUuid,
    sessionId: input.sessionId,
    sessionName: input.sessionName,
    cliVersion: input.cliVersion,
    updatedAt,
  });
}
