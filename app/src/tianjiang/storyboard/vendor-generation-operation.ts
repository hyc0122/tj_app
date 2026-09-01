import crypto from "node:crypto";
import type { DurableGenerationIdentity } from "@/tianjiang/generation/durable-generation-operation";

export type { DurableGenerationIdentity };

import { db as activeDb } from "@/utils/db";
import getPath from "@/utils/getPath";
import { getStableDeviceUUID } from "@/tianjiang/auth/device";
import { upsertPendingMutationJournalInTrx } from "@/tianjiang/runtime/legacy-mutation-journal";
import {
  createStoryboardGenerationPreviewDigest,
  type FinalGenerationRequest,
  type ProjectMediaReference,
} from "@/tianjiang/storyboard/storyboard-generation-service";
import {
  currentUserStorage,
  runWithProjectStorage,
} from "@/tianjiang/runtime/user-storage-context";
import { currentTeamWriteGuard } from "@/tianjiang/runtime/project-operation-port";

export interface PreparedVendorOperationItem {
  shotUuid: string;
  mediaType: "image" | "video";
  providerModel: string;
  mode: string;
  requestDigest: string;
  execute(candidateUuid: string): Promise<void>;
}

export interface VendorGenerationOperationTask {
  taskUuid: string;
  shotUuid: string;
  status: string;
  candidateUuid?: string;
  clientOperationId: string;
}

export type VendorGenerationOperationOutcome =
  | { httpStatus: 200; data: VendorGenerationOperationTask[] }
  | {
      httpStatus: 202;
      data: {
        clientOperationId: string;
        tasks: VendorGenerationOperationTask[];
      };
    };

export class VendorGenerationOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface PersistedVendorOperationSnapshot {
  operation: Record<string, unknown>;
  tasks: Array<Record<string, unknown>>;
  candidatesById: Map<string, Record<string, unknown>>;
}

interface InFlightVendorOperation {
  requestIntentDigest: string;
  promise: Promise<void>;
}

/** 可跨进程恢复的普通供应商任务；只允许保存最终生成合同中的白名单字段。 */
export interface DurableVendorOperationItem {
  shotUuid: string;
  mediaType: "image" | "video";
  providerModel: string;
  mode: string;
  requestDigest: string;
  request: FinalGenerationRequest;
}

const inFlightVendorOperations = new Map<string, InFlightVendorOperation>();
const DURABLE_VENDOR_OPTION_KEYS = new Set(["mode", "aspectRatio", "resolution", "durationMs"]);

/** 普通供应商也要求客户端显式提供 UUID；禁止后端静默生成导致断线重试重复收费。 */
export function normalizeVendorClientOperationId(raw: unknown): string {
  const value = String(raw ?? "").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new VendorGenerationOperationError(
      "VENDOR_CLIENT_OPERATION_ID_INVALID",
      "生成操作 ID 无效",
      400,
    );
  }
  return value;
}

/**
 * 在重建可变分镜/设置前先读取耐久操作；已完成直接重放，歧义 submitting 返回 202。
 * 同进程并发请求共享首个 Promise，外部 execute 因此最多发生一次。
 */
export async function replayVendorGenerationOperation(input: {
  projectUuid: string;
  clientOperationId: string;
  requestIntentDigest: string;
}): Promise<VendorGenerationOperationOutcome | null> {
  const snapshot = await readVendorOperationSafely(input.projectUuid, input.clientOperationId);
  if (!snapshot) return null;
  assertSameIntent(String(snapshot.operation.requestIntentDigest ?? ""), input.requestIntentDigest);
  assertVendorOperationIntegrity(input.projectUuid, input.clientOperationId, snapshot);
  if (snapshot.tasks.every(hasDurableRequestSnapshot)) {
    // 中文注释：首次提交若在事务提交后丢失 wake，同 ID 重放必须再次幂等唤醒；CAS 仍保证最多一次收费。
    scheduleDurableVendorOperation(input.projectUuid, input.clientOperationId);
  }
  return outcomeFromSnapshot(input.projectUuid, input.clientOperationId, snapshot);
}

/** 全批 staging 成功后才调用；先耐久 submitting，再执行每个收费项并收敛为 completed。 */
export async function executeVendorGenerationOperation(input: {
  projectUuid: string;
  clientOperationId: string;
  requestIntentDigest: string;
  paidBatchConfirmed: boolean;
  items: PreparedVendorOperationItem[];
}): Promise<VendorGenerationOperationOutcome> {
  if (input.items.length === 0) {
    throw new VendorGenerationOperationError("VENDOR_EMPTY_BATCH", "没有可提交的生成任务", 400);
  }
  const replay = await replayVendorGenerationOperation(input);
  if (replay) return replay;
  return executeFreshVendorOperation(input);
}

/**
 * 普通供应商统一耐久入队入口：只写 SQLite 并返回 202，prepare/stage/execute 均由后台调度器负责。
 */
export async function enqueueVendorGenerationOperation(input: {
  projectUuid: string;
  clientOperationId: string;
  requestIntentDigest: string;
  paidBatchConfirmed: boolean;
  items: DurableVendorOperationItem[];
}): Promise<VendorGenerationOperationOutcome> {
  if (input.items.length === 0) {
    throw new VendorGenerationOperationError("VENDOR_EMPTY_BATCH", "没有可提交的生成任务", 400);
  }
  const durableItems = input.items.map((item) => ({
    ...item,
    request: durableFinalRequestSnapshot(item.request),
  }));
  durableItems.forEach((item) => {
    const expectedDigest = createStoryboardGenerationPreviewDigest({
      projectUuid: input.projectUuid,
      shotUuid: item.shotUuid,
      mediaType: item.mediaType,
      request: item.request,
    });
    if (item.providerModel !== item.request.providerModel
      || item.mode !== String(item.request.options.mode ?? "")
      || item.requestDigest !== expectedDigest) {
      throw operationConflict();
    }
  });

  const replay = await replayVendorGenerationOperation(input);
  if (replay) {
    scheduleDurableVendorOperation(input.projectUuid, input.clientOperationId);
    return replay;
  }
  return enqueueFreshDurableVendorOperation({ ...input, items: durableItems });
}

async function enqueueFreshDurableVendorOperation(input: {
  projectUuid: string;
  clientOperationId: string;
  requestIntentDigest: string;
  paidBatchConfirmed: boolean;
  items: DurableVendorOperationItem[];
}): Promise<VendorGenerationOperationOutcome> {
  const now = Date.now();
  const originDeviceUuid = getStableDeviceUUID(getPath());
  const records = input.items.map((item, operationItemIndex) => ({
    item,
    operationItemIndex,
    taskUuid: stableVendorTaskUuid(input.projectUuid, input.clientOperationId, operationItemIndex),
  }));
  const operationDigest = createOperationDigest(
    input.projectUuid,
    input.paidBatchConfirmed,
    records.map((record) => record.item.requestDigest),
  );

  try {
    await runWithProjectStorage(input.projectUuid, () => activeDb.transaction(async (trx) => {
      const existing = await trx("o_storyboardGenerationOperation")
        .where({ clientOperationId: input.clientOperationId })
        .first();
      if (existing) return;
      await trx("o_storyboardGenerationOperation").insert({
        clientOperationId: input.clientOperationId,
        operationDigest,
        requestIntentDigest: input.requestIntentDigest,
        itemCount: records.length,
        paidBatchConfirmed: input.paidBatchConfirmed ? 1 : 0,
        state: "ready",
        createdAt: now,
        updatedAt: now,
      });
      await trx("o_storyboardGenerationTask").insert(records.map(({ item, operationItemIndex, taskUuid }) => ({
        taskUuid,
        shotUuid: item.shotUuid,
        parentTaskUuid: null,
        originDeviceUuid,
        mediaType: item.mediaType,
        providerId: item.providerModel.split(":", 1)[0] || "vendor",
        providerTaskId: null,
        providerSessionId: null,
        mode: item.mode,
        modelName: item.providerModel,
        // 中文注释：请求快照是后台恢复的唯一输入，绝不保存模型凭据或客户端未知字段。
        parametersJson: JSON.stringify({ requestDigest: item.requestDigest, request: item.request }),
        requestDigest: item.requestDigest,
        status: "queued",
        paidBatchConfirmedAt: input.paidBatchConfirmed ? now : null,
        providerCompletedAt: null,
        resultLocatorDigest: null,
        progress: 0,
        errorCode: null,
        errorSummary: null,
        createdAt: now,
        updatedAt: now,
        clientOperationId: input.clientOperationId,
        operationItemIndex,
        enqueueReady: 1,
        projectConcurrencyLimit: null,
        modelConcurrencyLimit: null,
      })));
      await upsertPendingMutationJournalInTrx(trx, "vendorGenerationQueued");
    }));
  } catch {
    // 中文注释：并发唯一键冲突只允许回读权威记录，禁止删除或覆盖赢家。
  }

  const persisted = await readVendorOperationSafely(input.projectUuid, input.clientOperationId);
  if (!persisted) {
    throw new VendorGenerationOperationError(
      "VENDOR_OPERATION_PERSIST_FAILED",
      "生成操作未耐久，请重试",
      500,
    );
  }
  assertSameIntent(String(persisted.operation.requestIntentDigest ?? ""), input.requestIntentDigest);
  assertVendorOperationIntegrity(input.projectUuid, input.clientOperationId, persisted, true);
  scheduleDurableVendorOperation(input.projectUuid, input.clientOperationId);
  return outcomeFromSnapshot(input.projectUuid, input.clientOperationId, persisted);
}

async function executeFreshVendorOperation(input: {
  projectUuid: string;
  clientOperationId: string;
  requestIntentDigest: string;
  paidBatchConfirmed: boolean;
  items: PreparedVendorOperationItem[];
}): Promise<VendorGenerationOperationOutcome> {
  const now = Date.now();
  const originDeviceUuid = getStableDeviceUUID(getPath());
  const records = input.items.map((item, operationItemIndex) => ({
    item,
    operationItemIndex,
    taskUuid: stableVendorTaskUuid(input.projectUuid, input.clientOperationId, operationItemIndex),
  }));
  const operationDigest = createOperationDigest(
    input.projectUuid,
    input.paidBatchConfirmed,
    records.map((record) => record.item.requestDigest),
  );

  let created = false;
  try {
    await runWithProjectStorage(input.projectUuid, () => activeDb.transaction(async (trx) => {
      const existing = await trx("o_storyboardGenerationOperation")
        .where({ clientOperationId: input.clientOperationId })
        .first();
      if (existing) return;
      await trx("o_storyboardGenerationOperation").insert({
        clientOperationId: input.clientOperationId,
        operationDigest,
        requestIntentDigest: input.requestIntentDigest,
        itemCount: records.length,
        paidBatchConfirmed: input.paidBatchConfirmed ? 1 : 0,
        state: "ready",
        createdAt: now,
        updatedAt: now,
      });
      await trx("o_storyboardGenerationTask").insert(records.map(({ item, operationItemIndex, taskUuid }) => {
        const providerId = item.providerModel.split(":", 1)[0] || "vendor";
        return {
          taskUuid,
          shotUuid: item.shotUuid,
          parentTaskUuid: null,
          originDeviceUuid,
          mediaType: item.mediaType,
          providerId,
          providerTaskId: null,
          providerSessionId: null,
          mode: item.mode,
          modelName: item.providerModel,
          // 中文注释：GREEN-A 先保留摘要身份；完整最终请求将在后台执行器阶段独立持久化。
          parametersJson: JSON.stringify({ requestDigest: item.requestDigest }),
          requestDigest: item.requestDigest,
          status: "queued",
          paidBatchConfirmedAt: input.paidBatchConfirmed ? now : null,
          providerCompletedAt: null,
          resultLocatorDigest: null,
          progress: 0,
          errorCode: null,
          errorSummary: null,
          createdAt: now,
          updatedAt: now,
          clientOperationId: input.clientOperationId,
          operationItemIndex,
          enqueueReady: 1,
          projectConcurrencyLimit: null,
          modelConcurrencyLimit: null,
        };
      }));
      await upsertPendingMutationJournalInTrx(trx, "vendorGenerationQueued");
      created = true;
    }));
  } catch {
    // 中文注释：唯一冲突可能来自另一请求/进程；只重读权威记录，绝不删除补偿。
  }

  const persisted = await readVendorOperationSafely(input.projectUuid, input.clientOperationId);
  if (!persisted) {
    throw new VendorGenerationOperationError(
      "VENDOR_OPERATION_PERSIST_FAILED",
      "生成操作未耐久，请重试",
      500,
    );
  }
  assertSameIntent(String(persisted.operation.requestIntentDigest ?? ""), input.requestIntentDigest);
  assertVendorOperationIntegrity(input.projectUuid, input.clientOperationId, persisted);
  // 中文注释：另一进程先赢得唯一 operation 时，本进程只能返回其耐久状态，禁止再次 execute。
  if (!created) return outcomeFromSnapshot(input.projectUuid, input.clientOperationId, persisted);
  if (String(persisted.operation.state ?? "") !== "ready"
    || Number(persisted.operation.itemCount) !== records.length
    || persisted.tasks.length !== records.length) {
    return outcomeFromSnapshot(input.projectUuid, input.clientOperationId, persisted);
  }
  if (persisted.tasks.some((task) => String(task.providerId ?? "") === "dreamina-cli")) {
    throw operationConflict();
  }

  const acceptedOutcome = outcomeFromSnapshot(input.projectUuid, input.clientOperationId, persisted);
  const key = operationKey(input.projectUuid, input.clientOperationId);
  const promise = runAcceptedVendorOperation(input, records);
  inFlightVendorOperations.set(key, {
    requestIntentDigest: input.requestIntentDigest,
    promise,
  });
  // 中文注释：后台领取异常只保留耐久 queued 状态供恢复，必须挂 catch 防止未处理 rejection。
  void promise.catch(() => undefined).finally(() => {
    const current = inFlightVendorOperations.get(key);
    if (current?.promise === promise) inFlightVendorOperations.delete(key);
  });
  return acceptedOutcome;
}

/**
 * 受理响应之外执行真实供应商调用；只有完整 operation 的 ready→submitting CAS 成功者可以越过收费边界。
 */
async function runAcceptedVendorOperation(
  input: {
    projectUuid: string;
    clientOperationId: string;
    requestIntentDigest: string;
    paidBatchConfirmed: boolean;
    items: PreparedVendorOperationItem[];
  },
  records: Array<{
    item: PreparedVendorOperationItem;
    operationItemIndex: number;
    taskUuid: string;
  }>,
): Promise<void> {
  const claimed = await runWithProjectStorage(input.projectUuid, () => activeDb.transaction(async (trx) => {
    const operationChanged = await trx("o_storyboardGenerationOperation")
      .where({ clientOperationId: input.clientOperationId, state: "ready" })
      .update({ state: "submitting", updatedAt: Date.now() });
    if (Number(operationChanged) !== 1) return false;
    const taskChanged = await trx("o_storyboardGenerationTask")
      .where({ clientOperationId: input.clientOperationId, status: "queued" })
      .update({ status: "submitting", updatedAt: Date.now() });
    if (Number(taskChanged) !== records.length) {
      throw new Error("普通供应商受理批次任务数量不一致");
    }
    await upsertPendingMutationJournalInTrx(trx, "vendorGenerationSubmitting");
    return true;
  }));
  if (!claimed) return;

  try {
    for (const record of records) {
      await record.item.execute(record.taskUuid);
      const completedAt = Date.now();
      await runWithProjectStorage(input.projectUuid, () => activeDb.transaction(async (trx) => {
        await trx("o_storyboardGenerationTask")
          .where({ taskUuid: record.taskUuid, clientOperationId: input.clientOperationId })
          .update({
            status: "completed",
            providerCompletedAt: completedAt,
            resultLocatorDigest: crypto.createHash("sha256").update(record.taskUuid).digest("hex"),
            progress: 100,
            errorCode: null,
            errorSummary: null,
            updatedAt: completedAt,
          });
        await upsertPendingMutationJournalInTrx(trx, "vendorGenerationTaskCompleted");
      }));
    }
    const completedAt = Date.now();
    await runWithProjectStorage(input.projectUuid, () => activeDb.transaction(async (trx) => {
      await trx("o_storyboardGenerationOperation")
        .where({ clientOperationId: input.clientOperationId, state: "submitting" })
        .update({ state: "completed", updatedAt: completedAt });
      await upsertPendingMutationJournalInTrx(trx, "vendorGenerationCompleted");
    }));
  } catch {
    const failedAt = Date.now();
    await runWithProjectStorage(input.projectUuid, () => activeDb.transaction(async (trx) => {
      await trx("o_storyboardGenerationTask")
        .where({ clientOperationId: input.clientOperationId, status: "submitting" })
        .update({
          status: "failed_fatal",
          errorCode: "VENDOR_GENERATION_FAILED",
          errorSummary: "普通供应商生成失败，请检查模型配置或稍后重试",
          updatedAt: failedAt,
        });
      await trx("o_storyboardGenerationOperation")
        .where({ clientOperationId: input.clientOperationId, state: "submitting" })
        .update({ state: "failed_fatal", updatedAt: failedAt });
      await upsertPendingMutationJournalInTrx(trx, "vendorGenerationAmbiguous");
    })).catch(() => undefined);
    return;
  }
}

async function readVendorOperationSafely(
  projectUuid: string,
  clientOperationId: string,
): Promise<PersistedVendorOperationSnapshot | null> {
  try {
    return await readVendorOperation(projectUuid, clientOperationId);
  } catch {
    // 中文注释：SQLite 错误可能包含 SQL、表名与本机路径，只能越过固定安全边界。
    throw new VendorGenerationOperationError(
      "VENDOR_OPERATION_READ_FAILED",
      "生成操作暂时不可读取，请稍后重试",
      500,
    );
  }
}

async function readVendorOperation(
  projectUuid: string,
  clientOperationId: string,
): Promise<PersistedVendorOperationSnapshot | null> {
  return runWithProjectStorage(projectUuid, async () => {
    const operation = await activeDb("o_storyboardGenerationOperation")
      .where({ clientOperationId })
      .first();
    if (!operation) return null;
    const tasks = await activeDb("o_storyboardGenerationTask")
      .where({ clientOperationId })
      .orderBy("operationItemIndex")
      .select();
    const taskUuids = tasks.map((task) => String(task.taskUuid));
    const candidates = taskUuids.length > 0
      ? await activeDb("o_storyboardCandidate").whereIn("candidateUuid", taskUuids).select()
      : [];
    return {
      operation,
      tasks,
      candidatesById: new Map(candidates.map((candidate) => [String(candidate.candidateUuid), candidate])),
    };
  });
}

function outcomeFromSnapshot(
  projectUuid: string,
  clientOperationId: string,
  snapshot: PersistedVendorOperationSnapshot,
): VendorGenerationOperationOutcome {
  assertVendorOperationIntegrity(projectUuid, clientOperationId, snapshot);
  const tasks = snapshot.tasks.map((task) => {
    const taskUuid = String(task.taskUuid ?? "");
    const completed = String(task.status ?? "") === "completed" && snapshot.candidatesById.has(taskUuid);
    return {
      taskUuid,
      shotUuid: String(task.shotUuid ?? ""),
      status: completed ? "completed" : String(task.status ?? "submitting"),
      ...(completed ? { candidateUuid: taskUuid } : {}),
      clientOperationId,
    };
  });
  const fullyCompleted = String(snapshot.operation.state ?? "") === "completed"
    && Number(snapshot.operation.itemCount) === tasks.length
    && tasks.length > 0
    && tasks.every((task) => task.status === "completed" && task.candidateUuid === task.taskUuid);
  if (fullyCompleted) return { httpStatus: 200, data: tasks };
  return {
    httpStatus: 202,
    data: { clientOperationId, tasks },
  };
}

function assertVendorOperationIntegrity(
  projectUuid: string,
  clientOperationId: string,
  snapshot: PersistedVendorOperationSnapshot,
  requireDurableRequest = false,
): void {
  const state = String(snapshot.operation.state ?? "");
  const itemCount = Number(snapshot.operation.itemCount);
  const paidBatchConfirmed = Number(snapshot.operation.paidBatchConfirmed);
  const requestIntentDigest = String(snapshot.operation.requestIntentDigest ?? "");
  const validStates = new Set(["ready", "submitting", "completed", "failed_fatal"]);
  if (!validStates.has(state)
    || !Number.isInteger(itemCount)
    || itemCount <= 0
    || itemCount !== snapshot.tasks.length
    || (paidBatchConfirmed !== 0 && paidBatchConfirmed !== 1)
    || !/^[a-f0-9]{64}$/.test(requestIntentDigest)) {
    throw operationConflict();
  }

  const requestDigests: string[] = [];
  snapshot.tasks.forEach((task, index) => {
    const taskUuid = String(task.taskUuid ?? "");
    const shotUuid = String(task.shotUuid ?? "");
    const mediaType = String(task.mediaType ?? "");
    const providerId = String(task.providerId ?? "");
    const providerModel = String(task.modelName ?? "");
    const mode = String(task.mode ?? "");
    const requestDigest = String(task.requestDigest ?? "");
    let parametersDigest = "";
    let durableRequest: FinalGenerationRequest | undefined;
    let hasDurableRequest = false;
    try {
      const parameters = JSON.parse(String(task.parametersJson ?? "{}")) as {
        requestDigest?: unknown;
        request?: FinalGenerationRequest;
      };
      parametersDigest = String(parameters.requestDigest ?? "");
      hasDurableRequest = Object.prototype.hasOwnProperty.call(parameters, "request");
      durableRequest = parameters.request;
    } catch {
      throw operationConflict();
    }
    if (String(task.clientOperationId ?? "").toLowerCase() !== clientOperationId
      || Number(task.operationItemIndex) !== index
      || taskUuid !== stableVendorTaskUuid(projectUuid, clientOperationId, index)
      || !/^[0-9a-f-]{36}$/.test(shotUuid)
      || (mediaType !== "image" && mediaType !== "video")
      || !providerId
      || providerId === "dreamina-cli"
      || providerModel.split(":", 1)[0] !== providerId
      || !mode
      || !/^[a-f0-9]{64}$/.test(requestDigest)
      || parametersDigest !== requestDigest
      || Number(task.enqueueReady) !== 1) {
      throw operationConflict();
    }
    // 中文注释：旧同步记录可以没有 request；一旦记录包含耐久 request，就必须每次重放都重新验摘要。
    if (requireDurableRequest || hasDurableRequest) {
      if (!durableRequest
        || durableRequest.providerModel !== providerModel
        || String(durableRequest.options?.mode ?? "") !== mode
        || createStoryboardGenerationPreviewDigest({
          projectUuid,
          shotUuid,
          mediaType,
          request: durableRequest,
        }) !== requestDigest) {
        throw operationConflict();
      }
    }
    const candidate = snapshot.candidatesById.get(taskUuid);
    if (candidate && (String(candidate.shotUuid ?? "") !== shotUuid
      || String(candidate.mediaType ?? "") !== mediaType)) {
      throw operationConflict();
    }
    if (state === "completed"
      && (String(task.status ?? "") !== "completed" || !candidate)) {
      throw operationConflict();
    }
    requestDigests.push(requestDigest);
  });

  const expectedOperationDigest = createOperationDigest(
    projectUuid,
    paidBatchConfirmed === 1,
    requestDigests,
  );
  if (String(snapshot.operation.operationDigest ?? "") !== expectedOperationDigest) {
    throw operationConflict();
  }
}

function operationKey(projectUuid: string, clientOperationId: string): string {
  return `${projectUuid.toLowerCase()}:${clientOperationId}`;
}

function createOperationDigest(
  projectUuid: string,
  paidBatchConfirmed: boolean,
  requestDigests: string[],
): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    projectUuid: projectUuid.toLowerCase(),
    paidBatchConfirmed,
    requestDigests,
  })).digest("hex");
}

function durableFinalRequestSnapshot(request: FinalGenerationRequest): FinalGenerationRequest {
  const options = Object.fromEntries(Object.entries(request.options ?? {}).map(([key, value]) => {
    if (!DURABLE_VENDOR_OPTION_KEYS.has(key)
      || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) {
      throw operationConflict();
    }
    return [key, value];
  }));
  const references = (request.references ?? []).map((reference) => durableMediaReference(reference));
  return {
    providerModel: String(request.providerModel ?? ""),
    prompt: String(request.prompt ?? ""),
    ...(typeof request.negativePrompt === "string" ? { negativePrompt: request.negativePrompt } : {}),
    references,
    ...(Array.isArray(request.capabilityFields)
      ? { capabilityFields: request.capabilityFields.map((field) => String(field)) }
      : {}),
    options,
    ...(request.workbenchOrigin
      ? {
        workbenchOrigin: {
          origin: "workbench" as const,
          projectId: Number(request.workbenchOrigin.projectId),
          scriptId: Number(request.workbenchOrigin.scriptId),
          trackId: Number(request.workbenchOrigin.trackId),
          ...(request.workbenchOrigin.videoId === undefined
            ? {}
            : { videoId: Number(request.workbenchOrigin.videoId) }),
        },
      }
      : {}),
  };
}

function hasDurableRequestSnapshot(task: Record<string, unknown>): boolean {
  try {
    const parameters = JSON.parse(String(task.parametersJson ?? "{}")) as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(parameters, "request")
      && Boolean(parameters.request)
      && typeof parameters.request === "object";
  } catch {
    return false;
  }
}

function durableMediaReference(reference: ProjectMediaReference): ProjectMediaReference {
  return {
    ...(typeof reference.assetUuid === "string" ? { assetUuid: reference.assetUuid } : {}),
    ...(typeof reference.relativePath === "string" ? { relativePath: reference.relativePath } : {}),
    ...(reference.mediaType ? { mediaType: reference.mediaType } : {}),
    ...(typeof reference.md5 === "string" ? { md5: reference.md5 } : {}),
    ...(typeof reference.size === "number" ? { size: reference.size } : {}),
  };
}

function scheduleDurableVendorOperation(projectUuid: string, clientOperationId: string): void {
  const context = currentUserStorage();
  if (!context) return;
  const identity = { issuer: context.issuer, userId: context.userId };
  const guard = currentTeamWriteGuard();
  const teamWriteGuard = guard ? { ...guard } : undefined;
  // 中文注释：动态加载打破 operation→scheduler→operation 的初始化环；异常由耐久恢复继续接管。
  void import("./vendor-generation-scheduler").then(({ wakeVendorGenerationScheduler }) => {
    wakeVendorGenerationScheduler({ projectUuid, clientOperationId, identity, teamWriteGuard });
  }).catch(() => undefined);
}

function assertSameIntent(existing: string, requested: string): void {
  if (!/^[a-f0-9]{64}$/.test(requested) || existing !== requested) throw operationConflict();
}

function operationConflict(): VendorGenerationOperationError {
  return new VendorGenerationOperationError(
    "VENDOR_CLIENT_OPERATION_CONFLICT",
    "同一生成操作 ID 对应的请求意图已变化",
    409,
  );
}

function stableVendorTaskUuid(projectUuid: string, clientOperationId: string, itemIndex: number): string {
  const hex = crypto.createHash("sha256")
    .update(`${projectUuid.toLowerCase()}:vendor:${clientOperationId}:${itemIndex}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
