import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CentralAuthGateway, CentralSession } from "../auth/central-session";
void import("@/tianjiang/canvas/canvas-execution-runtime");
import { getStableDeviceUUID } from "../auth/device";
import {
  OfflineGrantStore,
  type OfflineRuntimeCache,
} from "../auth/offline-grant-store";
import { evaluateOfflineWrite, type CachedOfflineGrant } from "../auth/offline-grant";
import { ProfileCrypto } from "../crypto/profile-crypto";
import type { CredentialStore } from "../crypto/credential-store";
import { UserKeyRecoveryClient } from "../crypto/user-key-recovery";
import { isKeyServiceUnavailableError } from "../auth/key-service-error";
import { ProfileStore } from "../data/profile-store";
import {
  PersonalProjectSync,
  type PersonalRemote,
} from "../sync/personal-project-sync";
import { ProfileSync } from "../sync/profile-sync";
import type { ProfileSyncStatus } from "../sync/profile-sync";
import {
  TeamProjectSync,
  type TeamRemote,
} from "../sync/team-project-sync";
import {
  CentralRuntimeAdapter,
  sweepExpiredIncomingDownloads,
  type RuntimeProjectCatalogItem,
} from "./central-runtime-adapter";
import { RuntimeProjectLocal } from "./project-runtime-local";
import { buildLocalProjectIdMap } from "./local-project-id";
import { LegacyMigrator } from "../migration/legacy-migrator";
import type { MigrationReport } from "../migration/migration-report";
import {
  isLegacyProjectRoute,
  type LegacyProjectTarget,
} from "./legacy-project-guard";
import {
  runWithUserStorage,
  userStorageRoot,
  userStorageSegment,
  type UserStorageIdentity,
} from "./user-storage-context";
import { initializeCanvasWorkspace, initializeWorkspaceProject, prepareUserDatabase, releaseProjectDatabaseLease } from "@/utils/db";
import { ProjectRuntimeActivationGate } from "./project-runtime-activation";
import {
  configureModelMediaResolver,
  type ModelMediaResolver,
} from "../media/model-media-reference";
import { purgeLocalProjectCopy } from "./local-project-purge";
import {
  cleanupMigratedLegacyMediaAfterCentralSuccess,
  markLegacyCleanupReadyAfterCentralSuccess,
  migrateLegacyProjectMedia,
} from "../media/legacy-project-media-migration";
import {
  reportSyncProgress,
  runWithSyncProgress,
  syncProgressStore,
} from "./sync-progress";
import { LocalPurgeQueue } from "./local-purge-queue";
import { SyncQueue } from "../sync/queue";
import {
  runPendingSyncConsumer,
  type PendingSyncConsumerResult,
} from "../sync/pending-sync-consumer";
import {
  PENDING_SYNC_BLOCKED_MESSAGE,
  PENDING_SYNC_EXIT_MESSAGE,
  classifyShutdownSyncFailure,
  extractStableErrorCode,
  preparePendingSyncForShutdown,
  type PendingSyncSummary,
} from "../sync/shutdown-policy";
import {
  attemptPersonalProjectClose,
  commitPersonalCloseAttempt,
  durableEnsurePersonalUpload,
  personalCloseResultToPublic,
  rollbackPersonalCloseAttempt,
  settlePersonalProjectClose as settlePersonalCloseUnified,
  type PersonalCloseAttemptResult,
  type PersonalCloseDeps,
  type PersonalCloseResult,
} from "../sync/personal-close-coordinator";
import {
  clearPendingLegacyMutationIntent,
  hasPendingLegacyMutationIntent,
  listPendingLegacyMutationIntents,
  recordPendingLegacyMutationIntent,
  type PendingLegacyMutationKind,
} from "./pending-legacy-mutation-intent";
import {
  clearPendingMutationJournalOnFile,
  isFinalizeAllowedCapture,
  probeProjectMutationJournal,
  type MutationJournalProbe,
} from "./legacy-mutation-journal";
import { listTeamReleaseReceiptProjectUuids } from "./team-release-receipt";
import { listTeamCheckpointReceiptProjectUuids } from "./team-checkpoint-receipt";
import { projectDirectory } from "../data/paths";
import type { PersonalSyncResult } from "../sync/personal-project-sync";

interface PersonalRuntime {
  kind: "personal";
  local: RuntimeProjectLocal;
  sync: PersonalProjectSync;
}

interface TeamRuntime {
  kind: "team";
  local: RuntimeProjectLocal;
  sync: TeamProjectSync;
}

type OpenProjectRuntime = PersonalRuntime | TeamRuntime;

interface ClosableProjectRuntime {
  kind: "personal" | "team";
  sync: { close(): Promise<unknown> };
  local: { close(): void };
}

export class RuntimePermissionError extends Error {
  readonly status = 403;
  readonly errorCode?: string;

  constructor(message: string, errorCode?: string) {
    super(message);
    this.errorCode = errorCode;
  }
}

export class RuntimeNotFoundError extends Error {
  readonly status = 404;
  readonly errorCode?: string;

  constructor(message: string, errorCode?: string) {
    super(message);
    this.errorCode = errorCode;
  }
}

export interface ProfileRuntimeFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ProfileRuntimeStatus {
  state: "idle" | "syncing" | "synced" | "failed";
  version: number;
  lastSuccessAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  retryable: boolean;
}

interface UserKeyRecoveryLike {
  deviceIdentity(): { publicKey: string; publicFingerprint: string };
  loadOrRecover(userUuid: string): Promise<Buffer>;
}

interface KeyRecoveryRetryState {
  accepting: boolean;
  userUuid?: string;
  count: number;
  pending: boolean;
  inFlight: boolean;
}

export interface SyncCoordinatorDependencies {
  createKeyRecoveryClient?: (
    gateway: CentralAuthGateway,
    session: CentralSession,
    deviceUuid: string,
    credentials: CredentialStore,
  ) => UserKeyRecoveryLike;
}

export function resolveProfileRuntimeStatus(
  syncStatus?: ProfileSyncStatus,
  failure?: ProfileRuntimeFailure,
): ProfileRuntimeStatus {
  if (syncStatus) {
    const failed = syncStatus.state === "failed";
    return {
      state: syncStatus.state,
      version: syncStatus.version,
      lastSuccessAt: syncStatus.lastSuccessAt ?? null,
      failureCode: failed ? "PROFILE_SYNC_FAILED" : null,
      failureMessage: failed ? syncStatus.failureReason ?? "个人配置同步失败" : null,
      retryable: failed,
    };
  }
  if (failure) {
    return {
      state: "failed",
      version: 0,
      lastSuccessAt: null,
      failureCode: failure.code,
      failureMessage: failure.message,
      retryable: failure.retryable,
    };
  }
  return {
    state: "idle",
    version: 0,
    lastSuccessAt: null,
    failureCode: null,
    failureMessage: null,
    retryable: false,
  };
}

/**
 * 天将漫创 App 进程内唯一同步协调器。
 * 所有公开入口都绑定中央会话或已验证离线授权，不能仅依赖浏览器传来的项目 UUID。
 */
export class SyncCoordinator {
  private session?: CentralSession;
  private remote?: CentralRuntimeAdapter;
  private profileStore?: ProfileStore;
  private profileSync?: ProfileSync;
  private profileFailure?: ProfileRuntimeFailure;
  private readonly profileCalibrations = new Map<string, Promise<unknown>>();
  private catalog = new Map<string, RuntimeProjectCatalogItem>();
  private localProjectIds = new Map<string, number>();
  private readonly projects = new Map<string, OpenProjectRuntime>();
  private readonly activationGate = new ProjectRuntimeActivationGate();
  private readonly deviceUuid: string;
  private readonly offlineGrantStore: OfflineGrantStore;
  private offlineCache?: OfflineRuntimeCache;
  private online = false;
  private deviceActive = false;
  private profileKey?: Buffer;
  private lastMigration?: {
    migrator: LegacyMigrator;
    report: MigrationReport;
  };
  /** 个人密钥服务降级重试：有界指数退避，禁止无限高频轮询。 */
  private keyRetryTimer?: ReturnType<typeof setTimeout>;
  private keyRetryCount = 0;
  private keyRetryUserUuid?: string;
  private keyRecoveryInFlight?: Promise<void>;
  private acceptingKeyRecovery = true;
  private static readonly KEY_RETRY_MAX = 5;
  private static readonly KEY_RETRY_BASE_MS = 30_000;
  private shutdownState = createShutdownPhaseState();
  /** shutdown intent 在入口同步写入且永久有效，任何迟到登录都不得重新发布运行时状态。 */
  private shutdownRequested = false;
  private shutdownEpoch = 0;
  private loginInFlight?: Promise<{ keyServiceDegraded: boolean }>;
  private shutdownInFlight?: Promise<void>;
  /** 最近一次普通退出待同步摘要（测试与状态投影可读）。 */
  private lastPendingSyncSummary?: PendingSyncSummary;
  /** 最近一次登录后续传消费者结果（测试可读，不含敏感字段）。 */
  private lastPendingSyncResumeResult?: PendingSyncConsumerResult;
  private pendingSyncResumeInFlight?: Promise<void>;
  /** retry_wait 的进程内唤醒句柄；真实任务时间仍以 SQLite 为准。 */
  private pendingSyncRetryTimer?: ReturnType<typeof setTimeout>;
  /** 可恢复：项目关闭前暂停 pending consumer，阻断后 resume */
  private projectCloseDraining = false;
  /**
   * 中文注释：仅用于同进程 shutdown 失败后的补偿重试；进程重启会重新构建 runtime。
   * 不写 sync_tasks / journal。
   */
  private readonly pendingPersonalCloseCompensations = new Set<string>();
  /**
   * 中文注释：批量退出/切换账号取消后，记录已经完成中央 close、必须重新 open 的 Team。
   * Team 不得进入 Personal sync_tasks；补偿必须重新经过正式权限、远端版本与锁状态检查。
   */
  private readonly pendingTeamCloseCompensations = new Set<string>();
  private readonly createKeyRecoveryClient: NonNullable<
    SyncCoordinatorDependencies["createKeyRecoveryClient"]
  >;

  constructor(
    private readonly dataRoot: string,
    private readonly gateway: CentralAuthGateway,
    private readonly credentials: CredentialStore,
    dependencies: SyncCoordinatorDependencies = {},
  ) {
    this.createKeyRecoveryClient = dependencies.createKeyRecoveryClient
      ?? ((nextGateway, session, deviceUuid, nextCredentials) => new UserKeyRecoveryClient(
        nextGateway,
        session,
        deviceUuid,
        nextCredentials,
      ));
    this.deviceUuid = getStableDeviceUUID(dataRoot);
    this.offlineGrantStore = new OfflineGrantStore(dataRoot);
    const loadedCache = this.offlineGrantStore.load();
    if (loadedCache?.issuer) {
      // 兼容旧缓存但仅保留公开目录字段，绝不把历史内部数字 ID 再返回 renderer。
      const catalog = loadedCache.catalog.map(sanitizeCachedCatalogItem);
      this.localProjectIds = buildLocalProjectIdMap(catalog.map((item) => item.projectUuid));
      this.offlineCache = { ...loadedCache, catalog };
      this.catalog = new Map(catalog.map((item) => [item.projectUuid, item]));
      this.deviceActive = !loadedCache.grant.revokedAt;
    }
  }

  onLogin(session: CentralSession): Promise<{ keyServiceDegraded: boolean }> {
    if (this.shutdownRequested) {
      return Promise.reject(new RuntimePermissionError("同步运行时正在关闭，拒绝账号登录"));
    }
    if (this.loginInFlight) {
      return Promise.reject(new RuntimePermissionError("已有账号登录初始化正在进行"));
    }
    const loginEpoch = this.shutdownEpoch;
    const attempt = this.performLogin(session, loginEpoch);
    this.loginInFlight = attempt;
    const release = () => {
      if (this.loginInFlight === attempt) this.loginInFlight = undefined;
    };
    void attempt.then(release, release);
    return attempt;
  }

  private async performLogin(
    session: CentralSession,
    loginEpoch: number,
  ): Promise<{ keyServiceDegraded: boolean }> {
    const captureCurrentState = () => ({
      session: this.session,
      remote: this.remote,
      profileStore: this.profileStore,
      profileSync: this.profileSync,
      profileFailure: this.profileFailure,
      catalog: new Map(this.catalog),
      localProjectIds: new Map(this.localProjectIds),
      offlineCache: this.offlineCache,
      online: this.online,
      deviceActive: this.deviceActive,
      profileKey: this.profileKey,
      lastMigration: this.lastMigration,
    });
    let previous = captureCurrentState();
    const retryBeforeSwitch = this.captureKeyRecoveryRetryState();
    let previousRetry = retryBeforeSwitch;
    // 切换账号前先停止旧账号密钥恢复，禁止它在 flush/close 期间替换 profileStore。
    try {
      await this.stopBackgroundWork();
      // 在途恢复可能在等待期间成功接管资源，回滚快照必须取排空后的真实活动状态。
      previous = captureCurrentState();
      previousRetry = this.retryStateAfterDrain(retryBeforeSwitch);
      if (previous.profileSync && previous.online) {
        // 中文注释：登录公共路径没有环境 ALS，必须在旧账号身份里 flush，禁止 applyLive 落到下一账号。
        const previousIdentity = previous.session
          ? { issuer: previous.session.serverUrl, userId: previous.session.user.id }
          : undefined;
        if (previousIdentity) {
          await prepareUserDatabase(previousIdentity);
          await runWithUserStorage(previousIdentity, () => previous.profileSync!.flush());
        } else {
          await previous.profileSync.flush();
        }
      }
      const nextIdentity = { issuer: session.serverUrl, userId: session.user.id };
      const sameAccountOfflineHandoff = !previous.session
        && previous.offlineCache
        && userStorageSegment({
          issuer: previous.offlineCache.issuer,
          userId: previous.offlineCache.userId,
        }) === userStorageSegment(nextIdentity);
      if (sameAccountOfflineHandoff) {
        // 中文注释：冷启动时页面可能已用离线授权打开同账号项目。
        // 这里仅停止离线定时任务并释放本地句柄，保留 SQLite/journal 待在线入口重新打开；
        // 禁止把同账号自动登录误当成账号切换，使用尚未接管的新会话强制中央关闭。
        this.closeOfflineProjectsForSameAccountLogin();
      } else {
        // 中文注释：真正账号切换/重新登录关闭旧会话项目时仍要求中央成功；
        // 整段必须绑定旧账号的独立进度上下文，失败恢复上一账号状态。
        await runWithSyncProgress(
          {
            operationId: `account-switch-${Date.now()}`,
            intent: "account_switch",
            reason: "account_switch",
            totalProjects: this.projects.size,
          },
          () => this.closeAll({ requireCentralSuccess: true }),
        );
      }
      this.assertLoginEpochCurrent(loginEpoch);
    } catch (error) {
      if (this.isLoginEpochCurrent(loginEpoch)) this.restoreKeyRecoveryRetry(previousRetry);
      throw error;
    }

    const remote = new CentralRuntimeAdapter(this.gateway, session, this.deviceUuid);
    // 中文注释：下载 incoming 必须落在账号隔离数据根，禁止 process.cwd 权威位置。
    remote.bindIncomingStorage(
      this.dataRoot,
      userStorageSegment({ issuer: session.serverUrl, userId: session.user.id }),
    );
    // 中文注释：启动时清理过期 orphan incoming（不碰活跃目录）。
    try {
      sweepExpiredIncomingDownloads(this.dataRoot);
    } catch {
      // 清理失败不阻断登录
    }
    let createdProfileStore: ProfileStore | undefined;
    let recoveredProfileKey: Buffer | undefined;
    try {
      // 登录成功后的生产顺序固定：设备登记 → 个人密钥 → 离线授权 → 配置同步 → 项目目录。
      const userUuid = stableUserUuid(session.serverUrl, session.user.id);
      const keyRecovery = this.createKeyRecoveryClient(
        this.gateway, session, this.deviceUuid, this.credentials,
      );
      const deviceIdentity = keyRecovery.deviceIdentity();
      await remote.registerDevice(deviceIdentity.publicKey, deviceIdentity.publicFingerprint);

      let profileKey: Buffer | undefined;
      let keyServiceDegraded = false;
      let profileFailure: ProfileRuntimeFailure | undefined;
      try {
        profileKey = await keyRecovery.loadOrRecover(userUuid);
        recoveredProfileKey = profileKey;
      } catch (error) {
        // 密钥服务不可用不得阻断中央登录；禁止本地伪造平台包装密钥。
        if (isKeyServiceUnavailableError(error)) {
          keyServiceDegraded = true;
          profileKey = undefined;
          profileFailure = {
            code: "KEY_SERVICE_UNAVAILABLE",
            message: "个人密钥服务暂不可用，恢复后将自动重试",
            retryable: true,
          };
        } else {
          throw error;
        }
      }

      const grant = await remote.refreshOfflineGrant();
      this.assertGrantUsable(grant, session.user.id);

      let profileSync: ProfileSync | undefined;
      if (profileKey) {
        createdProfileStore = new ProfileStore(
          this.dataRoot,
          userUuid,
          new ProfileCrypto(userUuid, profileKey),
        );
        const identity = { issuer: session.serverUrl, userId: session.user.id };
        profileSync = new ProfileSync(createdProfileStore, remote.profileRemote(), undefined, {
          account: identity,
        });
        // 中文注释：登录校准必须在新账号 db2 已准备且 ALS 绑定后回写，禁止空操作后标 synced。
        await prepareUserDatabase(identity);
        await runWithUserStorage(identity, async () => {
          const { bindAccountSyncBindings, prepareVendorOutboxForProfileLogin } = await import("../sync/profile-settings-adapter");
          bindAccountSyncBindings(profileSync!);
          // 中文注释：先把所属账号 queued outbox 写成 pending，再进入远端 reconcile。
          await prepareVendorOutboxForProfileLogin(profileSync!);
          await profileSync!.login();
        });
      }

      const catalog = await remote.projectCatalog(session.user.id);
      const localProjectIds = buildLocalProjectIdMap(catalog.map((item) => item.projectUuid));
      const cache: OfflineRuntimeCache = {
        issuer: session.serverUrl,
        userId: session.user.id,
        grant,
        catalog,
      };
      // 最后一段 await 后、任何持久化或实例指针替换前再次校验关闭 epoch。
      this.assertLoginEpochCurrent(loginEpoch);
      this.offlineGrantStore.save(cache);

      // 新账号配置和目录均已校验完成后再一次性替换活动指针。
      previous.profileStore?.close();
      this.session = session;
      this.remote = remote;
      this.profileStore = createdProfileStore;
      createdProfileStore = undefined;
      this.profileSync = profileSync;
      this.profileFailure = profileFailure;
      this.catalog = new Map(catalog.map((item) => [item.projectUuid, item]));
      this.localProjectIds = localProjectIds;
      this.offlineCache = cache;
      this.deviceActive = true;
      this.profileKey = profileKey;
      recoveredProfileKey = undefined;
      this.online = true;
      this.shutdownState = createShutdownPhaseState();
      this.acceptingKeyRecovery = true;
      configureModelMediaResolver(this.modelMediaResolver(remote));
      this.lastMigration = undefined;
      previous.profileKey?.fill(0);

      if (keyServiceDegraded) {
        this.scheduleKeyRecoveryRetry(userUuid);
      } else {
        this.keyRetryCount = 0;
        this.keyRetryUserUuid = undefined;
      }
      // 登录后：对账孤立本地目录 → 重试 local_purge → 真实待同步续传。
      // 不重复请求中央删除；后台执行不阻塞登录返回。
      void this.afterLoginBackgroundWork(session, loginEpoch).catch(() => undefined);
      return { keyServiceDegraded };
    } catch (error) {
      // 局部 store 尚未转移所有权时也必须关闭，避免 Windows SQLite 文件锁泄漏。
      try {
        createdProfileStore?.close();
      } finally {
        recoveredProfileKey?.fill(0);
        if (this.isLoginEpochCurrent(loginEpoch)) {
          const adapter = await import("../sync/profile-settings-adapter");
          adapter.restoreAccountSyncBindings(previous.profileSync ?? null);
          this.session = previous.session;
          this.remote = previous.remote;
          this.profileStore = previous.profileStore;
          this.profileSync = previous.profileSync;
          this.profileFailure = previous.profileFailure;
          this.catalog = previous.catalog;
          this.localProjectIds = previous.localProjectIds;
          this.offlineCache = previous.offlineCache;
          this.online = previous.online;
          configureModelMediaResolver(
            previous.online && previous.remote
              ? this.modelMediaResolver(previous.remote)
              : undefined,
          );
          this.deviceActive = previous.deviceActive;
          this.profileKey = previous.profileKey;
          this.lastMigration = previous.lastMigration;
          this.restoreKeyRecoveryRetry(previousRetry);
        }
      }
      throw error;
    }
  }

  isOfflineRequest(pathname: string, method: string): boolean {
    if (!["GET", "POST"].includes(method.toUpperCase())) return false;
    if (method.toUpperCase() === "GET" && pathname.startsWith("/oss/")) return true;
    if (isLegacyProjectRoute(pathname)) return true;
    if (!pathname.startsWith("/api/tianjiang/runtime/")) return false;
    return !pathname.endsWith("/network") && !pathname.includes("/migration");
  }

  offlineStorageIdentity(): UserStorageIdentity {
    this.assertOfflineBase();
    const cache = this.offlineCache!;
    if (!cache.issuer) throw new RuntimePermissionError("离线授权缺少中央发行方");
    return { issuer: cache.issuer, userId: cache.userId };
  }

  activationSnapshot(): { generations: number; tails: number; nextToken: number } {
    return this.activationGate.snapshot();
  }

  peekProject(projectUuid: string): RuntimeProjectCatalogItem | undefined {
    return this.catalog.get(projectUuid) ?? this.catalog.get(projectUuid.toLowerCase());
  }

  listProjects(session?: CentralSession): RuntimeProjectCatalogItem[] {
    this.assertAccess(session);
    const hidden = this.pendingLocalPurgeUuids(session);
    return [...this.catalog.values()]
      .filter((item) => !hidden.has(item.projectUuid.toLowerCase()))
      .map((item) => ({ ...item }));
  }

  /**
   * 方案 B 第二步：中央回收站已成功后清理本机副本。
   * 失败时入队 local_purge，禁止再次请求中央删除。
   * cleanupPending=true 仅当 durable 队列已写入成功。
   */
  async purgeLocalProjectCopy(
    session: CentralSession | undefined,
    projectUuid: string,
  ): Promise<{ localPurged: boolean; cleanupPending: boolean; alreadyAbsent: boolean }> {
    this.assertSession(session!);
    const active = session!;
    const normalized = projectUuid.toLowerCase();
    const identity = {
      issuer: active.serverUrl,
      userId: active.user.id,
    };
    try {
      // 已打开则先关闭句柄，再删目录。
      if (this.projects.has(normalized)) {
        try {
          await this.closeProjectInternal(active, normalized);
        } catch {
          // 关闭失败仍尝试强制清理，避免永久卡死。
          const runtime = this.projects.get(normalized);
          try {
            runtime?.local.close();
          } catch {
            // ignore
          }
          this.projects.delete(normalized);
        }
      }
      const result = await purgeLocalProjectCopy({
        dataRoot: this.dataRoot,
        identity,
        projectUuid: normalized,
        hooks: {
          forgetCatalogEntry: (uuid) => {
            this.catalog.delete(uuid);
            this.localProjectIds.delete(uuid);
          },
        },
      });
      this.withLocalPurgeQueue(identity, (queue) => {
        queue.complete(normalized);
      });
      return {
        localPurged: result.removed,
        cleanupPending: false,
        alreadyAbsent: result.alreadyAbsent,
      };
    } catch (error) {
      // 先写 durable 队列，再报告 cleanupPending；入队失败不得伪报已排队。
      let enqueued = false;
      try {
        enqueued = this.withLocalPurgeQueue(identity, (queue) => {
          queue.enqueue(normalized);
          queue.fail(
            normalized,
            error instanceof Error ? error.message.slice(0, 64) : "LOCAL_PURGE_FAILED",
            true,
          );
          return queue.pendingProjectUuids().includes(normalized);
        });
      } catch {
        enqueued = false;
      }
      // 从目录隐藏，避免用户继续打开待清理项目。
      this.catalog.delete(normalized);
      return { localPurged: false, cleanupPending: enqueued, alreadyAbsent: false };
    }
  }

  /** 启动/登录后重试未完成的本地清理（不重复请求中央）。 */
  async retryPendingLocalPurges(session: CentralSession): Promise<void> {
    const identity = { issuer: session.serverUrl, userId: session.user.id };
    for (let i = 0; i < 8; i += 1) {
      if (this.shutdownRequested) break;
      const task = this.withLocalPurgeQueue(identity, (queue) => queue.nextReady());
      if (!task) break;
      const result = await this.purgeLocalProjectCopy(session, task.projectUuid);
      if (result.cleanupPending) break;
    }
  }

  /**
   * 中央删除成功但 purge 请求未达 runtime 时的重对账：
   * 本机 projects 目录存在、中央目录已无的 UUID 写入 local_purge，下次/本次清理。
   */
  reconcileOrphanLocalProjects(session: CentralSession): number {
    const identity = { issuer: session.serverUrl, userId: session.user.id };
    const segment = userStorageSegment(identity);
    const projectsRoot = path.join(this.dataRoot, "runtime-users", segment, "projects");
    if (!fs.existsSync(projectsRoot)) return 0;
    const catalog = new Set([...this.catalog.keys()].map((id) => id.toLowerCase()));
    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    let enqueued = 0;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(projectsRoot);
    } catch {
      return 0;
    }
    return this.withLocalPurgeQueue(identity, (queue) => {
      for (const name of entries) {
        const uuid = name.toLowerCase();
        if (!uuidRe.test(uuid) || catalog.has(uuid)) continue;
        try {
          queue.enqueue(uuid);
          enqueued += 1;
        } catch {
          // 单条失败不影响其余
        }
      }
      return enqueued;
    });
  }

  /**
   * LocalPurgeQueue 统一生命周期：每次操作 try/finally 关闭，禁止散落句柄。
   * shutdown 时不再持有长期连接。
   */
  private withLocalPurgeQueue<T>(
    identity: { issuer: string; userId: number },
    run: (queue: LocalPurgeQueue) => T,
  ): T {
    const segment = userStorageSegment(identity);
    const databasePath = path.join(
      this.dataRoot,
      "runtime-users",
      segment,
      "local-purge-queue.sqlite",
    );
    const queue = new LocalPurgeQueue(databasePath);
    try {
      return run(queue);
    } finally {
      try {
        queue.close();
      } catch {
        // 关闭失败不向外抛，避免掩盖业务错误
      }
    }
  }

  private pendingLocalPurgeUuids(session?: CentralSession): Set<string> {
    if (!session) return new Set();
    try {
      return new Set(
        this.withLocalPurgeQueue(
          { issuer: session.serverUrl, userId: session.user.id },
          (queue) => queue.pendingProjectUuids(),
        ),
      );
    } catch {
      return new Set();
    }
  }

  private async afterLoginBackgroundWork(
    session: CentralSession,
    loginEpoch: number,
  ): Promise<void> {
    if (!this.isLoginEpochCurrent(loginEpoch)) return;
    try {
      this.reconcileOrphanLocalProjects(session);
    } catch {
      // 对账失败不阻断
    }
    if (!this.isLoginEpochCurrent(loginEpoch)) return;
    try {
      await this.retryPendingLocalPurges(session);
    } catch {
      // 清理失败保留队列
    }
    if (!this.isLoginEpochCurrent(loginEpoch)) return;
    try {
      // 中文注释：先按 journal/sidecar 对账并续期 Personal upload，再启动消费者。
      // Team 仅走锁与 receipt 恢复，禁止进入 Personal sync_tasks。
      await this.reconcilePendingPersonalUploads(session);
    } catch {
      // 对账失败不阻断登录；持久 mutation fact 保留，后续打开/退出仍会重试。
    }
    if (!this.isLoginEpochCurrent(loginEpoch)) return;
    this.schedulePendingSyncResume(loginEpoch);
  }

  /**
   * 在线刷新中央项目目录：成功后原子替换 catalog/localProjectIds。
   * 失败时必须保留旧目录；离线不得伪造中央刷新。
   */
  async refreshProjectCatalog(session: CentralSession): Promise<RuntimeProjectCatalogItem[]> {
    this.assertSession(session);
    if (!this.online || !this.remote) {
      throw new RuntimePermissionError("离线状态禁止伪造中央目录刷新");
    }
    const previousCatalog = this.catalog;
    const previousIds = this.localProjectIds;
    const previousCache = this.offlineCache;
    try {
      const catalog = await this.remote.projectCatalog(session.user.id);
      const localProjectIds = buildLocalProjectIdMap(catalog.map((item) => item.projectUuid));
      // 仅在完整映射成功后一次性替换，避免半更新。
      this.catalog = new Map(catalog.map((item) => [item.projectUuid, item]));
      this.localProjectIds = localProjectIds;
      if (previousCache) {
        const nextCache: OfflineRuntimeCache = {
          ...previousCache,
          catalog,
        };
        this.offlineGrantStore.save(nextCache);
        this.offlineCache = nextCache;
      }
      return this.listProjects(session);
    } catch (error) {
      this.catalog = previousCatalog;
      this.localProjectIds = previousIds;
      this.offlineCache = previousCache;
      throw error instanceof Error
        ? error
        : new RuntimePermissionError("项目目录刷新失败");
    }
  }

  async openProject(session: CentralSession | undefined, projectUuid: string): Promise<Record<string, unknown>> {
    return this.activationGate.serialize(projectUuid, async () => {
      const opened = await this.openProjectBody(session, projectUuid);
      if (!this.projects.get(projectUuid)) return opened;
      const runtimeGeneration = this.activationGate.issueOpenGeneration(projectUuid);
      return { ...opened, runtimeGeneration };
    });
  }

  private async openProjectBody(session: CentralSession | undefined, projectUuid: string): Promise<Record<string, unknown>> {
    const offline = this.assertAccess(session);
    // 中文注释：校准与项目打开同时启动，但不让不相关的设置网络请求阻塞本地项目首屏。
    const profileCalibration = this.profileSync?.reconcile("project_open") ?? null;
    if (profileCalibration) {
      const { bindSettingsDependentRead } = await import("../sync/profile-settings-adapter");
      bindSettingsDependentRead(profileCalibration);
      void profileCalibration.finally(() => bindSettingsDependentRead(null));
    }
    const existing = this.projects.get(projectUuid);
    if (existing) {
      this.bindProfileCalibration(projectUuid, profileCalibration);
      return this.projectState(projectUuid, existing);
    }
    const catalogItem = this.catalog.get(projectUuid);
    if (!catalogItem) throw new RuntimePermissionError("项目不存在或不可见");
    if (catalogItem.businessType === "canvas" && catalogItem.kind !== "personal") {
      throw new RuntimePermissionError("无限画布首期不支持团队归属", "CANVAS_TEAM_SCOPE_NOT_SUPPORTED");
    }

    const identity = offline
      ? this.offlineStorageIdentity()
      : { issuer: this.session!.serverUrl, userId: this.session!.user.id };
    const segment = userStorageSegment(identity);
    const local = new RuntimeProjectLocal(
      this.dataRoot,
      projectUuid,
      segment,
    );
    // 中文注释：远端 install 前必须结构化读取 journal（权威）+ sidecar（索引）
    const pendingLocal = this.detectPendingLocalMutation(projectUuid, segment);
    const protect = pendingLocal.pending || pendingLocal.journalUnreadable;
    const failClosed = pendingLocal.journalUnreadable;

    if (catalogItem.kind === "personal") {
      if (offline) this.assertOfflineProject(catalogItem);
      const sync = new PersonalProjectSync(
        local,
        offline
          ? offlinePersonalRemote()
          : this.remote!.personalRemote(
            projectUuid,
            (snapshot) => local.acceptDownloaded(snapshot),
            {
              currentVersion: catalogItem.currentVersion,
              readObject: (relativePath, expected) => local.readSyncObject(relativePath, expected),
              resolveObjectPath: (relativePath, expected) => local.resolveSyncObjectPath(relativePath, expected),
              resolveInventoryPath: (relativePath) => local.resolveLocalInventoryPath(relativePath),
            },
          ),
        () => this.online,
      );
      sync.setProtectPendingLocal(protect, { failClosed });
      sync.setPublishReceiptContext({ dataRoot: this.dataRoot, projectUuid });
      // 中文注释：idle/checkpoint 经协调器 finalize，禁止绕开
      sync.setSyncExecutor((reason) => this.runPersonalSyncAndFinalize(projectUuid, reason));
      sync.open();
      await sync.ensureLoaded();
      local.setWritable();
      // 中文注释：可写打开后迁移旧账号 oss 媒体；失败保留原引用，禁止发布残缺版本。
      this.migrateLegacyMediaIfNeeded(projectUuid, segment, local, true);
      const runtime: PersonalRuntime = { kind: "personal", local, sync };
      this.projects.set(projectUuid, runtime);
      // 中文注释：journal-only 必须在 workspace 初始化前恢复 dirty，避免初始化失败丢恢复
      if (protect) this.reapplyPendingLegacyMutation(projectUuid);
      await this.initializeOpenedWorkspace(projectUuid, catalogItem);
      this.bindProfileCalibration(projectUuid, profileCalibration);
      return this.projectState(projectUuid, runtime);
    }

    if (catalogItem.kind !== "team") {
      throw new RuntimePermissionError("项目类型未知，拒绝打开");
    }

    const sync = new TeamProjectSync(
      catalogItem.role,
      local,
      offline
        ? offlineTeamRemote()
        : this.remote!.teamRemote(
          projectUuid,
          (snapshot) => local.acceptDownloaded(snapshot),
          {
            currentVersion: catalogItem.currentVersion,
            readObject: (relativePath, expected) => local.readSyncObject(relativePath, expected),
            resolveObjectPath: (relativePath, expected) => local.resolveSyncObjectPath(relativePath, expected),
            resolveInventoryPath: (relativePath) => local.resolveLocalInventoryPath(relativePath),
          },
        ),
      () => this.currentEditorModels(),
    );
    sync.setProtectPendingLocal(protect);
    // 中文注释：本机 release receipt 持久化，重启后只重试 release
    sync.configureReleaseReceiptStore({
      dataRoot: this.dataRoot,
      userSegment: segment,
      projectUuid,
    });
    // 中文注释：Team 30s/120s 必须经协调器 finalize；禁止 sync 内自行清 dirty。
    // 中文注释：executor 已在 TeamProjectSync.syncTail 内，必须用 Unlocked 禁止嵌套锁。
    sync.setCheckpointExecutor(async (reason) => {
      const epoch = sync.currentEditEpoch();
      const operationId = `team-cp-${projectUuid}-${Date.now()}`;
      return runWithSyncProgress(
        {
          operationId,
          intent: "auto",
          reason: `team_checkpoint_${reason}`,
          totalProjects: 1,
          projectUuid,
          projectName: catalogItem.name,
          projectKind: "team",
        },
        async () => {
          const published = await sync.publishCheckpointUnlocked(reason);
          if (published.state !== "published" || !published.pendingFinalize) {
            return published;
          }
          try {
            // 中文注释：顺序：中央成功后 journal finalize → 清 receipt → 再定 dirty。
            this.finalizeMutationClearedAfterCentralSuccess(
              projectUuid,
              "published",
              published.capturedMutationGeneration,
              { editEpochAdvanced: sync.currentEditEpoch() !== epoch },
            );
            sync.confirmCheckpointFinalizeStrict();
            sync.markCheckpointCleanIfEpochStable(epoch);
            return { ...published, pendingFinalize: false };
          } catch (error) {
            // 中文注释：finalize/清 receipt 失败必须保留 dirty/receipt/journal。
            const runtime = this.projects.get(projectUuid);
            if (runtime?.kind === "team" && runtime.local.dirty !== undefined) {
              runtime.local.dirty = true;
            }
            syncProgressStore.fail(
              operationId,
              "CHECKPOINT_FINALIZE_FAILED",
              error instanceof Error ? error.message : "Team checkpoint finalize 失败",
            );
            throw error;
          }
        },
      );
    });
    if (offline) await sync.openOfflineReadonly();
    else await sync.open();
    // 中文注释：release_only 只读，协调器绝不得 setWritable
    const teamState = sync.state();
    if (teamState.editable && !teamState.releaseOnly) {
      local.setWritable();
      // 中文注释：viewer/无锁只读不得迁移；仅当前可写持锁编辑者可迁入项目 files。
      this.migrateLegacyMediaIfNeeded(projectUuid, segment, local, true);
    }
    const runtime: TeamRuntime = { kind: "team", local, sync };
    this.projects.set(projectUuid, runtime);
    // 中文注释：open 后处理 checkpoint 恢复——须先 projects.set，再 journal finalize → 清 receipt → 定 dirty。
    const pendingRecovery = sync.takePendingCheckpointRecovery();
    if (pendingRecovery?.pendingFinalize) {
      try {
        this.finalizeMutationClearedAfterCentralSuccess(
          projectUuid,
          "published",
          pendingRecovery.capturedMutationGeneration,
        );
        // 中文注释：finalize 成功后才允许清 checkpoint receipt。
        sync.confirmCheckpointFinalizeStrict();
        // N+1：remaining journal 保持 dirty；无剩余则可 clean。
        const stillPending = this.detectPendingLocalMutation(projectUuid, segment).pending;
        if (!stillPending && local.dirty !== undefined) {
          local.dirty = false;
        } else if (local.dirty !== undefined) {
          local.dirty = true;
        }
      } catch (error) {
        // 中文注释：失败保留 receipt/journal/sidecar/dirty，并撤销 projects 登记后向上失败。
        if (local.dirty !== undefined) local.dirty = true;
        this.projects.delete(projectUuid);
        local.close();
        throw error instanceof Error
          ? error
          : new Error("Team checkpoint 恢复 finalize 失败");
      }
    }
    // 团队：仅恢复 local.dirty，禁止塞入个人 upload 队列；release_only 不 reapply 写
    if (protect && !teamState.releaseOnly) this.reapplyPendingLegacyMutation(projectUuid);
    await this.initializeLegacyWorkspace(projectUuid, catalogItem);
    this.bindProfileCalibration(projectUuid, profileCalibration);
    return this.projectState(projectUuid, runtime);
  }

  /**
   * Personal 全入口统一：sync + finalize captured generation。
   * idle/checkpoint/manual/pending-upload 均经此路径。
   */
  async runPersonalSyncAndFinalize(
    projectUuid: string,
    reason: "idle" | "checkpoint" | "close" | "manual",
  ): Promise<PersonalSyncResult> {
    const runtime = this.projects.get(projectUuid) ?? this.projects.get(projectUuid.toLowerCase());
    if (!runtime || runtime.kind !== "personal") {
      throw new RuntimeNotFoundError("个人项目运行时未就绪");
    }
    const result = await runtime.sync.sync(reason);
    try {
      this.finalizeFromSyncResult(projectUuid, result);
    } catch (error) {
      // 中文注释：finalize 失败必须向上失败，禁止返回 synced/unchanged 伪装成功。
      runtime.local.dirty = true;
      throw error instanceof Error
        ? error
        : new Error("个人项目 finalize 失败，同步未完成");
    }
    return result;
  }

  /**
   * 远端 install 前探测：journal 权威 + sidecar 索引；不可读 fail-closed。
   */
  private detectPendingLocalMutation(
    projectUuid: string,
    userSegment: string,
  ): {
    pending: boolean;
    sources: Array<"journal" | "sidecar">;
    maxGeneration: number | null;
    journalUnreadable: boolean;
    journalProbe?: MutationJournalProbe;
  } {
    const sources: Array<"journal" | "sidecar"> = [];
    let maxGeneration: number | null = null;
    let journalUnreadable = false;
    let journalProbe: MutationJournalProbe | undefined;
    try {
      const dbPath = path.join(
        projectDirectory(this.dataRoot, projectUuid, userSegment),
        "project.sqlite",
      );
      journalProbe = probeProjectMutationJournal(dbPath);
      if (!journalProbe.ok) {
        journalUnreadable = true;
      } else if (journalProbe.pending) {
        sources.push("journal");
        maxGeneration = journalProbe.maxGeneration;
      }
    } catch {
      // 路径异常视为不可读 fail-closed
      journalUnreadable = true;
    }
    if (hasPendingLegacyMutationIntent(this.dataRoot, userSegment, projectUuid)) {
      sources.push("sidecar");
    }
    return {
      pending: sources.length > 0 || journalUnreadable,
      sources,
      maxGeneration,
      journalUnreadable,
      journalProbe,
    };
  }

  listRecoveries(
    session: CentralSession | undefined,
    projectUuid: string,
  ): ReturnType<RuntimeProjectLocal["listRecoveries"]> {
    this.assertAccess(session);
    return this.requireOpenProject(projectUuid).local.listRecoveries();
  }

  resolveRecovery(
    session: CentralSession | undefined,
    projectUuid: string,
    recoveryId: string,
    resolution: "keep_backup",
  ): ReturnType<RuntimeProjectLocal["resolveRecovery"]> {
    this.assertAccess(session);
    return this.requireOpenProject(projectUuid).local.resolveRecovery(recoveryId, resolution);
  }

  async editProject(
    session: CentralSession | undefined,
    projectUuid: string,
    namespace: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    const offline = this.assertAccess(session);
    const runtime = this.projects.get(projectUuid);
    const catalogItem = this.catalog.get(projectUuid);
    if (!runtime || !catalogItem) throw new RuntimePermissionError("项目尚未打开，禁止写入");
    if (offline && catalogItem.kind === "personal") this.assertOfflineProject(catalogItem);
    if (runtime.kind === "team" && !runtime.sync.state().editable) {
      throw new RuntimePermissionError("团队项目当前只读");
    }
    if (!offline && this.online) await this.refreshWriteAuthority(session!);
    runtime.local.setRecord(namespace, key, value);
    if (runtime.kind === "personal") runtime.sync.markEdited();
    // 中文注释：Team 持锁编辑同样走 30s/120s 自动发布，永不进入 Personal sync_tasks。
    if (runtime.kind === "team") runtime.sync.markEdited();
  }

  /**
   * 旧业务路由与 Socket 共用这一道授权门。
   * 团队 owner/editor 也必须同时满足设备有效、项目已打开且锁/围栏仍可写。
   */
  async authorizeLegacyRequest(
    session: CentralSession | undefined,
    target: LegacyProjectTarget,
    mutation: boolean,
  ): Promise<{ projectUuid: string; offline: boolean }> {
    const offline = this.assertAccess(session) || !this.online;
    if (offline) this.assertOfflineBase();
    if (mutation && !offline) await this.refreshWriteAuthority(session!);

    const scopedCandidates = [...this.projects.entries()].filter(([projectUuid]) => {
      const item = this.catalog.get(projectUuid);
      if (!item) return false;
      if (
        target.legacyProjectId !== undefined
        && this.localProjectId(projectUuid) !== target.legacyProjectId
      ) return false;
      return true;
    });
    if (mutation && scopedCandidates.length === 1) {
      const [projectUuid, runtime] = scopedCandidates[0];
      const item = this.catalog.get(projectUuid)!;
      if (
        item.kind === "team"
        && (item.role === "viewer" || runtime.kind !== "team" || !runtime.sync.state().editable)
      ) {
        // 已唯一定位到只读团队项目时先拒绝角色/锁，避免借不存在的子资源探测数据。
        throw new RuntimePermissionError("团队项目当前只读或编辑锁已失效");
      }
    }
    const candidates = scopedCandidates.filter(([, runtime]) => {
      return target.resources.every(({ table, id }) => runtime.local.hasLegacyResource(table, id));
    });
    if (candidates.length !== 1) {
      // 跨账号项目、未知子资源和歧义项目统一表现为不存在，避免泄漏目录关系。
      throw new RuntimeNotFoundError("项目或子资源不存在");
    }
    const [projectUuid, runtime] = candidates[0];
    const item = this.catalog.get(projectUuid)!;
    if (mutation && item.kind === "personal" && offline) {
      this.assertOfflineProject(item);
    }
    if (mutation && item.kind === "team") {
      if (offline) throw new RuntimePermissionError("团队项目离线只读");
      if (item.role === "viewer" || runtime.kind !== "team" || !runtime.sync.state().editable) {
        throw new RuntimePermissionError("团队项目当前只读或编辑锁已失效");
      }
    }
    return { projectUuid, offline };
  }

  markLegacyMutation(projectUuid: string): void {
    const runtime = this.projects.get(projectUuid);
    if (!runtime) throw new RuntimeNotFoundError("项目不存在或未打开");
    runtime.local.markLegacyEdited();
    if (runtime.kind === "personal") runtime.sync.markEdited();
    if (runtime.kind === "team") runtime.sync.markEdited();
  }

  /** 仅持久化 sidecar intent（不 touch runtime）；catalog 缺失 fail-closed */
  recordPendingLegacyMutationOnly(projectUuid: string, source = "scriptAgent"): void {
    const identity = this.currentStorageIdentity();
    if (!identity) throw new RuntimeNotFoundError("账号存储上下文不可用");
    const segment = userStorageSegment(identity);
    const catalogItem = this.catalog.get(projectUuid) ?? this.catalog.get(projectUuid.toLowerCase());
    if (!catalogItem) {
      throw new RuntimeNotFoundError("项目不在当前账号目录，拒绝写入 mutation intent");
    }
    if (catalogItem.kind !== "personal" && catalogItem.kind !== "team") {
      throw new RuntimePermissionError("项目类型未知，拒绝写入 mutation intent");
    }
    const kind: PendingLegacyMutationKind = catalogItem.kind;
    recordPendingLegacyMutationIntent({
      dataRoot: this.dataRoot,
      userSegment: segment,
      projectUuid: catalogItem.projectUuid,
      kind,
      source,
    });
  }

  /**
   * 中央确认同步成功后统一清理 journal（<= captured）+ sidecar。
   * 仅允许 synced | unchanged | published。
   * captured 必须为显式 number（含 0）；unknown/缺失禁止 finalize。
   */
  finalizeMutationClearedAfterCentralSuccess(
    projectUuid: string,
    state: string,
    capturedMutationGeneration?: number | "unknown",
    options?: { editEpochAdvanced?: boolean },
  ): void {
    if (state !== "synced" && state !== "unchanged" && state !== "published") {
      return;
    }
    if (!isFinalizeAllowedCapture(capturedMutationGeneration)) {
      throw new Error("mutation capture 未知或缺失，禁止 finalize 清理");
    }
    const identity = this.currentStorageIdentity();
    if (!identity) {
      throw new RuntimeNotFoundError("账号存储上下文不可用，无法清理 mutation 事实");
    }
    const segment = userStorageSegment(identity);
    let remainingPending = 0;
    try {
      const dbPath = path.join(
        projectDirectory(this.dataRoot, projectUuid, segment),
        "project.sqlite",
      );
      const result = clearPendingMutationJournalOnFile(dbPath, {
        captured: capturedMutationGeneration,
      });
      remainingPending = result.remainingPending;
    } catch (err) {
      throw err instanceof Error ? err : new Error("清理项目 journal 失败");
    }
    const runtime = this.projects.get(projectUuid) ?? this.projects.get(projectUuid.toLowerCase());
    const editEpochUnchanged = options?.editEpochAdvanced !== true;
    if (remainingPending > 0 || !editEpochUnchanged) {
      if (runtime) {
        runtime.local.dirty = true;
        if (runtime.kind === "personal") {
          runtime.sync.applyMutationFinalizeResult({
            remainingPending: remainingPending > 0,
            editEpochUnchanged,
          });
        }
      }
      return;
    }
    clearPendingLegacyMutationIntent(this.dataRoot, segment, projectUuid);
    if (runtime?.kind === "personal") {
      runtime.sync.applyMutationFinalizeResult({
        remainingPending: false,
        editEpochUnchanged: true,
      });
    }
    // 中文注释：中央成功并 finalize 后才允许清理旧账号 oss 副本；之前必须保留可重试原文件。
    try {
      markLegacyCleanupReadyAfterCentralSuccess({
        dataRoot: this.dataRoot,
        userSegment: segment,
        projectUuid,
      });
      cleanupMigratedLegacyMediaAfterCentralSuccess({
        dataRoot: this.dataRoot,
        userSegment: segment,
        projectUuid,
      });
    } catch {
      // 清理失败不回滚已同步版本；保留 receipt 供下次重试。
    }
  }

  /**
   * 旧媒体迁移入口。失败向上抛出，使打开流程 fail-closed，禁止带着半迁移状态继续发布。
   */
  private migrateLegacyMediaIfNeeded(
    projectUuid: string,
    userSegment: string,
    local: RuntimeProjectLocal,
    writable: boolean,
  ): void {
    if (!writable) return;
    const databasePath = path.join(
      projectDirectory(this.dataRoot, projectUuid, userSegment),
      "project.sqlite",
    );
    const accountOssRoot = path.join(
      this.dataRoot,
      "runtime-users",
      userSegment,
      "oss",
    );
    // 中文注释：迁移需独占打开 SQLite；先关闭 ProjectStore 句柄，完成后恢复可写。
    local.close();
    try {
      const result = migrateLegacyProjectMedia({
        dataRoot: this.dataRoot,
        userSegment,
        projectUuid,
        legacyProjectId: this.localProjectIds.get(projectUuid.toLowerCase()),
        databasePath,
        accountOssRoot,
        writable,
      });
      local.setWritable();
      if (result.migrated > 0) {
        // 中文注释：引用已切换，必须标记 dirty 以便完整对象进入下一轮中央版本。
        local.markLegacyEdited();
      }
    } catch (error) {
      try {
        local.setWritable();
      } catch {
        // ignore reopen failure; rethrow 原始迁移错误
      }
      throw error;
    }
  }

  /**
   * 统一消费 runtime.sync.close()/sync() 结果。
   * Team released_cleanup_pending：
   *   1) finalize journal/sidecar（按 captured）
   *   2) confirmReleasedCleanupStrict 删除 receipt（receipt 必须最后清除）
   * 任一步失败抛错，保留可恢复持久化事实。
   */
  private consumeSyncCloseResult(
    projectUuid: string,
    result: {
      state?: string;
      capturedMutationGeneration?: number | "unknown";
      editEpochAdvanced?: boolean;
      centralEvidenceConfirmed?: boolean;
    },
  ): void {
    const state = typeof result.state === "string" ? result.state : "closed";
    const runtime = this.projects.get(projectUuid) ?? this.projects.get(projectUuid.toLowerCase());

    // Team：中央已确认 release，等待本地 finalize + 最后清 receipt
    if (
      runtime?.kind === "team"
      && (state === "released_cleanup_pending"
        || (state === "published" && result.centralEvidenceConfirmed === true))
    ) {
      if (!isFinalizeAllowedCapture(result.capturedMutationGeneration)) {
        throw new Error("mutation capture 未知或缺失，禁止 finalize 清理");
      }
      // 中文注释：先 journal/sidecar，后 receipt——禁止颠倒
      try {
        this.finalizeMutationClearedAfterCentralSuccess(
          projectUuid,
          "published",
          result.capturedMutationGeneration,
          { editEpochAdvanced: result.editEpochAdvanced },
        );
      } catch (err) {
        throw err instanceof Error
          ? err
          : new Error("同步已确认但 mutation 清理失败，请重试");
      }
      // runtime.kind === "team" 已收窄为 TeamRuntime；禁止 optional 检测后静默跳过
      try {
        runtime.sync.confirmReleasedCleanupStrict();
      } catch (err) {
        // finalize 已成功但 receipt 仍在：重启只重试本地 cleanup
        throw err instanceof Error
          ? err
          : new Error("mutation 已清理但 release receipt 删除失败，请重试");
      }
      return;
    }

    this.finalizeFromSyncResult(projectUuid, result);
  }

  /** 统一消费 Personal/Team 同步结果并 finalize（不含 Team receipt 删除） */
  private finalizeFromSyncResult(
    projectUuid: string,
    result: {
      state?: string;
      capturedMutationGeneration?: number | "unknown";
      editEpochAdvanced?: boolean;
      /** Team：必须中央证据确认才允许清 journal */
      centralEvidenceConfirmed?: boolean;
    },
  ): void {
    const state = typeof result.state === "string" ? result.state : "closed";
    if (
      state === "offline_pending"
      || state === "skipped_viewer"
      || state === "skipped_not_editable"
      || state === "recovery_required"
      || state === "released_cleanup_pending"
    ) {
      // released_cleanup_pending 必须走 consumeSyncCloseResult，禁止半路径
      return;
    }
    // 中文注释：Team published 必须带中央版本+摘要证据，否则保留 journal
    const runtime = this.projects.get(projectUuid) ?? this.projects.get(projectUuid.toLowerCase());
    if (
      runtime?.kind === "team"
      && state === "published"
      && result.centralEvidenceConfirmed !== true
    ) {
      return;
    }
    // 对象幂等 unchanged 且无 capture：按 captured=0 finalize（不清除正整数 generation）
    const capture =
      result.capturedMutationGeneration === undefined && state === "unchanged"
        ? 0
        : result.capturedMutationGeneration;
    this.finalizeMutationClearedAfterCentralSuccess(
      projectUuid,
      state,
      capture,
      { editEpochAdvanced: result.editEpochAdvanced },
    );
  }

  /**
   * 事务成功后的权威登记：先持久化 intent，再尝试 runtime dirty。
   * intent 在同步成功清脏前保留，支持 close/重启恢复。
   */
  recordAndMarkLegacyMutation(projectUuid: string, source = "scriptAgent"): void {
    this.recordPendingLegacyMutationOnly(projectUuid, source);
    this.markLegacyMutation(projectUuid);
  }

  /**
   * 打开项目后重放 pending → dirty。
   * journal（权威）或 sidecar（索引）任一存在即恢复 dirty。
   */
  reapplyPendingLegacyMutation(projectUuid: string): boolean {
    const identity = this.currentStorageIdentity();
    if (!identity) return false;
    const segment = userStorageSegment(identity);
    const detected = this.detectPendingLocalMutation(projectUuid, segment);
    if (!detected.pending && !detected.journalUnreadable) return false;
    try {
      this.markLegacyMutation(projectUuid);
      return true;
    } catch {
      // journal-only 且项目已可写时再试
      try {
        const runtime = this.projects.get(projectUuid);
        if (runtime) {
          runtime.local.dirty = true;
          if (runtime.kind === "personal") runtime.sync.markEdited();
          return true;
        }
      } catch {
        // ignore
      }
      return false;
    }
  }

  /** 同步成功清脏后清除 intent */
  clearLegacyMutationIntentIfPresent(projectUuid: string): void {
    const identity = this.currentStorageIdentity();
    if (!identity) return;
    clearPendingLegacyMutationIntent(
      this.dataRoot,
      userStorageSegment(identity),
      projectUuid,
    );
  }

  hasPendingLegacyMutation(projectUuid: string): boolean {
    const identity = this.currentStorageIdentity();
    if (!identity) return false;
    const segment = userStorageSegment(identity);
    const det = this.detectPendingLocalMutation(projectUuid, segment);
    return det.pending || det.journalUnreadable;
  }

  listPendingLegacyMutationsForAccount(): ReturnType<typeof listPendingLegacyMutationIntents> {
    const identity = this.currentStorageIdentity();
    if (!identity) return [];
    return listPendingLegacyMutationIntents(this.dataRoot, userStorageSegment(identity));
  }

  async closeProjectInternal(
    session: CentralSession | undefined,
    projectUuid: string,
  ): Promise<Record<string, unknown>> {
    return this.closeProject(session, projectUuid);
  }

  async closeProject(
    session: CentralSession | undefined,
    projectUuid: string,
    requestedGeneration?: number,
  ): Promise<Record<string, unknown>> {
    let expectedGeneration = this.activationGate.captureCloseGeneration(projectUuid, requestedGeneration);
    if (
      requestedGeneration === undefined
      && expectedGeneration <= 0
      && this.projects.has(projectUuid)
    ) {
      // 中文注释：HTTP 外部关闭必须携带代次；进程内恢复/退出链可能接管旧运行时，
      // 此时为已存在的运行时补发一次代次，避免把真实关闭误判为 stale_close。
      expectedGeneration = this.activationGate.issueOpenGeneration(projectUuid);
    }
    return this.activationGate.serialize(projectUuid, async () => {
      const decision = this.activationGate.decideClose(projectUuid, expectedGeneration);
      if (decision.stale) {
        return {
          projectUuid,
          state: "stale_close",
          ignored: true,
          runtimeGeneration: decision.runtimeGeneration,
        };
      }
      const result = await this.closeProjectAfterActivation(session, projectUuid);
      this.activationGate.releaseAfterClose(projectUuid);
      try {
        const identity = this.currentStorageIdentity();
        if (identity) {
          await runWithUserStorage(identity, () => releaseProjectDatabaseLease(projectUuid, "ui"));
        }
      } catch {
        // 句柄释放失败不得伪装 close 失败；下次 idle 回收。
      }
      return { ...result, runtimeGeneration: 0 };
    });
  }

  private async closeProjectAfterActivation(
    session: CentralSession | undefined,
    projectUuid: string,
  ): Promise<Record<string, unknown>> {
    const offline = this.assertAccess(session);
    const runtime = this.projects.get(projectUuid);
    const catalogItem = this.catalog.get(projectUuid);
    if (!runtime || !catalogItem) throw new RuntimePermissionError("项目尚未打开");
    if (offline && catalogItem.kind === "personal") this.assertOfflineProject(catalogItem);
    // 关闭前重放 pending，避免 dirty=false 漏同步
    this.reapplyPendingLegacyMutation(projectUuid);
    const operationId = `close-${projectUuid}-${Date.now()}`;
    const { withGenerationRuntimePaused } = await import("@/tianjiang/tasks/generation-runtime-participants");
    // 中文注释：关闭项目只短暂排空提交关键区；无论成功或失败都必须恢复账号级后台任务。
    return withGenerationRuntimePaused(() =>
      runWithSyncProgress(
        {
          operationId,
          intent: "close_project",
          reason: "close_project",
          totalProjects: 1,
          projectUuid,
          projectName: catalogItem.name,
          projectKind: catalogItem.kind,
        },
        async () => this.closeProjectBody(session, projectUuid, runtime, catalogItem, offline, operationId),
      ),
    );
  }

  private async closeProjectBody(
    session: CentralSession | undefined,
    projectUuid: string,
    runtime: OpenProjectRuntime,
    catalogItem: RuntimeProjectCatalogItem,
    offline: boolean,
    operationId: string,
  ): Promise<Record<string, unknown>> {
    if (runtime.kind === "personal") {
      // 中文注释：统一 PersonalCloseCoordinator 状态机；正常关闭要求中央成功。
      try {
        const settled = await this.settlePersonalProjectClose(projectUuid, runtime, {
          identity: this.currentStorageIdentity(),
          sessionExpiresAt: this.resolveSessionExpiresAtMs(),
          surface: "closeProject",
          requireCentralSuccess: true,
        });
        if (
          settled.state === "close_blocked"
          || settled.state === "recovery_required"
        ) {
          syncProgressStore.fail(
            operationId,
            settled.errorCode,
            settled.message ?? "项目关闭失败，本地数据已保留",
          );
          throw new RuntimePermissionError(
            settled.message ?? "项目关闭失败，本地数据已保留",
          );
        }
        syncProgressStore.succeed(operationId);
        return personalCloseResultToPublic(settled);
      } catch (error) {
        if (!(error instanceof RuntimePermissionError)) {
          syncProgressStore.fail(
            operationId,
            undefined,
            error instanceof Error ? error.message : "关闭失败",
          );
        }
        throw error;
      }
    }

    let closeState = "closed";
    try {
      const result = await runtime.sync.close();
      closeState = typeof (result as { state?: string })?.state === "string"
        ? (result as { state: string }).state
        : "closed";
      try {
        // 中文注释：统一编排 close → finalize journal/sidecar → receipt 最后清除
        this.consumeSyncCloseResult(
          projectUuid,
          result as unknown as PersonalSyncResult,
        );
      } catch (err) {
        // clear 失败保留可重试事实；不得伪装 close 成功
        if (
          closeState === "synced"
          || closeState === "published"
          || closeState === "unchanged"
          || closeState === "released_cleanup_pending"
        ) {
          throw err instanceof Error
            ? err
            : new Error("同步已确认但 mutation 清理失败，请重试");
        }
        throw err;
      }
      // API：本地 finalize+receipt 清理完成后对外仍为 published
      if (closeState === "released_cleanup_pending") {
        closeState = "published";
      }
    } catch (error) {
      // 中文注释：Team 失败不得入 Personal queue；必须保持项目打开可继续编辑/重试。
      // 禁止提前 local.close / projects.delete。
      syncProgressStore.fail(
        operationId,
        undefined,
        error instanceof Error ? error.message : "团队项目关闭同步失败，已保持打开",
      );
      throw error instanceof Error
        ? error
        : new Error("团队项目关闭同步失败，已保持打开");
    }
    runtime.local.close();
    this.projects.delete(projectUuid);
    syncProgressStore.succeed(operationId);
    return { projectUuid, state: closeState };
  }

  /**
   * Personal 关闭统一编排（PersonalCloseCoordinator）：
   * - 仅中央同步+finalize 成功，或队列耐久回读确认后才 dispose
   * - 队列/open/ensure/回读失败：runtime 保留，禁止 pendingSync
   * - sessionExpiresAt 必须来自真实 CentralSession.expiresAt
   */
  private async settlePersonalProjectClose(
    projectUuid: string,
    runtime: PersonalRuntime,
    options: {
      identity: UserStorageIdentity | undefined;
      sessionExpiresAt: number | undefined;
      surface: "closeProject" | "closeAll" | "ordinaryShutdown";
      sharedQueue?: SyncQueue;
      openQueue?: (dataRoot: string, identity: UserStorageIdentity) => SyncQueue;
      requireCentralSuccess?: boolean;
    },
  ): Promise<PersonalCloseResult> {
    return settlePersonalCloseUnified(
      this.buildPersonalCloseDeps(projectUuid, runtime, options),
    );
  }

  async setNetworkOnline(session: CentralSession, online: boolean): Promise<void> {
    this.assertSession(session);
    if (online) {
      try {
        const grant = await this.remote!.refreshOfflineGrant();
        this.assertGrantUsable(grant, session.user.id);
        const cache: OfflineRuntimeCache = {
          issuer: session.serverUrl,
          userId: session.user.id,
          grant,
          catalog: [...this.catalog.values()],
        };
        this.offlineGrantStore.save(cache);
        this.offlineCache = cache;
        this.deviceActive = true;
        this.online = true;
        configureModelMediaResolver(this.modelMediaResolver(this.remote!));
        return;
      } catch (error) {
        this.offlineGrantStore.clear();
        this.offlineCache = undefined;
        this.deviceActive = false;
        this.online = false;
        configureModelMediaResolver(undefined);
        await this.makeTeamsReadonly("device_revoked");
        throw new RuntimePermissionError(
          error instanceof Error ? error.message : "设备离线授权核验失败",
        );
      }
    }
    this.assertOfflineBase();
    this.online = false;
    configureModelMediaResolver(undefined);
    // 断网时在 HTTP 请求返回前完成所有团队项目 SQLite 只读切换和恢复副本落盘。
    await this.makeTeamsReadonly("network_disconnected");
  }

  /**
   * 会话明确失效时 fail-closed。
   * - 空/空白 sessionId：忽略（缺 Cookie 不得清空运行时）。
   * - 未知/旧会话 id：不得清理当前有效账号。
   * - 仅当标识与当前 session 完全匹配时才清空 session/remote 并使团队只读。
   */
  async onSessionInvalid(invalidatedSession?: CentralSession | string): Promise<void> {
    if (invalidatedSession === undefined || invalidatedSession === null) {
      return;
    }
    if (typeof invalidatedSession === "string" && !invalidatedSession.trim()) {
      // 空标识：禁止误杀（历史根因：Socket 缺 Cookie 传入 ""）。
      return;
    }
    if (!this.session) {
      // 无活动运行时：无需清理。
      return;
    }
    const invalidId = typeof invalidatedSession === "string"
      ? invalidatedSession.trim()
      : invalidatedSession.id;
    if (invalidId !== this.session.id) {
      // 旧 Socket/HTTP 迟到失效或未知 id：保留当前会话。
      return;
    }
    if (typeof invalidatedSession !== "string") {
      if (
        invalidatedSession.serverUrl !== this.session.serverUrl
        || invalidatedSession.user.id !== this.session.user.id
      ) {
        return;
      }
    }
    this.session = undefined;
    this.remote = undefined;
    this.online = false;
    const { bindAccountSyncBindings } = await import("../sync/profile-settings-adapter");
    bindAccountSyncBindings(null);
    const { bumpModelCatalogVersion } = await import("../model-providers/model-catalog-invalidation");
    const { invalidateDreaminaCapabilityCache } = await import("../model-providers/dreamina-cli/capability-cache");
    invalidateDreaminaCapabilityCache();
    bumpModelCatalogVersion("session-invalid");
    configureModelMediaResolver(undefined);
    await this.makeTeamsReadonly("session_invalid");
  }

  async onLockInvalid(session: CentralSession, projectUuid: string): Promise<void> {
    this.assertSession(session);
    const runtime = this.projects.get(projectUuid);
    if (runtime?.kind === "team") await runtime.sync.onLockExpired();
  }

  async syncNow(session: CentralSession, projectUuid: string): Promise<Record<string, unknown>> {
    this.assertSession(session);
    const runtime = this.projects.get(projectUuid);
    if (!runtime) throw new RuntimePermissionError("项目尚未打开");
    if (runtime.kind === "team") {
      // Team 仍沿用既有 close 发布状态机；成功后立即重新获取锁并恢复工作区。
      let closed: Record<string, unknown>;
      try {
        closed = await this.closeProjectInternal(session, projectUuid);
      } catch (error) {
        // close 失败会释放旧 runtime；尽力重开以便用户修复后直接重试，原错误仍向上返回。
        try {
          await this.openProject(session, projectUuid);
        } catch {
          // journal/receipt 仍是恢复权威；重开失败不得覆盖原始发布错误。
        }
        throw error;
      }
      const reopened = await this.openProject(session, projectUuid);
      return {
        projectUuid,
        ...closed,
        runtime: reopened,
      };
    }
    // 中文注释：manual 必须经 finalize，禁止直接 sync 绕开 journal/sidecar 清理
    return {
      projectUuid,
      ...await this.runPersonalSyncAndFinalize(projectUuid, "manual"),
    };
  }

  private bindProfileCalibration(
    projectUuid: string,
    profileCalibration: Promise<unknown> | null,
  ): void {
    if (!profileCalibration) return;
    this.profileCalibrations.set(projectUuid, profileCalibration);
    void profileCalibration.finally(() => {
      if (this.profileCalibrations.get(projectUuid) === profileCalibration) {
        this.profileCalibrations.delete(projectUuid);
      }
    });
  }

  currentProfileCalibration(): Promise<unknown> | null {
    return this.profileSync?.currentReconcile() ?? null;
  }

  setProfileValue(session: CentralSession, key: string, value: string, _sensitive?: boolean): void {
    this.assertSession(session);
    if (!this.profileSync) throw new RuntimePermissionError("个人配置尚未初始化");
    this.profileSync.setPersistent(key, value);
  }

  async flushProfile(session: CentralSession): Promise<Record<string, unknown>> {
    this.assertSession(session);
    if (!this.profileSync) throw new RuntimePermissionError("个人配置尚未初始化");
    await this.profileSync.flush();
    return { ...this.profileSync.status() };
  }

  async retryProfileSync(session: CentralSession): Promise<ProfileRuntimeStatus> {
    this.assertSession(session);
    if (this.profileSync) {
      await this.profileSync.flush();
      return resolveProfileRuntimeStatus(this.profileSync.status(), this.profileFailure);
    }
    if (this.profileFailure?.retryable && this.keyRetryUserUuid) {
      // 用户点击重试时立即尝试一次；后台指数退避计数仍保留有界上限。
      this.clearKeyRetryTimer();
      await this.runKeyRecoveryAttempt();
      // 异步恢复会写回实例字段；显式还原联合类型，避免控制流仍沿用调用前的 undefined 收窄。
      const recoveredProfileSync = this.profileSync as ProfileSync | undefined;
      return resolveProfileRuntimeStatus(recoveredProfileSync?.status(), this.profileFailure);
    }
    throw new RuntimePermissionError("个人配置同步当前不可重试");
  }

  migrationStatus(session: CentralSession): Record<string, unknown> {
    this.assertSession(session);
    const sourceDatabase = path.join(this.dataRoot, "db2.sqlite");
    return {
      sourceDetected: fs.existsSync(sourceDatabase),
      state: this.lastMigration ? "completed" : "pending",
      migrationId: this.lastMigration?.report.migrationId ?? "",
      reportPath: this.lastMigration?.report.reportPath ?? "",
    };
  }

  async runMigration(session: CentralSession): Promise<MigrationReport> {
    this.assertSession(session);
    if (this.lastMigration) throw new RuntimePermissionError("本次登录已完成旧库迁移");
    const userUuid = stableUserUuid(session.serverUrl, session.user.id);
    const migrator = new LegacyMigrator({
      databasePath: path.join(this.dataRoot, "db2.sqlite"),
      filesRoot: path.join(this.dataRoot, "oss"),
      // 迁移先发布到独立原子目录，确认报告后再由后续导入流程切换，绝不覆盖运行中的旧库。
      // 短目录名降低 Windows MAX_PATH 风险（stage/runtime-users/projects 嵌套更深）。
      targetDataRoot: path.join(this.dataRoot, "mo", userUuid),
      userUUID: userUuid,
      userSegment: userStorageSegment({ issuer: session.serverUrl, userId: session.user.id }),
      profileCrypto: new ProfileCrypto(userUuid, this.requireProfileKey()),
    });
    const report = await migrator.migrate();
    this.lastMigration = { migrator, report };
    return report;
  }

  async rollbackMigration(session: CentralSession): Promise<void> {
    this.assertSession(session);
    if (!this.lastMigration) throw new RuntimePermissionError("没有可回滚的本次迁移");
    await this.lastMigration.migrator.rollback(this.lastMigration.report);
    this.lastMigration = undefined;
  }

  shutdown(): Promise<void> {
    // 必须发生在本方法首个 await 之前；关闭失败也不得允许旧登录重新开放资源。
    if (!this.shutdownRequested) {
      this.shutdownRequested = true;
      this.shutdownEpoch += 1;
    }
    if (this.shutdownInFlight) return this.shutdownInFlight;
    const attempt = this.performShutdown();
    this.shutdownInFlight = attempt;
    const release = () => {
      if (this.shutdownInFlight === attempt) this.shutdownInFlight = undefined;
    };
    void attempt.then(release, release);
    return attempt;
  }

  private async performShutdown(): Promise<void> {
    // 登录负责清理其局部资源；关闭必须等它落定后再销毁仍由协调器持有的旧资源。
    const login = this.loginInFlight;
    if (login) await login.catch(() => undefined);
    await executeRetryableShutdownPhases(this.shutdownState, {
      stopKeyRetry: () => this.stopBackgroundWork(),
      flushProfile: async () => {
        if (this.profileSync && this.online) {
          try {
            const session = this.session;
            if (session) {
              const identity = { issuer: session.serverUrl, userId: session.user.id };
              await prepareUserDatabase(identity);
              await runWithUserStorage(identity, () => this.profileSync!.flush());
            } else {
              await this.profileSync.flush();
            }
          } catch (error) {
            // 可恢复配置同步失败不阻断普通退出。
            if (classifyShutdownSyncFailure(error) !== "retryable") throw error;
          }
        }
      },
      closeProjects: () => this.commitProjectClosesForOrdinaryShutdown(),
      closeProfileStore: () => {
        this.profileStore?.close();
        this.profileStore = undefined;
      },
      clearProfileKey: () => {
        this.profileKey?.fill(0);
        this.profileKey = undefined;
      },
    });
    // 中文注释：登录校准会 prepareUserDatabase；关闭后必须释放 knex，避免 Windows 锁住 db2。
    const { destroyAllDatabaseHandles } = await import("@/utils/db");
    await destroyAllDatabaseHandles();
    const { bindAccountSyncBindings } = await import("../sync/profile-settings-adapter");
    bindAccountSyncBindings(null);
  }

  /** 普通退出摘要：pending 任务数与安全提示。 */
  pendingSyncShutdownSummary(): PendingSyncSummary | undefined {
    return this.lastPendingSyncSummary;
  }

  /** 最近一次真实续传消费者结果（测试用）。 */
  pendingSyncResumeResult(): PendingSyncConsumerResult | undefined {
    return this.lastPendingSyncResumeResult;
  }

  /**
   * 暂停 pending consumer 并等待在途上传结束（可恢复，非 shutdownRequested）。
   */
  async beginProjectCloseDrain(): Promise<void> {
    this.projectCloseDraining = true;
    this.clearPendingSyncRetryTimer();
    if (this.pendingSyncResumeInFlight) {
      await this.pendingSyncResumeInFlight.catch(() => undefined);
    }
  }

  /** 项目关闭阻断后恢复 pending consumer 调度。 */
  resumeProjectCloseDrain(): void {
    if (!this.projectCloseDraining) return;
    this.projectCloseDraining = false;
    if (this.session && !this.shutdownRequested) {
      this.schedulePendingSyncResume(this.shutdownEpoch);
    }
  }

  /**
   * 活动写 handler 排空后的项目关闭提交（serve 状态机 project_close_commit）。
   * 全有或全无：任一 Personal 阻断则全部 rollback，禁止 A 成功 dispose 而 B fatal 时 A 静默消失。
   */
  async commitProjectClosesForOrdinaryShutdown(): Promise<void> {
    await runWithSyncProgress(
      {
        operationId: `app-quit-${Date.now()}`,
        intent: "app_quit",
        reason: "app_quit",
        totalProjects: this.projects.size,
      },
      () => this.closeAllForOrdinaryShutdown({ atomicPersonal: true }),
    );
  }

  /**
   * 关闭打开中的项目：可恢复失败耐久入队；fatal/阻断必须 reject 生产 shutdown。
   * atomicPersonal=true：先全部 attempt，全部允许后再入队/dispose。
   * 成功后 projectsClosed=true；已关闭则禁止二次 close。
   */
  private async closeAllForOrdinaryShutdown(options?: {
    atomicPersonal?: boolean;
  }): Promise<void> {
    // 中文注释：drain 后已成功关项目则禁止 finalSync/shutdown 二次 close。
    // ordinary shutdown 必须经统一 settlePersonalProjectClose / settleProject，
    // 且用 attemptedPersonal 跟踪已 attempt Personal；preparePendingSyncForShutdown 已消费
    // 的项目，后续循环不得再次 close。
    if (this.shutdownState.projectsClosed) {
      return;
    }
    const atomicPersonal = options?.atomicPersonal === true;
    const identity = this.currentStorageIdentity();
    // 中文注释：必须使用真实会话/离线授权 expiresAt，禁止 Date.now()+7d
    const sessionExpiresAt = this.resolveSessionExpiresAtMs();
    const queue = identity
      ? openUserSyncQueue(this.dataRoot, identity)
      : undefined;
    const blockedProjectUUIDs: string[] = [];
    // 中文注释：普通退出不是中央事务；若后续 Team 阶段失败，
    // 必须用生产 openProject 补偿本轮已经 dispose 的 Personal，避免取消退出后项目消失。
    const disposedPersonalProjectUuids = new Set<string>();
    // 中文注释：中央 close 已成功的 Team 在本轮后续失败时已经释放锁，必须整体 reopen。
    const teamReadyForLocalClose: Array<{
      projectUuid: string;
      runtime: TeamRuntime;
    }> = [];
    let completedProjectCount = 0;
    const reportProjectCompleted = (
      projectUuid: string,
      runtime: OpenProjectRuntime,
    ): void => {
      completedProjectCount += 1;
      reportSyncProgress({
        completedProjects: completedProjectCount,
        projectUuid,
        projectName: this.catalog.get(projectUuid)?.name,
        projectKind: runtime.kind,
      });
    };
    try {
      // 中文注释：上一次退出补偿失败时保持 drain；本轮必须先恢复旧 Team，再拍摄关闭集合。
      await this.restorePendingTeamCloseCompensations();
      if (atomicPersonal) {
        // 中文注释：生产退出要求中央成功。即使项目未在 projects map，
        // queue/sidecar/journal/Team receipt 仍代表未完成业务，必须先正式重开再走同一关闭门。
        await this.openDurablePendingProjectsForCentralClose(queue);
      }
      // 关闭前重放：sidecar + journal-only 项目目录扫描
      const identityForPending = this.currentStorageIdentity();
      if (
        identityForPending
        && queue
        && sessionExpiresAt !== undefined
        && Number.isFinite(sessionExpiresAt)
        && sessionExpiresAt > Date.now()
      ) {
        const segment = userStorageSegment(identityForPending);
        const pendingUuids = new Set<string>();
        for (const intent of listPendingLegacyMutationIntents(this.dataRoot, segment)) {
          pendingUuids.add(intent.projectUuid);
          if (this.projects.has(intent.projectUuid)) {
            this.reapplyPendingLegacyMutation(intent.projectUuid);
          } else if (intent.kind === "personal") {
            try {
              durableEnsurePersonalUpload(
                queue,
                intent.projectUuid,
                sessionExpiresAt,
              );
            } catch {
              // 入队失败保留 journal 事实
            }
          }
        }
        for (const uuid of this.listJournalOnlyPendingProjectUuids(segment)) {
          pendingUuids.add(uuid);
          if (this.projects.has(uuid)) {
            this.reapplyPendingLegacyMutation(uuid);
          } else if (this.catalog.get(uuid)?.kind === "personal") {
            try {
              durableEnsurePersonalUpload(queue, uuid, sessionExpiresAt);
            } catch {
              // ignore
            }
          }
        }
        void pendingUuids;
      }

      const isDirtyRuntime = (projectUuid: string, runtime: OpenProjectRuntime): boolean => {
        if (runtime.local.dirty) return true;
        if (!identityForPending) return false;
        const seg = userStorageSegment(identityForPending);
        const det = this.detectPendingLocalMutation(projectUuid, seg);
        return det.pending || det.journalUnreadable;
      };

      if (atomicPersonal) {
        // 中文注释：历史补偿可能把已 dispose 的 Personal runtime 重新放回 projects。
        // 必须先恢复，再拍摄本轮关闭快照，否则恢复出的项目会被漏掉却仍被记为全部关闭。
        await this.restorePendingPersonalCloseCompensations();
      }

      const personalProjectUuids = [...this.projects.entries()]
        .filter(([, runtime]) => runtime.kind === "personal")
        .map(([projectUuid]) => projectUuid);
      const personalDirtyProjectUuids = [...this.projects.entries()]
        .filter(([projectUuid, runtime]) =>
          runtime.kind === "personal" && isDirtyRuntime(projectUuid, runtime)
        )
        .map(([projectUuid]) => projectUuid);
      // 中文注释：普通应用退出必须以本次 close 的真实结果为准，不能信任可能滞后的 online 缓存。
      // 中央同步成功仍直接提交；仅 retryable/offline_pending 先写账号耐久队列再释放本地句柄。
      // 显式退出账号、切换账号、无效授权、冲突和本地损坏仍走各自的严格阻断入口。
      const requirePersonalCentralSuccess = false;
      // Personal：atomic 批量 attempt → 全有或全无 commit；否则单项目 settle
      // 中文注释：preparePendingSyncForShutdown 已消费 / atomic 每项目最多 attempt 一次，
      // 后续循环不得再次 close 已消费 Personal。
      if (atomicPersonal) {
        const attemptTargets = personalProjectUuids.length > 0
          ? personalProjectUuids
          : personalDirtyProjectUuids;
        const attempts: Array<{
          projectUuid: string;
          runtime: PersonalRuntime;
          deps: PersonalCloseDeps;
          attempt: PersonalCloseAttemptResult;
        }> = [];
        for (const projectUuid of attemptTargets) {
          const runtime = this.projects.get(projectUuid);
          if (!runtime || runtime.kind !== "personal") continue;
          this.reportSyncProjectStarting(projectUuid, runtime);
          const deps = this.buildPersonalCloseDeps(projectUuid, runtime, {
            identity,
            sessionExpiresAt,
            surface: "ordinaryShutdown",
            sharedQueue: queue,
            requireCentralSuccess: requirePersonalCentralSuccess,
          });
          const attempt = await attemptPersonalProjectClose(deps);
          attempts.push({ projectUuid, runtime, deps, attempt });
        }
        const anyBlocked = attempts.some((a) => !a.attempt.allowSafeQuit);
        if (anyBlocked) {
          for (const a of attempts) {
            if (a.attempt.pendingAction) {
              rollbackPersonalCloseAttempt(a.runtime);
            }
          }
          for (const a of attempts) {
            if (!a.attempt.allowSafeQuit) blockedProjectUUIDs.push(a.projectUuid);
          }
          this.lastPendingSyncSummary = {
            pendingCount: queue ? queue.countPending() : 0,
            safeToQuit: false,
            message: PENDING_SYNC_BLOCKED_MESSAGE,
            blockedProjectUUIDs: blockedProjectUUIDs.length > 0
              ? blockedProjectUUIDs
              : undefined,
          };
          throw Object.assign(
            new Error(this.lastPendingSyncSummary.message),
            { code: "PERSONAL_CLOSE_BLOCKED" },
          );
        }
        // 全部允许：再入队/dispose（每个项目最多 1 次 attempt 已完成）
        // 中文注释：local.close 不可事务回滚，中途失败必须正式 openProject 补偿已 dispose 项
        const committedProjectUuids: string[] = [];
        for (const a of attempts) {
          if (!a.attempt.pendingAction) continue;
          const committed = commitPersonalCloseAttempt(a.deps, a.attempt, queue);
          if (committed.allowSafeQuit && committed.disposed) {
            committedProjectUuids.push(a.projectUuid);
            disposedPersonalProjectUuids.add(a.projectUuid);
            reportProjectCompleted(a.projectUuid, a.runtime);
            continue;
          }
          if (!committed.allowSafeQuit) {
            blockedProjectUUIDs.push(a.projectUuid);
            // 回滚尚未 commit 的 attempt
            for (const rest of attempts) {
              if (
                rest.projectUuid !== a.projectUuid
                && rest.attempt.pendingAction
                && this.projects.has(rest.projectUuid)
              ) {
                rollbackPersonalCloseAttempt(rest.runtime);
              }
            }
            // 中文注释：登记已 dispose UUID 供本轮与下轮 closeServe 重试补偿
            for (const uuid of committedProjectUuids) {
              this.pendingPersonalCloseCompensations.add(uuid);
            }
            try {
              // 中文注释：补偿 reopen 时 projectCloseDraining 须仍为 true，禁止先 resume 业务
              await this.restorePendingPersonalCloseCompensations();
            } catch (compensationError) {
              this.lastPendingSyncSummary = {
                pendingCount: queue ? queue.countPending() : 0,
                safeToQuit: false,
                message:
                  compensationError instanceof Error
                    ? compensationError.message
                    : PENDING_SYNC_BLOCKED_MESSAGE,
                blockedProjectUUIDs,
              };
              throw Object.assign(
                new Error(this.lastPendingSyncSummary.message),
                {
                  code: "PERSONAL_CLOSE_COMPENSATION_FAILED",
                  cause: compensationError,
                },
              );
            }
            this.lastPendingSyncSummary = {
              pendingCount: queue ? queue.countPending() : 0,
              safeToQuit: false,
              message: committed.message ?? PENDING_SYNC_BLOCKED_MESSAGE,
              blockedProjectUUIDs,
            };
            throw Object.assign(
              new Error(this.lastPendingSyncSummary.message),
              { code: "PERSONAL_CLOSE_BLOCKED" },
            );
          }
        }
        this.lastPendingSyncSummary = {
          pendingCount: queue ? queue.countPending() : 0,
          safeToQuit: true,
          message: PENDING_SYNC_EXIT_MESSAGE,
        };
      } else if (queue) {
        this.lastPendingSyncSummary = await preparePendingSyncForShutdown(queue, {
          sessionExpiresAt: sessionExpiresAt ?? 0,
          dirtyProjectUUIDs: personalDirtyProjectUuids,
          attemptProjectClose: async () => {},
          settleProject: async (projectUUID) => {
            const runtime = this.projects.get(projectUUID);
            if (!runtime || runtime.kind !== "personal") {
              return { allowSafeQuit: true, disposed: true };
            }
            this.reportSyncProjectStarting(projectUUID, runtime);
            const settled = await this.settlePersonalProjectClose(
              projectUUID,
              runtime,
              {
                identity,
                sessionExpiresAt,
                surface: "ordinaryShutdown",
                sharedQueue: queue,
              },
            );
            if (!settled.allowSafeQuit) blockedProjectUUIDs.push(projectUUID);
            if (settled.allowSafeQuit && settled.disposed) {
              disposedPersonalProjectUuids.add(projectUUID);
              reportProjectCompleted(projectUUID, runtime);
            }
            return {
              allowSafeQuit: settled.allowSafeQuit,
              disposed: settled.disposed,
            };
          },
        });
      }

      // 非 atomic 路径：其余未 settle 的 Personal
      if (!atomicPersonal) {
        const attemptedPersonal = new Set(personalDirtyProjectUuids);
        for (const [projectUuid, runtime] of [...this.projects]) {
          if (runtime.kind !== "personal" || attemptedPersonal.has(projectUuid)) continue;
          this.reportSyncProjectStarting(projectUuid, runtime);
          const settled = await this.settlePersonalProjectClose(projectUuid, runtime, {
            identity,
            sessionExpiresAt,
            surface: "ordinaryShutdown",
            sharedQueue: queue,
          });
          if (!settled.allowSafeQuit) blockedProjectUUIDs.push(projectUuid);
          if (settled.allowSafeQuit && settled.disposed) {
            disposedPersonalProjectUuids.add(projectUuid);
            reportProjectCompleted(projectUuid, runtime);
          }
        }
      }

      // Team：必须在写 handler 排空后（由 serve 状态机保证调用时机）再 publish/release。
      // 中文注释：中央阶段全部成功前，禁止 local.close / projects.delete；
      // 任一 publish/release/finalize/receipt 错误都要取消退出并保留恢复事实。
      for (const [projectUuid, runtime] of [...this.projects]) {
        if (runtime.kind !== "team") continue;
        this.reportSyncProjectStarting(projectUuid, runtime);
        try {
          await this.prepareTeamCloseForCentralSuccess(projectUuid, runtime);
          teamReadyForLocalClose.push({ projectUuid, runtime });
        } catch (cause) {
          blockedProjectUUIDs.push(projectUuid);
          this.lastPendingSyncSummary = {
            pendingCount: queue ? queue.countPending() : 0,
            safeToQuit: false,
            message: "团队项目同步未完成，已取消退出，请修复后重试",
            blockedProjectUUIDs: [...new Set(blockedProjectUUIDs)],
          };
          throw Object.assign(
            new Error(this.lastPendingSyncSummary.message),
            { code: "TEAM_CLOSE_BLOCKED", cause },
          );
        }
      }

      // 中文注释：所有 Team 中央阶段通过后才统一释放本地句柄；
      // local.close 失败时保留 map 条目，下一次关闭可继续重试。
      for (const { projectUuid, runtime } of teamReadyForLocalClose) {
        try {
          runtime.local.close();
        } catch (cause) {
          blockedProjectUUIDs.push(projectUuid);
          this.lastPendingSyncSummary = {
            pendingCount: queue ? queue.countPending() : 0,
            safeToQuit: false,
            message: "团队项目本地资源关闭失败，已取消退出，请重试",
            blockedProjectUUIDs: [...new Set(blockedProjectUUIDs)],
          };
          throw Object.assign(
            new Error(this.lastPendingSyncSummary.message),
            { code: "TEAM_CLOSE_BLOCKED", cause },
          );
        }
      }
      for (const { projectUuid, runtime } of teamReadyForLocalClose) {
        this.projects.delete(projectUuid);
        this.projects.delete(projectUuid.toLowerCase());
        reportProjectCompleted(projectUuid, runtime);
      }

      const prior = this.lastPendingSyncSummary;
      const safeToQuit =
        blockedProjectUUIDs.length === 0 && prior?.safeToQuit !== false;
      const allBlocked = [
        ...new Set([
          ...(prior?.blockedProjectUUIDs ?? []),
          ...blockedProjectUUIDs,
        ]),
      ];
      this.lastPendingSyncSummary = {
        pendingCount: queue ? queue.countPending() : 0,
        safeToQuit,
        message: safeToQuit
          ? PENDING_SYNC_EXIT_MESSAGE
          : (prior?.message ?? PENDING_SYNC_BLOCKED_MESSAGE),
        blockedProjectUUIDs: allBlocked.length > 0 ? allBlocked : undefined,
      };

      if (!safeToQuit) {
        throw Object.assign(
          new Error(this.lastPendingSyncSummary.message),
          { code: "PERSONAL_CLOSE_BLOCKED" },
        );
      }

      const remainingProjectUuids = [...this.projects.keys()];
      if (remainingProjectUuids.length > 0) {
        // 中文注释：projectsClosed 会让 finalSync 跳过再次关闭，因此它只能在运行时项目表为空时置真。
        // 任一残留项目都必须 fail-closed，禁止把部分关闭伪装成完整关闭。
        this.lastPendingSyncSummary = {
          pendingCount: queue ? queue.countPending() : 0,
          safeToQuit: false,
          message: "仍有项目运行时未完成关闭，请重试",
          blockedProjectUUIDs: remainingProjectUuids,
        };
        throw Object.assign(
          new Error(this.lastPendingSyncSummary.message),
          { code: "PERSONAL_CLOSE_BLOCKED" },
        );
      }

      if (queue) {
        queue.requeueRunningAsPending();
      }
      // 中文注释：成功仅记账一次；此时 projects 已为空，finalSync 才可安全跳过 closeProjects。
      this.shutdownState.projectsClosed = true;
    } catch (error) {
      if (
        error
        && typeof error === "object"
        && [
          "PERSONAL_CLOSE_COMPENSATION_FAILED",
          "TEAM_CLOSE_COMPENSATION_FAILED",
        ].includes((error as { code?: string }).code ?? "")
      ) {
        // 中文注释：内层已经尝试并登记补偿失败；必须留到下一次关闭重试，
        // 禁止同一调用立即二次 reopen，避免掩盖 fail-closed 状态。
        throw error;
      }
      if (teamReadyForLocalClose.length > 0) {
        for (const { projectUuid } of teamReadyForLocalClose) {
          this.pendingTeamCloseCompensations.add(projectUuid);
        }
        try {
          // 中文注释：中央 close 已经释放 Team 锁，退出取消后必须正式重开；
          // 仅保留旧 map 条目会留下 closed sync/local 的僵尸运行时。
          await this.restorePendingTeamCloseCompensations();
        } catch (compensationError) {
          const teamProjectUuids = teamReadyForLocalClose.map(({ projectUuid }) => projectUuid);
          const blocked = [
            ...new Set([
              ...(this.lastPendingSyncSummary?.blockedProjectUUIDs ?? []),
              ...teamProjectUuids,
            ]),
          ];
          this.lastPendingSyncSummary = {
            pendingCount: queue ? queue.countPending() : 0,
            safeToQuit: false,
            message: compensationError instanceof Error
              ? compensationError.message
              : "团队项目补偿恢复失败，禁止退出",
            blockedProjectUUIDs: blocked,
          };
          throw Object.assign(
            new Error(this.lastPendingSyncSummary.message),
            {
              code: "TEAM_CLOSE_COMPENSATION_FAILED",
              cause: compensationError,
              originalError: error,
            },
          );
        }
      }
      const missingPersonal = [...disposedPersonalProjectUuids]
        .filter((projectUuid) => !this.projects.has(projectUuid));
      if (missingPersonal.length > 0) {
        for (const projectUuid of missingPersonal) {
          this.pendingPersonalCloseCompensations.add(projectUuid);
        }
        try {
          // 中文注释：Team/后续阶段失败意味着退出已取消；
          // 已 dispose 的 Personal 必须走生产 openProject 恢复，不能静默留在目录之外。
          await this.restorePendingPersonalCloseCompensations();
        } catch (compensationError) {
          const blocked = [
            ...new Set([
              ...(this.lastPendingSyncSummary?.blockedProjectUUIDs ?? []),
              ...missingPersonal,
            ]),
          ];
          this.lastPendingSyncSummary = {
            pendingCount: queue ? queue.countPending() : 0,
            safeToQuit: false,
            message: compensationError instanceof Error
              ? compensationError.message
              : "个人项目补偿恢复失败，禁止退出",
            blockedProjectUUIDs: blocked,
          };
          throw Object.assign(
            new Error(this.lastPendingSyncSummary.message),
            {
              code: "PERSONAL_CLOSE_COMPENSATION_FAILED",
              cause: compensationError,
              originalError: error,
            },
          );
        }
      }
      throw error;
    } finally {
      queue?.close();
    }
  }

  private buildPersonalCloseDeps(
    projectUuid: string,
    runtime: PersonalRuntime,
    options: {
      identity: UserStorageIdentity | undefined;
      sessionExpiresAt: number | undefined;
      surface: "closeProject" | "closeAll" | "ordinaryShutdown";
      sharedQueue?: SyncQueue;
      openQueue?: (dataRoot: string, identity: UserStorageIdentity) => SyncQueue;
      requireCentralSuccess?: boolean;
    },
  ): PersonalCloseDeps {
    return {
      projectUuid,
      runtime,
      identity: options.identity,
      sessionExpiresAt: options.sessionExpiresAt,
      dataRoot: this.dataRoot,
      surface: options.surface,
      // 中文注释：关闭项目/退出/切换账号默认要求中央成功；仅不可控崩溃允许下次启动恢复。
      requireCentralSuccess: options.requireCentralSuccess !== false,
      sharedQueue: options.sharedQueue,
      openQueue:
        options.openQueue
        ?? ((dataRoot, identity) => openUserSyncQueue(dataRoot, identity)),
      consumeSyncCloseResult: (uuid, result) => {
        this.consumeSyncCloseResult(uuid, result);
      },
      deleteFromProjects: (uuid) => {
        this.projects.delete(uuid);
        this.projects.delete(uuid.toLowerCase());
      },
    };
  }

  /**
   * 对 pendingPersonalCloseCompensations 逐个正式 openProject（session 可为 undefined/离线）。
   * 中文注释：成功才从 Set 删除；失败 UUID 保留供下一次 closeServe 重试。
   */
  private async restorePendingPersonalCloseCompensations(): Promise<void> {
    if (this.pendingPersonalCloseCompensations.size === 0) return;
    // 中文注释：openProject→initializeLegacyWorkspace→prepareProjectDatabase 依赖用户存储 ALS
    const identity = this.currentStorageIdentity();
    if (!identity) {
      throw Object.assign(new Error("个人项目补偿恢复失败：缺少用户存储身份"), {
        code: "PERSONAL_CLOSE_COMPENSATION_FAILED",
      });
    }
    await runWithUserStorage(identity, async () => {
      for (const projectUuid of [...this.pendingPersonalCloseCompensations]) {
        try {
          if (!this.projects.has(projectUuid)) {
            // 中文注释：openProject(undefined) 走 assertAccess 离线 grant，禁止绕开权限
            await this.openProject(this.session, projectUuid);
          }
          const restored = this.projects.get(projectUuid);
          if (!restored || restored.kind !== "personal") {
            throw new Error(`个人项目恢复失败：${projectUuid}`);
          }
          this.pendingPersonalCloseCompensations.delete(projectUuid);
        } catch (cause) {
          throw Object.assign(new Error(`个人项目补偿恢复失败：${projectUuid}`), {
            code: "PERSONAL_CLOSE_COMPENSATION_FAILED",
            cause,
          });
        }
      }
    });
  }

  private currentStorageIdentity(): UserStorageIdentity | undefined {
    if (this.session) {
      return { issuer: this.session.serverUrl, userId: this.session.user.id };
    }
    if (this.offlineCache?.issuer) {
      return { issuer: this.offlineCache.issuer, userId: this.offlineCache.userId };
    }
    return undefined;
  }

  /**
   * 解析被关闭账号的真实会话过期时间（毫秒）。
   * 优先 CentralSession.expiresAt，其次离线授权 grant.expiresAt；禁止虚构 7 天。
   */
  private resolveSessionExpiresAtMs(): number | undefined {
    if (this.session?.expiresAt !== undefined && Number.isFinite(this.session.expiresAt)) {
      return this.session.expiresAt;
    }
    const grantExp = this.offlineCache?.grant?.expiresAt as string | number | undefined;
    if (typeof grantExp === "number" && Number.isFinite(grantExp)) {
      // 若为秒级时间戳则转毫秒
      return grantExp < 1e12 ? grantExp * 1000 : grantExp;
    }
    if (typeof grantExp === "string" && grantExp.trim()) {
      const parsed = Date.parse(grantExp);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }

  /**
   * 登录后启动真实待同步消费者：claim → 完整上传协议 → commit 后 complete。
   * 晚到回调在 shutdown epoch 变化后不得写库。
   */
  private schedulePendingSyncResume(loginEpoch?: number): void {
    if (this.shutdownRequested) return;
    if (this.projectCloseDraining) return;
    if (this.pendingSyncResumeInFlight) return;
    this.clearPendingSyncRetryTimer();
    const epoch = loginEpoch ?? this.shutdownEpoch;
    const attempt = this.runPendingSyncResume(epoch);
    this.pendingSyncResumeInFlight = attempt;
    const release = () => {
      if (this.pendingSyncResumeInFlight === attempt) {
        this.pendingSyncResumeInFlight = undefined;
        this.schedulePendingSyncRetry(epoch);
      }
    };
    void attempt.then(release, release);
  }

  private clearPendingSyncRetryTimer(): void {
    if (!this.pendingSyncRetryTimer) return;
    clearTimeout(this.pendingSyncRetryTimer);
    this.pendingSyncRetryTimer = undefined;
  }

  /**
   * 消费者本轮结束后读取队列中的最早 next_attempt_at，自动唤醒 retry_wait。
   * 定时器只负责唤醒；崩溃恢复仍由 SQLite 队列与下次登录对账保证。
   */
  private schedulePendingSyncRetry(loginEpoch: number): void {
    this.clearPendingSyncRetryTimer();
    if (
      !this.isLoginEpochCurrent(loginEpoch)
      || this.shutdownRequested
      || this.projectCloseDraining
      || this.pendingSyncResumeInFlight
    ) {
      return;
    }
    const identity = this.currentStorageIdentity();
    if (!identity) return;
    const queue = openUserSyncQueue(this.dataRoot, identity);
    let nextRunnableAt: number | undefined;
    try {
      nextRunnableAt = queue.nextRunnableAt();
    } finally {
      queue.close();
    }
    if (nextRunnableAt === undefined) return;
    // 至少延迟 50ms，避免一次最多处理 8 项时形成同步递归忙循环。
    const delay = Math.max(50, nextRunnableAt - Date.now());
    const timer = setTimeout(() => {
      if (this.pendingSyncRetryTimer !== timer) return;
      this.pendingSyncRetryTimer = undefined;
      this.schedulePendingSyncResume(loginEpoch);
    }, delay);
    timer.unref?.();
    this.pendingSyncRetryTimer = timer;
  }

  /** 登录后把 Personal queue/journal/sidecar 事实重建或续期到当前账号队列。 */
  private async reconcilePendingPersonalUploads(session: CentralSession): Promise<void> {
    const sessionExpiresAt = session.expiresAt;
    if (!Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= Date.now()) return;
    const identity: UserStorageIdentity = {
      issuer: session.serverUrl,
      userId: session.user.id,
    };
    const segment = userStorageSegment(identity);
    const pendingPersonalUuids = new Set<string>();
    const currentProjectKind = (projectUuid: string): "personal" | "team" | undefined => {
      const catalogItem =
        this.catalog.get(projectUuid)
        ?? this.catalog.get(projectUuid.toLowerCase());
      return catalogItem?.kind;
    };

    const queue = openUserSyncQueue(this.dataRoot, identity);
    try {
      // 中文注释：队列可能是重启后唯一持久事实，必须先纳入；当前 catalog 决定 Personal/Team 边界。
      for (const projectUuid of queue.listRecoverableUploadProjectUuids()) {
        const kind = currentProjectKind(projectUuid);
        if (kind === "personal") {
          pendingPersonalUuids.add(projectUuid);
        } else if (kind === "team") {
          queue.terminalizeActiveUploadsForProject(projectUuid, "UNSUPPORTED_TASK_TYPE");
        }
      }
      for (const intent of listPendingLegacyMutationIntents(this.dataRoot, segment)) {
        if (currentProjectKind(intent.projectUuid) === "personal") {
          pendingPersonalUuids.add(intent.projectUuid);
        }
      }
      for (const projectUuid of this.listJournalOnlyPendingProjectUuids(segment)) {
        if (currentProjectKind(projectUuid) === "personal") pendingPersonalUuids.add(projectUuid);
      }
      for (const projectUuid of pendingPersonalUuids) {
        try {
          // 只对仍有 durable mutation 的 Personal 项目迁移旧版通用 Error。
          queue.reviveLegacyGenericUploadFailure(projectUuid, sessionExpiresAt);
          const latestTask = queue.getLatestUploadTask(projectUuid);
          if (latestTask?.status === "failed" || latestTask?.status === "cancelled") {
            // 中文注释：fatal/用户取消属于自动重试终态；sidecar/journal 不得在每次登录绕过该权威状态。
            continue;
          }
          durableEnsurePersonalUpload(queue, projectUuid, sessionExpiresAt, { kind: "personal" });
        } catch {
          // 单项目失败不得阻断其他项目对账；其 journal/sidecar 事实保持不变。
        }
      }
    } finally {
      queue.close();
    }
  }

  private async runPendingSyncResume(loginEpoch: number): Promise<void> {
    const identity = this.currentStorageIdentity();
    if (!identity) return;
    if (!this.isLoginEpochCurrent(loginEpoch)) return;

    const queue = openUserSyncQueue(this.dataRoot, identity);
    try {
      if (!this.isLoginEpochCurrent(loginEpoch)) return;
      this.lastPendingSyncResumeResult = await runPendingSyncConsumer({
        queue,
        isActive: () =>
          this.isLoginEpochCurrent(loginEpoch)
          && !this.shutdownRequested
          && !this.projectCloseDraining,
        maxTasksPerRun: 8,
        executor: {
          uploadProject: async (projectUuid) => {
            if (
              !this.isLoginEpochCurrent(loginEpoch)
              || this.shutdownRequested
              || this.projectCloseDraining
            ) {
              throw Object.assign(new Error("runtime shutting down"), {
                code: "SHUTDOWN",
              });
            }
            await this.executePendingUpload(projectUuid);
          },
        },
      });
    } catch {
      // 续传失败不阻断登录；任务保留在队列
    } finally {
      // 无论成功失败都关闭本轮打开的队列句柄。
      try {
        queue.close();
      } catch {
        // ignore
      }
    }
  }

  /**
   * 复用现有 PersonalProjectSync 完整上传协议（begin → 对象上传 → confirm → commit）。
   * 远端 commit 确认前不得由调用方 mark complete。
   */
  private async executePendingUpload(projectUuid: string): Promise<void> {
    if (!this.session || !this.remote || !this.online) {
      throw Object.assign(new Error("云端存储暂不可用"), {
        code: "STORAGE_UNAVAILABLE",
      });
    }
    const normalized = projectUuid.toLowerCase();
    const catalogItem = this.catalog.get(normalized) ?? this.catalog.get(projectUuid);
    if (!catalogItem) {
      throw Object.assign(new Error("项目不在当前账号目录，无法续传"), {
        code: "CONTRACT_INVALID",
      });
    }
    if (catalogItem.kind !== "personal") {
      // 团队项目由关闭时持锁发布，pending upload 队列仅服务个人项目。
      throw Object.assign(new Error("团队项目不支持离线待同步上传"), {
        code: "UNSUPPORTED_TASK_TYPE",
      });
    }

    // 打开或复用本地 runtime；closed/zombie 不得把 unchanged 当成功，必须重开
    const existing =
      this.projects.get(normalized)
      ?? this.projects.get(projectUuid)
      ?? this.projects.get(catalogItem.projectUuid);
    if (existing?.kind === "personal") {
      const sync = existing.sync as PersonalProjectSync;
      if (typeof sync.isTerminalClosed === "function" && sync.isTerminalClosed()) {
        try {
          existing.local.close();
        } catch {
          // ignore
        }
        this.projects.delete(normalized);
        this.projects.delete(projectUuid);
        this.projects.delete(catalogItem.projectUuid);
      }
    }
    if (
      !this.projects.has(normalized)
      && !this.projects.has(projectUuid)
      && !this.projects.has(catalogItem.projectUuid)
    ) {
      await this.openProject(this.session, catalogItem.projectUuid);
    }
    const runtime =
      this.projects.get(normalized)
      ?? this.projects.get(projectUuid)
      ?? this.projects.get(catalogItem.projectUuid);
    if (!runtime || runtime.kind !== "personal") {
      throw Object.assign(new Error("个人项目运行时未就绪"), {
        code: "CONTRACT_INVALID",
      });
    }
    runtime.local.dirty = true;
    const result = await this.runPersonalSyncAndFinalize(catalogItem.projectUuid, "manual");
    if (result.state === "offline_pending") {
      throw Object.assign(new Error("离线无法完成上传"), { code: "NETWORK_OFFLINE" });
    }
    if (result.state === "unchanged" && runtime.local.dirty) {
      // 中文注释：脏数据却 unchanged 视为未真正上传，保留 retry
      throw Object.assign(new Error("待同步上传未真正提交远端"), {
        code: "STORAGE_UNAVAILABLE",
      });
    }
  }

  /**
   * 扫描账号 projects 目录，发现 journal-only pending（无 sidecar 也会入列）。
   */
  private listJournalOnlyPendingProjectUuids(userSegment: string): string[] {
    const projectsRoot = path.join(
      this.dataRoot,
      "runtime-users",
      userSegment,
      "projects",
    );
    if (!fs.existsSync(projectsRoot)) return [];
    const out: string[] = [];
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const name of fs.readdirSync(projectsRoot)) {
      if (!uuidRe.test(name)) continue;
      const dbPath = path.join(projectsRoot, name, "project.sqlite");
      const probe = probeProjectMutationJournal(dbPath);
      if ((!probe.ok && probe.pending) || (probe.ok && probe.pending)) {
        out.push(name);
      }
    }
    return out;
  }

  /**
   * 严格退出/切号前发现并重开所有持久同步事实。
   *
   * 中文注释：项目运行时 map 只是进程内视图；下列磁盘事实才是崩溃恢复权威：
   * Personal queue、mutation sidecar、project journal、Team checkpoint/release receipt。
   * 任一事实无法归属目录、无法重开或重开后类型不一致，都必须阻断退出，禁止假成功。
   */
  private async openDurablePendingProjectsForCentralClose(
    sharedQueue?: SyncQueue,
  ): Promise<void> {
    const identity = this.currentStorageIdentity();
    if (!identity) return;
    const segment = userStorageSegment(identity);
    const pendingSources = new Map<string, Set<string>>();
    const addPending = (projectUuid: string, source: string): void => {
      const normalized = projectUuid.toLowerCase();
      const sources = pendingSources.get(normalized) ?? new Set<string>();
      sources.add(source);
      pendingSources.set(normalized, sources);
    };

    let ownedQueue: SyncQueue | undefined;
    const queue = sharedQueue ?? (ownedQueue = openUserSyncQueue(this.dataRoot, identity));
    try {
      for (const projectUuid of queue.listRecoverableUploadProjectUuids()) {
        const item = this.catalog.get(projectUuid)
          ?? this.catalog.get(projectUuid.toLowerCase());
        if (item?.kind === "team") {
          // 中文注释：历史误入 Personal 队列的 Team 由 Team receipt/journal 决定恢复；
          // 先终止错误任务，禁止它越权走 Personal 上传协议。
          queue.terminalizeActiveUploadsForProject(projectUuid, "UNSUPPORTED_TASK_TYPE");
          continue;
        }
        addPending(projectUuid, "personal_queue");
      }
      for (const intent of listPendingLegacyMutationIntents(
        this.dataRoot,
        segment,
        { failClosed: true },
      )) {
        addPending(intent.projectUuid, "mutation_sidecar");
      }
      for (const projectUuid of this.listJournalOnlyPendingProjectUuids(segment)) {
        addPending(projectUuid, "mutation_journal");
      }
      for (const projectUuid of listTeamCheckpointReceiptProjectUuids(this.dataRoot, segment)) {
        addPending(projectUuid, "team_checkpoint_receipt");
      }
      for (const projectUuid of listTeamReleaseReceiptProjectUuids(this.dataRoot, segment)) {
        addPending(projectUuid, "team_release_receipt");
      }
    } finally {
      ownedQueue?.close();
    }

    if (pendingSources.size === 0) return;
    const allProjectUuids = new Set(
      [...this.projects.keys(), ...pendingSources.keys()].map((uuid) => uuid.toLowerCase()),
    );
    reportSyncProgress({ totalProjects: allProjectUuids.size });

    // 中文注释：生产 openProject 会初始化项目 SQLite/工作区，必须显式绑定旧账号 ALS；
    // 退出生命周期本身不保证仍处于某个 HTTP 请求上下文。
    await runWithUserStorage(identity, async () => {
      for (const [projectUuid, sources] of [...pendingSources.entries()]
        .sort(([left], [right]) => left.localeCompare(right))) {
        const item = this.catalog.get(projectUuid)
          ?? [...this.catalog.values()].find(
            (candidate) => candidate.projectUuid.toLowerCase() === projectUuid,
          );
        if (!item) {
          throw Object.assign(
            new Error(`待同步项目不在当前账号目录，禁止退出：${projectUuid}`),
            { code: "PENDING_PROJECT_NOT_IN_CATALOG", projectUuid },
          );
        }
        const hasTeamReceipt = sources.has("team_checkpoint_receipt")
          || sources.has("team_release_receipt");
        if (hasTeamReceipt && item.kind !== "team") {
          throw Object.assign(
            new Error(`团队同步凭据与项目类型不一致，禁止退出：${projectUuid}`),
            { code: "PENDING_PROJECT_KIND_MISMATCH", projectUuid },
          );
        }

        if (
          item.kind === "personal"
          && sources.has("personal_queue")
          && !sources.has("mutation_sidecar")
          && !sources.has("mutation_journal")
        ) {
          // 中文注释：旧版本可能只留下 Personal upload queue。它同样证明本地内容尚未完成中央提交，
          // 必须先升级为当前 sidecar 保护事实，再调用 openProject；否则 openProject 可能先安装远端版本，
          // 覆盖这份等待上传的本地项目。sidecar 只会在中央成功 finalize 后清理。
          recordPendingLegacyMutationIntent({
            dataRoot: this.dataRoot,
            userSegment: segment,
            projectUuid: item.projectUuid,
            kind: "personal",
            source: "pendingQueueRecovery",
          });
          sources.add("mutation_sidecar");
        }

        const existing = this.projects.get(item.projectUuid)
          ?? this.projects.get(projectUuid);
        if (existing) {
          if (sources.has("mutation_sidecar") || sources.has("mutation_journal")) {
            this.reapplyPendingLegacyMutation(item.projectUuid);
          }
          continue;
        }

        try {
          await this.openProject(this.session, item.projectUuid);
        } catch (cause) {
          throw Object.assign(
            new Error(
              cause instanceof Error
                ? cause.message
                : `待同步项目恢复失败，禁止退出：${item.projectUuid}`,
            ),
            {
              code: (cause as { code?: string } | undefined)?.code
                ?? "PENDING_PROJECT_OPEN_FAILED",
              projectUuid: item.projectUuid,
              cause,
            },
          );
        }
        const opened = this.projects.get(item.projectUuid)
          ?? this.projects.get(item.projectUuid.toLowerCase());
        if (!opened || opened.kind !== item.kind) {
          throw Object.assign(
            new Error(`待同步项目恢复结果无效，禁止退出：${item.projectUuid}`),
            { code: "PENDING_PROJECT_OPEN_INVALID", projectUuid: item.projectUuid },
          );
        }
        if (sources.has("mutation_sidecar") || sources.has("mutation_journal")) {
          this.reapplyPendingLegacyMutation(item.projectUuid);
        }
      }
    });
  }

  /** 先禁止重新调度，再等待已进入的密钥恢复；可由全局关闭装配在最终同步前调用。 */
  async stopBackgroundWork(): Promise<void> {
    this.acceptingKeyRecovery = false;
    this.clearKeyRetryTimer();
    this.clearPendingSyncRetryTimer();
    if (this.keyRecoveryInFlight) await this.keyRecoveryInFlight;
    // 等待在途续传消费者结束，避免 shutdown 后仍写队列。
    if (this.pendingSyncResumeInFlight) {
      await this.pendingSyncResumeInFlight.catch(() => undefined);
    }
    const profileCalibration = this.profileSync?.currentReconcile();
    if (profileCalibration) await profileCalibration.catch(() => undefined);
  }

  backgroundWorkSnapshot(): {
    acceptingKeyRecovery: boolean;
    keyRecoveryInFlight: boolean;
    keyRetryTimerActive: boolean;
  } {
    return {
      acceptingKeyRecovery: this.acceptingKeyRecovery,
      keyRecoveryInFlight: Boolean(this.keyRecoveryInFlight),
      keyRetryTimerActive: Boolean(this.keyRetryTimer),
    };
  }

  /** 有界重试个人密钥初始化：最多 5 次，基础间隔 30s 指数退避。 */
  private scheduleKeyRecoveryRetry(userUuid: string): void {
    if (!this.acceptingKeyRecovery) return;
    this.keyRetryUserUuid = userUuid;
    if (this.keyRetryCount >= SyncCoordinator.KEY_RETRY_MAX) return;
    const retryIndex = this.keyRetryCount;
    this.keyRetryCount += 1;
    this.armKeyRecoveryRetry(userUuid, retryIndex);
  }

  /** 安装一个确定序号的 timer；账号切换回滚可恢复被清除但尚未执行的同一轮重试。 */
  private armKeyRecoveryRetry(userUuid: string, retryIndex: number): void {
    if (!this.acceptingKeyRecovery) return;
    this.keyRetryUserUuid = userUuid;
    const delay = SyncCoordinator.KEY_RETRY_BASE_MS * (2 ** retryIndex);
    this.clearKeyRetryTimer();
    this.keyRetryTimer = setTimeout(() => {
      this.keyRetryTimer = undefined;
      void this.runKeyRecoveryAttempt().catch(() => undefined);
    }, delay);
    // 不阻塞进程退出。
    this.keyRetryTimer.unref?.();
  }

  private captureKeyRecoveryRetryState(): KeyRecoveryRetryState {
    return {
      accepting: this.acceptingKeyRecovery,
      userUuid: this.keyRetryUserUuid,
      count: this.keyRetryCount,
      pending: Boolean(this.keyRetryTimer),
      inFlight: Boolean(this.keyRecoveryInFlight),
    };
  }

  /**
   * stopBackgroundWork 会等待在途恢复；这里把“在途”转换成排空后的剩余语义，
   * 避免成功恢复后误重试，也避免非重试错误被旧快照重新激活。
   */
  private retryStateAfterDrain(before: KeyRecoveryRetryState): KeyRecoveryRetryState {
    if (!before.inFlight) return before;
    const retryableAfterDrain = Boolean(
      !this.profileKey
      && this.keyRetryUserUuid
      && this.profileFailure?.retryable,
    );
    return {
      ...before,
      userUuid: retryableAfterDrain ? this.keyRetryUserUuid : undefined,
      count: this.keyRetryCount,
      pending: false,
      inFlight: retryableAfterDrain,
    };
  }

  /** 只恢复重试的业务语义，绝不复用已经 clear 的 timer 句柄。 */
  private restoreKeyRecoveryRetry(state: KeyRecoveryRetryState): void {
    this.clearKeyRetryTimer();
    this.keyRetryCount = state.count;
    this.keyRetryUserUuid = state.userUuid;
    const mayResume = state.accepting
      && !this.shutdownRequested
      && !this.shutdownState.keyRetryStopped;
    this.acceptingKeyRecovery = mayResume;
    if (!mayResume) return;
    if (this.profileKey) {
      this.keyRetryCount = 0;
      this.keyRetryUserUuid = undefined;
      return;
    }
    if (!state.userUuid) return;
    if (state.pending) {
      // count 在原 timer 安装时已经递增；回滚只重新安装同一序号，不重复消耗额度。
      this.armKeyRecoveryRetry(state.userUuid, Math.max(0, state.count - 1));
    } else if (state.inFlight) {
      // 原在途尝试已经真实执行并失败，恢复时进入下一轮有界退避。
      this.scheduleKeyRecoveryRetry(state.userUuid);
    }
  }

  private clearKeyRetryTimer(): void {
    if (this.keyRetryTimer) {
      clearTimeout(this.keyRetryTimer);
      this.keyRetryTimer = undefined;
    }
  }

  private runKeyRecoveryAttempt(): Promise<void> {
    if (!this.acceptingKeyRecovery) return Promise.resolve();
    if (this.keyRecoveryInFlight) return this.keyRecoveryInFlight;
    const attempt = this.retryKeyRecovery();
    this.keyRecoveryInFlight = attempt;
    const release = () => {
      if (this.keyRecoveryInFlight === attempt) this.keyRecoveryInFlight = undefined;
    };
    void attempt.then(release, release);
    return attempt;
  }

  private async retryKeyRecovery(): Promise<void> {
    if (!this.session || !this.remote || !this.keyRetryUserUuid) return;
    if (this.profileKey) return;
    let ownedProfileKey: Buffer | undefined;
    let ownedProfileStore: ProfileStore | undefined;
    const previousProfileSync = this.profileSync;
    try {
      const keyRecovery = this.createKeyRecoveryClient(
        this.gateway, this.session, this.deviceUuid, this.credentials,
      );
      ownedProfileKey = await keyRecovery.loadOrRecover(this.keyRetryUserUuid);
      ownedProfileStore = new ProfileStore(
        this.dataRoot,
        this.keyRetryUserUuid,
        new ProfileCrypto(this.keyRetryUserUuid, ownedProfileKey),
      );
      const identity = { issuer: this.session.serverUrl, userId: this.session.user.id };
      const profileSync = new ProfileSync(ownedProfileStore, this.remote.profileRemote(), undefined, {
        account: identity,
      });
      await prepareUserDatabase(identity);
      await runWithUserStorage(identity, async () => {
        const { bindAccountSyncBindings, prepareVendorOutboxForProfileLogin } = await import("../sync/profile-settings-adapter");
        bindAccountSyncBindings(profileSync);
        // 中文注释：密钥恢复重试同样必须先恢复本账号 outbox，禁止只修首次登录。
        await prepareVendorOutboxForProfileLogin(profileSync);
        await profileSync.login();
      });
      this.profileStore?.close();
      // 只有远端登录全部成功后才把局部资源一次性转移给协调器实例。
      this.profileStore = ownedProfileStore;
      this.profileSync = profileSync;
      this.profileKey = ownedProfileKey;
      ownedProfileStore = undefined;
      ownedProfileKey = undefined;
      this.profileFailure = undefined;
      this.keyRetryCount = 0;
      this.keyRetryUserUuid = undefined;
    } catch (error) {
      const adapter = await import("../sync/profile-settings-adapter");
      adapter.restoreAccountSyncBindings(previousProfileSync ?? null);
      if (isKeyServiceUnavailableError(error)) {
        this.profileFailure = {
          code: "KEY_SERVICE_UNAVAILABLE",
          message: "个人密钥服务暂不可用，恢复后将自动重试",
          retryable: true,
        };
        if (this.keyRetryUserUuid) this.scheduleKeyRecoveryRetry(this.keyRetryUserUuid);
        return;
      }
      // 非密钥服务错误：停止重试，等待用户下次登录。
      this.profileFailure = {
        code: "KEY_RECOVERY_FAILED",
        message: "个人配置密钥恢复失败，请重新登录后重试",
        retryable: false,
      };
      this.keyRetryUserUuid = undefined;
    } finally {
      // login/构造/旧 store 关闭任一阶段失败，都不能泄漏 SQLite 句柄或明文 key。
      try {
        ownedProfileStore?.close();
      } finally {
        ownedProfileKey?.fill(0);
      }
    }
  }

  status(session?: CentralSession): Record<string, unknown> {
    this.assertAccess(session);
    return {
      initialized: Boolean((this.session && this.remote) || this.offlineCache),
      online: this.online,
      profile: resolveProfileRuntimeStatus(this.profileSync?.status(), this.profileFailure),
      projects: [...this.projects.entries()].map(([projectUuid, runtime]) =>
        this.projectState(projectUuid, runtime)),
    };
  }

  private projectState(projectUuid: string, runtime: OpenProjectRuntime): Record<string, unknown> {
    const catalogItem = this.catalog.get(projectUuid);
    if (!catalogItem) throw new RuntimeNotFoundError("项目目录映射已失效");
    const recoveryRequired = runtime.local.listRecoveries().some((item) => !item.resolved);
    const common = {
      projectUuid,
      project: workspaceProjectDTO(catalogItem, this.localProjectId(projectUuid)),
      recoveryRequired,
      runtimeGeneration: this.activationGate.currentGeneration(projectUuid),
    };
    if (runtime.kind === "personal") {
      return {
        ...common,
        kind: "personal",
        editable: this.deviceActive,
        accessMode: recoveryRequired ? "recovery" : this.deviceActive ? "readwrite" : "readonly",
      };
    }
    const state = runtime.sync.state();
    return {
      ...common,
      kind: "team",
      ...state,
      // 恢复清单是持久事实；用户明确保留副本后，锁状态仍只读但不再卡在恢复页。
      recoveryRequired,
      accessMode: recoveryRequired
        ? "recovery"
        : state.editable ? "readwrite" : "readonly",
    };
  }

  private requireOpenProject(projectUuid: string): OpenProjectRuntime {
    const runtime = this.projects.get(projectUuid);
    if (!runtime || !this.catalog.has(projectUuid)) {
      throw new RuntimeNotFoundError("项目尚未打开或不可见");
    }
    return runtime;
  }

  private async initializeOpenedWorkspace(
    projectUuid: string,
    catalogItem: RuntimeProjectCatalogItem,
  ): Promise<void> {
    if (catalogItem.businessType === "canvas") {
      await initializeCanvasWorkspace(projectUuid);
      const { canvasExecutionRuntime } = await import("../canvas/canvas-execution-runtime");
      canvasExecutionRuntime.wake(projectUuid);
      const { resumeCanvasImportJobs } = await import("../canvas/canvas-import-export-service");
      await resumeCanvasImportJobs(projectUuid);
      return;
    }
    await this.initializeLegacyWorkspace(projectUuid, catalogItem);
  }

  private async initializeLegacyWorkspace(
    projectUuid: string,
    catalogItem: RuntimeProjectCatalogItem,
  ): Promise<void> {
    if (catalogItem.businessType !== "novel" && catalogItem.businessType !== "script" && catalogItem.businessType !== "storyboard") {
      throw new RuntimePermissionError("影视旧工作区只接受 novel、script 或 storyboard");
    }
    await initializeWorkspaceProject(projectUuid, {
      id: this.localProjectId(projectUuid),
      name: catalogItem.name,
      projectType: catalogItem.businessType,
      userId: this.session?.user.id ?? this.offlineCache?.userId ?? catalogItem.ownerUserId,
    });
  }

  private localProjectId(projectUuid: string): number {
    const mapped = this.localProjectIds.get(projectUuid.toLowerCase());
    if (!mapped) throw new RuntimeNotFoundError("本地项目 ID 映射不存在");
    return mapped;
  }

  private currentEditorModels(): Record<string, string> {
    if (!this.profileStore) return {};
    const output: Record<string, string> = {};
    for (const key of this.profileStore.listKeys()) {
      if (key.startsWith("model.") || key.startsWith("vendor.")) {
        const value = this.profileStore.get(key);
        if (value !== undefined) output[key] = value;
      }
    }
    return output;
  }

  private modelMediaResolver(remote: CentralRuntimeAdapter): ModelMediaResolver {
    return {
      signObject: (objectKey, expiresSeconds) =>
        remote.signObjectDownload(objectKey, expiresSeconds),
      stageLocalPath: async (reference, expiresSeconds) => {
        if (!this.online || !this.deviceActive || !reference.projectUuid || !reference.relativePath) {
          throw new RuntimePermissionError("本地媒体暂存必须绑定当前在线项目和活动设备");
        }
        const runtime = this.projects.get(reference.projectUuid);
        const catalogItem = this.catalog.get(reference.projectUuid);
        if (!runtime || !catalogItem || !runtime.local.current) {
          throw new RuntimePermissionError("本地媒体所属项目尚未打开");
        }
        const bytes = runtime.local.readMedia(reference.relativePath, {
          md5: reference.md5,
          size: reference.size,
        });
        const guard = runtime.kind === "team" ? runtime.sync.writeGuard() : {};
        return remote.stageModelMedia(
          reference.projectUuid,
          runtime.local.current.version,
          reference,
          bytes,
          expiresSeconds,
          guard,
        );
      },
    };
  }

  /** 返回 true 表示当前请求走离线授权。 */
  private assertAccess(session?: CentralSession): boolean {
    if (session) {
      this.assertSession(session);
      return false;
    }
    if (this.session) throw new RuntimePermissionError("缺少当前中央会话");
    this.assertOfflineBase();
    return true;
  }

  private assertSession(session: CentralSession): void {
    if (!this.session || !this.remote) throw new RuntimePermissionError("同步运行时尚未完成登录初始化");
    if (
      session.id !== this.session.id
      || session.user.id !== this.session.user.id
      || !this.deviceActive
    ) {
      throw new RuntimePermissionError("请求会话、用户或设备与当前同步运行时不匹配");
    }
  }

  private assertOfflineBase(): void {
    const cache = this.offlineCache;
    if (!cache) throw new RuntimePermissionError("本机没有有效离线授权");
    const decision = evaluateOfflineWrite(cache.grant, {
      userId: cache.userId,
      deviceUuid: this.deviceUuid,
      projectKind: "personal",
      projectOwnerId: cache.userId,
      now: new Date(),
    });
    if (!decision.allowed) throw new RuntimePermissionError(`离线写入被拒绝: ${decision.reason}`);
    this.deviceActive = true;
  }

  private assertOfflineProject(item: RuntimeProjectCatalogItem): void {
    const cache = this.offlineCache;
    if (!cache) throw new RuntimePermissionError("本机没有有效离线授权");
    const decision = evaluateOfflineWrite(cache.grant, {
      userId: cache.userId,
      deviceUuid: this.deviceUuid,
      projectKind: item.kind,
      projectOwnerId: item.ownerUserId,
      now: new Date(),
    });
    if (!decision.allowed) throw new RuntimePermissionError(`离线写入被拒绝: ${decision.reason}`);
  }

  private assertGrantUsable(grant: CachedOfflineGrant, userId: number): void {
    const decision = evaluateOfflineWrite(grant, {
      userId,
      deviceUuid: this.deviceUuid,
      projectKind: "personal",
      projectOwnerId: userId,
      now: new Date(),
    });
    if (!decision.allowed) throw new RuntimePermissionError(`设备离线授权无效: ${decision.reason}`);
  }

  private async makeTeamsReadonly(reason: string): Promise<void> {
    await Promise.all([...this.projects.values()]
      .filter((runtime): runtime is TeamRuntime => runtime.kind === "team")
      .map((runtime) => {
        if (reason === "session_invalid") return runtime.sync.onSessionInvalid();
        if (reason === "network_disconnected") return runtime.sync.onNetworkLost();
        return runtime.sync.onLockExpired();
      }));
  }

  private async refreshWriteAuthority(session: CentralSession): Promise<void> {
    try {
      const grant = await this.remote!.refreshOfflineGrant();
      this.assertGrantUsable(grant, session.user.id);
      const cache: OfflineRuntimeCache = {
        issuer: session.serverUrl,
        userId: session.user.id,
        grant,
        catalog: [...this.catalog.values()],
      };
      this.offlineGrantStore.save(cache);
      this.offlineCache = cache;
      this.deviceActive = true;
    } catch (error) {
      // 写授权每次主动核验；撤销或校验失败后不能依赖 renderer 上报网络变化。
      this.offlineGrantStore.clear();
      this.offlineCache = undefined;
      this.deviceActive = false;
      await this.makeTeamsReadonly("device_revoked");
      throw new RuntimePermissionError(
        error instanceof Error ? error.message : "设备状态核验失败",
      );
    }
  }

  /**
   * Team 严格关闭的中央成功门：publish/release → finalize journal → 最后清 receipt。
   * 中文注释：本方法只确认中央与持久化事实，不关闭本地句柄、不删除 projects；
   * 调用方必须在全部 Team 通过后再执行本地释放。
   */
  private async prepareTeamCloseForCentralSuccess(
    projectUuid: string,
    runtime: TeamRuntime,
  ): Promise<void> {
    const result = await runtime.sync.close();
    this.consumeSyncCloseResult(projectUuid, result);

    if (result.state === "recovery_required") {
      throw new Error("团队项目仍需冲突/回执恢复，禁止关闭");
    }
    const identity = this.currentStorageIdentity();
    if (!identity) {
      throw new Error("账号存储上下文不可用，无法确认团队项目同步完成");
    }
    const remaining = this.detectPendingLocalMutation(
      projectUuid,
      userStorageSegment(identity),
    );
    if (remaining.pending || remaining.journalUnreadable) {
      throw new Error("团队项目仍有未完成 mutation，禁止关闭");
    }

    if (
      result.state === "released_cleanup_pending"
      || (result.state === "published" && result.centralEvidenceConfirmed === true)
    ) {
      // 中文注释：中央成功且 journal/receipt 已严格清理，才允许投影 clean。
      runtime.local.dirty = false;
      return;
    }
    if (runtime.local.dirty) {
      // viewer/not-editable 只有在确实无本地变更时才可安全关闭。
      throw new Error(`团队项目状态 ${result.state} 未证明本地变更已同步`);
    }
  }

  /**
   * 多项目退出/切换中的单项目进度起点。
   * 中文注释：阶段和传输计数按当前项目重置，整体 completedProjects 由仓库继续保持单调。
   */
  private reportSyncProjectStarting(
    projectUuid: string,
    runtime: OpenProjectRuntime,
  ): void {
    reportSyncProgress({
      phase: "preparing",
      projectUuid,
      projectName: this.catalog.get(projectUuid)?.name,
      projectKind: runtime.kind,
      resetProjectPhase: true,
      resetTransferCounters: true,
      completedObjects: 0,
      totalObjects: 0,
      objectIndex: 0,
      objectTotal: 0,
      uploadedBytes: 0,
      totalBytes: 0,
      counts: { database: 0, image: 0, video: 0, audio: 0, other: 0 },
    });
  }

  /**
   * 重新打开已完成中央 close、但因批量流程后续失败而取消退出的 Team 项目。
   * 中文注释：旧 runtime 可能只关闭了一部分资源，也可能仍在 map 中；无论哪种情况，
   * 都先幂等关闭并移除旧实例，再走生产 openProject 重新校验权限、远端版本与团队锁。
   * 成功才从 Set 删除；失败保留 UUID，serve-lifecycle 必须保持 drain，供下次重试。
   */
  private async restorePendingTeamCloseCompensations(): Promise<void> {
    if (this.pendingTeamCloseCompensations.size === 0) return;
    const identity = this.currentStorageIdentity();
    if (!identity) {
      throw Object.assign(new Error("团队项目补偿恢复失败：缺少用户存储身份"), {
        code: "TEAM_CLOSE_COMPENSATION_FAILED",
      });
    }

    await runWithUserStorage(identity, async () => {
      for (const projectUuid of [...this.pendingTeamCloseCompensations]) {
        try {
          const existing = this.projects.get(projectUuid)
            ?? this.projects.get(projectUuid.toLowerCase());
          if (existing) {
            if (existing.kind !== "team") {
              throw new Error(`团队项目恢复类型不匹配：${projectUuid}`);
            }
            // 中文注释：local.close 幂等；若前一轮只关闭了一半，这里完成剩余资源释放。
            existing.local.close();
            this.projects.delete(projectUuid);
            this.projects.delete(projectUuid.toLowerCase());
          }

          await this.openProject(this.session, projectUuid);
          const restored = this.projects.get(projectUuid)
            ?? this.projects.get(projectUuid.toLowerCase());
          if (!restored || restored.kind !== "team") {
            throw new Error(`团队项目恢复失败：${projectUuid}`);
          }
          this.pendingTeamCloseCompensations.delete(projectUuid);
        } catch (cause) {
          throw Object.assign(new Error(`团队项目补偿恢复失败：${projectUuid}`), {
            code: "TEAM_CLOSE_COMPENSATION_FAILED",
            cause,
          });
        }
      }
    });
  }

  /**
   * 显式退出登录/切换账号前：全部项目中央同步成功后才允许销毁会话。
   * 中文注释：失败必须保留原账号会话与项目可编辑态。
   */
  async prepareExplicitLogout(session?: CentralSession): Promise<void> {
    if (session) this.assertSession(session);
    const operationId = `logout-${Date.now()}`;
    const { pauseGenerationRuntime, resumeGenerationRuntime } = await import("@/tianjiang/tasks/generation-runtime-participants");
    await pauseGenerationRuntime();
    try {
      await runWithSyncProgress(
        {
          operationId,
          intent: "logout",
          reason: "logout",
          totalProjects: this.projects.size,
        },
        () => this.closeAll({ requireCentralSuccess: true }),
      );
    } catch (error) {
      await resumeGenerationRuntime();
      throw error;
    }
  }

  private async closeAll(options?: { requireCentralSuccess?: boolean }): Promise<void> {
    const requireCentralSuccess = options?.requireCentralSuccess !== false;
    // 中文注释：必须在覆盖 this.session 前，以旧账号 identity + 旧 session.expiresAt 写旧账号 queue
    const oldIdentity = this.currentStorageIdentity();
    const oldSessionExpiresAt = this.resolveSessionExpiresAtMs();
    const oldQueue = !requireCentralSuccess && oldIdentity
      ? openUserSyncQueue(this.dataRoot, oldIdentity)
      : undefined;
    const disposedPersonalProjectUuids = new Set<string>();
    const teamReadyForLocalClose: Array<{
      projectUuid: string;
      runtime: TeamRuntime;
    }> = [];
    let completedProjectCount = 0;
    const reportProjectCompleted = (
      projectUuid: string,
      runtime: OpenProjectRuntime,
    ): void => {
      completedProjectCount += 1;
      reportSyncProgress({
        completedProjects: completedProjectCount,
        projectUuid,
        projectName: this.catalog.get(projectUuid)?.name,
        projectKind: runtime.kind,
      });
    };
    try {
      // 中文注释：切换账号前仍处于旧身份，先恢复上次取消切换留下的 Team 补偿事实。
      await this.restorePendingTeamCloseCompensations();
      if (requireCentralSuccess) {
        // 中文注释：切换账号与显式退出同样不能只检查打开中的项目；
        // 先把旧账号磁盘上的待同步事实重开，再进入既有中央成功关闭状态机。
        await this.openDurablePendingProjectsForCentralClose(oldQueue);
      }
      // 中文注释：先完成 Personal 中央提交；若后续 Team 失败，catch 会用生产 openProject 恢复。
      for (const [projectUuid, runtime] of [...this.projects]) {
        if (runtime.kind !== "personal") continue;
        this.reportSyncProjectStarting(projectUuid, runtime);
        const settled = await this.settlePersonalProjectClose(projectUuid, runtime, {
          identity: oldIdentity,
          sessionExpiresAt: oldSessionExpiresAt,
          surface: "closeAll",
          sharedQueue: oldQueue,
          requireCentralSuccess,
        });
        // 队列失败/fatal/中央未成功：阻断账号切换，保留 A 的 session/runtime
        if (!settled.allowAccountSwitch || !settled.allowSafeQuit) {
          throw new RuntimePermissionError(
            settled.message
              ?? "旧账号项目关闭失败，禁止切换账号以免丢失待同步数据",
          );
        }
        if (settled.disposed) {
          disposedPersonalProjectUuids.add(projectUuid);
          reportProjectCompleted(projectUuid, runtime);
        }
      }

      // 中文注释：Team 中央阶段全部成功后才统一 local.close/delete；
      // recovery_required、未清 mutation、finalize/receipt 或本地关闭失败均阻断账号切换。
      for (const [projectUuid, runtime] of [...this.projects]) {
        if (runtime.kind !== "team") continue;
        this.reportSyncProjectStarting(projectUuid, runtime);
        try {
          await this.prepareTeamCloseForCentralSuccess(projectUuid, runtime);
          teamReadyForLocalClose.push({ projectUuid, runtime });
        } catch (error) {
          throw Object.assign(
            new Error("团队项目同步未完成，已取消退出/切换账号"),
            { code: "TEAM_CLOSE_BLOCKED", cause: error },
          );
        }
      }
      for (const { projectUuid, runtime } of teamReadyForLocalClose) {
        try {
          runtime.local.close();
        } catch (error) {
          throw Object.assign(
            new Error("团队项目本地资源关闭失败，已取消退出/切换账号"),
            { code: "TEAM_CLOSE_BLOCKED", cause: error },
          );
        }
      }
      for (const { projectUuid, runtime } of teamReadyForLocalClose) {
        this.projects.delete(projectUuid);
        this.projects.delete(projectUuid.toLowerCase());
        reportProjectCompleted(projectUuid, runtime);
      }

      const remaining = [...this.projects.keys()];
      if (remaining.length > 0) {
        throw Object.assign(
          new Error("旧账号仍有项目未完成关闭，禁止切换账号"),
          { code: "PROJECT_CLOSE_INCOMPLETE", projectUuids: remaining },
        );
      }
    } catch (error) {
      if (
        error
        && typeof error === "object"
        && [
          "PERSONAL_CLOSE_COMPENSATION_FAILED",
          "TEAM_CLOSE_COMPENSATION_FAILED",
        ].includes((error as { code?: string }).code ?? "")
      ) {
        throw error;
      }
      if (teamReadyForLocalClose.length > 0) {
        for (const { projectUuid } of teamReadyForLocalClose) {
          this.pendingTeamCloseCompensations.add(projectUuid);
        }
        try {
          // 中文注释：账号切换已取消，所有完成中央 close 的 Team 都必须恢复为旧账号 runtime。
          await this.restorePendingTeamCloseCompensations();
        } catch (compensationError) {
          throw Object.assign(
            new Error("旧账号团队项目补偿恢复失败，禁止切换账号"),
            {
              code: "TEAM_CLOSE_COMPENSATION_FAILED",
              cause: compensationError,
              originalError: error,
            },
          );
        }
      }
      const missingPersonal = [...disposedPersonalProjectUuids]
        .filter((projectUuid) => !this.projects.has(projectUuid));
      if (missingPersonal.length > 0) {
        for (const projectUuid of missingPersonal) {
          this.pendingPersonalCloseCompensations.add(projectUuid);
        }
        try {
          // 中文注释：账号切换失败时仍处于旧账号身份，必须先恢复旧账号项目再向上抛错。
          await this.restorePendingPersonalCloseCompensations();
        } catch (compensationError) {
          throw Object.assign(
            new Error("旧账号个人项目补偿恢复失败，禁止切换账号"),
            {
              code: "PERSONAL_CLOSE_COMPENSATION_FAILED",
              cause: compensationError,
              originalError: error,
            },
          );
        }
      }
      throw error;
    } finally {
      oldQueue?.close();
    }
  }

  /**
   * 同账号冷启动的离线→在线交接：只释放离线 runtime，不触发中央提交。
   * 项目持久数据、mutation journal 与恢复事实保持原样，登录成功后由在线 openProject 重建 remote。
   */
  private closeOfflineProjectsForSameAccountLogin(): void {
    for (const [projectUuid, runtime] of [...this.projects]) {
      if (runtime.kind === "personal") {
        runtime.sync.commitTerminalDispose();
      }
      runtime.local.close();
      this.projects.delete(projectUuid);
      this.projects.delete(projectUuid.toLowerCase());
    }
  }

  private requireProfileKey(): Buffer {
    if (!this.profileKey) throw new RuntimePermissionError("个人配置密钥尚未恢复");
    return this.profileKey;
  }

  private isLoginEpochCurrent(loginEpoch: number): boolean {
    return !this.shutdownRequested && loginEpoch === this.shutdownEpoch;
  }

  private assertLoginEpochCurrent(loginEpoch: number): void {
    if (!this.isLoginEpochCurrent(loginEpoch)) {
      throw new RuntimePermissionError("同步运行时正在关闭，拒绝账号登录提交");
    }
  }
}

export interface ShutdownPhaseState {
  keyRetryStopped: boolean;
  profileFlushed: boolean;
  projectsClosed: boolean;
  profileStoreClosed: boolean;
  profileKeyCleared: boolean;
  complete: boolean;
}

export interface ShutdownPhaseActions {
  stopKeyRetry(): void | Promise<void>;
  flushProfile(): void | Promise<void>;
  closeProjects(): void | Promise<void>;
  closeProfileStore(): void | Promise<void>;
  clearProfileKey(): void | Promise<void>;
}

export function createShutdownPhaseState(): ShutdownPhaseState {
  return {
    keyRetryStopped: false,
    profileFlushed: false,
    projectsClosed: false,
    profileStoreClosed: false,
    profileKeyCleared: false,
    complete: false,
  };
}

/** 每个阶段成功后立即记账；中段失败重试只继续未完成阶段。 */
export async function executeRetryableShutdownPhases(
  state: ShutdownPhaseState,
  actions: ShutdownPhaseActions,
): Promise<void> {
  if (state.complete) return;
  if (!state.keyRetryStopped) {
    await actions.stopKeyRetry();
    state.keyRetryStopped = true;
  }
  if (!state.profileFlushed) {
    await actions.flushProfile();
    state.profileFlushed = true;
  }
  if (!state.projectsClosed) {
    await actions.closeProjects();
    state.projectsClosed = true;
  }
  if (!state.profileStoreClosed) {
    await actions.closeProfileStore();
    state.profileStoreClosed = true;
  }
  if (!state.profileKeyCleared) {
    await actions.clearProfileKey();
    state.profileKeyCleared = true;
  }
  state.complete = true;
}

/**
 * 测试/简易关闭：仅 close 本地句柄。
 * 生产协调器必须使用 consumeSyncCloseResult 编排（finalize → 最后清 receipt）。
 * 调用方若持有 Team released_cleanup_pending，禁止依赖本函数完成 mutation 清理。
 * 禁止用本函数替代生产 queue 编排。
 * close 失败时保留 map 条目供 ShutdownGate 重试；成功后才 local.close + delete。
 * Personal 第二次 close 由 closeInFlight 共享 rejection，禁止 unchanged。
 */
export async function closeRuntimeProjects(
  projects: Map<string, ClosableProjectRuntime>,
): Promise<void> {
  for (const [projectUuid, runtime] of [...projects]) {
    // 失败抛出且不删除：允许上层重试同一 runtime
    await runtime.sync.close();
    try {
      const sync = runtime.sync as { disposeTerminal?: () => void };
      sync.disposeTerminal?.();
    } catch {
      // ignore
    }
    try {
      runtime.local.close();
    } catch {
      // ignore
    }
    projects.delete(projectUuid);
  }
}

function stableUserUuid(issuer: string, userId: number): string {
  const hex = crypto
    .createHash("sha256")
    .update(`tianjiang-central-user:${issuer}:${userId}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** 每账号独立 SQLite 队列文件，禁止跨账号共享路径。 */
export function openUserSyncQueue(
  dataRoot: string,
  identity: UserStorageIdentity,
): SyncQueue {
  const queuePath = path.join(userStorageRoot(dataRoot, identity), "sync-queue.sqlite");
  return new SyncQueue(queuePath);
}

function workspaceProjectDTO(
  item: RuntimeProjectCatalogItem,
  localProjectId: number,
): Record<string, unknown> {
  return {
    id: String(localProjectId),
    // 带回中央 UUID，前端「我的项目」可过滤，避免云端项目污染本地遗留列表。
    projectUuid: item.projectUuid,
    name: item.name,
    intro: "",
    type: "",
    artStyle: null,
    videoRatio: null,
    createTime: 0,
    updatedAt: 0,
    imageModel: "",
    videoModel: "",
    projectType: item.businessType,
    imageQuality: "",
    mode: "",
    directorManual: "",
  };
}

function sanitizeCachedCatalogItem(item: RuntimeProjectCatalogItem): RuntimeProjectCatalogItem {
  if (item.businessType === "canvas" && item.kind === "team") {
    throw new RuntimePermissionError("无限画布首期不支持团队归属", "CANVAS_TEAM_SCOPE_NOT_SUPPORTED");
  }
  return {
    projectUuid: item.projectUuid,
    name: item.name,
    kind: item.kind,
    ownerUserId: item.ownerUserId,
    role: item.role,
    myRole: item.myRole,
    currentVersion: item.currentVersion,
    syncState: item.syncState,
    lastSyncedAt: item.lastSyncedAt,
    updatedAt: item.updatedAt,
    lockStatus: item.lockStatus,
    lockHolderName: item.lockHolderName,
    openMode: item.openMode,
    businessType: item.businessType,
    assetSourceProjectUuid: item.assetSourceProjectUuid ?? "",
  };
}

function offlinePersonalRemote(): PersonalRemote {
  return {
    latest: async () => {
      throw new Error("离线状态不能下载个人项目");
    },
    publish: async () => {
      throw new Error("离线状态不能发布个人项目");
    },
  };
}

function offlineTeamRemote(): TeamRemote {
  const reject = async () => {
    throw new Error("离线状态不能访问团队远端");
  };
  return {
    acquire: async () => {
      await reject();
      return undefined;
    },
    download: reject,
    publish: reject,
    release: reject,
    heartbeat: reject,
  };
}
