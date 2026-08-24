import crypto from "node:crypto";

import { accountDb, accountDatabase } from "@/utils/db";

export function shouldDispatchOnThisDevice(originDeviceUuid: string, currentDeviceUuid: string): boolean {
  return originDeviceUuid === currentDeviceUuid;
}

type DispatchIdentity = {
  taskUuid: string;
  projectUuid: string;
  originDeviceUuid: string;
  mediaType: string;
  providerId?: string;
  modelName: string;
  mode: string;
  clientOperationId?: string | null;
  operationItemIndex?: number | null;
};

/** 结构化标识账号投影身份冲突，调用层据此 fail-closed，禁止依赖错误文案判断。 */
export class DreaminaDispatchIdentityConflictError extends Error {
  readonly code = "DREAMINA_DISPATCH_IDENTITY_CONFLICT";

  constructor() {
    super("即梦账号投影与生成操作身份冲突");
  }
}

/** 账号库本地身份摘要供领取事务校验；并发限额是可刷新字段，故不纳入摘要。 */
export function createDreaminaDispatchIdentityDigest(input: DispatchIdentity): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    taskUuid: input.taskUuid,
    projectUuid: input.projectUuid.toLowerCase(),
    originDeviceUuid: input.originDeviceUuid,
    mediaType: input.mediaType,
    providerId: input.providerId ?? "dreamina-cli",
    modelName: input.modelName,
    mode: input.mode,
    clientOperationId: input.clientOperationId?.toLowerCase() ?? null,
    operationItemIndex: input.operationItemIndex ?? null,
  })).digest("hex");
}

export async function insertDreaminaDispatch(input: {
  taskUuid: string;
  projectUuid: string;
  originDeviceUuid: string;
  mediaType: "image" | "video";
  modelName: string;
  mode: string;
  projectConcurrencyLimit: number;
  modelConcurrencyLimit: number;
  createdAt: number;
  clientOperationId?: string | null;
  operationItemIndex?: number | null;
  dispatchReady?: boolean;
}): Promise<void> {
  await insertDreaminaDispatchInTrx(accountDb, input);
}

/** 批量入队复用同一账号库事务，提交前任何一项都不可被调度器看见。 */
export async function insertDreaminaDispatchInTrx(
  trx: typeof accountDb,
  input: {
    taskUuid: string;
    projectUuid: string;
    originDeviceUuid: string;
    mediaType: "image" | "video";
    modelName: string;
    mode: string;
    projectConcurrencyLimit: number;
    modelConcurrencyLimit: number;
    createdAt: number;
    clientOperationId?: string | null;
    operationItemIndex?: number | null;
    dispatchReady?: boolean;
  },
): Promise<void> {
  const existing = await trx("o_dreaminaCliDispatch").where({ taskUuid: input.taskUuid }).first();
  const identityDigest = createDreaminaDispatchIdentityDigest({
    ...input,
    providerId: "dreamina-cli",
  });
  if (existing) {
    const sameOperation = String(existing.projectUuid) === input.projectUuid
      && String(existing.clientOperationId ?? "") === String(input.clientOperationId ?? "")
      && Number(existing.operationItemIndex ?? -1) === Number(input.operationItemIndex ?? -1)
      && String(existing.originDeviceUuid ?? "") === input.originDeviceUuid
      && String(existing.mediaType ?? "") === input.mediaType
      && String(existing.providerId ?? "") === "dreamina-cli"
      && String(existing.modelName ?? "") === input.modelName
      && String(existing.mode ?? "") === input.mode;
    if (!sameOperation) {
      throw new DreaminaDispatchIdentityConflictError();
    }
    if (!existing.dispatchIdentityDigest) {
      // 中文注释：兼容迁移前已经落下的不可领取占位，只在完整身份一致时补摘要。
      await trx("o_dreaminaCliDispatch").where({ taskUuid: input.taskUuid }).update({
        dispatchIdentityDigest: identityDigest,
        updatedAt: Date.now(),
      });
    }
    return;
  }
  await trx("o_dreaminaCliDispatch").insert({
    taskUuid: input.taskUuid,
    projectUuid: input.projectUuid,
    originDeviceUuid: input.originDeviceUuid,
    mediaType: input.mediaType,
    providerId: "dreamina-cli",
    modelName: input.modelName,
    mode: input.mode,
    projectConcurrencyLimit: input.projectConcurrencyLimit,
    modelConcurrencyLimit: input.modelConcurrencyLimit,
    // 中文注释：跨库批次尚未 ready 时先落为不可调度终态占位，整批校验后再原子切为真实状态。
    queueState: input.dispatchReady === false ? "terminal" : "queued",
    providerState: "not_sent",
    providerResultJson: null,
    providerTerminalAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    slotHeld: 0,
    notificationsMuted: 0,
    clientOperationId: input.clientOperationId ?? null,
    operationItemIndex: input.operationItemIndex ?? null,
    dispatchReady: input.dispatchReady === false ? 0 : 1,
    dispatchIdentityDigest: identityDigest,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

export async function countHeldSlots(): Promise<number> {
  const rows = await accountDb("o_dreaminaCliDispatch").where({ slotHeld: 1 }).select("taskUuid");
  return rows.length;
}

export async function hasUnknownSlot(): Promise<boolean> {
  const row = await accountDb("o_dreaminaCliDispatch")
    .where({ providerState: "unknown", slotHeld: 1 })
    .first();
  return Boolean(row);
}

export interface DreaminaClaimResult {
  taskUuid: string;
  projectUuid: string;
  mode: string;
  modelName: string;
  leaseOwner: string;
}

/**
 * 账号库 SQLite BEGIN IMMEDIATE 原子领取。
 * 同时计算账号 / 项目 / 模型三层已占槽，取最小值决定是否可领。
 */
export async function claimNextDreaminaDispatch(input: {
  currentDeviceUuid: string;
  accountLimit: number;
  leaseOwner: string;
}): Promise<DreaminaClaimResult | null> {
  const knex = accountDatabase();
  const conn = await knex.client.acquireConnection() as {
    exec: (sql: string) => void;
    prepare: (sql: string) => {
      get: (...args: unknown[]) => Record<string, unknown> | undefined;
      all: (...args: unknown[]) => Array<Record<string, unknown>>;
      run: (...args: unknown[]) => { changes: number };
    };
  };
  try {
    conn.exec("BEGIN IMMEDIATE");
    try {
      const unknown = conn.prepare(
        "SELECT taskUuid FROM o_dreaminaCliDispatch WHERE providerState = ? AND slotHeld = 1 LIMIT 1",
      ).get("unknown");
      if (unknown) {
        conn.exec("COMMIT");
        return null;
      }
      const heldRow = conn.prepare(
        "SELECT COUNT(1) AS c FROM o_dreaminaCliDispatch WHERE slotHeld = 1",
      ).get() as { c?: number } | undefined;
      const held = Number(heldRow?.c ?? 0);
      if (held >= input.accountLimit) {
        conn.exec("COMMIT");
        return null;
      }
      const queued = conn.prepare(
        `SELECT taskUuid, projectUuid, originDeviceUuid, mediaType, providerId, mode, modelName,
                clientOperationId, operationItemIndex, dispatchIdentityDigest,
                projectConcurrencyLimit, modelConcurrencyLimit
         FROM o_dreaminaCliDispatch
         WHERE queueState = ? AND providerState = ? AND originDeviceUuid = ? AND dispatchReady = 1
         ORDER BY createdAt ASC, taskUuid ASC`,
      ).all("queued", "not_sent", input.currentDeviceUuid);
      for (const row of queued) {
        if (row.clientOperationId != null) {
          const expectedDigest = createDreaminaDispatchIdentityDigest({
            taskUuid: String(row.taskUuid),
            projectUuid: String(row.projectUuid),
            originDeviceUuid: String(row.originDeviceUuid),
            mediaType: String(row.mediaType),
            providerId: String(row.providerId),
            modelName: String(row.modelName),
            mode: String(row.mode),
            clientOperationId: String(row.clientOperationId),
            operationItemIndex: Number(row.operationItemIndex),
          });
          if (String(row.dispatchIdentityDigest ?? "") !== expectedDigest) {
            // 中文注释：摘要漂移在同一 BEGIN IMMEDIATE 内隔离，禁止恢复扫描与领取之间的竞态收费。
            conn.prepare(
              `UPDATE o_dreaminaCliDispatch SET dispatchReady = 0, updatedAt = ?
               WHERE taskUuid = ? AND queueState = ? AND providerState = ? AND dispatchReady = 1`,
            ).run(Date.now(), row.taskUuid, "queued", "not_sent");
            continue;
          }
        }
        const projectLimit = Math.max(1, Number(row.projectConcurrencyLimit) || 1);
        const modelLimit = Math.max(1, Number(row.modelConcurrencyLimit) || 1);
        const projectHeld = Number((conn.prepare(
          "SELECT COUNT(1) AS c FROM o_dreaminaCliDispatch WHERE slotHeld = 1 AND projectUuid = ?",
        ).get(row.projectUuid) as { c?: number } | undefined)?.c ?? 0);
        const modelHeld = Number((conn.prepare(
          "SELECT COUNT(1) AS c FROM o_dreaminaCliDispatch WHERE slotHeld = 1 AND modelName = ?",
        ).get(row.modelName) as { c?: number } | undefined)?.c ?? 0);
        if (projectHeld >= projectLimit || modelHeld >= modelLimit) continue;
        const updated = conn.prepare(
          `UPDATE o_dreaminaCliDispatch
           SET queueState = ?, slotHeld = 1, leaseOwner = ?, leaseExpiresAt = ?, updatedAt = ?
           WHERE taskUuid = ? AND projectUuid = ? AND originDeviceUuid = ? AND mediaType = ?
             AND providerId = ? AND modelName = ? AND mode = ?
             AND COALESCE(clientOperationId, '') = COALESCE(?, '')
             AND COALESCE(operationItemIndex, -1) = COALESCE(?, -1)
             AND COALESCE(dispatchIdentityDigest, '') = COALESCE(?, '')
             AND queueState = ? AND providerState = ? AND dispatchReady = 1`,
        ).run(
          "claiming",
          input.leaseOwner,
          Date.now() + 30_000,
          Date.now(),
          row.taskUuid,
          row.projectUuid,
          row.originDeviceUuid,
          row.mediaType,
          row.providerId,
          row.modelName,
          row.mode,
          row.clientOperationId,
          row.operationItemIndex,
          row.dispatchIdentityDigest,
          "queued",
          "not_sent",
        );
        if (updated.changes !== 1) continue;
        conn.exec("COMMIT");
        return {
          taskUuid: String(row.taskUuid),
          projectUuid: String(row.projectUuid),
          mode: String(row.mode),
          modelName: String(row.modelName),
          leaseOwner: input.leaseOwner,
        };
      }
      conn.exec("COMMIT");
      return null;
    } catch (error) {
      try { conn.exec("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    }
  } finally {
    knex.client.releaseConnection(conn);
  }
}
