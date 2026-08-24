import crypto from "node:crypto";

import getPath from "@/utils/getPath";
import { accountDb, db as activeDb } from "@/utils/db";
import { getStableDeviceUUID } from "@/tianjiang/auth/device";
import { runWithProjectStorage } from "@/tianjiang/runtime/user-storage-context";
import type { FinalGenerationRequest } from "@/tianjiang/storyboard/storyboard-generation-service";
import {
  assertDreaminaGenerationRequest,
  createStoryboardGenerationPreviewDigest,
  prepareDreaminaStoryboardGenerationRequest,
  readWorkbenchGenerationOrigin,
  resolveDreaminaGenerationMode,
} from "@/tianjiang/storyboard/storyboard-generation-service";
import { StoryboardService } from "@/tianjiang/storyboard/storyboard-service";

import {
  createDreaminaDispatchIdentityDigest,
  DreaminaDispatchIdentityConflictError,
  insertDreaminaDispatchInTrx,
} from "./dreamina-cli/task-store";
import { upsertPendingMutationJournalInTrx } from "@/tianjiang/runtime/legacy-mutation-journal";
import { ensureOVideoWorkbenchReadyBindingGuards } from "@/tianjiang/data/storyboard-project-migration";
import type { Knex } from "knex";

export interface AsyncMediaEnqueueInput {
  projectUuid: string;
  shotUuid: string;
  mediaType: "image" | "video";
  providerModel: string;
  mode: string;
  request?: FinalGenerationRequest;
  /** 仅限同一调用链刚由 prepareDreaminaStoryboardGenerationRequest 生成的请求。 */
  requestReferenceIdentityVerified?: boolean;
  parentTaskUuid?: string | null;
  paidBatchConfirmed: boolean;
  origin?: "storyboard" | "workbench";
}

export interface AsyncMediaEnqueueResult {
  taskUuid: string;
  status: "queued" | "recovering" | "submitting" | "submitted" | "provider_completed"
    | "postprocess_failed_retryable" | "postprocess_failed_fatal" | "completed"
    | "failed_retryable" | "failed_fatal" | "cancelled_local";
  clientOperationId: string;
}

// 26列项目批量插入在256项时约6656绑定变量，显著低于本机SQLite 32766变量上限。
export const MAX_DREAMINA_ENQUEUE_ITEMS = 256;

export class DreaminaEnqueueError extends Error {
  readonly code: string;
  readonly status: number;
  readonly data: unknown;

  constructor(code: string, message: string, status = 400, data: unknown = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

function createRecoveringEnqueueError(
  clientOperationId: string,
  taskUuids: readonly string[],
): DreaminaEnqueueError {
  return new DreaminaEnqueueError(
    "DREAMINA_ENQUEUE_RECOVERING",
    // 中文注释：跨库错误只返回恢复状态，不泄露 SQL、提示词或设备路径。
    "生成操作已受理，正在恢复本机队列",
    202,
    {
      clientOperationId,
      tasks: taskUuids.map((taskUuid) => ({
        taskUuid,
        status: "recovering" as const,
        clientOperationId,
      })),
    },
  );
}

export type DreaminaPersistedBeforeReadyHook = (input: {
  projectUuid: string;
  clientOperationId: string;
  records: Array<{
    taskUuid: string;
    item: {
      shotUuid: string;
      request: FinalGenerationRequest;
    };
  }>;
}) => Promise<void> | void;

export async function enqueueAsyncMediaTasks(input: {
  projectUuid: string;
  clientOperationId?: string;
  requestIntentDigest?: string;
  items: Array<Omit<AsyncMediaEnqueueInput, "projectUuid" | "paidBatchConfirmed">>;
  paidBatchConfirmed: boolean;
  onPersistedBeforeReady?: DreaminaPersistedBeforeReadyHook;
}): Promise<AsyncMediaEnqueueResult[]> {
  if (input.items.length === 0) {
    throw new DreaminaEnqueueError("DREAMINA_EMPTY_BATCH", "没有可提交的生成任务");
  }
  if (input.items.length > 1 && !input.paidBatchConfirmed) {
    throw new DreaminaEnqueueError(
      "DREAMINA_PAID_BATCH_CONFIRMATION_REQUIRED",
      "批量付费任务需要确认后才能写入",
    );
  }
  const confirmedAt = input.paidBatchConfirmed ? Date.now() : null;
  const projectUuid = input.projectUuid.toLowerCase();
  const clientOperationId = normalizeDreaminaClientOperationId(input.clientOperationId ?? crypto.randomUUID());
  const requestIntentDigest = input.requestIntentDigest?.toLowerCase();
  if (requestIntentDigest && !/^[a-f0-9]{64}$/.test(requestIntentDigest)) {
    throw new DreaminaEnqueueError("DREAMINA_REQUEST_INTENT_INVALID", "生成操作意图摘要无效");
  }
  if (input.items.length > MAX_DREAMINA_ENQUEUE_ITEMS) {
    throw new DreaminaEnqueueError(
      "DREAMINA_BATCH_LIMIT_EXCEEDED",
      `单次即梦生成最多提交 ${MAX_DREAMINA_ENQUEUE_ITEMS} 项`,
      400,
    );
  }
  if (requestIntentDigest) {
    const replay = await replayAcceptedDreaminaEnqueue({
      projectUuid,
      clientOperationId,
      requestIntentDigest,
      onAcceptedBeforeReady: input.onPersistedBeforeReady,
    });
    if (replay) return replay;
  }
  const storyboard = new StoryboardService(projectUuid);
  const settings = await storyboard.getSettings();
  // 中文注释：HTTP 入队阶段不得等待 CLI 登录或实时能力探测；后台调度越过执行边界前会再次严格校验。
  const shots = input.items.some((item) => !item.request) ? await storyboard.listShots() : [];
  // 中文注释：预检完整批次后再开始事务，避免后项非法时前项已经进入收费队列。
  const preparedItems = [] as Array<Omit<AsyncMediaEnqueueInput, "projectUuid" | "paidBatchConfirmed"> & {
    request: FinalGenerationRequest;
  }>;
  const referenceIdentityCache = new Map<string, { md5: string; size: number }>();
  for (const item of input.items) {
    if (item.origin === "workbench") {
      if (!item.request) {
        throw new DreaminaEnqueueError("DREAMINA_INVALID_ARGUMENT", "工作台即梦任务缺少最终请求");
      }
      if (item.request.workbenchOrigin?.origin !== "workbench") {
        throw new DreaminaEnqueueError("DREAMINA_INVALID_ARGUMENT", "工作台即梦任务缺少来源身份");
      }
      // 中文注释：工作台跳过分镜查找，但仍走同一套模式/能力/引用合同，禁止另建调度通道。
      const mode = resolveDreaminaGenerationMode({
        mediaType: item.mediaType,
        requestedMode: item.mode,
        references: item.request.references,
        capabilityPolicy: "enqueue",
      });
      assertDreaminaGenerationRequest({
        projectUuid,
        mediaType: item.mediaType,
        providerModel: item.providerModel,
        mode,
        request: item.request,
      }, {
        verifyReferenceIdentity: item.requestReferenceIdentityVerified !== true,
        capabilityPolicy: "enqueue",
      });
      preparedItems.push({ ...item, mode, request: item.request });
      continue;
    }
    if (!item.request) {
      const shot = shots.find((candidate) => candidate.shotUuid === item.shotUuid);
      if (!shot) throw new DreaminaEnqueueError("DREAMINA_SHOT_NOT_FOUND", "生成分镜不存在", 404);
      const prepared = await prepareDreaminaStoryboardGenerationRequest({
        projectUuid,
        mediaType: item.mediaType,
        providerModel: item.providerModel,
        requestedMode: item.mode,
        settings,
        shot,
        referenceIdentityCache,
        capabilityPolicy: "enqueue",
      });
      preparedItems.push({ ...item, mode: prepared.mode, request: prepared.request });
      continue;
    }
    const baseRequest = item.request;
    const mode = resolveDreaminaGenerationMode({
      mediaType: item.mediaType,
      requestedMode: item.mode,
      references: baseRequest.references,
      capabilityPolicy: "enqueue",
    });
    const request = item.request;
    assertDreaminaGenerationRequest({
      projectUuid,
      mediaType: item.mediaType,
      providerModel: item.providerModel,
      mode,
      request,
    }, {
      verifyReferenceIdentity: item.requestReferenceIdentityVerified !== true,
      capabilityPolicy: "enqueue",
    });
    preparedItems.push({ ...item, mode, request });
  }
  return persistQueuedBatch({
    projectUuid,
    clientOperationId,
    requestIntentDigest,
    items: preparedItems,
    paidBatchConfirmed: input.paidBatchConfirmed,
    confirmedAt,
    settings,
    onPersistedBeforeReady: input.onPersistedBeforeReady,
  });
}

async function persistQueuedBatch(input: {
  projectUuid: string;
  clientOperationId: string;
  requestIntentDigest?: string;
  items: Array<Omit<AsyncMediaEnqueueInput, "projectUuid" | "paidBatchConfirmed"> & {
    request: FinalGenerationRequest;
  }>;
  paidBatchConfirmed: boolean;
  confirmedAt: number | null;
  settings: Awaited<ReturnType<StoryboardService["getSettings"]>>;
  onPersistedBeforeReady?: DreaminaPersistedBeforeReadyHook;
}): Promise<AsyncMediaEnqueueResult[]> {
  const now = Date.now();
  const originDeviceUuid = getStableDeviceUUID(getPath());
  const records = input.items.map((item, operationItemIndex) => ({
    item,
    operationItemIndex,
    taskUuid: stableTaskUuid(input.projectUuid, input.clientOperationId, operationItemIndex),
    digest: createEnqueueItemDigest({
      projectUuid: input.projectUuid,
      shotUuid: item.shotUuid,
      mediaType: item.mediaType,
      providerModel: item.providerModel,
      mode: item.mode,
      request: item.request,
      parentTaskUuid: item.parentTaskUuid ?? null,
    }),
    projectConcurrencyLimit: item.mediaType === "video"
      ? Number(input.settings.videoConcurrency) || 1
      : Number(input.settings.imageConcurrency) || 1,
    modelConcurrencyLimit: 1,
  }));
  const operationDigest = createOperationDigest({
    projectUuid: input.projectUuid,
    paidBatchConfirmed: input.paidBatchConfirmed,
    itemDigests: records.map((item) => item.digest),
  });
  const requestIntentDigest = input.requestIntentDigest ?? createEnqueueRequestIntentDigest({
    projectUuid: input.projectUuid,
    action: "internal-final",
    paidBatchConfirmed: input.paidBatchConfirmed,
    items: records.map((record) => ({ requestDigest: record.digest })),
  });
  let persisted = false;
  let lastPersistError: unknown;
  for (let attempt = 0; attempt < 3 && !persisted; attempt += 1) {
    try {
      await runWithProjectStorage(input.projectUuid, async () => {
        await activeDb.transaction(async (trx) => {
          const existing = await trx("o_storyboardGenerationOperation")
            .where({ clientOperationId: input.clientOperationId })
            .first();
          if (existing) return;
          await trx("o_storyboardGenerationOperation").insert({
            clientOperationId: input.clientOperationId,
            operationDigest,
            requestIntentDigest,
            itemCount: records.length,
            paidBatchConfirmed: input.paidBatchConfirmed ? 1 : 0,
            state: "preparing",
            createdAt: now,
            updatedAt: now,
          });
          await trx("o_storyboardGenerationTask").insert(records.map(({
            item,
            taskUuid,
            digest,
            operationItemIndex,
            projectConcurrencyLimit,
            modelConcurrencyLimit,
          }) => ({
            taskUuid,
            shotUuid: item.shotUuid,
            parentTaskUuid: item.parentTaskUuid ?? null,
            originDeviceUuid,
            mediaType: item.mediaType,
            providerId: "dreamina-cli",
            providerTaskId: null,
            providerSessionId: null,
            mode: item.mode,
            modelName: item.providerModel,
            parametersJson: JSON.stringify(item.request),
            requestDigest: digest,
            status: "queued",
            paidBatchConfirmedAt: input.confirmedAt,
            providerCompletedAt: null,
            resultLocatorDigest: null,
            progress: 0,
            errorCode: null,
            errorSummary: null,
            createdAt: now,
            updatedAt: now,
            clientOperationId: input.clientOperationId,
            operationItemIndex,
            enqueueReady: 0,
            projectConcurrencyLimit,
            modelConcurrencyLimit,
          })));
          await upsertPendingMutationJournalInTrx(trx, "dreaminaEnqueue");
        });
      });
    } catch (error) {
      // 中文注释：并发首写可能遇到 SQLite busy/唯一冲突，必须在事务外重读权威 operation。
      lastPersistError = error;
    }
    let snapshot: PersistedOperationSnapshot | null = null;
    try {
      snapshot = await readPersistedOperation(input.projectUuid, input.clientOperationId);
    } catch (error) {
      lastPersistError = error;
    }
    if (snapshot) {
      assertExpectedOperation(snapshot, {
        projectUuid: input.projectUuid,
        clientOperationId: input.clientOperationId,
        operationDigest,
        requestIntentDigest,
        paidBatchConfirmed: input.paidBatchConfirmed,
        records,
      });
      persisted = true;
      break;
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
  }
  if (!persisted) {
    throw new DreaminaEnqueueError(
      "DREAMINA_BATCH_PERSIST_FAILED",
      // 中文注释：底层 SQL 可能包含最终参数，禁止把提示词或本机路径回显到 HTTP。
      lastPersistError ? "生成操作未耐久，请重试" : "生成操作未耐久",
      500,
    );
  }
  // 中文注释：工作台必须在 dispatchReady/wake 之前绑定 o_video；失败则保持 preparing。
  if (input.onPersistedBeforeReady) {
    await input.onPersistedBeforeReady({
      projectUuid: input.projectUuid,
      clientOperationId: input.clientOperationId,
      records: records.map((record) => ({
        taskUuid: record.taskUuid,
        item: {
          shotUuid: record.item.shotUuid,
          request: record.item.request,
        },
      })),
    });
  }
  let resumedResults: AsyncMediaEnqueueResult[] | null = null;
  for (let attempt = 0; attempt < 3 && !resumedResults; attempt += 1) {
    try {
      resumedResults = await resumeDreaminaEnqueueOperation({
        projectUuid: input.projectUuid,
        clientOperationId: input.clientOperationId,
      });
    } catch (error) {
      if (error instanceof DreaminaEnqueueError && error.status === 409) throw error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  if (!resumedResults) {
    // 中文注释：禁止删除补偿；preparing 操作由同 ID 重试或启动恢复前滚收敛。
    throw createRecoveringEnqueueError(
      input.clientOperationId,
      records.map(({ taskUuid }) => taskUuid),
    );
  }
  try {
    const { wakeDreaminaScheduler } = await import("./dreamina-cli/scheduler");
    // 中文注释：账号库整批提交后只唤醒一次，禁止中途领取半个批次。
    wakeDreaminaScheduler();
  } catch {
    // 调度循环未就绪时任务仍已耐久入队。
  }
  return resumedResults;
}

/**
 * 已耐久操作优先于当前可变设置/分镜/CLI 能力；同一请求意图只前滚并返回原任务。
 */
export async function replayAcceptedDreaminaEnqueue(input: {
  projectUuid: string;
  clientOperationId: string;
  requestIntentDigest: string;
  onAcceptedBeforeReady?: DreaminaPersistedBeforeReadyHook;
}): Promise<AsyncMediaEnqueueResult[] | null> {
  const projectUuid = input.projectUuid.toLowerCase();
  const clientOperationId = normalizeDreaminaClientOperationId(input.clientOperationId);
  const snapshot = await readPersistedOperation(projectUuid, clientOperationId);
  if (!snapshot) return null;
  assertPersistedOperationIntegrity(snapshot, projectUuid, clientOperationId);
  if (String(snapshot.operation.requestIntentDigest ?? "") !== input.requestIntentDigest.toLowerCase()) {
    throw new DreaminaEnqueueError(
      "DREAMINA_CLIENT_OPERATION_CONFLICT",
      "同一生成操作 ID 对应的请求意图已变化",
      409,
    );
  }
  if (input.onAcceptedBeforeReady) {
    // 中文注释：已受理的工作台重试只从耐久最终请求补齐历史绑定，不再读取 CLI、轨道或引用文件。
    await input.onAcceptedBeforeReady({
      projectUuid,
      clientOperationId,
      records: persistedHookRecords(snapshot),
    });
  }
  try {
    return await resumeDreaminaEnqueueOperation({ projectUuid, clientOperationId });
  } catch (error) {
    if (error instanceof DreaminaEnqueueError && error.status === 409) throw error;
    if (error instanceof DreaminaDispatchIdentityConflictError) {
      throw new DreaminaEnqueueError(
        "DREAMINA_CLIENT_OPERATION_CONFLICT",
        "即梦账号投影批次身份不一致",
        409,
      );
    }
    // 中文注释：只有项目库中的原 operation 仍完整且身份未变，才把账号投影异常降级为安全 202。
    const current = await readPersistedOperation(projectUuid, clientOperationId);
    if (!current) throw error;
    assertSameOperationSnapshot(snapshot, current, projectUuid, clientOperationId);
    throw createRecoveringEnqueueError(
      clientOperationId,
      current.tasks.map((task) => String(task.taskUuid)),
    );
  }
}

/**
 * 调度收费前只读复核整个已 ready 操作，确保最终参数、条目顺序与批次摘要仍是确认时的同一份内容。
 */
export async function assertAcceptedDreaminaEnqueueIntegrity(input: {
  projectUuid: string;
  clientOperationId: string;
}): Promise<void> {
  const projectUuid = input.projectUuid.toLowerCase();
  const clientOperationId = normalizeDreaminaClientOperationId(input.clientOperationId);
  const snapshot = await readPersistedOperation(projectUuid, clientOperationId);
  if (!snapshot || String(snapshot.operation.state ?? "") !== "ready") {
    throw new Error("生成操作尚未完整就绪");
  }
  assertPersistedOperationIntegrity(snapshot, projectUuid, clientOperationId);
  await assertWorkbenchVideoBindings(snapshot, projectUuid);
  if (!snapshot.tasks.every((task) => Number(task.enqueueReady) === 1)) {
    // 中文注释：批次是同一次付费确认，任一兄弟任务未 ready 时整批都不得进入供应商边界。
    throw new Error("生成操作批次尚未完整就绪");
  }
}

/** 所有入口共用同一 UUID 规范化，大小写重试归一，非法值在读取耐久状态前拒绝。 */
export function normalizeDreaminaClientOperationId(raw: unknown): string {
  const value = String(raw ?? "").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new DreaminaEnqueueError("DREAMINA_CLIENT_OPERATION_ID_INVALID", "生成操作 ID 无效", 400);
  }
  return value;
}

/** 请求意图仅保存稳定 SHA，禁止把提示词、路径或引用明文写进 operation 表。 */
export function createEnqueueRequestIntentDigest(input: {
  projectUuid: string;
  action: "generate" | "retry" | "internal-final";
  paidBatchConfirmed: boolean;
  items: readonly unknown[];
}): string {
  return crypto.createHash("sha256").update(stableJson({
    projectUuid: input.projectUuid.toLowerCase(),
    action: input.action,
    paidBatchConfirmed: input.paidBatchConfirmed,
    items: input.items,
  })).digest("hex");
}

/**
 * 把项目库的完整 operation 前滚为账号库可领取投影；任一步失败都保留耐久 preparing 状态。
 */
export async function resumeDreaminaEnqueueOperation(input: {
  projectUuid: string;
  clientOperationId: string;
}): Promise<AsyncMediaEnqueueResult[]> {
  const projectUuid = input.projectUuid.toLowerCase();
  const clientOperationId = normalizeDreaminaClientOperationId(input.clientOperationId);
  const snapshot = await readPersistedOperation(projectUuid, clientOperationId);
  if (!snapshot) throw new Error("生成操作记录不存在");
  assertPersistedOperationIntegrity(snapshot, projectUuid, clientOperationId);
  // 中文注释：启动恢复没有工作台补绑定回调；缺失或错绑必须停在 preparing，禁止投影 ready。
  await assertWorkbenchVideoBindings(snapshot, projectUuid);
  if (String(snapshot.operation.state ?? "") === "ready"
    && snapshot.tasks.every((task) => Number(task.enqueueReady) === 1)) {
    const projected = await accountDb("o_dreaminaCliDispatch")
      .where({ projectUuid, clientOperationId })
      .orderBy("operationItemIndex")
      .select();
    if (projected.length === snapshot.tasks.length
      && projected.every((row) => Boolean(row.dispatchIdentityDigest))) {
      assertProjectedBatch(snapshot, projected, projectUuid, clientOperationId);
      if (projected.every((row) => Number(row.dispatchReady) === 1)) {
        // 中文注释：完整 ready 的网络重试只读返回原集合，不刷新时间戳也不重复唤醒调度器。
        return snapshot.tasks.map((task) => ({
          taskUuid: String(task.taskUuid),
          status: persistedTaskStatus(task.status),
          clientOperationId,
        }));
      }
    }
  }
  await accountDb.transaction(async (trx) => {
    for (const task of snapshot.tasks) {
      await insertDreaminaDispatchInTrx(trx as typeof accountDb, {
        taskUuid: String(task.taskUuid),
        projectUuid,
        originDeviceUuid: String(task.originDeviceUuid),
        mediaType: task.mediaType === "video" ? "video" : "image",
        modelName: String(task.modelName),
        mode: String(task.mode),
        projectConcurrencyLimit: Math.max(1, Number(task.projectConcurrencyLimit) || 1),
        modelConcurrencyLimit: Math.max(1, Number(task.modelConcurrencyLimit) || 1),
        createdAt: Number(task.createdAt) || Date.now(),
        clientOperationId,
        operationItemIndex: Number(task.operationItemIndex),
        dispatchReady: false,
      });
    }
  });
  const beforeProjectReady = await readPersistedOperation(projectUuid, clientOperationId);
  if (!beforeProjectReady) throw new Error("生成操作记录不存在");
  assertSameOperationSnapshot(snapshot, beforeProjectReady, projectUuid, clientOperationId);
  const readyAt = Date.now();
  await runWithProjectStorage(projectUuid, async () => {
    await activeDb.transaction(async (trx) => {
      await trx("o_storyboardGenerationTask")
        .where({ clientOperationId })
        .update({ enqueueReady: 1, updatedAt: readyAt });
      await trx("o_storyboardGenerationOperation")
        .where({ clientOperationId })
        .update({ state: "ready", updatedAt: readyAt });
      // 中文注释：在同一项目事务内复核，触发器或并发写导致的删除/改绑会整体回滚 ready。
      await assertWorkbenchVideoBindings(snapshot, projectUuid, trx);
      await upsertPendingMutationJournalInTrx(trx, "dreaminaEnqueueReady");
    });
  });
  const beforeDispatchReady = await readPersistedOperation(projectUuid, clientOperationId);
  if (!beforeDispatchReady) throw new Error("生成操作记录不存在");
  assertSameOperationSnapshot(snapshot, beforeDispatchReady, projectUuid, clientOperationId);
  // 中文注释：跨库 dispatchReady 提交前再次读取权威绑定；ready 后的身份列由项目触发器保持不可漂移。
  await assertWorkbenchVideoBindings(beforeDispatchReady, projectUuid);
  await accountDb.transaction(async (trx) => {
    const projected = await trx("o_dreaminaCliDispatch")
      .where({ projectUuid, clientOperationId })
      .orderBy("operationItemIndex")
      .select();
    assertProjectedBatch(snapshot, projected, projectUuid, clientOperationId);
    for (const task of snapshot.tasks) {
      const row = projected[Number(task.operationItemIndex)];
      const safelyPrepared = String(row?.queueState ?? "") === "terminal"
        || (String(row?.queueState ?? "") === "queued" && String(row?.providerState ?? "") === "not_sent");
      // 中文注释：已付费阶段只在项目状态、供应商状态和 submitId 全部吻合时原样解隔离，绝不重建或重提。
      const safelyQuarantinedProviderStage = isSafelyQuarantinedProviderStage(task, row);
      if (Number(row?.dispatchReady) === 0 && !safelyPrepared && !safelyQuarantinedProviderStage) {
        throw new DreaminaEnqueueError(
          "DREAMINA_CLIENT_OPERATION_CONFLICT",
          "即梦账号投影状态无法安全恢复",
          409,
        );
      }
      if (Number(row?.dispatchReady) === 0 && safelyPrepared) {
        await trx("o_dreaminaCliDispatch").where({ taskUuid: task.taskUuid }).update(restoredDispatchState(task));
      }
    }
    await trx("o_dreaminaCliDispatch")
      .where({ projectUuid, clientOperationId })
      .update({ dispatchReady: 1, updatedAt: readyAt });
  });
  return snapshot.tasks.map((task) => ({
    taskUuid: String(task.taskUuid),
    status: persistedTaskStatus(task.status),
    clientOperationId,
  }));
}

type PersistedOperationSnapshot = {
  operation: Record<string, unknown>;
  tasks: Array<Record<string, unknown>>;
};

type ExpectedOperationRecord = {
  item: {
    shotUuid: string;
    mediaType: "image" | "video";
    providerModel: string;
    mode: string;
    request: FinalGenerationRequest;
    parentTaskUuid?: string | null;
  };
  operationItemIndex: number;
  taskUuid: string;
  digest: string;
};

function persistedHookRecords(snapshot: PersistedOperationSnapshot): Parameters<DreaminaPersistedBeforeReadyHook>[0]["records"] {
  return snapshot.tasks.map((task) => {
    let request: FinalGenerationRequest;
    try {
      request = JSON.parse(String(task.parametersJson ?? "")) as FinalGenerationRequest;
    } catch {
      throw new Error("生成操作最终参数损坏");
    }
    return {
      taskUuid: String(task.taskUuid ?? ""),
      item: {
        shotUuid: String(task.shotUuid ?? ""),
        request,
      },
    };
  });
}

async function assertWorkbenchVideoBindings(
  snapshot: PersistedOperationSnapshot,
  projectUuid: string,
  database?: Knex | Knex.Transaction,
): Promise<void> {
  const required = snapshot.tasks.flatMap((task) => {
    let request: FinalGenerationRequest;
    try {
      request = JSON.parse(String(task.parametersJson ?? "")) as FinalGenerationRequest;
    } catch {
      throw new Error("生成操作最终参数损坏");
    }
    const origin = readWorkbenchGenerationOrigin(request);
    return origin ? [{ taskUuid: String(task.taskUuid ?? ""), origin }] : [];
  });
  if (required.length === 0) return;
  const verify = async (projectDb: Knex | Knex.Transaction): Promise<void> => {
    if (!(await projectDb.schema.hasColumn("o_video", "generationTaskUuid"))) {
      throw workbenchVideoHistoryMissing();
    }
    await ensureOVideoWorkbenchReadyBindingGuards(projectDb);
    const rows = await projectDb("o_video")
      .whereIn("generationTaskUuid", required.map(({ taskUuid }) => taskUuid))
      .select("id", "generationTaskUuid", "projectId", "scriptId", "videoTrackId");
    for (const expected of required) {
      const matching = rows.filter((row) => String(row.generationTaskUuid ?? "") === expected.taskUuid);
      const exact = matching.length === 1
        && Number.isInteger(Number(matching[0]?.id))
        && Number(matching[0]?.id) > 0
        && Number(matching[0]?.projectId) === expected.origin.projectId
        && Number(matching[0]?.scriptId) === expected.origin.scriptId
        && Number(matching[0]?.videoTrackId) === expected.origin.trackId;
      if (!exact) throw workbenchVideoHistoryMissing();
    }
  };
  if (database) {
    await verify(database);
    return;
  }
  await runWithProjectStorage(projectUuid, () => verify(activeDb));
}

function workbenchVideoHistoryMissing(): DreaminaEnqueueError {
  return new DreaminaEnqueueError(
    "WORKBENCH_VIDEO_HISTORY_MISSING",
    "工作台历史记录缺失",
    500,
  );
}

async function readPersistedOperation(
  projectUuid: string,
  clientOperationId: string,
): Promise<PersistedOperationSnapshot | null> {
  return runWithProjectStorage(projectUuid, async () => {
    const operation = await activeDb("o_storyboardGenerationOperation")
      .where({ clientOperationId })
      .first();
    if (!operation) return null;
    const tasks = await activeDb("o_storyboardGenerationTask")
      .where({ clientOperationId })
      .orderBy("operationItemIndex")
      .select();
    return { operation, tasks } as PersistedOperationSnapshot;
  });
}

function assertExpectedOperation(
  snapshot: PersistedOperationSnapshot,
  expected: {
    projectUuid: string;
    clientOperationId: string;
    operationDigest: string;
    requestIntentDigest: string;
    paidBatchConfirmed: boolean;
    records: ExpectedOperationRecord[];
  },
): void {
  try {
    assertPersistedOperationIntegrity(snapshot, expected.projectUuid, expected.clientOperationId);
  } catch {
    throw new DreaminaEnqueueError(
      "DREAMINA_CLIENT_OPERATION_CONFLICT",
      "生成操作的耐久任务集合不一致",
      409,
    );
  }
  const exact = String(snapshot.operation.operationDigest) === expected.operationDigest
    && String(snapshot.operation.requestIntentDigest ?? "") === expected.requestIntentDigest
    && Number(snapshot.operation.itemCount) === expected.records.length
    && Number(snapshot.operation.paidBatchConfirmed) === Number(expected.paidBatchConfirmed)
    && snapshot.tasks.length === expected.records.length
    && expected.records.every((record, index) => {
      const stored = snapshot.tasks[index];
      return String(stored?.taskUuid ?? "") === record.taskUuid
        && String(stored?.requestDigest ?? "") === record.digest
        && Number(stored?.operationItemIndex ?? -1) === record.operationItemIndex
        && String(stored?.shotUuid ?? "") === record.item.shotUuid
        && String(stored?.mediaType ?? "") === record.item.mediaType
        && String(stored?.modelName ?? "") === record.item.providerModel
        && String(stored?.mode ?? "") === record.item.mode
        && String(stored?.parentTaskUuid ?? "") === String(record.item.parentTaskUuid ?? "");
    });
  if (!exact) {
    throw new DreaminaEnqueueError(
      "DREAMINA_CLIENT_OPERATION_CONFLICT",
      "同一生成操作 ID 对应的任务内容或顺序已变化",
      409,
    );
  }
}

function assertPersistedOperationIntegrity(
  snapshot: PersistedOperationSnapshot,
  requestedProjectUuid: string,
  requestedClientOperationId: string,
): void {
  const projectUuid = requestedProjectUuid.toLowerCase();
  const clientOperationId = requestedClientOperationId.toLowerCase();
  const operationState = String(snapshot.operation.state ?? "");
  const itemCount = Number(snapshot.operation.itemCount);
  const paidBatchConfirmed = Number(snapshot.operation.paidBatchConfirmed);
  if (!projectUuid
    || !clientOperationId
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clientOperationId)
    || !Number.isInteger(itemCount)
    || itemCount < 1
    || itemCount > MAX_DREAMINA_ENQUEUE_ITEMS
    || (paidBatchConfirmed !== 0 && paidBatchConfirmed !== 1)
    || (itemCount > 1 && paidBatchConfirmed !== 1)
    || (operationState !== "preparing" && operationState !== "ready")
    || String(snapshot.operation.clientOperationId ?? "").toLowerCase() !== clientOperationId
    || !/^[a-f0-9]{64}$/.test(String(snapshot.operation.requestIntentDigest ?? ""))
    || snapshot.tasks.length !== itemCount) {
    throw new Error("生成操作任务集合不完整");
  }
  const itemDigests = snapshot.tasks.map((task, index) => {
    if ((task.mediaType !== "image" && task.mediaType !== "video")
      || Number(task.operationItemIndex) !== index
      || String(task.clientOperationId ?? "").toLowerCase() !== clientOperationId
      || String(task.taskUuid ?? "") !== stableTaskUuid(projectUuid, clientOperationId, index)
      || String(task.providerId ?? "") !== "dreamina-cli") {
      throw new Error("生成操作任务身份不一致");
    }
    let request: FinalGenerationRequest;
    try {
      request = JSON.parse(String(task.parametersJson ?? "")) as FinalGenerationRequest;
    } catch {
      throw new Error("生成操作最终参数损坏");
    }
    const digest = createEnqueueItemDigest({
      projectUuid,
      shotUuid: String(task.shotUuid ?? ""),
      mediaType: task.mediaType === "video" ? "video" : "image",
      providerModel: String(task.modelName ?? ""),
      mode: String(task.mode ?? ""),
      request,
      parentTaskUuid: task.parentTaskUuid == null ? null : String(task.parentTaskUuid),
    });
    if (String(task.requestDigest ?? "") !== digest) throw new Error("生成操作摘要不一致");
    return digest;
  });
  const operationDigest = createOperationDigest({
    projectUuid,
    paidBatchConfirmed: Number(snapshot.operation.paidBatchConfirmed) === 1,
    itemDigests,
  });
  if (String(snapshot.operation.operationDigest ?? "") !== operationDigest) {
    throw new Error("生成操作批次摘要不一致");
  }
}

function assertSameOperationSnapshot(
  expected: PersistedOperationSnapshot,
  actual: PersistedOperationSnapshot,
  projectUuid: string,
  clientOperationId: string,
): void {
  assertPersistedOperationIntegrity(actual, projectUuid, clientOperationId);
  const exact = String(actual.operation.operationDigest ?? "") === String(expected.operation.operationDigest ?? "")
    && String(actual.operation.requestIntentDigest ?? "") === String(expected.operation.requestIntentDigest ?? "")
    && Number(actual.operation.itemCount) === Number(expected.operation.itemCount)
    && Number(actual.operation.paidBatchConfirmed) === Number(expected.operation.paidBatchConfirmed)
    && actual.tasks.length === expected.tasks.length
    && expected.tasks.every((task, index) => {
      const candidate = actual.tasks[index];
      return String(candidate?.taskUuid ?? "") === String(task.taskUuid ?? "")
        && String(candidate?.requestDigest ?? "") === String(task.requestDigest ?? "")
        && Number(candidate?.operationItemIndex ?? -1) === index;
    });
  if (!exact) throw new Error("生成操作在前滚期间发生变化");
}

function assertProjectedBatch(
  snapshot: PersistedOperationSnapshot,
  projected: Array<Record<string, unknown>>,
  projectUuid: string,
  clientOperationId: string,
): void {
  const exact = projected.length === snapshot.tasks.length && snapshot.tasks.every((task, index) => {
    const row = projected[index];
    return String(row?.taskUuid ?? "") === String(task.taskUuid ?? "")
      && String(row?.projectUuid ?? "").toLowerCase() === projectUuid
      && String(row?.clientOperationId ?? "").toLowerCase() === clientOperationId
      && Number(row?.operationItemIndex ?? -1) === index
      && String(row?.originDeviceUuid ?? "") === String(task.originDeviceUuid ?? "")
      && String(row?.mediaType ?? "") === String(task.mediaType ?? "")
      && String(row?.providerId ?? "") === "dreamina-cli"
      && String(row?.modelName ?? "") === String(task.modelName ?? "")
      && String(row?.mode ?? "") === String(task.mode ?? "")
      && String(row?.dispatchIdentityDigest ?? "") === createDreaminaDispatchIdentityDigest({
        taskUuid: String(row?.taskUuid ?? ""),
        projectUuid: String(row?.projectUuid ?? ""),
        originDeviceUuid: String(row?.originDeviceUuid ?? ""),
        mediaType: String(row?.mediaType ?? ""),
        providerId: String(row?.providerId ?? ""),
        modelName: String(row?.modelName ?? ""),
        mode: String(row?.mode ?? ""),
        clientOperationId: String(row?.clientOperationId ?? ""),
        operationItemIndex: Number(row?.operationItemIndex),
      });
  });
  if (!exact) {
    throw new DreaminaEnqueueError(
      "DREAMINA_CLIENT_OPERATION_CONFLICT",
      "即梦账号投影批次身份不一致",
      409,
    );
  }
}

function isSafelyQuarantinedProviderStage(
  task: Record<string, unknown>,
  row: Record<string, unknown> | undefined,
): boolean {
  if (!row) return false;
  const expected = restoredDispatchState(task);
  const queueState = String(row.queueState ?? "");
  if (queueState !== "provider_active" && queueState !== "postprocessing") return false;
  if (queueState !== String(expected.queueState ?? "")
    || String(row.providerState ?? "") !== String(expected.providerState ?? "")
    || Number(row.slotHeld) !== Number(expected.slotHeld)) {
    return false;
  }
  let providerResult: Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(row.providerResultJson ?? "")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    providerResult = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  const durableSubmitId = String(task.providerTaskId ?? "");
  const projectedSubmitId = String(providerResult.submitId ?? providerResult.submit_id ?? "");
  return durableSubmitId ? projectedSubmitId === durableSubmitId : projectedSubmitId === "";
}

function restoredDispatchState(task: Record<string, unknown>): Record<string, unknown> {
  const status = String(task.status ?? "");
  const submitId = String(task.providerTaskId ?? "");
  const updatedAt = Date.now();
  if ((status === "submitted" || status === "submitting") && submitId) {
    return {
      queueState: "provider_active",
      providerState: "running",
      slotHeld: 1,
      providerResultJson: JSON.stringify({ submitId, submit_id: submitId }),
      updatedAt,
    };
  }
  if (status === "submitted" || status === "submitting") {
    // 中文注释：提交结果未知时占槽并禁止重排队，避免恢复过程产生二次收费。
    return {
      queueState: "provider_active",
      providerState: "unknown",
      slotHeld: 1,
      providerResultJson: JSON.stringify({ message: "入队恢复：提交结果待确认，禁止自动重提" }),
      updatedAt,
    };
  }
  if (status === "provider_completed" || status === "postprocess_failed_retryable") {
    return {
      queueState: "postprocessing",
      providerState: "completed",
      slotHeld: 0,
      providerResultJson: JSON.stringify(submitId ? { submitId, submit_id: submitId } : {}),
      updatedAt,
    };
  }
  if (status === "completed" || status === "failed_fatal" || status === "failed_retryable"
    || status === "postprocess_failed_fatal" || status === "cancelled_local") {
    return {
      queueState: "terminal",
      providerState: status === "completed" ? "completed" : "failed",
      slotHeld: 0,
      providerResultJson: JSON.stringify(submitId ? { submitId, submit_id: submitId } : {}),
      updatedAt,
    };
  }
  if (status !== "queued") throw new Error("生成操作任务状态无法安全恢复");
  return {
    queueState: "queued",
    providerState: "not_sent",
    slotHeld: 0,
    updatedAt,
  };
}

function persistedTaskStatus(raw: unknown): AsyncMediaEnqueueResult["status"] {
  const status = String(raw ?? "");
  if (status === "submitting" || status === "submitted" || status === "provider_completed"
    || status === "postprocess_failed_retryable" || status === "completed"
    || status === "failed_retryable" || status === "failed_fatal"
    || status === "postprocess_failed_fatal" || status === "cancelled_local") {
    return status;
  }
  return "queued";
}

function createEnqueueItemDigest(input: {
  projectUuid: string;
  shotUuid: string;
  mediaType: "image" | "video";
  providerModel: string;
  mode: string;
  request: FinalGenerationRequest;
  parentTaskUuid?: string | null;
}): string {
  const previewDigest = createStoryboardGenerationPreviewDigest({
    projectUuid: input.projectUuid,
    shotUuid: input.shotUuid,
    mediaType: input.mediaType,
    request: input.request,
  });
  // 中文注释：任务/dispatch 身份继续绑定 execute 已验证的实时 capabilityFields。
  const capabilityFields = [...(input.request.capabilityFields ?? [])]
    .filter((field) => typeof field === "string")
    .sort();
  return crypto.createHash("sha256").update(JSON.stringify({
    previewDigest,
    providerModel: input.providerModel,
    mode: input.mode,
    parentTaskUuid: input.parentTaskUuid ?? null,
    capabilityFields,
  })).digest("hex");
}

function createOperationDigest(input: {
  projectUuid: string;
  paidBatchConfirmed: boolean;
  itemDigests: readonly string[];
}): string {
  // 中文注释：operation 只保存规范化最终任务的 SHA，不记录提示词、密钥或本机路径。
  return crypto.createHash("sha256").update(JSON.stringify({
    projectUuid: input.projectUuid.toLowerCase(),
    paidBatchConfirmed: input.paidBatchConfirmed,
    itemDigests: input.itemDigests,
  })).digest("hex");
}

export function stableDreaminaTaskUuid(
  projectUuid: string,
  clientOperationId: string,
  itemIndex: number,
): string {
  return stableTaskUuid(projectUuid, clientOperationId, itemIndex);
}

function stableTaskUuid(projectUuid: string, clientOperationId: string, itemIndex: number): string {
  const hex = crypto.createHash("sha256")
    .update(`${projectUuid}:${clientOperationId}:${itemIndex}`)
    .digest("hex");
  // 中文注释：设置 UUID v5/variant 位，稳定身份只由项目、用户操作和条目顺序决定。
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
