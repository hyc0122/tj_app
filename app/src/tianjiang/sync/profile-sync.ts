import type { ProfilePendingMutation, ProfileStore, StoredProfileEntry } from "../data/profile-store";
import {
  assertRegisteredProfileSyncKey,
  assertRegistrySensitivity,
  findProfileSyncRegistration,
  isDeviceLocalProfileSyncKey,
  registeredSensitivity,
} from "./profile-sync-registry";
import { applyLiveAccountSettings, listVendorKeyAliases } from "./profile-settings-adapter";
import type { UserStorageIdentity } from "../runtime/user-storage-context";

export interface ProfileSnapshot {
  version: number;
  entries: Record<string, StoredProfileEntry>;
}

export interface ProfileVersionMetadata {
  version: number;
  etag: string;
  updatedAt?: string;
}

export interface ProfileRemote {
  getMetadata(): Promise<ProfileVersionMetadata>;
  getCurrent(): Promise<ProfileSnapshot>;
  commit(baseVersion: number, entries: Record<string, StoredProfileEntry>): Promise<ProfileSnapshot>;
}

export type ProfileSyncState = "idle" | "syncing" | "synced" | "failed";

export type ProfileReconcileTrigger =
  | "login"
  | "project_open"
  | "settings_save"
  | "manual_retry"
  | "background";

export interface ProfileReconcileResult {
  state: "unchanged" | "downloaded" | "uploaded" | "failed";
  version: number;
  usedCachedLocal: boolean;
}

export interface ProfileSyncStatus {
  state: ProfileSyncState;
  version: number;
  lastSuccessAt?: string;
  failureReason?: string;
}

export class ProfileConflictError extends Error {
  constructor() {
    super("个人配置基础版本已过期");
    this.name = "ProfileConflictError";
  }
}

type Schedule = (run: () => void, delay: number) => unknown;

export interface ProfileSyncOptions {
  /** 中文注释：生产必须绑定账号身份，flush/apply 不得依赖环境 ALS。 */
  account?: UserStorageIdentity;
}

export class ProfileSync {
  private readonly pending = new Map<string, ProfilePendingMutation>();
  private timerGeneration = 0;
  private currentStatus: ProfileSyncStatus;
  private reconcileInFlight: Promise<ProfileReconcileResult> | null = null;
  private readonly account?: UserStorageIdentity;

  constructor(
    private readonly store: ProfileStore,
    private readonly remote: ProfileRemote,
    private readonly schedule: Schedule = (run, delay) => setTimeout(run, delay),
    options: ProfileSyncOptions = {},
  ) {
    this.account = options.account;
    this.hydratePendingFromStore();
    this.currentStatus = { state: "idle", version: store.getProfileVersion() };
  }

  currentReconcile(): Promise<ProfileReconcileResult> | null {
    return this.reconcileInFlight;
  }

  /** 中文注释：给 capture/apply 定时器在没有环境 ALS 时回到绑定账号。 */
  accountBinding(): UserStorageIdentity | undefined {
    return this.account;
  }

  /** 中文注释：盘点失败必须标 failed，禁止调用方吞掉后仍像未发生。 */
  reportFailure(error: unknown): void {
    this.markFailure(error);
  }

  listStoredKeys(): string[] {
    return this.store.listKeys();
  }

  readStored(key: string): string | undefined {
    return this.store.get(key);
  }

  /**
   * 中文注释：升级清理旧快照键只删远端条目，不写 deleted.* tombstone，
   * 以免把未修改内置 Skill 当成用户删除。
   */
  dropSnapshotKey(key: string): void {
    this.store.runAtomic(() => {
      this.store.remove(key);
      this.persistPending({ key, op: "delete" });
    });
  }

  /**
   * 中文注释：明确 upsert 时按逻辑 ID 清掉全部历史 live/deleted 别名，只写权威键。
   * 清别名是 pending delete，不得再生成逻辑删除 tombstone。
   */
  replaceVendorLogicalSnapshot(id: string, liveValue: string): void {
    const aliases = listVendorKeyAliases(id);
    const sensitive = registeredSensitivity(aliases.authoritative) === "encrypted";
    this.store.runAtomic(() => {
      for (const key of aliases.deleted) {
        if (this.store.listKeys().includes(key)) this.store.remove(key);
        this.persistPending({ key, op: "delete" });
      }
      for (const key of aliases.live) {
        if (key === aliases.authoritative) continue;
        if (this.store.listKeys().includes(key)) this.store.remove(key);
        this.persistPending({ key, op: "delete" });
      }
      this.store.set(aliases.authoritative, liveValue, sensitive);
      const entry = this.store.exportStoredSnapshot()[aliases.authoritative];
      validateStoredEntry(aliases.authoritative, entry);
      this.persistPending({ key: aliases.authoritative, op: "set", entry });
    });
  }

  /** 中文注释：明确删除必须同时 tombstone 权威键与历史别名，结果与遍历顺序无关。 */
  tombstoneVendorLogicalSnapshot(id: string): void {
    const aliases = listVendorKeyAliases(id);
    this.store.runAtomic(() => {
      for (const key of aliases.live) {
        this.writeExplicitDelete(key, this.store.get(key) ?? JSON.stringify({ id }));
      }
    });
  }

  markSkillSyncSchema(version: string): void {
    this.store.setMeta("skill_sync_schema", version);
  }

  reconcile(trigger: ProfileReconcileTrigger): Promise<ProfileReconcileResult> {
    if (this.reconcileInFlight) return this.reconcileInFlight;
    const running = this.runReconcile(trigger).finally(() => {
      if (this.reconcileInFlight === running) this.reconcileInFlight = null;
    });
    this.reconcileInFlight = running;
    return running;
  }

  async login(): Promise<void> {
    const result = await this.reconcile("login");
    if (result.state === "failed") {
      throw new Error(this.currentStatus.failureReason ?? "个人配置同步失败");
    }
  }

  private async runReconcile(_trigger: ProfileReconcileTrigger): Promise<ProfileReconcileResult> {
    this.currentStatus = { ...this.currentStatus, state: "syncing", failureReason: undefined };
    try {
      // 中文注释：版本相同且无 pending 时只读 metadata，禁止再拉完整快照。
      const metadata = await this.remote.getMetadata();
      validateMetadata(metadata);
      this.hydratePendingFromStore();
      if (metadata.version === this.store.getProfileVersion() && this.pending.size === 0) {
        this.markSuccess(metadata.version);
        return { state: "unchanged", version: metadata.version, usedCachedLocal: true };
      }
      // 中文注释：有明确 pending 时只重放 set/delete，禁止用下载覆盖未提交的本机变更。
      if (this.pending.size > 0) {
        await this.flush();
        return { state: "uploaded", version: this.store.getProfileVersion(), usedCachedLocal: true };
      }
      const current = await this.remote.getCurrent();
      validateSnapshot(current);
      if (current.version > this.store.getProfileVersion()) {
        // 中文注释：必须先回写真实账号库；失败不得抬升 profile 版本，也不得标 synced。
        try {
          await this.applyCommittedLive(current.entries, "download");
        } catch (error) {
          this.markFailure(error);
          return {
            state: "failed",
            version: this.store.getProfileVersion(),
            usedCachedLocal: true,
          };
        }
        this.store.applyStoredSnapshot(current.entries, current.version);
        this.markSuccess(current.version);
        const { bumpModelCatalogVersion } = await import("../model-providers/model-catalog-invalidation");
        bumpModelCatalogVersion("profile");
        return { state: "downloaded", version: current.version, usedCachedLocal: false };
      }
      if (this.store.getProfileVersion() > current.version) {
        for (const [key, entry] of Object.entries(this.store.exportStoredSnapshot())) {
          this.persistPending({ key, op: "set", entry });
        }
        await this.flush();
        return { state: "uploaded", version: this.store.getProfileVersion(), usedCachedLocal: true };
      }
      this.markSuccess(Math.max(current.version, this.store.getProfileVersion()));
      return {
        state: "unchanged",
        version: this.store.getProfileVersion(),
        usedCachedLocal: true,
      };
    } catch (error) {
      this.markFailure(error);
      return {
        state: "failed",
        version: this.store.getProfileVersion(),
        usedCachedLocal: true,
      };
    }
  }

  forgetMissingCollectionKeys(liveKeys: Set<string>, prefixes: readonly string[]): void {
    for (const key of this.store.listKeys()) {
      if (!prefixes.some((prefix) => key.startsWith(prefix))) continue;
      if (liveKeys.has(key)) continue;
      // 中文注释：只有本机曾经观察到的集合键才能记显式删除。
      this.recordExplicitDelete(key, this.store.get(key));
    }
  }

  setPersistent(key: string, value: string, _sensitive?: boolean): void {
    assertRegisteredProfileSyncKey(key);
    // 中文注释：敏感度只信注册表，忽略调用方/客户端传入值。
    const sensitive = registeredSensitivity(key) === "encrypted";
    const deletedKey = `deleted.${key}`;
    if (
      this.store.get(key) === value
      && !this.pending.has(key)
      && !this.pending.has(deletedKey)
      && !this.store.listKeys().includes(deletedKey)
    ) {
      // 中文注释：未变化的 live 值不是显式 mutation，禁止当成 pending set 覆盖远端。
      return;
    }
    this.store.runAtomic(() => {
      if (this.store.listKeys().includes(deletedKey) || this.pending.has(deletedKey)) {
        this.store.remove(deletedKey);
        this.persistPending({ key: deletedKey, op: "delete" });
      }
      this.store.set(key, value, sensitive);
      const entry = this.store.exportStoredSnapshot()[key];
      validateStoredEntry(key, entry);
      this.persistPending({ key, op: "set", entry });
    });
    const generation = ++this.timerGeneration;
    this.schedule(() => {
      if (generation === this.timerGeneration) void this.flush().catch(() => undefined);
    }, 5_000);
  }

  async flush(): Promise<void> {
    this.hydratePendingFromStore();
    if (this.pending.size === 0) {
      this.markSuccess(this.store.getProfileVersion());
      return;
    }
    this.currentStatus = { ...this.currentStatus, state: "syncing", failureReason: undefined };
    try {
      let attempts = 0;
      while (attempts < 3) {
        attempts += 1;
        const current = await this.remote.getCurrent();
        validateSnapshot(current);
        // 中文注释：远端已包含本机 pending（commit 成功但响应丢失）时禁止再次提交。
        if (this.pendingAlreadyApplied(current.entries)) {
          await this.confirmAppliedSnapshot(current);
          return;
        }
        const outgoing = mergeOutgoingEntries(current.entries, this.pending, this.store);
        validateEntries(outgoing);
        try {
          const committed = await this.remote.commit(current.version, outgoing);
          validateSnapshot(committed);
          // 中文注释：先回写真实账号库，成功后才能清 pending 并标 synced。
          await this.confirmAppliedSnapshot(committed);
          return;
        } catch (error) {
          if (!(error instanceof ProfileConflictError) || attempts >= 3) throw error;
          // 只重放本机仍未提交的稳定键，远端其他键保持最新值。
        }
      }
    } catch (error) {
      this.markFailure(error);
      throw error;
    }
  }

  status(): ProfileSyncStatus {
    return { ...this.currentStatus };
  }

  private hydratePendingFromStore(): void {
    this.pending.clear();
    for (const mutation of this.store.listPendingMutations()) {
      this.pending.set(mutation.key, mutation);
    }
  }

  /**
   * 中文注释：下载必须回写真实账号库；flush 在已绑定账号时也必须进该账号库。
   * 未绑定账号的 store-only flush 只维护 profile.sqlite / 远端，禁止误用环境 ALS。
   */
  private async applyCommittedLive(
    entries: Record<string, StoredProfileEntry>,
    mode: "download" | "flush",
  ): Promise<void> {
    const live = this.store.decodeStoredEntries(entries);
    if (this.account) {
      const { prepareUserDatabase } = await import("@/utils/db");
      const { runWithUserStorage } = await import("../runtime/user-storage-context");
      await prepareUserDatabase(this.account);
      await runWithUserStorage(this.account, () => applyLiveAccountSettings(live));
      return;
    }
    if (mode === "flush") return;
    await applyLiveAccountSettings(live);
  }

  private pendingAlreadyApplied(remote: Record<string, StoredProfileEntry>): boolean {
    if (this.pending.size === 0) return false;
    const liveRemote = this.store.decodeStoredEntries(remote);
    for (const [key, mutation] of this.pending) {
      if (mutation.op === "delete") {
        if (Object.hasOwn(remote, key)) return false;
        continue;
      }
      if (!mutation.entry) return false;
      const want = this.store.decodeStoredEntries({ [key]: mutation.entry })[key];
      if (liveRemote[key] !== want) return false;
    }
    return true;
  }

  private async confirmAppliedSnapshot(snapshot: ProfileSnapshot): Promise<void> {
    try {
      await this.applyCommittedLive(snapshot.entries, "flush");
    } catch (error) {
      this.markFailure(error);
      throw error;
    }
    this.store.applyStoredSnapshot(snapshot.entries, snapshot.version);
    this.store.clearPendingMutations();
    this.pending.clear();
    this.timerGeneration += 1;
    this.markSuccess(snapshot.version);
  }

  private persistPending(mutation: ProfilePendingMutation): void {
    this.store.upsertPendingMutation(mutation);
    this.pending.set(mutation.key, mutation);
  }

  private recordExplicitDelete(key: string, previous?: string): void {
    this.store.runAtomic(() => this.writeExplicitDelete(key, previous));
  }

  private writeExplicitDelete(key: string, previous?: string): void {
    if (isDeviceLocalProfileSyncKey(key) || key.startsWith("deleted.")) return;
    const deletedKey = `deleted.${key}`;
    const payload = JSON.stringify(collectionTombstonePayload(key, previous));
    this.store.remove(key);
    this.store.set(deletedKey, payload, false);
    const tombstone = this.store.exportStoredSnapshot()[deletedKey];
    validateStoredEntry(deletedKey, tombstone);
    this.persistPending({ key, op: "delete" });
    this.persistPending({ key: deletedKey, op: "set", entry: tombstone });
  }

  private markSuccess(version: number): void {
    this.currentStatus = {
      state: "synced",
      version,
      lastSuccessAt: new Date().toISOString(),
    };
  }

  private markFailure(error: unknown): void {
    this.currentStatus = {
      ...this.currentStatus,
      state: "failed",
      failureReason: error instanceof Error ? error.message : "个人配置同步失败",
    };
  }
}

function validateMetadata(metadata: ProfileVersionMetadata): void {
  if (!Number.isSafeInteger(metadata.version) || metadata.version < 0) {
    throw new Error("个人配置远端版本无效");
  }
  if (metadata.etag !== `profile-v${metadata.version}`) {
    throw new Error("个人配置 metadata ETag 无效");
  }
}

function validateSnapshot(snapshot: ProfileSnapshot): void {
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 0) {
    throw new Error("个人配置远端版本无效");
  }
  validateEntries(snapshot.entries);
}

function validateEntries(entries: Record<string, StoredProfileEntry>): void {
  if (!entries || typeof entries !== "object" || Object.keys(entries).length > 2048) {
    throw new Error("个人配置快照无效");
  }
  for (const [key, entry] of Object.entries(entries)) {
    if (isDeviceLocalProfileSyncKey(key)) continue;
    validateStoredEntry(key, entry);
  }
}

function validateStoredEntry(key: string, entry: StoredProfileEntry | undefined): asserts entry is StoredProfileEntry {
  if (
    !entry
    || !/^[a-z][a-z0-9_.-]{0,127}$/i.test(key)
    || /^(?:team|project)\./i.test(key)
    || typeof entry.value !== "string"
    || (entry.sensitive && !entry.value.startsWith("tj-profile:v1:"))
    || (!entry.sensitive && !entry.value.startsWith("plain:"))
  ) {
    throw new Error("个人配置同步条目无效");
  }
  const registration = findProfileSyncRegistration(key);
  if (!registration) throw new Error(`PROFILE_SYNC_KEY_NOT_REGISTERED: ${key}`);
  assertRegistrySensitivity(key, entry.sensitive);
}

function mergeOutgoingEntries(
  remote: Record<string, StoredProfileEntry>,
  pending: Map<string, ProfilePendingMutation>,
  store: ProfileStore,
): Record<string, StoredProfileEntry> {
  const next: Record<string, StoredProfileEntry> = {};
  for (const [key, entry] of Object.entries(remote)) {
    if (!findProfileSyncRegistration(key) || isDeviceLocalProfileSyncKey(key)) continue;
    next[key] = repairOutgoingEntry(store, key, entry) ?? entry;
  }
  for (const [key, mutation] of pending) {
    if (!findProfileSyncRegistration(key) || isDeviceLocalProfileSyncKey(key)) continue;
    if (mutation.op === "delete") {
      delete next[key];
      continue;
    }
    if (!mutation.entry) continue;
    const repaired = repairOutgoingEntry(store, key, mutation.entry);
    if (repaired) next[key] = repaired;
  }
  return next;
}

function repairOutgoingEntry(
  store: ProfileStore,
  key: string,
  entry: StoredProfileEntry,
): StoredProfileEntry | undefined {
  const registration = findProfileSyncRegistration(key);
  if (!registration) return undefined;
  const mustEncrypt = registration.sensitivity === "encrypted";
  if (mustEncrypt && (!entry.sensitive || entry.value.startsWith("plain:"))) {
    const live = store.get(key);
    if (!live) return undefined;
    store.set(key, live, true);
    const repaired = store.exportStoredSnapshot()[key];
    return repaired?.sensitive ? repaired : undefined;
  }
  return entry;
}

function collectionTombstonePayload(key: string, previous?: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { $tombstone: true };
  let parsed: Record<string, unknown> = {};
  if (previous) {
    try {
      const value = JSON.parse(previous) as unknown;
      if (value && typeof value === "object") parsed = value as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  if (key.startsWith("vendorItem.") && typeof parsed.id === "string") payload.id = parsed.id;
  if (key.startsWith("vendor.")) payload.id = typeof parsed.id === "string" ? parsed.id : key.slice("vendor.".length);
  if (key.startsWith("prompt.")) payload.id = Number(key.slice("prompt.".length));
  if (key.startsWith("agent.")) payload.key = typeof parsed.key === "string" ? parsed.key : key.slice("agent.".length);
  if (key.startsWith("model.")) {
    payload.vendorId = parsed.vendorId;
    payload.model = parsed.model;
    payload.path = parsed.path;
    payload.fileName = parsed.fileName;
  }
  if (key.startsWith("skill.")) payload.path = parsed.path;
  return payload;
}
