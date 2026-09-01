/**
 * Personal 项目关闭与待同步交接的统一状态机。
 * closeProject / ordinary shutdown / 账号切换 closeAll 必须共用本模块。
 *
 * 中文注释：dispose 与「中央同步成功」或「队列耐久落盘确认」绑定；
 * 队列任一步失败不得 pendingSync=true，不得释放 runtime。
 */
import type { SyncQueue } from "./queue";
import type { PersonalProjectSync, PersonalSyncResult } from "./personal-project-sync";
import type { UserStorageIdentity } from "../runtime/user-storage-context";
import {
  classifyPersonalCloseFailure,
  extractStableErrorCode,
  type PersonalCloseFailureClass,
} from "./shutdown-policy";

export type PersonalCloseSurface =
  | "closeProject"
  | "closeAll"
  | "ordinaryShutdown"
  | "closeRuntimeProjects";

/** 统一结果：调用方据此决定是否允许退出/账号切换 */
export type PersonalCloseResult = {
  projectUuid: string;
  /**
   * synced/unchanged：中央同步+finalize 成功，已 dispose
   * offline_pending/pending_sync：队列已耐久确认，已 dispose
   * close_blocked：fatal/队列失败/无有效会话，runtime 必须仍在
   * recovery_required：版本冲突，runtime 仍在
   */
  state:
    | "synced"
    | "unchanged"
    | "offline_pending"
    | "pending_sync"
    | "close_blocked"
    | "recovery_required";
  pendingSync?: boolean;
  queued?: boolean;
  taskId?: string;
  sessionExpiresAt?: number;
  errorCode?: string;
  message?: string;
  /** true 表示已 terminal dispose + local.close + projects.delete */
  disposed: boolean;
  /** 是否允许账号切换继续 */
  allowAccountSwitch: boolean;
  /** 是否允许普通退出 safeToQuit */
  allowSafeQuit: boolean;
};

export interface PersonalCloseRuntime {
  kind: "personal";
  local: {
    dirty: boolean;
    close(): void;
  };
  sync: PersonalProjectSync & {
    disposeTerminal?: () => void;
    commitTerminalDispose?: () => void;
    rollbackCloseAttempt?: () => void;
    resumeOpen?: () => void;
  };
}

export interface PersonalCloseDeps {
  projectUuid: string;
  runtime: PersonalCloseRuntime;
  identity: UserStorageIdentity | undefined;
  /**
   * 被关闭账号真实 CentralSession.expiresAt（毫秒）。
   * 禁止 Date.now()+7d；缺失则不得虚构。
   */
  sessionExpiresAt: number | undefined;
  dataRoot: string;
  surface: PersonalCloseSurface;
  /**
   * 正常关闭/退出/切换账号必须中央成功。
   * true 时 queued/offline_pending/retry_wait 不得 allowSafeQuit。
   */
  requireCentralSuccess?: boolean;
  /** 打开账号队列；可注入以模拟 open 失败 */
  openQueue: (dataRoot: string, identity: UserStorageIdentity) => SyncQueue;
  /** 可选：账号切换复用已打开队列 */
  sharedQueue?: SyncQueue;
  /** finalize journal/sidecar；成功路径调用 */
  consumeSyncCloseResult: (
    projectUuid: string,
    result: PersonalSyncResult,
  ) => void;
  /** 从 projects map 删除（仅 dispose 路径） */
  deleteFromProjects: (projectUuid: string) => void;
}

export const PERSONAL_CLOSE_PENDING_MESSAGE =
  "本地内容已保存，将在下次启动后继续同步";

/**
 * 耐久入队：ensure + 回读确认 projectUuid / task_type / status / sessionExpiresAt。
 * 画布关闭与个人项目共用同一 flush：超时进入 durable queue，不得直接销毁未同步库。
 * 仅允许尚未过期的 sessionExpiresAt；session_expired 不得冒充可交接成功。
 * 任一步失败抛错，调用方不得 dispose。
 */
export function durableEnsurePersonalUpload(
  queue: SyncQueue,
  projectUuid: string,
  sessionExpiresAt: number,
  errorCodeForFail?: string | { errorCodeForFail?: string; kind?: string },
): { taskId: string; sessionExpiresAt: number; status: string } {
  const options = typeof errorCodeForFail === "object" && errorCodeForFail
    ? errorCodeForFail
    : { errorCodeForFail };
  if (options.kind) {
    const { rejectIfTeamWouldEnterPersonalQueue } = require("./personal-project-sync") as typeof import("./personal-project-sync");
    rejectIfTeamWouldEnterPersonalQueue(options.kind);
  }
  const failCode = typeof errorCodeForFail === "string" ? errorCodeForFail : options.errorCodeForFail;
  errorCodeForFail = failCode;
  if (!Number.isFinite(sessionExpiresAt)) {
    throw Object.assign(new Error("同步会话过期时间无效"), {
      code: "SESSION_EXPIRES_INVALID",
    });
  }
  // 中文注释：过期会话禁止入队，否则任务永远无法 claim
  if (sessionExpiresAt <= Date.now()) {
    throw Object.assign(new Error("同步会话已过期，无法写入待同步队列"), {
      code: "SESSION_EXPIRED",
    });
  }
  const taskId = queue.ensureUploadQueued(projectUuid, sessionExpiresAt);
  if (failCode) {
    try {
      const task = queue.get(taskId);
      if (task?.status === "queued" || task?.status === "retry_wait") {
        queue.markRunning(taskId);
      }
      if (queue.get(taskId)?.status === "running") {
        queue.fail(taskId, failCode, true);
      }
    } catch {
      // fail 标记失败不取消已落库的 upload 事实；下方仍须回读
    }
  }
  const verified = queue.get(taskId);
  if (!verified) {
    throw Object.assign(new Error("队列回读失败：任务不存在"), {
      code: "QUEUE_VERIFY_FAILED",
    });
  }
  if (verified.projectUUID !== projectUuid) {
    throw Object.assign(new Error("队列回读失败：项目标识不匹配"), {
      code: "QUEUE_VERIFY_FAILED",
    });
  }
  if (verified.type !== "upload") {
    throw Object.assign(new Error("队列回读失败：任务类型不是 upload"), {
      code: "QUEUE_VERIFY_FAILED",
    });
  }
  // 中文注释：成功交接白名单不含 session_expired（不可 claim）
  const allowed = new Set(["queued", "running", "retry_wait"]);
  if (!allowed.has(verified.status)) {
    throw Object.assign(
      new Error(`队列回读失败：非法状态 ${verified.status}`),
      { code: "QUEUE_VERIFY_FAILED" },
    );
  }
  if (verified.sessionExpiresAt !== sessionExpiresAt) {
    throw Object.assign(new Error("队列回读失败：sessionExpiresAt 不匹配"), {
      code: "QUEUE_VERIFY_FAILED",
    });
  }
  return {
    taskId: verified.id,
    sessionExpiresAt: verified.sessionExpiresAt,
    status: verified.status,
  };
}

/**
 * 将 terminal dispose、本地句柄关闭、runtime 删除纳入可观察结果。
 * 任一步抛错即中止，禁止 catch 后继续删除；调用方不得记 disposed=true。
 */
export function commitDisposePersonalRuntime(deps: PersonalCloseDeps): void {
  const { runtime, projectUuid, deleteFromProjects } = deps;
  // 中文注释：先确认本地句柄关闭；失败时不得 delete，sync 仍可 rollback
  runtime.local.close();
  if (typeof runtime.sync.commitTerminalDispose === "function") {
    runtime.sync.commitTerminalDispose();
  } else if (typeof runtime.sync.disposeTerminal === "function") {
    runtime.sync.disposeTerminal();
  }
  deleteFromProjects(projectUuid);
}

export function rollbackPersonalCloseAttempt(runtime: PersonalCloseRuntime): void {
  try {
    if (typeof runtime.sync.rollbackCloseAttempt === "function") {
      runtime.sync.rollbackCloseAttempt();
    } else if (typeof runtime.sync.resumeOpen === "function") {
      runtime.sync.resumeOpen();
    }
  } catch {
    // ignore
  }
}

function blockedResult(
  projectUuid: string,
  error: unknown,
  fallbackMessage: string,
  extra?: Partial<PersonalCloseResult>,
): PersonalCloseResult {
  return {
    projectUuid,
    state: "close_blocked",
    disposed: false,
    pendingSync: false,
    allowAccountSwitch: false,
    allowSafeQuit: false,
    errorCode: extractStableErrorCode(error),
    message: error instanceof Error ? error.message : fallbackMessage,
    ...extra,
  };
}

/** attempt 阶段结果：尚未 dispose；batch 关闭用 pendingAction 做全有或全无 */
export type PersonalCloseAttemptResult = PersonalCloseResult & {
  pendingAction?: "dispose_synced" | "enqueue_and_dispose";
  enqueueErrorCode?: string;
  syncResult?: PersonalSyncResult;
};

/**
 * 仅 attemptClose + 分类，不 dispose、不入队。
 * ordinary shutdown 批量路径先收集全部 attempt，任一阻断则全部 rollback。
 */
export async function attemptPersonalProjectClose(
  deps: PersonalCloseDeps,
): Promise<PersonalCloseAttemptResult> {
  const { projectUuid, runtime } = deps;
  let syncResult: PersonalSyncResult | undefined;
  let syncError: unknown;

  try {
    syncResult = (await runtime.sync.close()) as PersonalSyncResult;
  } catch (error) {
    syncError = error;
  }

  if (syncResult && (syncResult.state === "synced" || syncResult.state === "unchanged")) {
    try {
      deps.consumeSyncCloseResult(projectUuid, syncResult);
    } catch (err) {
      rollbackPersonalCloseAttempt(runtime);
      return blockedResult(
        projectUuid,
        err,
        "同步已确认但 mutation 清理失败，请重试",
      );
    }
    return {
      projectUuid,
      state: syncResult.state,
      disposed: false,
      allowAccountSwitch: true,
      allowSafeQuit: true,
      pendingAction: "dispose_synced",
      syncResult,
    };
  }

  const offlinePending = syncResult?.state === "offline_pending";
  const failureClass: PersonalCloseFailureClass = offlinePending
    ? "retryable"
    : classifyPersonalCloseFailure(syncError ?? new Error("SYNC_ERROR"));

  if (failureClass === "conflict") {
    rollbackPersonalCloseAttempt(runtime);
    return {
      projectUuid,
      state: "recovery_required",
      disposed: false,
      pendingSync: false,
      allowAccountSwitch: false,
      allowSafeQuit: false,
      errorCode: extractStableErrorCode(syncError),
      message:
        syncError instanceof Error
          ? syncError.message
          : "个人项目远端版本已前进，请处理恢复副本",
    };
  }

  if (failureClass === "fatal") {
    rollbackPersonalCloseAttempt(runtime);
    return blockedResult(
      projectUuid,
      syncError ?? new Error("SYNC_ERROR"),
      "项目关闭时本地数据异常，请修复后重试",
    );
  }

  if (!deps.identity) {
    rollbackPersonalCloseAttempt(runtime);
    return blockedResult(
      projectUuid,
      Object.assign(new Error("缺少账号存储身份，无法写入待同步队列"), {
        code: "STORAGE_IDENTITY_MISSING",
      }),
      "缺少账号存储身份，无法写入待同步队列",
    );
  }

  const expiresAt = deps.sessionExpiresAt;
  if (
    expiresAt === undefined
    || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now()
  ) {
    rollbackPersonalCloseAttempt(runtime);
    return blockedResult(
      projectUuid,
      Object.assign(new Error("同步会话已过期或无效，请重新登录后再关闭"), {
        code: "SESSION_EXPIRED",
      }),
      "同步会话已过期或无效，请重新登录后再关闭",
    );
  }

  const errorCode = offlinePending
    ? "NETWORK_OFFLINE"
    : extractStableErrorCode(syncError);

  // 中文注释：正常关闭/退出/切换账号要求中央成功；仅入队不得 safeToQuit。
  if (deps.requireCentralSuccess) {
    rollbackPersonalCloseAttempt(runtime);
    return blockedResult(
      projectUuid,
      Object.assign(
        new Error(
          offlinePending
            ? "网络不可用，中央同步未完成，已取消关闭/退出/切换账号"
            : "中央同步未成功，已取消关闭/退出/切换账号",
        ),
        { code: offlinePending ? "CENTRAL_SYNC_REQUIRED_OFFLINE" : "CENTRAL_SYNC_REQUIRED" },
      ),
      offlinePending
        ? "网络不可用，中央同步未完成，已取消关闭/退出/切换账号"
        : "中央同步未成功，已取消关闭/退出/切换账号",
    );
  }

  return {
    projectUuid,
    state: offlinePending ? "offline_pending" : "pending_sync",
    disposed: false,
    pendingSync: false,
    allowAccountSwitch: true,
    allowSafeQuit: true,
    pendingAction: "enqueue_and_dispose",
    enqueueErrorCode: errorCode,
    message: PERSONAL_CLOSE_PENDING_MESSAGE,
    errorCode,
  };
}

/**
 * 对单项目 attempt 结果执行入队（如需）+ commitDispose。
 * dispose 失败返回 blocked，runtime 保留可重试引用。
 */
export function commitPersonalCloseAttempt(
  deps: PersonalCloseDeps,
  attempt: PersonalCloseAttemptResult,
  queue: SyncQueue | undefined,
): PersonalCloseResult {
  if (!attempt.allowSafeQuit || !attempt.pendingAction) {
    return {
      projectUuid: attempt.projectUuid,
      state: attempt.state,
      disposed: false,
      pendingSync: false,
      allowAccountSwitch: attempt.allowAccountSwitch,
      allowSafeQuit: attempt.allowSafeQuit,
      errorCode: attempt.errorCode,
      message: attempt.message,
    };
  }

  if (attempt.pendingAction === "enqueue_and_dispose") {
    if (!deps.identity || !queue) {
      rollbackPersonalCloseAttempt(deps.runtime);
      return blockedResult(
        deps.projectUuid,
        Object.assign(new Error("缺少队列，无法完成待同步交接"), {
          code: "QUEUE_MISSING",
        }),
        "缺少队列，无法完成待同步交接",
      );
    }
    const expiresAt = deps.sessionExpiresAt;
    if (
      expiresAt === undefined
      || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now()
    ) {
      rollbackPersonalCloseAttempt(deps.runtime);
      return blockedResult(
        deps.projectUuid,
        Object.assign(new Error("同步会话已过期或无效，请重新登录后再关闭"), {
          code: "SESSION_EXPIRED",
        }),
        "同步会话已过期或无效，请重新登录后再关闭",
      );
    }
    try {
      const durable = durableEnsurePersonalUpload(
        queue,
        deps.projectUuid,
        expiresAt,
        attempt.enqueueErrorCode,
      );
      try {
        commitDisposePersonalRuntime(deps);
      } catch (disposeError) {
        // 中文注释：队列已耐久，保留 pendingSync/taskId 事实，但仍阻断退出
        return {
          ...blockedResult(
            deps.projectUuid,
            Object.assign(
              disposeError instanceof Error
                ? disposeError
                : new Error(String(disposeError)),
              { code: "LOCAL_RUNTIME_CLOSE_FAILED" },
            ),
            "项目资源释放失败，runtime 已保留，请重试关闭",
          ),
          pendingSync: true,
          queued: true,
          taskId: durable.taskId,
          sessionExpiresAt: durable.sessionExpiresAt,
          errorCode: "LOCAL_RUNTIME_CLOSE_FAILED",
        };
      }
      return {
        projectUuid: deps.projectUuid,
        state: attempt.state === "offline_pending" ? "offline_pending" : "pending_sync",
        pendingSync: true,
        queued: true,
        taskId: durable.taskId,
        sessionExpiresAt: durable.sessionExpiresAt,
        disposed: true,
        allowAccountSwitch: true,
        allowSafeQuit: true,
        errorCode: attempt.enqueueErrorCode,
        message: PERSONAL_CLOSE_PENDING_MESSAGE,
      };
    } catch (queueError) {
      rollbackPersonalCloseAttempt(deps.runtime);
      return blockedResult(
        deps.projectUuid,
        queueError,
        "待同步队列写入失败，项目仍保持打开",
      );
    }
  }

  // dispose_synced
  try {
    commitDisposePersonalRuntime(deps);
  } catch (disposeError) {
    return blockedResult(
      deps.projectUuid,
      disposeError,
      "项目资源释放失败，runtime 已保留，请重试关闭",
    );
  }
  return {
    projectUuid: deps.projectUuid,
    state: attempt.state === "unchanged" ? "unchanged" : "synced",
    disposed: true,
    allowAccountSwitch: true,
    allowSafeQuit: true,
  };
}

/**
 * 单项目关闭权威入口（closeProject / 账号切换 closeAll）。
 * ordinary shutdown 批量路径应使用 attempt + 全有或全无 commit，禁止先 dispose 成功项。
 */
export async function settlePersonalProjectClose(
  deps: PersonalCloseDeps,
): Promise<PersonalCloseResult> {
  const attempt = await attemptPersonalProjectClose(deps);
  if (!attempt.allowSafeQuit || !attempt.pendingAction) {
    return attempt;
  }

  let ownQueue: SyncQueue | undefined;
  try {
    let queue: SyncQueue | undefined = deps.sharedQueue;
    if (attempt.pendingAction === "enqueue_and_dispose" && !queue) {
      if (!deps.identity) {
        rollbackPersonalCloseAttempt(deps.runtime);
        return blockedResult(
          deps.projectUuid,
          Object.assign(new Error("缺少账号存储身份，无法写入待同步队列"), {
            code: "STORAGE_IDENTITY_MISSING",
          }),
          "缺少账号存储身份，无法写入待同步队列",
        );
      }
      try {
        ownQueue = deps.openQueue(deps.dataRoot, deps.identity);
        queue = ownQueue;
      } catch (openError) {
        rollbackPersonalCloseAttempt(deps.runtime);
        return blockedResult(
          deps.projectUuid,
          openError,
          "待同步队列打开失败，项目仍保持打开",
        );
      }
    }
    return commitPersonalCloseAttempt(deps, attempt, queue);
  } finally {
    if (ownQueue) {
      try {
        ownQueue.close();
      } catch {
        // ignore
      }
    }
  }
}

/** 将统一结果映射为 closeProject HTTP/IPC 载荷 */
export function personalCloseResultToPublic(
  result: PersonalCloseResult,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    projectUuid: result.projectUuid,
    state: result.state,
  };
  if (result.pendingSync) base.pendingSync = true;
  if (result.queued) base.queued = true;
  if (result.taskId) base.taskId = result.taskId;
  if (result.sessionExpiresAt !== undefined) {
    base.sessionExpiresAt = result.sessionExpiresAt;
  }
  if (result.message) base.message = result.message;
  if (result.errorCode) base.errorCode = result.errorCode;
  if (result.disposed === false) base.runtimeRetained = true;
  return base;
}
