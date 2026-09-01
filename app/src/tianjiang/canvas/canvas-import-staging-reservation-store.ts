import type { Knex } from "knex";

import { CANVAS_LIMITS } from "../contracts";

function stagingError(errorCode: string, message: string, status: number, retryable: boolean): never {
  throw Object.assign(new Error(message), { errorCode, status, retryable, name: "CanvasRuntimeError" });
}

export async function migrateCanvasAccountStagingReservations(
  database: Knex | Knex.Transaction,
): Promise<void> {
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_import_staging_reservations (
      reservation_uuid TEXT PRIMARY KEY,
      project_uuid TEXT NOT NULL,
      client_mutation_id TEXT NOT NULL UNIQUE,
      lease_epoch INTEGER NOT NULL,
      declared_hold_bytes INTEGER NOT NULL,
      received_bytes INTEGER NOT NULL,
      expanded_bytes INTEGER NOT NULL,
      reserved_bytes INTEGER NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

function reservedBytes(declared: number, received: number, expanded: number): number {
  return Math.max(declared, received) + expanded;
}

export async function reserveCanvasImportStaging(input: {
  projectUuid: string;
  clientMutationId: string;
  archiveSizeBytes: number;
}): Promise<{ reservationUuid: string; leaseEpoch: number }> {
  if (!Number.isSafeInteger(input.archiveSizeBytes) || input.archiveSizeBytes < 0) {
    stagingError("CANVAS_IMPORT_REQUEST_INVALID", "便携画布导入请求不合法", 422, false);
  }
  const { accountDb } = await import("@/utils/db");
  return accountDb.transaction(async (trx) => {
    const existing = await trx("canvas_import_staging_reservations")
      .where({ client_mutation_id: input.clientMutationId })
      .first();
    if (existing) {
      return {
        reservationUuid: String(existing.reservation_uuid),
        leaseEpoch: Number(existing.lease_epoch),
      };
    }
    const usedRow = await trx("canvas_import_staging_reservations").sum({ total: "reserved_bytes" }).first();
    const used = Number((usedRow as { total?: number } | undefined)?.total ?? 0);
    const next = reservedBytes(input.archiveSizeBytes, 0, 0);
    if (used + next > CANVAS_LIMITS.MAX_CANVAS_ACCOUNT_STAGING_BYTES) {
      stagingError("CANVAS_STAGING_STORAGE_LIMIT", "账号暂存配额或磁盘余量不足", 507, true);
    }
    const now = new Date().toISOString();
    const reservationUuid = crypto.randomUUID();
    await trx("canvas_import_staging_reservations").insert({
      reservation_uuid: reservationUuid,
      project_uuid: input.projectUuid,
      client_mutation_id: input.clientMutationId,
      lease_epoch: 1,
      declared_hold_bytes: input.archiveSizeBytes,
      received_bytes: 0,
      expanded_bytes: 0,
      reserved_bytes: next,
      state: "active",
      created_at: now,
      updated_at: now,
    });
    return { reservationUuid, leaseEpoch: 1 };
  });
}

export async function releaseCanvasImportStaging(clientMutationId: string): Promise<void> {
  const { accountDb } = await import("@/utils/db");
  await accountDb("canvas_import_staging_reservations").where({
    client_mutation_id: clientMutationId,
  }).del();
}
