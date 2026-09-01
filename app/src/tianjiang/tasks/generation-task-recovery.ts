import type { Knex } from "knex";
import { AsyncLocalStorage } from "node:async_hooks";
import { currentUserStorage } from "../runtime/user-storage-context";
import { safeVendorGenerationErrorSummary } from "../storyboard/vendor-generation-safety";
import { decideDurableGenerationRecovery } from "../generation/durable-generation-worker";
import type { NormalizedGenerationArtifact } from "./generation-task-artifacts";
import { isUsableGenerationArtifact } from "./generation-task-artifacts";
import {
  assertPersistableStagingPath,
  cleanupOwnedStagingFile,
  materializeGenerationArtifact,
} from "./generation-artifact-downloader";
import {
  artifactFromResultLocator,
  locatorFromArtifact,
  parseGenerationResultLocator,
  stringifyGenerationResultLocator,
} from "./generation-result-locator";
import {
  applyGenerationBusinessFinalizer,
  installRecoveredArtifactFile,
  parseRelatedGenerationTarget,
  resolveGenerationTaskFinalizer,
  type RecoveredTaskRow,
} from "./generation-task-finalizers";

export { decideDurableGenerationRecovery };

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
  artifact?: NormalizedGenerationArtifact;
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
    const adapter = lookupProviderAdapter(task.provider);
    if (!adapter) {
      return {
        state: "temporary_error",
        reason: `供应商 ${task.provider} 未登记可信任务状态查询适配器`,
      };
    }
    return adapter(task.remoteTaskId, task);
  },
};

function lookupProviderAdapter(provider: string): ProviderStatusAdapter | undefined {
  const context = currentUserStorage();
  if (context?.projectUuid) {
    const projectScoped = providerAdapters.get(`${context.segment}:${context.projectUuid}:${provider}`);
    if (projectScoped) return projectScoped;
  }
  if (context) {
    const userScoped = providerAdapters.get(`${context.segment}:_user:${provider}`);
    if (userScoped) return userScoped;
  }
  return providerAdapters.get(provider);
}

function providerAdapterKey(provider: string): string {
  const context = currentUserStorage();
  return context
    ? `${context.segment}:${context.projectUuid ?? "_user"}:${provider}`
    : provider;
}

export function isCapturingGenerationTask(): boolean {
  return captureStorage.getStore() !== undefined;
}

interface RecoverableTaskRow extends Omit<GenerationTaskIdentity, "taskClass"> {
  id: number;
  createdAt: number;
  generationStatus: "polling" | "temporary_failure" | "pending_finalize";
  relatedObjects?: string | null;
  resultLocator?: string | null;
  taskClass?: string | null;
}

export interface GenerationFinalizeCrashHooks {
  afterVendorReturn?: () => void;
  afterFileWritten?: () => void;
  beforeBusinessCommit?: () => void;
}

let finalizeCrashHooks: GenerationFinalizeCrashHooks | undefined;

export function setGenerationFinalizeCrashHooks(hooks: GenerationFinalizeCrashHooks | null): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  finalizeCrashHooks = hooks ?? undefined;
}

export interface GenerationRecoverySummary {
  checked: number;
  completed: number;
  pending: number;
  manualRetry: number;
}

export interface GenerationRecoveryOptions {
  /** 返回 false 时保留原任务状态，不访问供应商；用于后台重试退避。 */
  shouldPoll?: (task: GenerationTaskIdentity) => boolean;
}

/**
 * 恢复本地进行中的生成任务。
 * 只查询原远端 ID，临时网络错误持续保留进行中；过期任务仍禁止无限自动轮询。
 */
export async function recoverGenerationTasks(
  database: Knex,
  poller: GenerationTaskPoller,
  now = Date.now(),
  options: GenerationRecoveryOptions = {},
): Promise<GenerationRecoverySummary> {
  const rows = await database<RecoverableTaskRow>("o_tasks")
    .where("state", "进行中")
    .whereIn("generationStatus", ["polling", "temporary_failure", "pending_finalize"])
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
    const identity: GenerationTaskIdentity = {
      provider: row.provider,
      remoteTaskId: row.remoteTaskId,
      projectUuid: row.projectUuid,
      requestDigest: row.requestDigest,
      taskClass: (row as any).taskClass,
      model: (row as any).model,
      remoteStatusHint: (row as any).remoteStatusHint,
    };
    const pendingLocator = parseGenerationResultLocator((row as RecoverableTaskRow).resultLocator);
    if (pendingLocator) {
      summary.checked += 1;
      try {
        await settleCompletedGenerationTask({
          database,
          task: {
            id: row.id,
            taskClass: (row as { taskClass?: string }).taskClass,
            relatedObjects: (row as { relatedObjects?: string }).relatedObjects,
            resultLocator: (row as RecoverableTaskRow).resultLocator,
            projectUuid: row.projectUuid,
            remoteTaskId: row.remoteTaskId,
            provider: row.provider,
          },
          artifact: artifactFromResultLocator(pendingLocator),
          now,
          lastPollPatch: { lastPollAt: now },
        });
        summary.completed += 1;
      } catch {
        await database("o_tasks").where("id", row.id).update({
          lastPollAt: now,
          generationStatus: "pending_finalize",
          state: "进行中",
          reason: safeVendorGenerationErrorSummary(),
        });
        summary.pending += 1;
      }
      continue;
    }
    // 中文注释：退避中的任务既不查询供应商，也不改写 lastPollAt/重试状态。待终结任务必须继续落盘。
    if (options.shouldPoll && !options.shouldPoll(identity)) continue;
    summary.checked += 1;
    let result: RemoteGenerationResult;
    try {
      result = await poller.poll(identity);
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
      if (!isUsableGenerationArtifact(result.artifact)) {
        await database("o_tasks").where("id", row.id).update({
          lastPollAt: now,
          generationStatus: "temporary_failure",
          reason: "生成结果尚未落库，不能标记为已完成",
        });
        summary.pending += 1;
        continue;
      }
      try {
        await settleCompletedGenerationTask({
          database,
          task: {
            id: row.id,
            taskClass: (row as { taskClass?: string }).taskClass,
            relatedObjects: (row as { relatedObjects?: string }).relatedObjects,
            projectUuid: row.projectUuid,
            remoteTaskId: row.remoteTaskId,
            provider: row.provider,
          },
          artifact: result.artifact,
          now,
          lastPollPatch: common,
        });
        summary.completed += 1;
      } catch {
        await database("o_tasks").where("id", row.id).update({
          lastPollAt: now,
          generationStatus: "pending_finalize",
          state: "进行中",
          reason: safeVendorGenerationErrorSummary(),
        });
        summary.pending += 1;
      }
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
    if (isFinalProbe) {
      // 中文注释：恢复窗口结束后任何非终态结果都必须转人工处理，不能永久占用后台运行态。
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

/**
 * 供应商成功返回后只能进入待终结；文件与业务表成功后，才在同一事务把 o_tasks 标完成。
 * 正常执行与重启恢复共用此 finalizer。
 */
export async function settleCompletedGenerationTask(input: {
  database: Knex;
  task: RecoveredTaskRow;
  artifact: NormalizedGenerationArtifact;
  now: number;
  lastPollPatch?: Record<string, unknown>;
}): Promise<void> {
  const initialLocator = locatorFromArtifact(input.artifact);
  let locatorPersisted = false;
  try {
  await persistResultLocator(input.database, input.task.id, initialLocator, {
    ...(input.lastPollPatch ?? { lastPollAt: input.now }),
    state: "进行中",
    generationStatus: "polling",
  });
  locatorPersisted = true;
  const localArtifact = await materializeGenerationArtifact(input.artifact);
  const stagedLocator = locatorFromArtifact({
    ...localArtifact,
    remoteUrl: initialLocator.remoteUrl ?? localArtifact.remoteUrl,
  });
  await persistResultLocator(input.database, input.task.id, stagedLocator, {
    ...(input.lastPollPatch ?? { lastPollAt: input.now }),
    state: "进行中",
    generationStatus: "pending_finalize",
    reason: null,
  });
  finalizeCrashHooks?.afterVendorReturn?.();

  const related = parseRelatedGenerationTarget(input.task.relatedObjects);
  const finalizer = resolveGenerationTaskFinalizer(input.task.taskClass, related);
  if (!finalizer) throw new Error("缺少任务产物终结器，不能标记为已完成");
  if (!related.relativePath) throw new Error("完成合同缺少目标相对路径");
  await installRecoveredArtifactFile(
    input.database,
    input.task.projectUuid,
    related.relativePath,
    localArtifact,
  );
  finalizeCrashHooks?.afterFileWritten?.();

  await input.database.transaction(async (trx) => {
    finalizeCrashHooks?.beforeBusinessCommit?.();
    await applyGenerationBusinessFinalizer({
      trx,
      filesDatabase: input.database,
      task: input.task,
      related,
      artifact: localArtifact,
      now: input.now,
    });
    const completedPatch: Record<string, unknown> = {
      ...(input.lastPollPatch ?? { lastPollAt: input.now }),
      state: "已完成",
      generationStatus: "completed",
      manualRetryRequired: 0,
      reason: null,
    };
    if (await hasResultLocatorColumn(trx)) {
      completedPatch.resultLocator = stringifyGenerationResultLocator({
        ...stagedLocator,
        stagingPath: undefined,
      });
    }
    await trx("o_tasks").where("id", input.task.id).update(completedPatch);
  });
  await cleanupOwnedStagingFile(stagedLocator.stagingPath);
  } catch (error) {
    if (locatorPersisted) {
      await markGenerationTaskPendingFinalize(input.database, input.task.id, input.now).catch(() => undefined);
    }
    throw error;
  }
}

async function hasResultLocatorColumn(database: Knex): Promise<boolean> {
  try {
    return await database.schema.hasColumn("o_tasks", "resultLocator");
  } catch {
    return false;
  }
}

async function persistResultLocator(
  database: Knex,
  taskId: number,
  locator: ReturnType<typeof locatorFromArtifact>,
  extra: Record<string, unknown>,
): Promise<void> {
  const patch: Record<string, unknown> = { ...extra };
  if (locator.stagingPath) assertPersistableStagingPath(locator.stagingPath);
  if (await hasResultLocatorColumn(database)) {
    patch.resultLocator = stringifyGenerationResultLocator(locator);
  }
  await database("o_tasks").where("id", taskId).update(patch);
}

export async function markGenerationTaskPendingFinalize(
  database: Knex,
  taskId: number,
  now = Date.now(),
): Promise<void> {
  await database("o_tasks").where("id", taskId).update({
    state: "进行中",
    generationStatus: "pending_finalize",
    lastPollAt: now,
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
