import type { PersonalManifest } from "./personal-project-sync";
import {
  clearTeamReleaseReceipt,
  computeManifestFingerprint,
  evidenceMatchesReceipt,
  readTeamReleaseReceiptStrict,
  writeTeamReleaseReceipt,
  type ManifestObjectDigest,
  type TeamReceiptPhase,
  type TeamReleaseReceipt,
} from "../runtime/team-release-receipt";
import {
  clearTeamCheckpointReceipt,
  readTeamCheckpointReceipt,
  writeTeamCheckpointReceipt,
} from "../runtime/team-checkpoint-receipt";

export type TeamProjectRole = "owner" | "editor" | "viewer";

export interface TeamLocal {
  current?: PersonalManifest;
  dirty?: boolean;
  install(readonly: boolean): Promise<void>;
  setReadonly(reason: string): Promise<void>;
  createRecovery(reason: string): Promise<void>;
  createSnapshot(options?: {
    afterBackup?: () => void | Promise<void>;
  }): Promise<PersonalManifest>;
  markLegacyEdited?(): void;
}

export type TeamSyncResult = {
  state: "published" | "unchanged" | "skipped_not_editable" | "skipped_viewer";
  capturedMutationGeneration?: number | "unknown";
  /** checkpoint 永不释放锁 */
  retainedLock: true;
  /** finalize 尚未完成时为 true，协调器不得清 dirty */
  pendingFinalize?: boolean;
};

/**
 * 中文注释：checkpoint 恢复结构化结果。
 * 证据一致时只推进本地版本视图并返回 pendingFinalize；
 * 禁止在此删 receipt / dirty=false——必须由 SyncCoordinator finalize 后再 clear。
 */
export type TeamCheckpointRecoveryResult = {
  recovered: true;
  pendingFinalize: true;
  expectedVersion: number;
  capturedMutationGeneration: number | "unknown";
  objects: ManifestObjectDigest[];
  manifestFingerprint: string;
};

/** 协调器注入：定时器必须走 publish → finalize → confirmCheckpointFinalizeStrict */
export type TeamCheckpointExecutor = (
  reason: "idle" | "checkpoint" | "manual",
) => Promise<TeamSyncResult>;

export interface ProjectEvidence {
  version: number;
  objects: ManifestObjectDigest[];
}

export interface TeamRemote {
  acquire(): Promise<{ lockId: string; fencingToken: number; holderName?: string } | undefined>;
  download(): Promise<void>;
  publish(
    lockId: string,
    fencingToken: number,
    snapshot: PersonalManifest,
    personalModels: Record<string, string>,
  ): Promise<void>;
  release(lockId: string, fencingToken: number): Promise<void>;
  heartbeat(lockId: string, fencingToken: number): Promise<void>;
  /** 中央当前版本（权威 getProject） */
  latestVersion?(): Promise<number>;
  /** 中央版本+对象摘要证据（生产 getProject） */
  fetchProjectEvidence?(): Promise<ProjectEvidence>;
}

export interface TeamProjectState {
  editable: boolean;
  readonlyReason: string;
  lockHolder: string;
  recoveryRequired: boolean;
  /** 仅 release，禁止业务写与 re-publish */
  releaseOnly?: boolean;
  /** 仅本地清理 receipt，禁止 publish/release */
  cleanupOnly?: boolean;
}

export type TeamCloseResultState =
  | "published"
  /** release 已成功（或幂等），等待协调器 finalize journal/sidecar 后再删 receipt */
  | "released_cleanup_pending"
  | "skipped_not_editable"
  | "skipped_viewer"
  | "recovery_required";

export type TeamCloseResult = {
  state: TeamCloseResultState;
  capturedMutationGeneration?: number | "unknown";
  releasePending?: boolean;
  /** 中央证据已确认时为 true，finalize 才可清 journal */
  centralEvidenceConfirmed?: boolean;
};

export interface TeamReleaseReceiptStoreConfig {
  dataRoot: string;
  userSegment: string;
  projectUuid: string;
}

type PendingMemory = {
  lockId: string;
  fencingToken: number;
  capturedMutationGeneration?: number | "unknown";
  baseVersion?: number;
  expectedVersion?: number;
  manifestFingerprint?: string;
  objects?: ManifestObjectDigest[];
  phase: TeamReceiptPhase;
};

export class TeamProjectSync {
  private lock?: { lockId: string; fencingToken: number };
  private current: TeamProjectState = {
    editable: false,
    readonlyReason: "not_open",
    lockHolder: "",
    recoveryRequired: false,
    releaseOnly: false,
    cleanupOnly: false,
  };
  private heartbeatGeneration = 0;
  private protectPendingLocal = false;
  private releasePending?: PendingMemory;
  private receiptStore?: TeamReleaseReceiptStoreConfig;
  private receiptClearHook?: () => void;
  private idleHandle: unknown;
  private checkpointHandle: unknown;
  private scheduleToken = 0;
  private checkpointToken = 0;
  private editEpoch = 0;
  private syncTail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private checkpointExecutor?: TeamCheckpointExecutor;

  constructor(
    private readonly role: TeamProjectRole,
    private readonly local: TeamLocal,
    private readonly remote: TeamRemote,
    private readonly currentEditorModels: () => Record<string, string>,
    private readonly schedule: (run: () => void, delay: number) => unknown = scheduleUnref,
    private readonly heartbeatIntervalMs = 20_000,
  ) {}

  setProtectPendingLocal(protect: boolean): void {
    this.protectPendingLocal = protect;
  }

  setCheckpointExecutor(executor: TeamCheckpointExecutor | undefined): void {
    this.checkpointExecutor = executor;
  }

  configureReleaseReceiptStore(config: TeamReleaseReceiptStoreConfig): void {
    this.receiptStore = config;
  }

  /** 测试钩子：强制 clear receipt 失败 */
  setReceiptClearHook(hook: (() => void) | undefined): void {
    this.receiptClearHook = hook;
  }

  /**
   * 按 phase 分开恢复：
   * - acquired_release_pending：从未 publish，只幂等 release
   * - publishing：getProject 核对版本+摘要
   * - published_release_pending：release_only
   * - released_cleanup_pending：仅本地清理
   */
  async restoreReleaseReceiptIfPresent(): Promise<boolean> {
    if (!this.receiptStore) return false;
    if (this.role === "viewer") {
      return false;
    }
    const read = readTeamReleaseReceiptStrict(
      this.receiptStore.dataRoot,
      this.receiptStore.userSegment,
      this.receiptStore.projectUuid,
    );
    if (read.kind === "missing") return false;
    const receipt = read.receipt;

    if (receipt.phase === "acquired_release_pending") {
      this.enterAcquiredReleaseOnly(receipt);
      return true;
    }

    if (receipt.phase === "released_cleanup_pending") {
      this.releasePending = this.memoryFromReceipt(receipt);
      this.current = {
        editable: false,
        readonlyReason: "released_cleanup_pending",
        lockHolder: "",
        recoveryRequired: false,
        releaseOnly: false,
        cleanupOnly: true,
      };
      return true;
    }

    if (receipt.phase === "published_release_pending") {
      this.enterReleaseOnly(receipt);
      return true;
    }

    // publishing：必须用中央证据判断是否已提交
    if (receipt.phase === "publishing") {
      return this.recoverPublishingReceipt(receipt);
    }

    return false;
  }

  async open(): Promise<void> {
    if (this.receiptStore && (await this.restoreReleaseReceiptIfPresent())) {
      if (this.current.cleanupOnly) {
        await this.local.setReadonly("released_cleanup_pending");
      } else if (this.current.releaseOnly) {
        await this.local.setReadonly("release_only_pending");
      } else if (this.current.recoveryRequired) {
        // already set
      } else {
        // publishing 可重试：仍只读直至 close 重试路径持锁
        await this.local.setReadonly("publishing_retry");
      }
      return;
    }
    // 中文注释：checkpoint receipt 与 release receipt 分离；先恢复 checkpoint 再获锁。
    // 中文注释：恢复只验证中央证据并返回 pendingFinalize；finalize/清 receipt 由协调器完成。
    if (this.receiptStore) {
      try {
        const recovered = await this.recoverCheckpointReceiptIfPresent();
        if (recovered && recovered.pendingFinalize) {
          this.pendingCheckpointRecovery = recovered;
        }
      } catch {
        // fail-closed：保留 dirty/receipt，继续以只读恢复态打开供用户处理
        if (this.local.dirty !== undefined) this.local.dirty = true;
      }
    }

    if (this.role === "viewer") {
      if (this.protectPendingLocal) {
        await this.local.install(true);
        this.current = {
          editable: false,
          readonlyReason: "viewer_role_pending_local",
          lockHolder: "",
          recoveryRequired: true,
        };
        return;
      }
      await this.remote.download();
      await this.local.install(true);
      this.current = {
        editable: false,
        readonlyReason: "viewer_role",
        lockHolder: "",
        recoveryRequired: false,
      };
      return;
    }

    const acquired = await this.remote.acquire();
    if (this.protectPendingLocal) {
      const releaseAcquired = async () => {
        if (!acquired) return;
        try {
          await this.remote.release(acquired.lockId, acquired.fencingToken);
        } catch {
          if (this.receiptStore) {
            this.persistReleasePending(
              {
                lockId: acquired.lockId,
                fencingToken: acquired.fencingToken,
                baseVersion: this.local.current?.version,
                phase: "acquired_release_pending",
              },
              "acquired_release_pending",
            );
          }
        }
      };
      if (typeof this.remote.latestVersion === "function") {
        try {
          const remoteVersion = await this.remote.latestVersion();
          if (!Number.isFinite(remoteVersion)) {
            throw new Error("中央版本非有限值");
          }
          const localVersion = this.local.current?.version;
          if (localVersion == null || !Number.isFinite(localVersion)) {
            await releaseAcquired();
            await this.local.setReadonly("pending_mutation_local_version_missing");
            await this.local.createRecovery("pending_mutation_local_version_missing");
            this.current = {
              editable: false,
              readonlyReason: "local_version_missing",
              lockHolder: "",
              recoveryRequired: true,
            };
            return;
          }
          if (remoteVersion > localVersion) {
            await releaseAcquired();
            await this.local.setReadonly("pending_mutation_remote_advanced");
            await this.local.createRecovery("pending_mutation_remote_advanced");
            this.current = {
              editable: false,
              readonlyReason: "remote_version_advanced",
              lockHolder: "",
              recoveryRequired: true,
            };
            return;
          }
        } catch {
          await releaseAcquired();
          await this.local.setReadonly("pending_mutation_version_unknown");
          await this.local.createRecovery("pending_mutation_version_unknown");
          this.current = {
            editable: false,
            readonlyReason: "remote_version_unknown",
            lockHolder: "",
            recoveryRequired: true,
          };
          return;
        }
      }
      if (!acquired) {
        await this.local.setReadonly("locked_by_other_pending_local");
        await this.local.createRecovery("pending_mutation_lock_unavailable");
        this.current = {
          editable: false,
          readonlyReason: "locked_by_other",
          lockHolder: "",
          recoveryRequired: true,
        };
        return;
      }
      this.lock = { lockId: acquired.lockId, fencingToken: acquired.fencingToken };
      await this.local.install(false);
      this.current = {
        editable: true,
        readonlyReason: "",
        lockHolder: acquired.holderName ?? "",
        recoveryRequired: false,
      };
      this.scheduleHeartbeat();
      return;
    }

    await this.remote.download();
    if (!acquired) {
      await this.local.install(true);
      this.current = {
        editable: false,
        readonlyReason: "locked_by_other",
        lockHolder: "",
        recoveryRequired: false,
      };
      return;
    }
    this.lock = { lockId: acquired.lockId, fencingToken: acquired.fencingToken };
    await this.local.install(false);
    this.current = {
      editable: true,
      readonlyReason: "",
      lockHolder: acquired.holderName ?? "",
      recoveryRequired: false,
    };
    this.scheduleHeartbeat();
  }

  async openOfflineReadonly(): Promise<void> {
    if (this.protectPendingLocal) {
      await this.local.setReadonly("offline_team_forbidden_pending_local");
      await this.local.createRecovery("pending_mutation_offline");
      this.current = {
        editable: false,
        readonlyReason: "offline_team_forbidden",
        lockHolder: "",
        recoveryRequired: true,
      };
      return;
    }
    await this.local.install(true);
    this.current = {
      editable: false,
      readonlyReason: "offline_team_forbidden",
      lockHolder: "",
      recoveryRequired: false,
    };
  }

  async onNetworkLost(): Promise<void> {
    await this.becomeReadonly("network_disconnected");
  }

  async onSessionInvalid(): Promise<void> {
    await this.becomeReadonly("session_invalid");
  }

  async onLockExpired(): Promise<void> {
    await this.becomeReadonly("lease_expired");
  }

  /**
   * 编辑后调度 30s idle / 120s checkpoint 自动发布（保持锁）。
   * 中文注释：viewer、无锁、只读恢复态不得调度发布。
   */
  markEdited(): void {
    if (this.role === "viewer" || !this.current.editable || this.current.releaseOnly || this.current.cleanupOnly) {
      return;
    }
    if (!this.lock) return;
    if (this.local.dirty !== undefined) this.local.dirty = true;
    else this.local.markLegacyEdited?.();
    this.editEpoch += 1;
    if (this.closed) return;
    this.scheduleFollowUpPublish();
  }

  /**
   * checkpoint：snapshot → receipt → publish；finalize 与清 dirty 必须由协调器 executor 完成。
   * 全程不 release。不得复用最终 close/release receipt。
   * 中文注释：进入统一 syncTail；executor 内必须用 publishCheckpointUnlocked 禁止嵌套锁。
   */
  async publishCheckpoint(reason: "idle" | "checkpoint" | "manual" = "manual"): Promise<TeamSyncResult> {
    return this.withSyncLock(() => this.publishCheckpointUnlocked(reason));
  }

  /**
   * 已在 syncTail 内调用的 checkpoint 发布（禁止再套 withSyncLock）。
   * 中文注释：协调器 executor 必须使用本方法，禁止 public publishCheckpoint 嵌套。
   */
  async publishCheckpointUnlocked(
    reason: "idle" | "checkpoint" | "manual" = "manual",
  ): Promise<TeamSyncResult> {
    return this.publishCheckpointBody(reason);
  }

  /** 定时器入口：整段 executor 必须在同一把 syncTail 内（含 finalize/清 receipt）。 */
  async runScheduledCheckpoint(reason: "idle" | "checkpoint"): Promise<TeamSyncResult> {
    return this.withSyncLock(async () => {
      if (this.checkpointExecutor) {
        // 中文注释：executor 已在锁内；其内部不得再调会嵌套锁的 public publishCheckpoint。
        return this.checkpointExecutor(reason);
      }
      // 中文注释：无 executor 时禁止自行清 dirty；仅返回 pendingFinalize。
      return this.publishCheckpointUnlocked(reason);
    });
  }

  private async publishCheckpointBody(
    _reason: "idle" | "checkpoint" | "manual",
  ): Promise<TeamSyncResult> {
    if (this.role === "viewer") {
      return { state: "skipped_viewer", retainedLock: true };
    }
    if (!this.lock || !this.current.editable || this.current.releaseOnly || this.current.cleanupOnly) {
      return { state: "skipped_not_editable", retainedLock: true };
    }
    if (this.local.dirty === false) {
      return { state: "unchanged", retainedLock: true };
    }
    const { lockId, fencingToken } = this.lock;
    const baseVersion = this.local.current?.version ?? 0;
    const snapshot = await this.local.createSnapshot();
    const captured = snapshot.capturedMutationGeneration === undefined
      ? 0
      : snapshot.capturedMutationGeneration;
    if (captured === "unknown") {
      throw new Error("缺少 captured mutation generation，禁止 Team checkpoint 发布");
    }
    const objects: ManifestObjectDigest[] = snapshot.objects.map((o) => ({
      relativePath: o.relativePath,
      md5: o.md5,
      size: o.size,
    }));
    const expectedVersion = baseVersion + 1;
    if (this.receiptStore) {
      // 中文注释：checkpoint receipt 与最终 release receipt 分目录，禁止阶段混淆。
      writeTeamCheckpointReceipt(
        this.receiptStore.dataRoot,
        this.receiptStore.userSegment,
        {
          projectUuid: this.receiptStore.projectUuid,
          lockId,
          fencingToken,
          phase: "publishing",
          baseVersion,
          expectedVersion,
          capturedMutationGeneration: captured,
          objects,
        },
      );
    }
    try {
      await this.remote.publish(lockId, fencingToken, {
        version: snapshot.version,
        objects: structuredClone(snapshot.objects),
      }, { ...this.currentEditorModels() });
    } catch (error) {
      // 中文注释：锁/fencing 失败时切只读，publish 次数已发生但不得释放锁伪装成功。
      const message = error instanceof Error ? error.message : String(error);
      if (/锁|fencing|lease|token|device|viewer/i.test(message)) {
        await this.becomeReadonly("lock_or_fencing_invalid");
      }
      throw error;
    }
    // 中文注释：checkpoint 仅推进本地版本清单，保持可写与持锁；禁止在此清 dirty。
    this.local.current = {
      version: expectedVersion,
      objects: structuredClone(snapshot.objects),
    };
    if (this.local.dirty !== undefined) this.local.dirty = true;
    if (this.receiptStore) {
      writeTeamCheckpointReceipt(
        this.receiptStore.dataRoot,
        this.receiptStore.userSegment,
        {
          projectUuid: this.receiptStore.projectUuid,
          lockId,
          fencingToken,
          phase: "published_pending_finalize",
          baseVersion,
          expectedVersion,
          capturedMutationGeneration: captured,
          objects,
        },
      );
    }
    // 中文注释：保持原锁与心跳；dirty 必须待 finalize+清 receipt 成功后由协调器清除。
    this.scheduleHeartbeat();
    return {
      state: "published",
      capturedMutationGeneration: captured,
      retainedLock: true,
      pendingFinalize: true,
    };
  }

  /**
   * 重启恢复 published_pending_finalize：
   * - 中央版本+对象摘要一致：只推进本地版本视图，返回 pendingFinalize；不删 receipt、不清 dirty
   * - 证据不确定：fail-closed，保留 dirty/receipt
   * 中文注释：journal finalize → 确认清理 → confirmCheckpointFinalizeStrict 必须由 SyncCoordinator 执行。
   */
  async recoverCheckpointReceiptIfPresent(): Promise<false | TeamCheckpointRecoveryResult> {
    if (!this.receiptStore) return false;
    const receipt = readTeamCheckpointReceipt(
      this.receiptStore.dataRoot,
      this.receiptStore.userSegment,
      this.receiptStore.projectUuid,
    );
    if (!receipt || receipt.phase !== "published_pending_finalize") return false;
    if (typeof this.remote.fetchProjectEvidence !== "function") {
      throw new Error("中央项目证据接口不可用，checkpoint 恢复 fail-closed");
    }
    let evidence: ProjectEvidence;
    try {
      evidence = await this.remote.fetchProjectEvidence();
    } catch (error) {
      if (this.local.dirty !== undefined) this.local.dirty = true;
      throw new Error(
        `中央证据不确定，保留 checkpoint receipt 与 dirty：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const fingerprint = computeManifestFingerprint(receipt.objects);
    const evidenceFp = computeManifestFingerprint(evidence.objects);
    if (evidence.version !== receipt.expectedVersion || evidenceFp !== fingerprint) {
      if (this.local.dirty !== undefined) this.local.dirty = true;
      throw new Error("中央版本或对象摘要与 checkpoint receipt 不一致，fail-closed");
    }
    // 中文注释：证据一致——仅同步本地版本视图；receipt 与 dirty 留给协调器 finalize 路径。
    this.local.current = {
      version: receipt.expectedVersion,
      objects: receipt.objects.map((o) => ({
        relativePath: o.relativePath,
        md5: o.md5,
        size: o.size,
      })),
    };
    if (this.local.dirty !== undefined) this.local.dirty = true;
    return {
      recovered: true,
      pendingFinalize: true,
      expectedVersion: receipt.expectedVersion,
      capturedMutationGeneration: receipt.capturedMutationGeneration,
      objects: receipt.objects.map((o) => ({
        relativePath: o.relativePath,
        md5: o.md5,
        size: o.size,
      })),
      manifestFingerprint: fingerprint,
    };
  }

  /** 暴露最近一次 open 时未完成的 checkpoint 恢复（供协调器 finalize）。 */
  private pendingCheckpointRecovery?: TeamCheckpointRecoveryResult;

  takePendingCheckpointRecovery(): TeamCheckpointRecoveryResult | undefined {
    const value = this.pendingCheckpointRecovery;
    this.pendingCheckpointRecovery = undefined;
    return value;
  }

  /** 协调器 finalize 成功后清除 checkpoint receipt（不得触碰 release receipt）。 */
  confirmCheckpointFinalizeStrict(): void {
    if (!this.receiptStore) return;
    clearTeamCheckpointReceipt(
      this.receiptStore.dataRoot,
      this.receiptStore.userSegment,
      this.receiptStore.projectUuid,
    );
  }

  /** 仅在 finalize + 清 receipt 成功后由协调器调用。 */
  markCheckpointCleanIfEpochStable(epochAtPublish: number): void {
    if (this.editEpoch === epochAtPublish && this.local.dirty !== undefined) {
      this.local.dirty = false;
    } else if (this.local.dirty !== undefined) {
      this.local.dirty = true;
      this.scheduleFollowUpPublish();
    }
  }

  currentEditEpoch(): number {
    return this.editEpoch;
  }

  private scheduleFollowUpPublish(): void {
    if (this.closed || !this.current.editable || !this.lock) return;
    tryCancelSchedule(this.idleHandle);
    this.idleHandle = undefined;
    const idleToken = ++this.scheduleToken;
    this.idleHandle = this.schedule(() => {
      this.idleHandle = undefined;
      if (idleToken !== this.scheduleToken || this.closed) return;
      // 中文注释：定时器必须经 executor，禁止直接 publish 后清 dirty。
      void this.runScheduledCheckpoint("idle").catch(() => undefined);
    }, 30_000);
    if (!this.checkpointHandle) {
      const checkpointToken = ++this.checkpointToken;
      this.checkpointHandle = this.schedule(() => {
        this.checkpointHandle = undefined;
        if (checkpointToken !== this.checkpointToken || this.closed) return;
        void this.runScheduledCheckpoint("checkpoint").catch(() => undefined);
      }, 120_000);
    }
  }

  private cancelAutosyncTimers(): void {
    this.scheduleToken += 1;
    this.checkpointToken += 1;
    tryCancelSchedule(this.idleHandle);
    tryCancelSchedule(this.checkpointHandle);
    this.idleHandle = undefined;
    this.checkpointHandle = undefined;
  }

  private withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.syncTail.then(fn, fn);
    this.syncTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 关闭入口：取消新调度后，整段 publish/release 进入同一 syncTail。
   * 中文注释：必须等待在途 checkpoint 完成；禁止与 checkpoint 并发 publish。
   */
  async close(): Promise<TeamCloseResult> {
    this.closed = true;
    this.cancelAutosyncTimers();
    return this.withSyncLock(() => this.closeBody());
  }

  private async closeBody(): Promise<TeamCloseResult> {
    if (this.role === "viewer") {
      return { state: "skipped_viewer" };
    }

    // 仅本地 cleanup：禁止 publish/release；禁止在协调器 finalize 前删 receipt
    // 中文注释：receipt 是最后一个清除的持久化事实——先返回 released_cleanup_pending，
    // 由 SyncCoordinator 完成 journal/sidecar finalize 后再 confirmReleasedCleanupStrict。
    if (this.current.cleanupOnly || this.releasePending?.phase === "released_cleanup_pending") {
      const gen = this.releasePending?.capturedMutationGeneration;
      if (gen === undefined || gen === "unknown") {
        // fail-closed：无合法 capture 不得伪装清理成功
        return { state: "recovery_required" };
      }
      this.lock = undefined;
      this.current = {
        editable: false,
        readonlyReason: "released_cleanup_pending",
        lockHolder: "",
        recoveryRequired: false,
        releaseOnly: false,
        cleanupOnly: true,
      };
      return {
        state: "released_cleanup_pending",
        capturedMutationGeneration: gen,
        centralEvidenceConfirmed: true,
      };
    }

    // 冲突/证据不足：禁止 publish/release 伪装成功
    if (this.current.recoveryRequired) {
      return { state: "recovery_required" };
    }

    // release_only：仅 release；成功后落 released_cleanup_pending，不删 receipt
    if (this.releasePending?.phase === "acquired_release_pending") {
      return this.finishAcquiredReleaseOnly(this.releasePending);
    }

    // 已 publish 的 release_only：release 后必须等待 mutation finalize
    if (this.current.releaseOnly || this.releasePending?.phase === "published_release_pending") {
      if (!this.releasePending) {
        return { state: "skipped_not_editable" };
      }
      return this.finishReleaseOnly(this.releasePending);
    }

    // 中文注释：publishing 表示上次响应结果不确定；同进程重试也必须先核对中央证据。
    // 禁止直接 re-publish，否则“中央已提交、响应丢失”会产生重复版本。
    if (this.releasePending?.phase === "publishing") {
      return this.retryPublishingClose(this.releasePending);
    }

    if (!this.lock || !this.current.editable) {
      return { state: "skipped_not_editable" };
    }

    return this.performPublishReleaseCycle(this.lock);
  }

  /**
   * 协调器在 journal/sidecar finalize 成功后调用：严格删除 receipt。
   * 中文注释：禁止 TeamProjectSync 在 release 成功后自行删除；receipt 必须最后清除。
   */
  confirmReleasedCleanupStrict(): void {
    this.clearReleasePendingStrict();
    this.current = {
      editable: false,
      readonlyReason: "closed",
      lockHolder: "",
      recoveryRequired: false,
      releaseOnly: false,
      cleanupOnly: false,
    };
  }

  state(): TeamProjectState {
    return { ...this.current };
  }

  pendingReleaseSnapshot():
    | { capturedMutationGeneration?: number | "unknown"; centralEvidenceConfirmed?: boolean }
    | undefined {
    if (!this.releasePending) return undefined;
    return {
      capturedMutationGeneration: this.releasePending.capturedMutationGeneration,
      centralEvidenceConfirmed:
        this.releasePending.phase === "published_release_pending"
        || this.releasePending.phase === "released_cleanup_pending",
    };
  }

  writeGuard(): { lockId: string; fencingToken: number } {
    if (this.current.releaseOnly || this.current.cleanupOnly) {
      throw new Error("团队项目 release_only/cleanup 只读，禁止业务写入");
    }
    if (!this.lock || !this.current.editable) {
      throw new Error("团队项目当前没有有效编辑锁");
    }
    return { ...this.lock };
  }

  private async recoverPublishingReceipt(receipt: TeamReleaseReceipt): Promise<boolean> {
    // 无指纹/期望版本：不得当作已发布
    if (
      receipt.expectedVersion == null
      || !receipt.manifestFingerprint
      || receipt.capturedMutationGeneration === undefined
    ) {
      await this.local.setReadonly("publishing_receipt_incomplete");
      await this.local.createRecovery("publishing_receipt_incomplete");
      this.releasePending = this.memoryFromReceipt(receipt);
      this.current = {
        editable: false,
        readonlyReason: "publishing_receipt_incomplete",
        lockHolder: "",
        recoveryRequired: true,
        releaseOnly: false,
        cleanupOnly: false,
      };
      return true;
    }

    if (typeof this.remote.fetchProjectEvidence !== "function") {
      await this.local.setReadonly("central_evidence_unavailable");
      await this.local.createRecovery("central_evidence_unavailable");
      this.releasePending = this.memoryFromReceipt(receipt);
      this.current = {
        editable: false,
        readonlyReason: "central_evidence_unavailable",
        lockHolder: "",
        recoveryRequired: true,
      };
      return true;
    }

    let evidence: ProjectEvidence;
    try {
      evidence = await this.remote.fetchProjectEvidence();
    } catch {
      await this.local.setReadonly("central_evidence_fetch_failed");
      await this.local.createRecovery("central_evidence_fetch_failed");
      this.releasePending = this.memoryFromReceipt(receipt);
      this.current = {
        editable: false,
        readonlyReason: "central_evidence_fetch_failed",
        lockHolder: "",
        recoveryRequired: true,
      };
      return true;
    }

    if (evidenceMatchesReceipt(receipt, evidence)) {
      // 中文注释：中央版本+摘要均匹配 → 已发布，仅 release
      const upgraded: TeamReleaseReceipt = {
        ...receipt,
        phase: "published_release_pending",
      };
      if (this.receiptStore) {
        writeTeamReleaseReceipt(
          this.receiptStore.dataRoot,
          this.receiptStore.userSegment,
          upgraded,
        );
      }
      this.enterReleaseOnly(upgraded);
      return true;
    }

    // 远端已前进且不匹配本意图 → 冲突 fail-closed，禁止 re-publish
    if (
      Number.isFinite(evidence.version)
      && receipt.baseVersion != null
      && evidence.version > receipt.baseVersion
    ) {
      await this.local.setReadonly("publishing_remote_advanced");
      await this.local.createRecovery("publishing_remote_advanced");
      this.releasePending = this.memoryFromReceipt(receipt);
      this.current = {
        editable: false,
        readonlyReason: "publishing_remote_advanced",
        lockHolder: "",
        recoveryRequired: true,
        releaseOnly: false,
      };
      return true;
    }

    // 仍在 base：可重试 publish（持原锁信息）
    this.releasePending = this.memoryFromReceipt(receipt);
    this.lock = { lockId: receipt.lockId, fencingToken: receipt.fencingToken };
    this.current = {
      editable: false,
      readonlyReason: "publishing_retry",
      lockHolder: "",
      recoveryRequired: false,
      releaseOnly: false,
    };
    this.scheduleHeartbeat();
    return true;
  }

  private enterReleaseOnly(receipt: TeamReleaseReceipt): void {
    this.releasePending = this.memoryFromReceipt({
      ...receipt,
      phase: "published_release_pending",
    });
    this.lock = { lockId: receipt.lockId, fencingToken: receipt.fencingToken };
    this.current = {
      editable: false,
      readonlyReason: "release_only_pending",
      lockHolder: "",
      recoveryRequired: false,
      releaseOnly: true,
      cleanupOnly: false,
    };
    this.scheduleHeartbeat();
  }

  /** 未 publish 锁恢复：只释放锁，成功后删 receipt，绝不触发 mutation finalize。 */
  private enterAcquiredReleaseOnly(receipt: TeamReleaseReceipt): void {
    this.releasePending = this.memoryFromReceipt({
      ...receipt,
      phase: "acquired_release_pending",
    });
    this.lock = { lockId: receipt.lockId, fencingToken: receipt.fencingToken };
    this.current = {
      editable: false,
      readonlyReason: "acquired_release_pending",
      lockHolder: "",
      recoveryRequired: false,
      releaseOnly: true,
      cleanupOnly: false,
    };
    this.scheduleHeartbeat();
  }

  private memoryFromReceipt(receipt: TeamReleaseReceipt): PendingMemory {
    return {
      lockId: receipt.lockId,
      fencingToken: receipt.fencingToken,
      capturedMutationGeneration: receipt.capturedMutationGeneration,
      baseVersion: receipt.baseVersion,
      expectedVersion: receipt.expectedVersion,
      manifestFingerprint: receipt.manifestFingerprint,
      objects: receipt.objects,
      phase: receipt.phase,
    };
  }

  private async performPublishReleaseCycle(lock: {
    lockId: string;
    fencingToken: number;
  }): Promise<TeamCloseResult> {
    const { lockId, fencingToken } = lock;
    const baseVersion = this.local.current?.version ?? 0;
    const snapshot = await this.local.createSnapshot();
    const capturedMutationGeneration = snapshot.capturedMutationGeneration;
    // 测试 FakeLocal 可无 generation：生产 snapshot 必有；缺省按 0 仅当明确 number
    const captured =
      capturedMutationGeneration === undefined
        ? 0
        : capturedMutationGeneration;
    if (captured === "unknown") {
      throw new Error("缺少 captured mutation generation，禁止发布");
    }
    const objects: ManifestObjectDigest[] = snapshot.objects.map((o) => ({
      relativePath: o.relativePath,
      md5: o.md5,
      size: o.size,
    }));
    const manifestFingerprint = computeManifestFingerprint(objects);
    const expectedVersion = baseVersion + 1;
    const uploadManifest: PersonalManifest = {
      version: snapshot.version,
      objects: structuredClone(snapshot.objects),
    };

    // 中文注释：snapshot 完成后、publish 前写入完整 publishing receipt
    this.persistReleasePending(
      {
        lockId,
        fencingToken,
        baseVersion,
        expectedVersion,
        capturedMutationGeneration: captured,
        manifestFingerprint,
        objects,
        phase: "publishing",
      },
      "publishing",
    );

    try {
      await this.remote.publish(lockId, fencingToken, uploadManifest, {
        ...this.currentEditorModels(),
      });
    } catch (error) {
      // 中文注释：publish 抛错不能证明中央未提交。立即切只读并保留 publishing receipt，
      // 后续同进程 close 与重启恢复统一走“中央版本+对象摘要”证据门。
      this.current = {
        editable: false,
        readonlyReason: "publishing_evidence_pending",
        lockHolder: "",
        recoveryRequired: false,
        releaseOnly: false,
        cleanupOnly: false,
      };
      try {
        await this.local.setReadonly("publishing_evidence_pending");
      } catch {
        // 中文注释：内存写门已 fail-closed；磁盘切只读失败也不能覆盖原始发布错误。
        this.current.readonlyReason = "publishing_readonly_failed";
      }
      this.scheduleHeartbeat();
      throw error;
    }

    // 客户端收到成功响应：升级为 published_release_pending（仍须 release）
    this.persistReleasePending(
      {
        lockId,
        fencingToken,
        baseVersion,
        expectedVersion,
        capturedMutationGeneration: captured,
        manifestFingerprint,
        objects,
        phase: "published_release_pending",
      },
      "published_release_pending",
    );

    return this.finishReleaseOnly({
      lockId,
      fencingToken,
      capturedMutationGeneration: captured,
      baseVersion,
      expectedVersion,
      manifestFingerprint,
      objects,
      phase: "published_release_pending",
    });
  }

  private async retryPublishingClose(pending: PendingMemory): Promise<TeamCloseResult> {
    // 中文注释：复用重启恢复的同一套证据判断，消除“同进程直接重发”的双发布窗口。
    await this.recoverPublishingReceipt(this.releaseReceiptFromPending(pending));

    if (this.current.recoveryRequired) {
      return { state: "recovery_required" };
    }
    if (this.current.releaseOnly && this.releasePending) {
      return this.finishReleaseOnly(this.releasePending);
    }
    if (
      this.releasePending?.phase !== "publishing"
      || this.current.readonlyReason !== "publishing_retry"
      || !this.lock
    ) {
      return { state: "recovery_required" };
    }

    // 中文注释：只有中央仍停在 base 时才允许受控重试；项目保持只读，禁止夹入新编辑。
    return this.performPublishReleaseCycle(this.lock);
  }

  /** 将同进程内存 intent 转为与重启恢复相同的证据对象。 */
  private releaseReceiptFromPending(pending: PendingMemory): TeamReleaseReceipt {
    return {
      projectUuid: this.receiptStore?.projectUuid ?? "00000000-0000-4000-8000-000000000000",
      lockId: pending.lockId,
      fencingToken: pending.fencingToken,
      capturedMutationGeneration: pending.capturedMutationGeneration,
      baseVersion: pending.baseVersion,
      expectedVersion: pending.expectedVersion,
      manifestFingerprint: pending.manifestFingerprint,
      objects: pending.objects,
      publishedAt: new Date().toISOString(),
      phase: "publishing",
    };
  }

  private async finishReleaseOnly(pending: PendingMemory): Promise<TeamCloseResult> {
    try {
      await this.remote.release(pending.lockId, pending.fencingToken);
    } catch (error) {
      this.scheduleHeartbeat();
      throw error;
    }
    // 中文注释：release 成功（含严格幂等重试）后原子落盘 released_cleanup_pending。
    // 禁止在此删除 receipt——崩溃窗口内必须仍能凭 receipt 中的 capture 恢复 finalize。
    if (pending.capturedMutationGeneration === undefined || pending.capturedMutationGeneration === "unknown") {
      // 保留 published_release_pending 事实，fail-closed
      this.persistReleasePending(
        { ...pending, phase: "published_release_pending" },
        "published_release_pending",
      );
      this.current = {
        editable: false,
        readonlyReason: "release_capture_unknown",
        lockHolder: "",
        recoveryRequired: true,
        releaseOnly: true,
        cleanupOnly: false,
      };
      return { state: "recovery_required" };
    }
    this.persistReleasePending(
      { ...pending, phase: "released_cleanup_pending" },
      "released_cleanup_pending",
    );
    this.lock = undefined;
    this.heartbeatGeneration += 1;
    this.current = {
      editable: false,
      readonlyReason: "released_cleanup_pending",
      lockHolder: "",
      recoveryRequired: false,
      releaseOnly: false,
      cleanupOnly: true,
    };
    return {
      state: "released_cleanup_pending",
      capturedMutationGeneration: pending.capturedMutationGeneration,
      centralEvidenceConfirmed: true,
    };
  }

  /**
   * 从未 publish 的锁只做幂等 release；清理回执后仍保留本地 mutation 恢复语义。
   */
  private async finishAcquiredReleaseOnly(pending: PendingMemory): Promise<TeamCloseResult> {
    try {
      await this.remote.release(pending.lockId, pending.fencingToken);
    } catch (error) {
      this.scheduleHeartbeat();
      throw error;
    }
    this.clearReleasePendingStrict();
    this.lock = undefined;
    this.heartbeatGeneration += 1;
    this.current = {
      editable: false,
      readonlyReason: "pending_mutation_recovery_required",
      lockHolder: "",
      recoveryRequired: true,
      releaseOnly: false,
      cleanupOnly: false,
    };
    return { state: "recovery_required" };
  }

  private persistReleasePending(
    pending: PendingMemory,
    phase: TeamReceiptPhase,
  ): void {
    this.releasePending = { ...pending, phase };
    if (!this.receiptStore) return;
    const receipt: TeamReleaseReceipt = {
      projectUuid: this.receiptStore.projectUuid,
      lockId: pending.lockId,
      fencingToken: pending.fencingToken,
      capturedMutationGeneration: pending.capturedMutationGeneration,
      baseVersion: pending.baseVersion,
      expectedVersion: pending.expectedVersion,
      manifestFingerprint: pending.manifestFingerprint,
      objects: pending.objects,
      publishedAt: new Date().toISOString(),
      phase,
    };
    writeTeamReleaseReceipt(
      this.receiptStore.dataRoot,
      this.receiptStore.userSegment,
      receipt,
    );
  }

  private clearReleasePendingStrict(): void {
    if (this.receiptClearHook) {
      this.receiptClearHook();
    }
    if (!this.receiptStore) {
      this.releasePending = undefined;
      return;
    }
    clearTeamReleaseReceipt(
      this.receiptStore.dataRoot,
      this.receiptStore.userSegment,
      this.receiptStore.projectUuid,
    );
    this.releasePending = undefined;
  }

  private async becomeReadonly(reason: string): Promise<void> {
    this.heartbeatGeneration += 1;
    this.lock = undefined;
    await this.local.setReadonly(reason);
    await this.local.createRecovery(reason);
    this.current = {
      editable: false,
      readonlyReason: reason,
      lockHolder: "",
      recoveryRequired: true,
    };
  }

  private scheduleHeartbeat(): void {
    const generation = ++this.heartbeatGeneration;
    this.schedule(() => void this.runHeartbeat(generation), this.heartbeatIntervalMs);
  }

  private async runHeartbeat(generation: number): Promise<void> {
    if (generation !== this.heartbeatGeneration || !this.lock) return;
    if (!this.current.editable && !this.current.releaseOnly) return;
    try {
      await this.remote.heartbeat(this.lock.lockId, this.lock.fencingToken);
      if (generation === this.heartbeatGeneration) {
        this.schedule(() => void this.runHeartbeat(generation), this.heartbeatIntervalMs);
      }
    } catch {
      if (generation === this.heartbeatGeneration) await this.becomeReadonly("heartbeat_failed");
    }
  }
}

function scheduleUnref(run: () => void, delay: number): NodeJS.Timeout {
  const timer = setTimeout(run, delay);
  timer.unref();
  return timer;
}

function tryCancelSchedule(handle: unknown): void {
  if (!handle) return;
  if (typeof (handle as { cancel?: () => void }).cancel === "function") {
    try {
      (handle as { cancel: () => void }).cancel();
    } catch {
      // ignore
    }
    return;
  }
  try {
    clearTimeout(handle as NodeJS.Timeout);
  } catch {
    // ignore
  }
}
