import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { db as activeDb, prepareProjectDatabase } from "@/utils/db";
import Ai from "@/utils/ai";
import getPath from "@/utils/getPath";
import { getStableDeviceUUID } from "@/tianjiang/auth/device";
import { projectDirectory } from "@/tianjiang/data/paths";
import { assertManagedPathChainHasNoLinks } from "@/tianjiang/media/project-file-store";
import { upsertPendingMutationJournalInTrx } from "@/tianjiang/runtime/legacy-mutation-journal";
import {
  currentUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
  type UserStorageIdentity,
} from "@/tianjiang/runtime/user-storage-context";
import {
  runWithTeamWriteGuard,
  type TeamWriteGuard,
} from "@/tianjiang/runtime/project-operation-port";
import { syncCoordinator } from "@/tianjiang/runtime/runtime";
import {
  adaptVendorGenerationRequest,
  assertCandidateInstallWritable,
  createStoryboardGenerationPreviewDigest,
  persistVendorGenerationResult,
  type FinalGenerationRequest,
} from "@/tianjiang/storyboard/storyboard-generation-service";
import { safeVendorGenerationFailure } from "@/tianjiang/storyboard/vendor-generation-safety";

interface PersistedVendorTask {
  taskUuid: string;
  shotUuid: string;
  mediaType: "image" | "video";
  providerId: string;
  modelName: string;
  mode: string;
  parametersJson: string;
  requestDigest: string;
  operationItemIndex: number;
  enqueueReady: number;
  originDeviceUuid: string;
}

interface RunnableVendorTask extends PersistedVendorTask {
  request: FinalGenerationRequest;
}

const activeRuns = new Map<string, Promise<void>>();
let acceptingRuns = true;
type DurableBatchInspection = "runnable" | "foreign_device" | "invalid";

/** 唤醒指定耐久批次；同账号同项目同 operation 在本进程内只能存在一个执行 Promise。 */
export function wakeVendorGenerationScheduler(input: {
  projectUuid: string;
  clientOperationId: string;
  identity: UserStorageIdentity;
  teamWriteGuard?: TeamWriteGuard;
}): void {
  if (!acceptingRuns) return;
  const key = schedulerKey(input.identity, input.projectUuid, input.clientOperationId);
  if (activeRuns.has(key)) return;
  const promise = Promise.resolve().then(() => runWithUserStorage(input.identity, () =>
    runWithTeamWriteGuard(input.teamWriteGuard, () =>
      runVendorGenerationOperation(input.projectUuid, input.clientOperationId))));
  activeRuns.set(key, promise);
  // 中文注释：调度异常必须在此消费，公开状态只从 SQLite 读取，禁止形成未处理 rejection。
  void promise.catch(() => undefined).finally(() => {
    if (activeRuns.get(key) === promise) activeRuns.delete(key);
  });
}

/** 测试和关闭流程可等待当前进程内的普通供应商后台任务自然收敛。 */
export async function drainVendorGenerationScheduler(): Promise<void> {
  await Promise.allSettled([...activeRuns.values()]);
}

/** 关闭阶段先停新领取，再等待已领取任务写回稳定状态。 */
export function stopVendorGenerationScheduler(): void {
  acceptingRuns = false;
}

/** 新账号/新一轮服务启动后重新开放耐久任务领取。 */
export function resumeVendorGenerationScheduler(): void {
  acceptingRuns = true;
}

/**
 * 账号激活恢复：只重新领取尚未越过收费边界的 ready 批次；孤立 submitting 一律隔离，禁止盲目重发。
 */
export async function recoverDurableVendorGenerationOperations(): Promise<{
  recovered: number;
  quarantined: number;
}> {
  const context = currentUserStorage();
  if (!context) return { recovered: 0, quarantined: 0 };
  const identity = { issuer: context.issuer, userId: context.userId };
  const projectsRoot = path.join(getPath(), "runtime-users", context.segment, "projects");
  if (!fs.existsSync(projectsRoot)) return { recovered: 0, quarantined: 0 };

  let recovered = 0;
  let quarantined = 0;
  for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const projectUuid = entry.name.toLowerCase();
    try {
      assertManagedPathChainHasNoLinks(getPath(), projectDirectory(getPath(), projectUuid, context.segment));
      await prepareProjectDatabase(projectUuid);
      const operations = await runWithProjectStorage(projectUuid, async () => {
        if (!await activeDb.schema.hasTable("o_storyboardGenerationOperation")
          || !await activeDb.schema.hasTable("o_storyboardGenerationTask")) return [];
        return activeDb("o_storyboardGenerationOperation")
          .whereIn("state", ["ready", "submitting"])
          .select("clientOperationId", "state", "itemCount");
      });
      for (const operation of operations) {
        const clientOperationId = String(operation.clientOperationId ?? "").toLowerCase();
        if (!/^[0-9a-f-]{36}$/.test(clientOperationId)) continue;
        const key = schedulerKey(identity, projectUuid, clientOperationId);
        if (activeRuns.has(key)) continue;
        if (String(operation.state ?? "") === "submitting") {
          const origin = await inspectDurableTaskOrigin(
            projectUuid,
            clientOperationId,
            Number(operation.itemCount),
          );
          if (origin === "foreign_device") {
            // 中文注释：异源设备可能仍在真实供应商边界内，当前设备绝不能把它改写成失败终态。
            continue;
          }
          quarantined += await quarantineInterruptedOperation(projectUuid, clientOperationId, "outcome_unknown");
          continue;
        }
        const durable = await inspectDurableTaskBatch(
          projectUuid,
          clientOperationId,
          Number(operation.itemCount),
        );
        if (durable === "foreign_device") {
          // 中文注释：项目库可跨设备同步，异源任务必须留给原设备，不能靠本地 SQLite CAS 争抢收费。
          continue;
        }
        if (durable === "invalid") {
          quarantined += await quarantineInterruptedOperation(projectUuid, clientOperationId, "recovery_required");
          continue;
        }
        const recoveryContext = resolveRecoveryWriteContext(projectUuid);
        if (!recoveryContext) {
          quarantined += await quarantineInterruptedOperation(projectUuid, clientOperationId, "recovery_required");
          continue;
        }
        wakeVendorGenerationScheduler({
          projectUuid,
          clientOperationId,
          identity,
          teamWriteGuard: recoveryContext.teamWriteGuard,
        });
        recovered += 1;
      }
    } catch {
      // 中文注释：单项目损坏不得阻断其余项目恢复，也不得输出可能含路径或 SQL 的底层异常。
    }
  }
  return { recovered, quarantined };
}

/**
 * 从 SQLite 重建完整请求并越过供应商边界。只有 ready→submitting CAS 的唯一赢家可以执行。
 */
export async function runVendorGenerationOperation(
  projectUuid: string,
  clientOperationId: string,
): Promise<void> {
  let tasks: RunnableVendorTask[] | null;
  try {
    tasks = await claimReadyOperation(projectUuid, clientOperationId);
  } catch {
    // 中文注释：耐久快照损坏时必须在越过收费边界前隔离，禁止反复恢复或执行被篡改请求。
    await quarantineInterruptedOperation(projectUuid, clientOperationId, "recovery_required");
    return;
  }
  if (!tasks) return;

  try {
    // 中文注释：Team 角色、设备、锁与 fencing 必须在任何供应商 prepare/execute 前重新验证。
    assertCandidateInstallWritable(projectUuid);
    // 中文注释：整批先完成纯本地适配与 prepare，再统一 stage；任一失败时不得执行任何收费调用。
    const prepared = await Promise.all(tasks.map(async (task) => {
      const adapted = adaptVendorGenerationRequest({
        projectUuid,
        mediaType: task.mediaType,
        request: task.request,
      });
      const key = task.modelName as `${string}:${string}`;
      if (adapted.mediaType === "video") {
        const execution = await Ai.Video(key).prepare(adapted.config);
        return { task, stage: () => execution.stage() };
      }
      const execution = await Ai.Image(key).prepare(adapted.config);
      return { task, stage: () => execution.stage() };
    }));
    const executable = await Promise.all(prepared.map(async ({ task, stage }) => ({
      task,
      execution: await stage(),
    })));

    for (const { task, execution } of executable) {
      assertCandidateInstallWritable(projectUuid);
      await persistVendorGenerationResult({
        projectUuid,
        shotUuid: task.shotUuid,
        mediaType: task.mediaType,
        request: task.request,
        candidateUuid: task.taskUuid,
        runner: {
          run: async () => execution.execute(),
        },
      });
      await markTaskCompleted(projectUuid, clientOperationId, task.taskUuid);
    }
    await markOperationCompleted(projectUuid, clientOperationId, tasks.length);
  } catch (error) {
    await markOperationFailed(projectUuid, clientOperationId, error);
  }
}

async function claimReadyOperation(
  projectUuid: string,
  clientOperationId: string,
): Promise<RunnableVendorTask[] | null> {
  return runWithProjectStorage(projectUuid, () => activeDb.transaction(async (trx) => {
    const operation = await trx("o_storyboardGenerationOperation")
      .where({ clientOperationId })
      .first("state", "itemCount", "operationDigest", "paidBatchConfirmed");
    if (!operation || String(operation.state ?? "") !== "ready") return null;
    const rawTasks = await trx("o_storyboardGenerationTask")
      .where({ clientOperationId, status: "queued" })
      .orderBy("operationItemIndex")
      .select(
        "taskUuid",
        "shotUuid",
        "mediaType",
        "providerId",
        "modelName",
        "mode",
        "parametersJson",
        "requestDigest",
        "operationItemIndex",
        "enqueueReady",
        "originDeviceUuid",
      );
    if (rawTasks.length !== Number(operation.itemCount) || rawTasks.length === 0) {
      throw new Error("普通供应商耐久任务数量不一致");
    }
    const origins = new Set(rawTasks.map((row) => String(row.originDeviceUuid ?? "")));
    if (origins.size !== 1 || !/^[0-9a-f-]{36}$/.test([...origins][0] ?? "")) {
      throw new Error("普通供应商耐久任务来源设备不一致");
    }
    if ([...origins][0] !== getStableDeviceUUID(getPath())) return null;
    const tasks = rawTasks.map((row, index) => parseRunnableTask(projectUuid, row, index));
    const expectedOperationDigest = persistedOperationDigest(
      projectUuid,
      Number(operation.paidBatchConfirmed) === 1,
      tasks.map((task) => task.requestDigest),
    );
    if (String(operation.operationDigest ?? "") !== expectedOperationDigest) {
      throw new Error("普通供应商耐久批次摘要不一致");
    }
    const shotRows = await trx("o_storyboardShot")
      .whereIn("shotUuid", [...new Set(tasks.map((task) => task.shotUuid))])
      .select("shotUuid");
    const existingShots = new Set(shotRows.map((row) => String(row.shotUuid ?? "")));
    if (tasks.some((task) => !existingShots.has(task.shotUuid))) {
      throw new Error("普通供应商耐久任务所属分镜不存在");
    }
    const operationChanged = await trx("o_storyboardGenerationOperation")
      .where({ clientOperationId, state: "ready" })
      .update({ state: "submitting", updatedAt: Date.now() });
    if (Number(operationChanged) !== 1) return null;
    const taskChanged = await trx("o_storyboardGenerationTask")
      .where({ clientOperationId, status: "queued" })
      .update({ status: "submitting", updatedAt: Date.now() });
    if (Number(taskChanged) !== tasks.length) {
      throw new Error("普通供应商耐久任务领取失败");
    }
    await upsertPendingMutationJournalInTrx(trx, "vendorGenerationSubmitting");
    return tasks;
  }));
}

async function inspectDurableTaskBatch(
  projectUuid: string,
  clientOperationId: string,
  itemCount: number,
): Promise<DurableBatchInspection> {
  if (!Number.isInteger(itemCount) || itemCount <= 0) return "invalid";
  return runWithProjectStorage(projectUuid, async () => {
    const rows = await activeDb("o_storyboardGenerationTask")
      .where({ clientOperationId, status: "queued", enqueueReady: 1 })
      .whereNot({ providerId: "dreamina-cli" })
      .orderBy("operationItemIndex")
      .select(
        "taskUuid",
        "shotUuid",
        "mediaType",
        "providerId",
        "modelName",
        "mode",
        "parametersJson",
        "requestDigest",
        "operationItemIndex",
        "enqueueReady",
        "originDeviceUuid",
      );
    if (rows.length !== itemCount) return "invalid";
    const origins = new Set(rows.map((row) => String(row.originDeviceUuid ?? "")));
    if (origins.size !== 1 || !/^[0-9a-f-]{36}$/.test([...origins][0] ?? "")) return "invalid";
    if ([...origins][0] !== getStableDeviceUUID(getPath())) return "foreign_device";
    try {
      const tasks = rows.map((row, index) => parseRunnableTask(projectUuid, row, index));
      const shotRows = await activeDb("o_storyboardShot")
        .whereIn("shotUuid", [...new Set(tasks.map((task) => task.shotUuid))])
        .select("shotUuid");
      const existingShots = new Set(shotRows.map((row) => String(row.shotUuid ?? "")));
      return tasks.every((task) => existingShots.has(task.shotUuid)) ? "runnable" : "invalid";
    } catch {
      return "invalid";
    }
  });
}

async function inspectDurableTaskOrigin(
  projectUuid: string,
  clientOperationId: string,
  itemCount: number,
): Promise<"local_device" | "foreign_device" | "invalid"> {
  if (!Number.isInteger(itemCount) || itemCount <= 0) return "invalid";
  return runWithProjectStorage(projectUuid, async () => {
    const rows = await activeDb("o_storyboardGenerationTask")
      .where({ clientOperationId })
      .select("originDeviceUuid");
    if (rows.length !== itemCount) return "invalid";
    const origins = new Set(rows.map((row) => String(row.originDeviceUuid ?? "")));
    if (origins.size !== 1 || !/^[0-9a-f-]{36}$/.test([...origins][0] ?? "")) return "invalid";
    return [...origins][0] === getStableDeviceUUID(getPath()) ? "local_device" : "foreign_device";
  });
}

async function quarantineInterruptedOperation(
  projectUuid: string,
  clientOperationId: string,
  reason: "outcome_unknown" | "recovery_required",
): Promise<number> {
  return runWithProjectStorage(projectUuid, () => activeDb.transaction(async (trx) => {
    const changed = await trx("o_storyboardGenerationOperation")
      .where({ clientOperationId })
      .whereIn("state", ["ready", "submitting"])
      .update({ state: "failed_fatal", updatedAt: Date.now() });
    if (Number(changed) !== 1) return 0;
    await trx("o_storyboardGenerationTask")
      .where({ clientOperationId })
      .whereIn("status", ["queued", "submitting"])
      .update({
        status: "failed_fatal",
        errorCode: reason === "outcome_unknown"
          ? "VENDOR_OUTCOME_UNKNOWN"
          : "VENDOR_GENERATION_RECOVERY_REQUIRED",
        errorSummary: reason === "outcome_unknown"
          ? "应用异常退出后无法确认供应商提交结果；为避免重复扣费不会自动重提"
          : "耐久生成任务无法安全恢复，请重新提交",
        updatedAt: Date.now(),
      });
    await upsertPendingMutationJournalInTrx(trx, "vendorGenerationRecoveryQuarantined");
    return 1;
  }));
}

function resolveRecoveryWriteContext(projectUuid: string): { teamWriteGuard?: TeamWriteGuard } | null {
  let item: ReturnType<typeof syncCoordinator.listProjects>[number] | undefined;
  try {
    item = syncCoordinator.listProjects(undefined).find((row) => row.projectUuid === projectUuid);
  } catch {
    item = syncCoordinator.peekProject(projectUuid);
  }
  if (!item || item.myRole === "viewer" || item.openMode === "readonly") return null;
  if (item.kind !== "team") return {};

  const deviceUuid = getStableDeviceUUID(getPath());
  const expectedDevice = String(item.lockDeviceUuid ?? deviceUuid);
  const lockId = String(item.lockId ?? "");
  const fencingToken = Number(item.fencingToken);
  if (item.lockStatus !== "active"
    || !lockId
    || expectedDevice !== deviceUuid
    || !Number.isFinite(fencingToken)
    || fencingToken <= 0) {
    return null;
  }
  return { teamWriteGuard: { deviceUuid, lockId, fencingToken } };
}

function parseRunnableTask(
  projectUuid: string,
  row: Record<string, unknown>,
  expectedIndex: number,
): RunnableVendorTask {
  const taskUuid = String(row.taskUuid ?? "");
  const shotUuid = String(row.shotUuid ?? "");
  const mediaType = String(row.mediaType ?? "");
  const providerId = String(row.providerId ?? "");
  const modelName = String(row.modelName ?? "");
  const mode = String(row.mode ?? "");
  const requestDigest = String(row.requestDigest ?? "");
  const operationItemIndex = Number(row.operationItemIndex);
  const enqueueReady = Number(row.enqueueReady);
  const originDeviceUuid = String(row.originDeviceUuid ?? "");
  let request: FinalGenerationRequest;
  let parametersDigest = "";
  try {
    const parameters = JSON.parse(String(row.parametersJson ?? "{}")) as {
      requestDigest?: unknown;
      request?: FinalGenerationRequest;
    };
    request = parameters.request!;
    parametersDigest = String(parameters.requestDigest ?? "");
  } catch {
    throw new Error("普通供应商耐久请求无法解析");
  }
  if ((mediaType !== "image" && mediaType !== "video")
    || !/^[0-9a-f-]{36}$/.test(shotUuid)
    || !providerId
    || providerId === "dreamina-cli"
    || modelName.split(":", 1)[0] !== providerId
    || !mode
    || operationItemIndex !== expectedIndex
    || enqueueReady !== 1
    || !/^[0-9a-f-]{36}$/.test(originDeviceUuid)
    || !/^[a-f0-9]{64}$/.test(requestDigest)
    || parametersDigest !== requestDigest
    || !request
    || request.providerModel !== modelName
    || String(request.options?.mode ?? "") !== mode
    || !Array.isArray(request.references)
    || !request.options
    || typeof request.options !== "object"
    || createStoryboardGenerationPreviewDigest({
      projectUuid,
      shotUuid,
      mediaType,
      request,
    }) !== requestDigest) {
    throw new Error("普通供应商耐久请求无效");
  }
  return {
    taskUuid,
    shotUuid,
    mediaType,
    providerId,
    modelName,
    mode,
    parametersJson: String(row.parametersJson ?? ""),
    requestDigest,
    operationItemIndex,
    enqueueReady,
    originDeviceUuid,
    request,
  };
}

function persistedOperationDigest(
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

async function markTaskCompleted(
  projectUuid: string,
  clientOperationId: string,
  taskUuid: string,
): Promise<void> {
  const completedAt = Date.now();
  await runWithProjectStorage(projectUuid, () => activeDb.transaction(async (trx) => {
    const changed = await trx("o_storyboardGenerationTask")
      .where({ taskUuid, clientOperationId, status: "submitting" })
      .update({
        status: "completed",
        providerCompletedAt: completedAt,
        resultLocatorDigest: crypto.createHash("sha256").update(taskUuid).digest("hex"),
        progress: 100,
        errorCode: null,
        errorSummary: null,
        updatedAt: completedAt,
      });
    if (Number(changed) !== 1) throw new Error("普通供应商任务完成态写入失败");
    await upsertPendingMutationJournalInTrx(trx, "vendorGenerationTaskCompleted");
  }));
}

async function markOperationCompleted(
  projectUuid: string,
  clientOperationId: string,
  itemCount: number,
): Promise<void> {
  const completedAt = Date.now();
  await runWithProjectStorage(projectUuid, () => activeDb.transaction(async (trx) => {
    const completedTasks = await trx("o_storyboardGenerationTask")
      .where({ clientOperationId, status: "completed" })
      .count<{ count: number }[]>({ count: "taskUuid" });
    if (Number(completedTasks[0]?.count ?? 0) !== itemCount) {
      throw new Error("普通供应商批次尚未全部完成");
    }
    const changed = await trx("o_storyboardGenerationOperation")
      .where({ clientOperationId, state: "submitting" })
      .update({ state: "completed", updatedAt: completedAt });
    if (Number(changed) !== 1) throw new Error("普通供应商批次完成态写入失败");
    await upsertPendingMutationJournalInTrx(trx, "vendorGenerationCompleted");
  }));
}

async function markOperationFailed(
  projectUuid: string,
  clientOperationId: string,
  error: unknown,
): Promise<void> {
  const failedAt = Date.now();
  const failure = safeVendorGenerationFailure(error);
  await runWithProjectStorage(projectUuid, () => activeDb.transaction(async (trx) => {
    await trx("o_storyboardGenerationTask")
      .where({ clientOperationId, status: "submitting" })
      .update({
        status: "failed_fatal",
        errorCode: failure.code,
        errorSummary: failure.message,
        updatedAt: failedAt,
      });
    await trx("o_storyboardGenerationOperation")
      .where({ clientOperationId, state: "submitting" })
      .update({ state: "failed_fatal", updatedAt: failedAt });
    await upsertPendingMutationJournalInTrx(trx, "vendorGenerationFailed");
  })).catch(() => undefined);
}

function schedulerKey(
  identity: UserStorageIdentity,
  projectUuid: string,
  clientOperationId: string,
): string {
  return `${identity.issuer}:${identity.userId}:${projectUuid.toLowerCase()}:${clientOperationId}`;
}
