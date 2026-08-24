/**
 * 下次同账号启动后的真实待同步上传消费者。
 * 必须走完整 begin → 对象上传 → confirm → commit；远端 commit 前不得标记成功。
 * 不记录项目正文、密钥、签名 URL、绝对路径或原始服务端堆栈。
 */

import type { SyncQueue, SyncTask } from "./queue";
import {
  classifyPersonalCloseFailure,
  extractStableErrorCode,
} from "./shutdown-policy";

export type PendingSyncFailureClass = "retryable" | "fatal";

export interface PendingUploadExecutor {
  /**
   * 对单个项目执行完整上传协议。
   * 成功返回后由消费者 mark complete；抛错进入失败分类。
   */
  uploadProject(projectUuid: string): Promise<void>;
}

export interface PendingSyncConsumerOptions {
  queue: SyncQueue;
  executor: PendingUploadExecutor;
  /** 返回 true 表示仍可继续消费（未 shutdown / epoch 未变） */
  isActive: () => boolean;
  /** 单轮最多领取任务数，防止登录被饿死 */
  maxTasksPerRun?: number;
}

export interface PendingSyncConsumerResult {
  attempted: number;
  completed: number;
  retryable: number;
  fatal: number;
  /** 测试可见：真实执行过上传的项目 UUID 列表（有序） */
  uploadedProjectUuids: string[];
}

/**
 * 直接采用共享分类器：
 * - retryable：仅网络/超时/5xx/认证过期等白名单
 * - fatal/conflict → fatal（进入 failed，禁止无限重试）
 * 禁止默认回落 retryable。
 */
export function classifyPendingSyncFailure(error: unknown): PendingSyncFailureClass {
  const klass = classifyPersonalCloseFailure(error);
  if (klass === "retryable") return "retryable";
  return "fatal";
}

/** 给用户的安全中文摘要，不含路径/密钥/堆栈。 */
export function safePendingSyncFailureSummary(error: unknown): string {
  const klass = classifyPendingSyncFailure(error);
  if (klass === "fatal") {
    return "本地同步数据无法校验，已停止自动重试，请检查项目后手动处理";
  }
  const code = extractStableErrorCode(error);
  if (/AUTH|SESSION|401|UNAUTHORIZED/i.test(code)) {
    return "登录已失效，请重新登录后继续同步";
  }
  if (/STORAGE|平台存储/i.test(code) || /存储/i.test(String(error instanceof Error ? error.message : ""))) {
    return "云端存储暂不可用，将在稍后自动重试";
  }
  return "网络或服务暂不可用，将在稍后自动重试";
}

/**
 * 领取并执行当前账号队列中的 ready upload 任务。
 * 调用方负责打开/关闭 queue，并保证 isActive 在 shutdown epoch 变化后返回 false。
 */
export async function runPendingSyncConsumer(
  options: PendingSyncConsumerOptions,
): Promise<PendingSyncConsumerResult> {
  const maxTasks = Math.max(1, options.maxTasksPerRun ?? 8);
  const result: PendingSyncConsumerResult = {
    attempted: 0,
    completed: 0,
    retryable: 0,
    fatal: 0,
    uploadedProjectUuids: [],
  };

  // 重启后 running 必须回到 pending，才能被 claim。
  options.queue.requeueRunningAsPending();

  for (let i = 0; i < maxTasks; i += 1) {
    if (!options.isActive()) break;

    let task: SyncTask | undefined;
    try {
      task = options.queue.claimNextReady();
    } catch {
      break;
    }
    if (!task) break;
    if (task.type !== "upload") {
      // 非 upload 任务本消费者不处理：标记失败避免死循环。
      try {
        options.queue.fail(task.id, "UNSUPPORTED_TASK_TYPE", false);
      } catch {
        // ignore
      }
      result.fatal += 1;
      result.attempted += 1;
      continue;
    }

    result.attempted += 1;
    try {
      if (!options.isActive()) {
        // shutdown 后不得继续上传或写回；running 由下次启动 requeue。
        break;
      }
      await options.executor.uploadProject(task.projectUUID);
      if (!options.isActive()) {
        // 晚到成功回调：不得 complete，等待下次启动幂等续传。
        break;
      }
      options.queue.complete(task.id);
      result.completed += 1;
      result.uploadedProjectUuids.push(task.projectUUID);
    } catch (error) {
      if (!options.isActive()) break;
      const klass = classifyPendingSyncFailure(error);
      const code = extractStableErrorCode(error);
      try {
        options.queue.fail(task.id, code, klass === "retryable");
      } catch {
        // 队列已关闭等：由 isActive 保护，忽略
      }
      if (klass === "retryable") {
        result.retryable += 1;
        // 有界退避后等待 nextAttemptAt，本轮不再强行领取后续以免打满。
        break;
      }
      result.fatal += 1;
    }
  }

  return result;
}
