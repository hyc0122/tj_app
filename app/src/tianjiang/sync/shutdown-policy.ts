/**
 * 普通退出时的同步失败分类与待同步收尾策略。
 * 错误只持久化稳定错误码，不含路径/密钥/原始对象。
 *
 * 中文注释：失败分类为明确白名单——仅网络/离线/超时/5xx/认证过期为 retryable；
 * SQLite/journal/snapshot/integrity/未知默认 fatal；conflict 单独恢复语义。
 */

import type { SyncQueue } from "./queue";

export type ShutdownSyncFailureClass = "retryable" | "fatal" | "conflict";

/** 与 Shutdown 分类一致，供 PersonalCloseCoordinator 使用 */
export type PersonalCloseFailureClass = ShutdownSyncFailureClass;

export interface PendingSyncSummary {
  pendingCount: number;
  /**
   * fatal 或队列耐久失败时为 false，禁止伪装 safeToQuit。
   */
  safeToQuit: boolean;
  /** 给用户的安全提示，不含敏感细节 */
  message: string;
  blockedProjectUUIDs?: string[];
}

export const PENDING_SYNC_EXIT_MESSAGE = "本地内容已保存，将在下次启动后继续同步";
export const PENDING_SYNC_BLOCKED_MESSAGE =
  "存在无法自动恢复的本地同步错误，请修复后重试关闭";

/** 仅白名单可恢复：网络、离线、超时、明确 5xx、认证过期 */
const RETRYABLE_CODE_RE =
  /^(NETWORK|NETWORK_OFFLINE|OFFLINE|TIMEOUT|ECONN|ENOTFOUND|ETIMEDOUT|AUTH_EXPIRED|SESSION_EXPIRED|UNAUTHORIZED|HTTP_5\d\d|HTTP_401|STORAGE_UNAVAILABLE|STORAGE_NOT_CONFIGURED|AbortError)$/i;

const RETRYABLE_MESSAGE_RE =
  /NETWORK|OFFLINE|TIMEOUT|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|AbortError|平台存储|网络|超时|离线|5\d\d|AUTH_EXPIRED|SESSION_EXPIRED|UNAUTHORIZED/i;

const CONFLICT_RE =
  /PersonalProjectConflict|remote_version_advanced|版本已前进|conflict|Conflict|CONFLICT/i;

const FATAL_RE =
  /SQLITE|CORRUPT|journal|Journal|JOURNAL|snapshot|Snapshot|integrity|Integrity|manifest|Manifest|EPERM|EACCES|ENOENT|path|权限|不可读|unreadable|UNKNOWN|fatal|FATAL/i;

/**
 * Personal / shutdown 统一失败分类（白名单）。
 * - retryable：仅网络/离线/超时/5xx/认证过期
 * - conflict：版本冲突，恢复/阻断，不得冒充网络
 * - fatal：SQLite/journal/snapshot/integrity/路径/权限/未知（默认）
 */
export function classifyPersonalCloseFailure(
  error: unknown,
): PersonalCloseFailureClass {
  if (error == null) return "fatal";
  const code = extractStableErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";

  // 产品边界错误即使中文文案含“离线”，也绝不能进入网络重试队列。
  if (/^(UNSUPPORTED_TASK_TYPE|CONTRACT_INVALID)$/i.test(code)) return "fatal";

  if (
    CONFLICT_RE.test(code)
    || CONFLICT_RE.test(message)
    || CONFLICT_RE.test(name)
  ) {
    return "conflict";
  }

  if (RETRYABLE_CODE_RE.test(code) || RETRYABLE_MESSAGE_RE.test(message)) {
    // 再排除 fatal 关键字优先
    if (FATAL_RE.test(code) || FATAL_RE.test(message)) {
      // SQLITE 等优先 fatal
      if (!/^NETWORK|OFFLINE|TIMEOUT|HTTP_5|AUTH_/i.test(code)) {
        return "fatal";
      }
    }
    return "retryable";
  }

  if (FATAL_RE.test(code) || FATAL_RE.test(message) || FATAL_RE.test(name)) {
    return "fatal";
  }

  // 默认 fatal：禁止未知错误入队
  return "fatal";
}

/** @deprecated 使用 classifyPersonalCloseFailure；保留别名兼容调用点 */
export function classifyShutdownSyncFailure(
  error: unknown,
): ShutdownSyncFailureClass {
  return classifyPersonalCloseFailure(error);
}

/** 仅提取稳定短码，截断并剔除疑似密钥/路径片段。 */
export function extractStableErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; name?: unknown; status?: unknown };
    if (typeof record.code === "string" && record.code.trim()) {
      return sanitizeErrorCode(record.code);
    }
    if (typeof record.status === "number" && Number.isFinite(record.status)) {
      return `HTTP_${record.status}`;
    }
    if (typeof record.name === "string" && record.name.trim()) {
      return sanitizeErrorCode(record.name);
    }
  }
  if (error instanceof Error && error.message) {
    const token = error.message.split(/[\s:：]/)[0] ?? "SYNC_ERROR";
    return sanitizeErrorCode(token);
  }
  return "SYNC_ERROR";
}

function sanitizeErrorCode(raw: string): string {
  const cleaned = raw
    .replace(/[A-Za-z]:\\[^\s]+/g, "")
    .replace(/\/[^\s]+/g, "")
    .replace(/sk-[A-Za-z0-9]+/g, "")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+/g, "")
    .trim();
  return (cleaned || "SYNC_ERROR").slice(0, 64);
}

export interface ShutdownProjectCloseResult {
  projectUUID: string;
  outcome: "synced" | "enqueued" | "skipped" | "blocked";
  errorCode?: string;
}

/**
 * 退出阶段：仅 retryable 失败入队；fatal/conflict 阻断 safeToQuit。
 * 禁止对 fatal 无条件入队。
 */
export async function preparePendingSyncForShutdown(
  queue: SyncQueue,
  options: {
    now?: number;
    sessionExpiresAt: number;
    dirtyProjectUUIDs: string[];
    attemptProjectClose: (projectUUID: string) => Promise<void>;
    /**
     * 可选：由 PersonalCloseCoordinator 完成整段 close+入队+dispose，
     * 返回时表示该项目已处理完毕（成功/入队/阻断）。
     */
    settleProject?: (
      projectUUID: string,
    ) => Promise<{ allowSafeQuit: boolean; disposed: boolean }>;
  },
): Promise<PendingSyncSummary> {
  const now = options.now ?? Date.now();
  const blocked: string[] = [];
  let safeToQuit = true;

  for (const projectUUID of options.dirtyProjectUUIDs) {
    if (options.settleProject) {
      const settled = await options.settleProject(projectUUID);
      if (!settled.allowSafeQuit) {
        safeToQuit = false;
        blocked.push(projectUUID);
      }
      continue;
    }
    try {
      await options.attemptProjectClose(projectUUID);
    } catch (error) {
      const klass = classifyPersonalCloseFailure(error);
      const errorCode = extractStableErrorCode(error);
      if (klass === "retryable") {
        const taskId = queue.ensureUploadQueued(projectUUID, options.sessionExpiresAt);
        try {
          const task = queue.get(taskId);
          if (task?.status === "queued" || task?.status === "retry_wait") {
            queue.markRunning(taskId);
          }
          if (queue.get(taskId)?.status === "running") {
            queue.fail(taskId, errorCode, true);
          }
          // 回读确认
          const verified = queue.get(taskId);
          if (!verified || verified.projectUUID !== projectUUID) {
            safeToQuit = false;
            blocked.push(projectUUID);
          }
        } catch {
          safeToQuit = false;
          blocked.push(projectUUID);
        }
      } else {
        // fatal / conflict：禁止入队，阻断安全退出
        safeToQuit = false;
        blocked.push(projectUUID);
      }
    }
  }
  queue.requeueRunningAsPending();
  const pendingCount = queue.countPending();
  void now;
  return {
    pendingCount,
    safeToQuit,
    message: safeToQuit ? PENDING_SYNC_EXIT_MESSAGE : PENDING_SYNC_BLOCKED_MESSAGE,
    blockedProjectUUIDs: blocked.length > 0 ? blocked : undefined,
  };
}
