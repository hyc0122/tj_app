import type { Knex } from "knex";
import { AsyncLocalStorage } from "node:async_hooks";
import { currentUserStorage } from "../runtime/user-storage-context";
import { safeVendorGenerationErrorSummary } from "../storyboard/vendor-generation-safety";

const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type RemoteGenerationState =
  | "pending"
  | "completed"
  | "failed"
  | "not_found"
  | "temporary_error";

export interface RemoteGenerationResult {
  state: RemoteGenerationState;
  reason?: string;
}

export interface GenerationTaskIdentity {
  provider: string;
  remoteTaskId: string;
  projectUuid: string;
  requestDigest: string;
  taskClass?: string;
  model?: string;
  remoteStatusHint?: string;
}

export interface GenerationTaskPoller {
  /**
   * 只允许查询已有远端任务 ID；接口故意不提供 create/resubmit，防止恢复链自动重发。
   */
  poll(task: GenerationTaskIdentity): Promise<RemoteGenerationResult>;
}

type ProviderStatusAdapter = (
  remoteTaskId: string,
  task: GenerationTaskIdentity,
) => Promise<RemoteGenerationResult>;

const providerAdapters = new Map<string, ProviderStatusAdapter>();
const captureStorage = new AsyncLocalStorage<{
  provider: string;
  attach(remoteTaskId: string, remoteStatusHint?: string): Promise<void>;
}>();

export function runWithGenerationTaskCapture<T>(
  provider: string,
  attach: (remoteTaskId: string, remoteStatusHint?: string) => Promise<void>,
  run: () => T,
): T {
  return captureStorage.run({ provider, attach }, run);
}

export async function captureCurrentGenerationTask(
  provider: string,
  remoteTaskId: string,
  remoteStatusHint?: string,
): Promise<void> {
  const current = captureStorage.getStore();
  if (!current) return;
  if (current.provider !== provider) throw new Error("生成任务供应商上下文不匹配");
  await current.attach(remoteTaskId, remoteStatusHint);
}

/**
 * 供应商模块只能登记“查询状态”适配器，恢复器不接受创建任务函数。
 */
export function registerGenerationTaskStatusAdapter(
  provider: string,
  adapter: ProviderStatusAdapter,
): () => void {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(provider)) throw new Error("供应商标识无效");
  const key = providerAdapterKey(provider);
  providerAdapters.set(key, adapter);
  return () => {
    if (providerAdapters.get(key) === adapter) providerAdapters.delete(key);
  };
}

export const registeredGenerationTaskPoller: GenerationTaskPoller = {
  async poll(task) {
    const adapter = providerAdapters.get(providerAdapterKey(task.provider))
      ?? providerAdapters.get(task.provider);
    if (!adapter) {
      return {
        state: "temporary_error",
        reason: `供应商 ${task.provider} 未登记可信任务状态查询适配器`,
      };
    }
    return adapter(task.remoteTaskId, task);
  },
};

function providerAdapterKey(provider: string): string {
  const context = currentUserStorage();
  return context
    ? `${context.segment}:${context.projectUuid ?? "_user"}:${provider}`
    : provider;
}

interface RecoverableTaskRow extends GenerationTaskIdentity {
  id: number;
  createdAt: number;
  generationStatus: "polling" | "temporary_failure";
}

export interface GenerationRecoverySummary {
  checked: number;
  completed: number;
  pending: number;
  manualRetry: number;
}

/**
 * 恢复本地进行中的生成任务。
 * 只查询原远端 ID，临时网络错误持续保留进行中；过期任务仍禁止无限自动轮询。
 */
export async function recoverGenerationTasks(
  database: Knex,
  poller: GenerationTaskPoller,
  now = Date.now(),
): Promise<GenerationRecoverySummary> {
  const rows = await database<RecoverableTaskRow>("o_tasks")
    .where("state", "进行中")
    .whereIn("generationStatus", ["polling", "temporary_failure"])
    .whereNotNull("provider")
    .whereNotNull("remoteTaskId")
    .whereNotNull("projectUuid")
    .whereNotNull("requestDigest")
    .where((query) => query.whereNull("manualRetryRequired").orWhere("manualRetryRequired", 0))
    .select("*");
  const summary: GenerationRecoverySummary = {
    checked: 0,
    completed: 0,
    pending: 0,
    manualRetry: 0,
  };

  for (const row of rows) {
    const isExpired = now - Number(row.createdAt) > RECOVERY_WINDOW_MS;
    const isFinalProbe = isExpired;
    if (isFinalProbe && Number((row as any).recoveryAttemptedAt ?? 0) > 0) continue;
    summary.checked += 1;
    let result: RemoteGenerationResult;
    try {
      result = await poller.poll({
        provider: row.provider,
        remoteTaskId: row.remoteTaskId,
        projectUuid: row.projectUuid,
        requestDigest: row.requestDigest,
        taskClass: (row as any).taskClass,
        model: (row as any).model,
        remoteStatusHint: (row as any).remoteStatusHint,
      });
    } catch {
      result = {
        state: "temporary_error",
        reason: safeVendorGenerationErrorSummary(),
      };
    }

    const common = {
      lastPollAt: now,
      ...(isFinalProbe ? { recoveryAttemptedAt: now } : {}),
    };
    if (result.state === "completed") {
      await database("o_tasks").where("id", row.id).update({
        ...common,
        state: "已完成",
        generationStatus: "completed",
        manualRetryRequired: 0,
        reason: null,
      });
      summary.completed += 1;
      continue;
    }
    if (result.state === "failed" || result.state === "not_found") {
      await requireManualRetry(
        database,
        row.id,
        now,
        safeVendorGenerationErrorSummary(),
      );
      summary.manualRetry += 1;
      continue;
    }
    if (isFinalProbe && result.state !== "temporary_error") {
      await requireManualRetry(
        database,
        row.id,
        now,
        safeVendorGenerationErrorSummary(),
      );
      summary.manualRetry += 1;
      continue;
    }
    await database("o_tasks").where("id", row.id).update({
      lastPollAt: now,
      generationStatus: result.state === "temporary_error" ? "temporary_failure" : "polling",
      reason: result.reason ? safeVendorGenerationErrorSummary() : null,
    });
    summary.pending += 1;
  }
  return summary;
}

/**
 * 人工重试只解除“查询原 ID”门禁，不创建或替换 remoteTaskId。
 */
export async function retryExistingRemoteTask(database: Knex, taskId: number): Promise<void> {
  const row = await database("o_tasks").where("id", taskId).first();
  if (!row?.remoteTaskId || !row?.provider) throw new Error("任务不存在或缺少远端任务标识");
  await database("o_tasks").where("id", taskId).update({
    state: "进行中",
    generationStatus: "temporary_failure",
    manualRetryRequired: 0,
    recoveryAttemptedAt: null,
    reason: null,
  });
}

async function requireManualRetry(
  database: Knex,
  taskId: number,
  now: number,
  reason: string,
): Promise<void> {
  await database("o_tasks").where("id", taskId).update({
    state: "生成失败",
    generationStatus: "manual_retry",
    manualRetryRequired: 1,
    recoveryAttemptedAt: now,
    lastPollAt: now,
    reason,
  });
}
