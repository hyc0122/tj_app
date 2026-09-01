import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { accountDb, db as activeDb, acquireProjectDatabaseLease, releaseProjectDatabaseLease } from "@/utils/db";
import getPath from "@/utils/getPath";
import { getStableDeviceUUID } from "@/tianjiang/auth/device";
import { projectDirectory } from "@/tianjiang/data/paths";
import { assertManagedPathChainHasNoLinks } from "@/tianjiang/media/project-file-store";
import { currentUserStorage, runWithProjectStorage } from "@/tianjiang/runtime/user-storage-context";
import { upsertPendingMutationJournalInTrx } from "@/tianjiang/runtime/legacy-mutation-journal";
import { createDreaminaDispatchIdentityDigest, insertDreaminaDispatch } from "./task-store";

function sqliteHasTable(databasePath: string, tableName: string): boolean {
  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    return Boolean(
      database.prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      ).get(tableName),
    );
  } catch {
    return false;
  } finally {
    try {
      database?.close();
    } catch {
      // ignore
    }
  }
}
import {
  assertAcceptedDreaminaEnqueueIntegrity,
  resumeDreaminaEnqueueOperation,
} from "../async-generation-service";
import {
  reconcilePendingProjectTaskMirrors,
  recoverDreaminaClaimingSlots,
  isDreaminaLifecycleDrainActiveForCurrentUser,
  tickDreaminaScheduler,
  wakeDreaminaScheduler,
} from "./scheduler";
import { runSerializedDreaminaEnablement } from "./dreamina-enablement";
import { readDreaminaCliSettings, writeDreaminaCliSettings } from "./session-store";

/**
 * 恢复异常退出遗留的生命周期暂停。
 * 手动暂停永不自动解除；enabledOnly 用于页面状态读取，避免关闭的 CLI 被意外开门。
 */
export async function recoverOrphanedDreaminaLifecycleDrain(
  options: { enabledOnly?: boolean } = {},
): Promise<boolean> {
  return runSerializedDreaminaEnablement(async () => {
    const settings = await readDreaminaCliSettings();
    if (options.enabledOnly && settings.enabled === false) return false;
    if (settings.pauseReason !== "lifecycle_drain") return false;
    if (isDreaminaLifecycleDrainActiveForCurrentUser()) return false;

    await writeDreaminaCliSettings(
      { pauseReason: "none" },
      { expectedUpdatedAt: settings.updatedAt },
    );
    if (!isDreaminaLifecycleDrainActiveForCurrentUser()) return true;

    // 中文注释：检查与写入之间若重新进入排空，必须按新版本恢复暂停，禁止短暂领取。
    const current = await readDreaminaCliSettings();
    if (current.pauseReason === "none") {
      await writeDreaminaCliSettings(
        { pauseReason: "lifecycle_drain" },
        { expectedUpdatedAt: current.updatedAt },
      );
    }
    return false;
  });
}

/**
 * 启动/登录恢复：先补建缺失 dispatch，再恢复占槽任务，最后唤醒自动调度。
 * 禁止在没有 submitId 的情况下补发可能已扣费的请求。
 */
export async function recoverDreaminaSlots(
  options: { recoverLifecycleDrain?: boolean } = {},
): Promise<{ recovered: number }> {
  if (options.recoverLifecycleDrain) {
    await recoverOrphanedDreaminaLifecycleDrain();
  }
  const rebuilt = await rebuildMissingDreaminaDispatch();
  const mirroredCancels = await recoverPendingLocalCancels();
  // 中文注释：运行时手工恢复也必须复用 scheduler 的 inFlight + CAS 边界，禁止双重 submit。
  const recoveredClaims = await recoverDreaminaClaimingSlots({ includeUnexpired: true });
  const quarantinedBindings = await quarantineInvalidRunnableWorkbenchBindings();
  await tickDreaminaScheduler();
  const runnable = await accountDb("o_dreaminaCliDispatch")
    .where({ dispatchReady: 1 })
    .andWhere((query) => query
      .where({ queueState: "queued" })
      .orWhereIn("queueState", ["provider_active", "postprocessing"]))
    .first("taskUuid");
  // 中文注释：仅存在可运行的耐久投影时启动循环；缺工作台绑定的 preparing 操作必须保持静默。
  if (runnable) wakeDreaminaScheduler();
  // 只统计本轮实际补建、CAS 改写或新隔离的行，重复恢复不得重复计数。
  return { recovered: rebuilt + mirroredCancels + recoveredClaims + quarantinedBindings };
}

/** startup tick 前逐 operation 复核项目权威状态；异常投影只隔离，不回显底层错误。 */
async function quarantineInvalidRunnableWorkbenchBindings(): Promise<number> {
  const candidates = await accountDb("o_dreaminaCliDispatch")
    .whereNotNull("clientOperationId")
    .where({ dispatchReady: 1 })
    .andWhere((query) => query
      .where({ queueState: "queued" })
      .orWhereIn("queueState", ["provider_active", "postprocessing"]))
    .groupBy("projectUuid", "clientOperationId")
    .select("projectUuid", "clientOperationId");
  let quarantined = 0;
  for (const candidate of candidates) {
    const projectUuid = String(candidate.projectUuid ?? "").toLowerCase();
    const clientOperationId = String(candidate.clientOperationId ?? "").toLowerCase();
    try {
      await acquireProjectDatabaseLease(projectUuid, "scheduler");
      await assertAcceptedDreaminaEnqueueIntegrity({ projectUuid, clientOperationId });
    } catch (error) {
      const changed = await accountDb("o_dreaminaCliDispatch")
        .where({ projectUuid, clientOperationId, dispatchReady: 1 })
        .andWhere((query) => query
          .where({ queueState: "queued" })
          .orWhereIn("queueState", ["provider_active", "postprocessing"]))
        .update({ dispatchReady: 0, updatedAt: Date.now() });
      quarantined += Number(changed) || 0;
      console.warn("即梦工作台绑定恢复门禁失败，已隔离账号投影", {
        projectUuid,
        clientOperationId,
        errorCode: safeRecoveryErrorCode(error),
      });
    } finally {
      await releaseProjectDatabaseLease(projectUuid, "scheduler");
    }
  }
  return quarantined;
}

/** 扫描本机项目库，把原设备 queued 且缺账号投影的任务幂等补回，不新建 taskUuid。 */
export async function rebuildMissingDreaminaDispatch(): Promise<number> {
  const context = currentUserStorage();
  if (!context) return 0;
  const origin = getStableDeviceUUID(getPath());
  const projectsRoot = path.join(getPath(), "runtime-users", context.segment, "projects");
  if (!fs.existsSync(projectsRoot)) return 0;
  let rebuilt = 0;
  for (const name of fs.readdirSync(projectsRoot)) {
    // 中文注释：恢复扫描不得跟随项目目录或任一父链 link/reparse，避免跨账号打开外部 project.sqlite。
    try {
      assertManagedPathChainHasNoLinks(getPath(), projectDirectory(getPath(), name, context.segment));
    } catch {
      continue;
    }
    const dbPath = path.join(projectsRoot, name, "project.sqlite");
    if (!fs.existsSync(dbPath)) continue;
    if (!sqliteHasTable(dbPath, "o_storyboardGenerationTask")) continue;
    try {
      await acquireProjectDatabaseLease(name, "scheduler");
    } catch {
      continue;
    }
    try {
    const inventory = await runWithProjectStorage(name, async () => {
      if (!await activeDb.schema.hasTable("o_storyboardGenerationTask")) {
        return { operations: [], operationTasks: [], legacyTasks: [] };
      }
      const operations = await activeDb("o_storyboardGenerationOperation")
        .select("clientOperationId", "state", "itemCount");
      const operationTasks = await activeDb("o_storyboardGenerationTask")
        .where({ providerId: "dreamina-cli" })
        .whereNotNull("clientOperationId")
        .groupBy("clientOperationId")
        .select("clientOperationId")
        .count({ taskCount: "taskUuid" })
        .min({ minOriginDeviceUuid: "originDeviceUuid" })
        .max({ maxOriginDeviceUuid: "originDeviceUuid" })
        .sum({ notReadyCount: activeDb.raw("CASE WHEN enqueueReady = 1 THEN 0 ELSE 1 END") });
      const legacyTasks = await activeDb("o_storyboardGenerationTask")
        .where({ originDeviceUuid: origin, providerId: "dreamina-cli" })
        .whereNull("clientOperationId")
        .whereIn("status", [
          "queued",
          "submitting",
          "submitted",
          "provider_completed",
          "postprocess_failed_retryable",
        ])
        .select(
          "taskUuid",
          "shotUuid",
          "mediaType",
          "modelName",
          "mode",
          "createdAt",
          "status",
          "providerTaskId",
        );
      return { operations, operationTasks, legacyTasks };
    });
    const projected = await accountDb("o_dreaminaCliDispatch")
      .where({ projectUuid: name.toLowerCase() })
      .whereNotNull("clientOperationId")
      .groupBy("clientOperationId")
      .select("clientOperationId")
      .count({ dispatchCount: "taskUuid" })
      .sum({ notReadyCount: accountDb.raw("CASE WHEN dispatchReady = 1 THEN 0 ELSE 1 END") });
    const projectTasksByOperation = indexByOperation(inventory.operationTasks);
    const projectedByOperation = indexByOperation(projected);
    for (const operation of inventory.operations) {
      const clientOperationId = String(operation.clientOperationId ?? "").toLowerCase();
      if (!clientOperationId) continue;
      const projectTasks = projectTasksByOperation.get(clientOperationId);
      if (!projectTasks
        || String(projectTasks.minOriginDeviceUuid ?? "") !== origin
        || String(projectTasks.maxOriginDeviceUuid ?? "") !== origin) {
        continue;
      }
      const accountRows = projectedByOperation.get(clientOperationId);
      const affected = countOperationRowsNeedingRecovery(operation, projectTasks, accountRows, name);
      if (affected === 0) continue;
      // 中文注释：preparing/ready 任一崩溃窗口都只前滚同一个耐久 operation，不创建新 taskUuid。
      try {
        await resumeDreaminaEnqueueOperation({ projectUuid: name, clientOperationId });
        rebuilt += affected;
      } catch (error) {
        // 中文注释：单个损坏或暂时被锁定的 operation 保持不可领取，不能阻断其它项目恢复。
        console.warn("即梦生成 operation 恢复失败", {
          projectUuid: name.toLowerCase(),
          clientOperationId,
          errorCode: safeRecoveryErrorCode(error),
        });
      }
    }
    rebuilt += await quarantineDriftedClaimableDispatches(name, origin);
    for (const task of inventory.legacyTasks) {
      const existing = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: task.taskUuid }).first();
      if (existing) continue;
      await insertDreaminaDispatch({
        taskUuid: String(task.taskUuid),
        projectUuid: name,
        originDeviceUuid: origin,
        mediaType: task.mediaType === "video" ? "video" : "image",
        modelName: String(task.modelName ?? "dreamina-cli:text2image"),
        mode: String(task.mode ?? "text2image"),
        projectConcurrencyLimit: 1,
        modelConcurrencyLimit: 1,
        createdAt: Number(task.createdAt) || Date.now(),
      });
      const submitId = String(task.providerTaskId ?? "");
      const status = String(task.status ?? "");
      if (submitId && (status === "submitted" || status === "submitting")) {
        // 项目任务已有 submitId：补投影为 provider_active，禁止再走 queued 重提。
        await accountDb("o_dreaminaCliDispatch").where({ taskUuid: task.taskUuid }).update({
          queueState: "provider_active",
          providerState: "running",
          slotHeld: 1,
          providerResultJson: JSON.stringify({ submitId, submit_id: submitId }),
          updatedAt: Date.now(),
        });
      } else if (status === "submitted" || status === "submitting") {
        // 中文注释：旧版可能在 submit 已发出但 submitId 未落盘时崩溃；必须占槽等待人工确认，禁止重提收费。
        await accountDb("o_dreaminaCliDispatch").where({ taskUuid: task.taskUuid }).update({
          queueState: "provider_active",
          providerState: "unknown",
          slotHeld: 1,
          providerResultJson: JSON.stringify({ message: "存量任务提交结果待确认，禁止自动重提" }),
          updatedAt: Date.now(),
        });
      } else if (status === "provider_completed" || status === "postprocess_failed_retryable") {
        await accountDb("o_dreaminaCliDispatch").where({ taskUuid: task.taskUuid }).update({
          queueState: "postprocessing",
          providerState: "completed",
          slotHeld: 0,
          providerResultJson: JSON.stringify(submitId ? { submitId, submit_id: submitId } : {}),
          updatedAt: Date.now(),
        });
      }
      rebuilt += 1;
    }
    } finally {
      await releaseProjectDatabaseLease(name, "scheduler");
    }
  }
  return rebuilt;
}

async function quarantineDriftedClaimableDispatches(
  projectUuid: string,
  originDeviceUuid: string,
): Promise<number> {
  const pageSize = 64;
  let quarantined = 0;
  let afterTaskUuid = "";
  for (;;) {
    const claimable = await accountDb("o_dreaminaCliDispatch")
      .where({
        projectUuid: projectUuid.toLowerCase(),
        originDeviceUuid,
        queueState: "queued",
        providerState: "not_sent",
        dispatchReady: 1,
      })
      .whereNotNull("clientOperationId")
      .andWhere("taskUuid", ">", afterTaskUuid)
      .orderBy("taskUuid")
      .limit(pageSize)
      .select(
        "taskUuid",
        "projectUuid",
        "originDeviceUuid",
        "mediaType",
        "providerId",
        "modelName",
        "mode",
        "clientOperationId",
        "operationItemIndex",
        "dispatchIdentityDigest",
      );
    if (claimable.length === 0) break;
    afterTaskUuid = String(claimable[claimable.length - 1]?.taskUuid ?? afterTaskUuid);
    const projectRows = await runWithProjectStorage(projectUuid, () =>
      activeDb("o_storyboardGenerationTask")
        .whereIn("taskUuid", claimable.map((row) => String(row.taskUuid)))
        .select(
          "taskUuid",
          "originDeviceUuid",
          "mediaType",
          "providerId",
          "modelName",
          "mode",
          "status",
          "clientOperationId",
          "operationItemIndex",
          "enqueueReady",
        ));
    const projectByTask = new Map(projectRows.map((row) => [String(row.taskUuid), row]));
    for (const row of claimable) {
      const taskUuid = String(row.taskUuid ?? "");
      const task = projectByTask.get(taskUuid);
      const identityDigest = createDreaminaDispatchIdentityDigest({
        taskUuid,
        projectUuid: String(row.projectUuid ?? ""),
        originDeviceUuid: String(row.originDeviceUuid ?? ""),
        mediaType: String(row.mediaType ?? ""),
        providerId: String(row.providerId ?? ""),
        modelName: String(row.modelName ?? ""),
        mode: String(row.mode ?? ""),
        clientOperationId: String(row.clientOperationId ?? ""),
        operationItemIndex: Number(row.operationItemIndex),
      });
      const valid = Boolean(task)
        && String(row.dispatchIdentityDigest ?? "") === identityDigest
        && String(task?.status ?? "") === "queued"
        && Number(task?.enqueueReady ?? 0) === 1
        && String(task?.originDeviceUuid ?? "") === String(row.originDeviceUuid ?? "")
        && String(task?.mediaType ?? "") === String(row.mediaType ?? "")
        && String(task?.providerId ?? "") === String(row.providerId ?? "")
        && String(task?.modelName ?? "") === String(row.modelName ?? "")
        && String(task?.mode ?? "") === String(row.mode ?? "")
        && String(task?.clientOperationId ?? "").toLowerCase() === String(row.clientOperationId ?? "").toLowerCase()
        && Number(task?.operationItemIndex ?? -1) === Number(row.operationItemIndex ?? -1);
      if (valid) continue;
      const changed = await accountDb("o_dreaminaCliDispatch")
        .where({
          taskUuid,
          queueState: "queued",
          providerState: "not_sent",
          dispatchReady: 1,
        })
        .update({ dispatchReady: 0, updatedAt: Date.now() });
      quarantined += Number(changed) || 0;
      console.warn("即梦待领取投影身份不一致，已隔离", {
        projectUuid: projectUuid.toLowerCase(),
        taskUuid,
        errorCode: "DREAMINA_DISPATCH_IDENTITY_MISMATCH",
      });
    }
    if (claimable.length < pageSize) break;
  }
  return quarantined;
}

async function recoverPendingLocalCancels(): Promise<number> {
  const pending = await accountDb("o_dreaminaCliDispatch")
    .where({ queueState: "terminal", providerState: "failed" })
    .whereRaw("json_extract(providerResultJson, '$.localCancelPending') = 1")
    .select("taskUuid", "projectUuid");
  let recovered = 0;
  for (const row of pending) {
    const taskUuid = String(row.taskUuid ?? "");
    const projectUuid = String(row.projectUuid ?? "").toLowerCase();
    try {
      const mirrored = await runWithProjectStorage(projectUuid, async () => {
        const current = await activeDb("o_storyboardGenerationTask").where({ taskUuid }).first();
        if (!current) throw new Error("CANCEL_PROJECT_TASK_MISSING");
        if (String(current.status) === "cancelled_local") return false;
        if (String(current.status) !== "queued") throw new Error("CANCEL_PROJECT_STATE_CONFLICT");
        await activeDb.transaction(async (trx) => {
          const changed = await trx("o_storyboardGenerationTask").where({ taskUuid, status: "queued" }).update({
            status: "cancelled_local",
            updatedAt: Date.now(),
          });
          if (Number(changed) !== 1) throw new Error("CANCEL_PROJECT_STATE_CONFLICT");
          await upsertPendingMutationJournalInTrx(trx, "dreaminaCancelRecovery");
        });
        return true;
      });
      await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
        providerResultJson: null,
        updatedAt: Date.now(),
      });
      if (mirrored) recovered += 1;
    } catch (error) {
      console.warn("即梦本地取消镜像恢复失败", {
        projectUuid,
        taskUuid,
        errorCode: safeRecoveryErrorCode(error),
      });
    }
  }
  return recovered;
}

export async function resolveUnknownTask(input: {
  taskUuid: string;
  confirm: boolean;
}): Promise<void> {
  if (!input.confirm) {
    const error = new Error("强制终结结果未知必须二次确认，远端可能仍运行且可能已扣费");
    (error as { code?: string }).code = "DREAMINA_UNKNOWN_CONFIRMATION_REQUIRED";
    throw error;
  }
  const projectMirrorPending = {
    status: "failed_fatal",
    errorCode: "DREAMINA_UNKNOWN_MANUALLY_RESOLVED",
    errorSummary: "用户已确认终结结果未知任务",
  } as const;
  await accountDb.transaction(async (trx) => {
    const current = await trx("o_dreaminaCliDispatch")
      .where({ taskUuid: input.taskUuid })
      .first();
    if (!current
      || String(current.queueState) !== "provider_active"
      || String(current.providerState) !== "unknown"
      || Number(current.slotHeld) !== 1) {
      throw unknownResolutionStateConflict();
    }

    let guarded = trx("o_dreaminaCliDispatch").where({
      taskUuid: input.taskUuid,
      queueState: "provider_active",
      providerState: "unknown",
      slotHeld: 1,
      updatedAt: current.updatedAt,
    });
    // 中文注释：人工终结只能消费读取时看到的同一版本、lease 与 provider 结果，禁止覆盖并发恢复或终态。
    guarded = current.leaseOwner === null || current.leaseOwner === undefined
      ? guarded.whereNull("leaseOwner")
      : guarded.andWhere("leaseOwner", current.leaseOwner);
    guarded = current.leaseExpiresAt === null || current.leaseExpiresAt === undefined
      ? guarded.whereNull("leaseExpiresAt")
      : guarded.andWhere("leaseExpiresAt", current.leaseExpiresAt);
    guarded = current.providerResultJson === null || current.providerResultJson === undefined
      ? guarded.whereNull("providerResultJson")
      : guarded.andWhere("providerResultJson", current.providerResultJson);

    const resolvedAt = Date.now();
    const changed = await guarded.update({
      queueState: "terminal",
      providerState: "failed",
      slotHeld: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      providerTerminalAt: resolvedAt,
      providerResultJson: JSON.stringify({
        ...safeJson(current.providerResultJson),
        projectMirrorPending,
      }),
      updatedAt: Math.max(resolvedAt, Number(current.updatedAt ?? 0) + 1),
    });
    if (Number(changed) !== 1) throw unknownResolutionStateConflict();
  });
  // 中文注释：账号终态与 marker 已提交后才尝试跨库镜像；失败由后续恢复轮次幂等重放。
  await reconcilePendingProjectTaskMirrors();
}

function unknownResolutionStateConflict(): Error {
  const error = new Error("只有仍占槽且结果未知的任务可以强制终结");
  (error as { code?: string; status?: number }).code = "DREAMINA_UNKNOWN_STATE_CONFLICT";
  (error as { code?: string; status?: number }).status = 409;
  return error;
}

function indexByOperation(
  rows: Array<Record<string, unknown>>,
): Map<string, Record<string, unknown>> {
  const indexed = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const operationId = String(row.clientOperationId ?? "").toLowerCase();
    if (!operationId) continue;
    indexed.set(operationId, row);
  }
  return indexed;
}

function countOperationRowsNeedingRecovery(
  operation: Record<string, unknown>,
  projectTasks: Record<string, unknown>,
  projected: Record<string, unknown> | undefined,
  _projectUuid: string,
): number {
  const itemCount = Math.max(0, Number(operation.itemCount) || 0);
  const projectCount = Math.max(0, Number(projectTasks.taskCount) || 0);
  const projectNotReady = Math.max(0, Number(projectTasks.notReadyCount) || 0);
  const dispatchCount = Math.max(0, Number(projected?.dispatchCount) || 0);
  const dispatchNotReady = Math.max(0, Number(projected?.notReadyCount) || 0);
  if (String(operation.state ?? "") !== "ready") return Math.max(1, itemCount);
  const missingProject = Math.max(0, itemCount - projectCount);
  const missingDispatch = Math.max(0, itemCount - dispatchCount);
  return Math.max(projectNotReady + missingProject, dispatchNotReady + missingDispatch);
}

function safeJson(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw ?? "{}"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    // 中文注释：历史损坏结果不得阻断人工终结，后续只保留新的安全状态 marker。
    return {};
  }
}

function safeRecoveryErrorCode(error: unknown): string {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return /^[A-Z0-9_]{3,80}$/.test(code) ? code : "DREAMINA_OPERATION_RECOVERY_FAILED";
}
