import { currentUserStorage } from "@/tianjiang/runtime/user-storage-context";
import { DEFAULT_DREAMINA_EXECUTABLE, type DreaminaCapabilitySnapshot } from "./contracts";
import {
  assertDreaminaEnablementRevision,
  assertDreaminaProbeIdentity,
  currentDreaminaProbeToken,
  dreaminaProbePathKey,
  isDreaminaEnablementStaleError,
  readDreaminaAuthoritativeProbeIdentity,
  readDreaminaEnablementRevision,
  readDreaminaProbeEpoch,
  sameDreaminaProbePath,
} from "./dreamina-enablement";

function defaultAccountScopeId(): string {
  // 中文注释：能力缓存必须跟启动检测一样按当前用户隔离，禁止所有账号共用 local。
  return currentUserStorage()?.segment ?? "local";
}

export type ProviderCatalogState =
  | "ready"
  | "checking"
  | "failed"
  | "disabled"
  | "not_checked";

export interface DreaminaCapabilityCacheEntry {
  state: ProviderCatalogState;
  snapshot: DreaminaCapabilitySnapshot | null;
  checkedAt: number | null;
  failureReason?: string;
  revision?: number;
  epoch?: number;
  executablePath?: string | null;
  generation?: number;
}

interface CapabilityCacheIdentity {
  accountScopeId: string;
  revision: number;
  epoch: number;
  executablePath: string | null;
  generation?: number;
  executionTarget: string;
}

const cacheByKey = new Map<string, DreaminaCapabilityCacheEntry>();
const inflight = new Map<string, Promise<DreaminaCapabilityCacheEntry>>();

let capabilityRefreshBeforeProbeHookForTests: (() => Promise<void> | void) | null = null;

export function setDreaminaCapabilityRefreshBeforeProbeHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  capabilityRefreshBeforeProbeHookForTests = hook;
}

function stale(): never {
  throw Object.assign(new Error("即梦 CLI 启停状态已变化"), {
    status: 409,
    code: "DREAMINA_CLI_ENABLEMENT_STALE",
  });
}

function currentCacheIdentity(accountScopeId: string, executionTarget: string): CapabilityCacheIdentity {
  const token = currentDreaminaProbeToken();
  const tokenSegment = currentUserStorage()?.segment;
  const sameAccount = Boolean(token && tokenSegment === accountScopeId);
  const authoritative = readDreaminaAuthoritativeProbeIdentity(accountScopeId);
  const currentScope = currentUserStorage()?.segment;
  return {
    accountScopeId,
    // 中文注释：其他账号不得套用当前 ALS 的 revision/epoch/path，否则路径迁移会误伤隔离缓存。
    revision: sameAccount ? token!.revision : readDreaminaEnablementRevision(accountScopeId),
    epoch: sameAccount ? token!.epoch : readDreaminaProbeEpoch(accountScopeId),
    executablePath: authoritative?.executablePath
      ?? (sameAccount ? token!.executablePath : null)
      ?? (accountScopeId === currentScope ? DEFAULT_DREAMINA_EXECUTABLE : null),
    generation: sameAccount ? token!.generation : undefined,
    executionTarget,
  };
}

function cacheKey(identity: CapabilityCacheIdentity): string {
  return [
    identity.accountScopeId,
    String(identity.revision),
    String(identity.epoch),
    dreaminaProbePathKey(identity.executablePath),
    identity.executionTarget,
  ].join(":");
}

function stampIdentity(
  entry: DreaminaCapabilityCacheEntry,
  identity: CapabilityCacheIdentity,
): DreaminaCapabilityCacheEntry {
  return {
    ...entry,
    revision: identity.revision,
    epoch: identity.epoch,
    executablePath: identity.executablePath,
    generation: identity.generation,
  };
}

function cacheMatchesIdentity(
  entry: DreaminaCapabilityCacheEntry,
  identity: CapabilityCacheIdentity,
): boolean {
  if (entry.revision !== identity.revision) return false;
  if (entry.epoch !== identity.epoch) return false;
  if (!sameDreaminaProbePath(entry.executablePath, identity.executablePath)) return false;
  return true;
}

export function capabilityCacheMatchesCurrentProbe(
  entry: DreaminaCapabilityCacheEntry,
): boolean {
  if (entry.state !== "ready" || entry.snapshot?.installed !== true || entry.snapshot.loggedIn !== true) {
    return false;
  }
  const identity = currentCacheIdentity(defaultAccountScopeId(), "windows_native");
  return cacheMatchesIdentity(entry, identity);
}

export function readDreaminaCapabilityCache(
  accountScopeId = defaultAccountScopeId(),
  executionTarget = "windows_native",
): DreaminaCapabilityCacheEntry {
  const identity = currentCacheIdentity(accountScopeId, executionTarget);
  const entry = cacheByKey.get(cacheKey(identity));
  if (!entry || !cacheMatchesIdentity(entry, identity)) {
    return {
      state: "not_checked",
      snapshot: null,
      checkedAt: null,
    };
  }
  return entry;
}

export function writeDreaminaCapabilityCache(
  entry: DreaminaCapabilityCacheEntry,
  accountScopeId = defaultAccountScopeId(),
  executionTarget = "windows_native",
): void {
  // 中文注释：写缓存前必须确认 token/revision，且只写入当前完整探测身份。
  assertDreaminaEnablementRevision();
  const token = currentDreaminaProbeToken();
  if (token) {
    if (token.revision !== readDreaminaEnablementRevision()) stale();
    if (token.epoch !== readDreaminaProbeEpoch()) stale();
  }
  const identity = currentCacheIdentity(accountScopeId, executionTarget);
  cacheByKey.set(cacheKey(identity), stampIdentity(entry, identity));
}

function deleteScopeKeys(store: Map<string, unknown>, scope: string): void {
  for (const key of [...store.keys()]) {
    if (key.startsWith(`${scope}:`)) store.delete(key);
  }
}

export function invalidateDreaminaCapabilityCache(accountScopeId?: string): void {
  const scope = accountScopeId ?? currentUserStorage()?.segment;
  if (!scope) {
    if (process.env.NODE_TEST_CONTEXT) {
      cacheByKey.clear();
      inflight.clear();
      capabilityRefreshBeforeProbeHookForTests = null;
    }
    return;
  }
  // 中文注释：路径变化必须同时丢掉当前账号的缓存与 inFlight，禁止新请求 join 旧 Promise。
  deleteScopeKeys(cacheByKey, scope);
  deleteScopeKeys(inflight, scope);
}

export async function refreshDreaminaCapabilities(options: {
  force?: boolean;
  executionTarget?: string;
  accountScopeId?: string;
  probe: () => Promise<DreaminaCapabilitySnapshot>;
}): Promise<DreaminaCapabilityCacheEntry> {
  const accountScopeId = options.accountScopeId ?? defaultAccountScopeId();
  const executionTarget = options.executionTarget ?? "windows_native";
  const started = currentCacheIdentity(accountScopeId, executionTarget);
  const key = cacheKey(started);
  const existing = cacheByKey.get(key);
  if (!options.force && existing && existing.state === "ready" && existing.snapshot
    && cacheMatchesIdentity(existing, started)) {
    await assertDreaminaProbeIdentity(started.executablePath);
    assertDreaminaEnablementRevision();
    return existing;
  }
  const running = inflight.get(key);
  if (running) return running;
  const task = (async () => {
    // 中文注释：测试钩子覆盖“A 的能力探测 inFlight 已挂上、尚未跑 CLI”的窗口。
    if (capabilityRefreshBeforeProbeHookForTests) await capabilityRefreshBeforeProbeHookForTests();
    try {
      await assertDreaminaProbeIdentity(started.executablePath);
      const snapshot = await options.probe();
      await assertDreaminaProbeIdentity(started.executablePath);
      assertDreaminaEnablementRevision();
      const current = currentCacheIdentity(accountScopeId, executionTarget);
      if (
        current.revision !== started.revision
        || current.epoch !== started.epoch
        || !sameDreaminaProbePath(current.executablePath, started.executablePath)
      ) {
        stale();
      }
      const token = currentDreaminaProbeToken();
      if (token && started.generation != null && token.generation !== started.generation) stale();
      const entry = stampIdentity({
        state: snapshot.installed ? "ready" : "disabled",
        snapshot,
        checkedAt: Date.now(),
      }, current);
      cacheByKey.set(cacheKey(current), entry);
      return entry;
    } catch (error) {
      if (isDreaminaEnablementStaleError(error)) throw error;
      const current = currentCacheIdentity(accountScopeId, executionTarget);
      if (
        current.revision !== started.revision
        || current.epoch !== started.epoch
        || !sameDreaminaProbePath(current.executablePath, started.executablePath)
      ) {
        stale();
      }
      const entry = stampIdentity({
        state: "failed",
        snapshot: existing?.snapshot ?? null,
        checkedAt: Date.now(),
        failureReason: error instanceof Error ? error.message : "即梦能力探测失败",
      }, current);
      cacheByKey.set(cacheKey(current), entry);
      return entry;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}
