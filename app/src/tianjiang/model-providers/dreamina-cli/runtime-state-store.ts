import { accountDb } from "@/utils/db";
import { readDreaminaCapabilityCache } from "./capability-cache";
import type {
  DreaminaAccountStatus,
  DreaminaCliSettings,
  DreaminaExecutionTarget,
  DreaminaInstallStatus,
  DreaminaProviderStatus,
} from "./contracts";

const RUNTIME_TABLE = "o_dreaminaCliRuntimeState";

export interface DreaminaRuntimeStateRow {
  executablePath: string | null;
  preferredExecutionTarget: DreaminaExecutionTarget;
  effectiveExecutionTarget: DreaminaExecutionTarget | null;
  install: DreaminaInstallStatus;
  account: DreaminaAccountStatus;
  pendingOperation: "none" | "feature_install" | "distribution_install" | "cli_install";
  updatedAt: number;
}

function emptyRuntime(): DreaminaRuntimeStateRow {
  return {
    executablePath: null,
    preferredExecutionTarget: "windows_native",
    effectiveExecutionTarget: null,
    install: {
      state: "not_installed",
      version: null,
      executablePath: null,
      managed: false,
      checkedAt: null,
    },
    account: { state: "unknown" },
    pendingOperation: "none",
    updatedAt: 0,
  };
}

function asTarget(value: unknown, fallback: DreaminaExecutionTarget | null = "windows_native"): DreaminaExecutionTarget | null {
  if (value === "windows_native" || value === "wsl") return value;
  return fallback;
}

function omitEmptyAccountFields(account: DreaminaAccountStatus): DreaminaAccountStatus {
  // 中文注释：CLI 未返回套餐/到期/积分时省略字段，禁止伪造 0 或日期。
  const next: DreaminaAccountStatus = { state: account.state };
  if (account.points) next.points = account.points;
  if (account.planName) next.planName = account.planName;
  if (account.expiresAt) next.expiresAt = account.expiresAt;
  if (account.refreshedAt) next.refreshedAt = account.refreshedAt;
  if (account.reason) next.reason = account.reason;
  if (account.lastKnownState) next.lastKnownState = account.lastKnownState;
  if (account.verified !== undefined) next.verified = account.verified;
  return next;
}

export async function readDreaminaRuntimeState(): Promise<DreaminaRuntimeStateRow> {
  try {
    const row = await accountDb(RUNTIME_TABLE).where({ id: 1 }).first();
    if (!row) return emptyRuntime();
    return {
      executablePath: typeof row.executablePath === "string" && row.executablePath
        ? row.executablePath
        : null,
      preferredExecutionTarget: asTarget(row.preferredExecutionTarget, "windows_native") ?? "windows_native",
      effectiveExecutionTarget: asTarget(row.effectiveExecutionTarget, null),
      install: {
        state: row.installState ?? "not_installed",
        version: row.installVersion ?? null,
        executablePath: typeof row.executablePath === "string" && row.executablePath
          ? row.executablePath
          : null,
        managed: Number(row.installManaged) === 1,
        checkedAt: row.installCheckedAt == null ? null : Number(row.installCheckedAt),
        reason: row.installReason || undefined,
      },
      account: omitEmptyAccountFields({
        state: row.accountState ?? "unknown",
        points: row.accountPoints || undefined,
        planName: row.accountPlanName || undefined,
        expiresAt: row.accountExpiresAt || undefined,
        refreshedAt: row.accountRefreshedAt == null ? undefined : Number(row.accountRefreshedAt),
        reason: row.accountReason || undefined,
      }),
      pendingOperation: row.pendingOperation ?? "none",
      updatedAt: Number(row.updatedAt) || 0,
    };
  } catch {
    return emptyRuntime();
  }
}

let afterReadHookForTests: (() => Promise<void> | void) | null = null;

export function setDreaminaRuntimeStateAfterReadHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  afterReadHookForTests = hook;
}

function buildRuntimeColumnPatch(
  patch: {
    executablePath?: string | null;
    preferredExecutionTarget?: DreaminaExecutionTarget;
    effectiveExecutionTarget?: DreaminaExecutionTarget | null;
    install?: Partial<DreaminaInstallStatus>;
    account?: Partial<DreaminaAccountStatus>;
    pendingOperation?: DreaminaRuntimeStateRow["pendingOperation"];
  },
  options: { replaceAccount?: boolean },
): Record<string, unknown> {
  const update: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.executablePath !== undefined) {
    update.executablePath = patch.executablePath;
  } else if (patch.install && Object.hasOwn(patch.install, "executablePath")) {
    update.executablePath = patch.install.executablePath ?? null;
  }
  if (patch.preferredExecutionTarget !== undefined) {
    update.preferredExecutionTarget = patch.preferredExecutionTarget;
  }
  if (Object.hasOwn(patch, "effectiveExecutionTarget")) {
    update.effectiveExecutionTarget = patch.effectiveExecutionTarget ?? null;
  }
  if (patch.install) {
    if (patch.install.state !== undefined) update.installState = patch.install.state;
    if (Object.hasOwn(patch.install, "version")) update.installVersion = patch.install.version ?? null;
    if (patch.install.managed !== undefined) update.installManaged = patch.install.managed ? 1 : 0;
    if (Object.hasOwn(patch.install, "checkedAt")) update.installCheckedAt = patch.install.checkedAt ?? null;
    if (Object.hasOwn(patch.install, "reason")) update.installReason = patch.install.reason ?? null;
  }
  if (patch.account) {
    if (options.replaceAccount) {
      update.accountState = patch.account.state ?? "unknown";
      update.accountPoints = patch.account.points ?? null;
      update.accountPlanName = patch.account.planName ?? null;
      update.accountExpiresAt = patch.account.expiresAt ?? null;
      update.accountRefreshedAt = patch.account.refreshedAt ?? null;
      update.accountReason = patch.account.reason ?? null;
    } else {
      if (patch.account.state !== undefined) update.accountState = patch.account.state;
      if (Object.hasOwn(patch.account, "points")) update.accountPoints = patch.account.points ?? null;
      if (Object.hasOwn(patch.account, "planName")) update.accountPlanName = patch.account.planName ?? null;
      if (Object.hasOwn(patch.account, "expiresAt")) update.accountExpiresAt = patch.account.expiresAt ?? null;
      if (Object.hasOwn(patch.account, "refreshedAt")) update.accountRefreshedAt = patch.account.refreshedAt ?? null;
      if (Object.hasOwn(patch.account, "reason")) update.accountReason = patch.account.reason ?? null;
    }
  }
  if (patch.pendingOperation !== undefined) {
    update.pendingOperation = patch.pendingOperation;
  }
  return update;
}

export async function writeDreaminaRuntimeState(patch: {
  executablePath?: string | null;
  preferredExecutionTarget?: DreaminaExecutionTarget;
  effectiveExecutionTarget?: DreaminaExecutionTarget | null;
  install?: Partial<DreaminaInstallStatus>;
  account?: Partial<DreaminaAccountStatus>;
  pendingOperation?: DreaminaRuntimeStateRow["pendingOperation"];
}, options: { replaceAccount?: boolean } = {}): Promise<DreaminaRuntimeStateRow> {
  // 中文注释：先读旧运行态再暂停，覆盖陈旧整行 RMW 窗口；写回不得持有该快照。
  await readDreaminaRuntimeState();
  if (afterReadHookForTests) await afterReadHookForTests();
  return accountDb.transaction(async (trx) => {
    const existing = await trx(RUNTIME_TABLE).where({ id: 1 }).first();
    const columnPatch = buildRuntimeColumnPatch(patch, options);
    if (!existing) {
      const empty = emptyRuntime();
      await trx(RUNTIME_TABLE).insert({
        id: 1,
        executablePath: empty.executablePath,
        preferredExecutionTarget: empty.preferredExecutionTarget,
        effectiveExecutionTarget: empty.effectiveExecutionTarget,
        installState: empty.install.state,
        installVersion: empty.install.version,
        installManaged: empty.install.managed ? 1 : 0,
        installCheckedAt: empty.install.checkedAt,
        installReason: empty.install.reason ?? null,
        accountState: empty.account.state,
        accountPoints: empty.account.points ?? null,
        accountPlanName: empty.account.planName ?? null,
        accountExpiresAt: empty.account.expiresAt ?? null,
        accountRefreshedAt: empty.account.refreshedAt ?? null,
        accountReason: empty.account.reason ?? null,
        pendingOperation: empty.pendingOperation,
        ...columnPatch,
      });
    } else {
      // 中文注释：事务内按字段 patch，禁止把钩子前读到的陈旧路径/账户整行写回。
      await trx(RUNTIME_TABLE).where({ id: 1 }).update(columnPatch);
    }
    const next = await trx(RUNTIME_TABLE).where({ id: 1 }).first();
    return {
      executablePath: typeof next?.executablePath === "string" && next.executablePath
        ? next.executablePath
        : null,
      preferredExecutionTarget: asTarget(next?.preferredExecutionTarget, "windows_native") ?? "windows_native",
      effectiveExecutionTarget: asTarget(next?.effectiveExecutionTarget, null),
      install: {
        state: next?.installState ?? "not_installed",
        version: next?.installVersion ?? null,
        executablePath: typeof next?.executablePath === "string" && next.executablePath
          ? next.executablePath
          : null,
        managed: Number(next?.installManaged) === 1,
        checkedAt: next?.installCheckedAt == null ? null : Number(next.installCheckedAt),
        reason: next?.installReason || undefined,
      },
      account: omitEmptyAccountFields({
        state: next?.accountState ?? "unknown",
        points: next?.accountPoints || undefined,
        planName: next?.accountPlanName || undefined,
        expiresAt: next?.accountExpiresAt || undefined,
        refreshedAt: next?.accountRefreshedAt == null ? undefined : Number(next.accountRefreshedAt),
        reason: next?.accountReason || undefined,
      }),
      pendingOperation: next?.pendingOperation ?? "none",
      updatedAt: Number(next?.updatedAt) || 0,
    };
  });
}

export async function buildDreaminaProviderStatus(
  settings: DreaminaCliSettings,
  queue: DreaminaProviderStatus["queue"],
): Promise<DreaminaProviderStatus> {
  const runtime = await readDreaminaRuntimeState();
  const resolvedPath = runtime.executablePath ?? settings.executablePath ?? runtime.install.executablePath;
  const install = {
    ...runtime.install,
    executablePath: resolvedPath,
  };
  const lastKnownState = runtime.account.state;
  const installReady = install.state === "installed" && Boolean(resolvedPath);
  // 中文注释：缓存已登录若与未安装/空路径并存，不得再当作当前已登录真值返回。
  const account = !installReady && runtime.account.state === "logged_in"
    ? omitEmptyAccountFields({
      state: "unknown",
      lastKnownState,
      verified: false,
      reason: install.reason || runtime.account.reason || "未找到可执行文件或尚未检测",
      refreshedAt: runtime.account.refreshedAt,
    })
    : omitEmptyAccountFields({
      ...runtime.account,
      lastKnownState,
      verified: false,
    });
  return {
    preferredExecutionTarget: runtime.preferredExecutionTarget,
    effectiveExecutionTarget: runtime.effectiveExecutionTarget,
    install,
    account,
    capability: readDreaminaCapabilityCache(),
    queue,
  };
}
