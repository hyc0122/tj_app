import Database from "better-sqlite3";

import { canvasExecutionOutboxPath, migrateCanvasExecutionOutbox } from "./canvas-execution-outbox-migration";

export interface CanvasOutboxRow {
  intentUuid: string;
  projectUuid: string;
  runUuid: string;
  batchUuid: string;
  originDeviceUuid: string;
  immutableRequestJson: string;
  requestDigest: string;
  providerIdempotencyKey: string;
  providerId: string;
  deploymentKey: string;
  credentialSlotId: string;
  state: string;
}

export function openCanvasExecutionOutbox(): Database.Database {
  migrateCanvasExecutionOutbox();
  return new Database(canvasExecutionOutboxPath());
}

export function upsertCanvasOutboxRow(row: CanvasOutboxRow): void {
  const db = openCanvasExecutionOutbox();
  try {
    db.prepare(`
      INSERT INTO canvas_execution_outbox (
        intent_uuid, project_uuid, run_uuid, batch_uuid, origin_device_uuid,
        immutable_request_json, request_digest, provider_idempotency_key,
        provider_id, deployment_key, credential_slot_id,
        submission_generation, attempt, state
      ) VALUES (
        @intentUuid, @projectUuid, @runUuid, @batchUuid, @originDeviceUuid,
        @immutableRequestJson, @requestDigest, @providerIdempotencyKey,
        @providerId, @deploymentKey, @credentialSlotId,
        1, 0, @state
      )
      ON CONFLICT(intent_uuid) DO NOTHING
    `).run(row);
  } finally {
    db.close();
  }
}

export function getCanvasOutboxByIdentity(projectUuid: string, intentUuid: string, runUuid: string): CanvasOutboxRow | undefined {
  const db = openCanvasExecutionOutbox();
  try {
    const row = db.prepare(`
      SELECT intent_uuid as intentUuid, project_uuid as projectUuid, run_uuid as runUuid,
             batch_uuid as batchUuid, origin_device_uuid as originDeviceUuid,
             immutable_request_json as immutableRequestJson, request_digest as requestDigest,
             provider_idempotency_key as providerIdempotencyKey,
             provider_id as providerId, deployment_key as deploymentKey,
             credential_slot_id as credentialSlotId, state
      FROM canvas_execution_outbox
      WHERE project_uuid = ? AND intent_uuid = ? AND run_uuid = ?
    `).get(projectUuid, intentUuid, runUuid) as CanvasOutboxRow | undefined;
    return row;
  } finally {
    db.close();
  }
}

export function getCanvasOutboxByRun(projectUuid: string, runUuid: string): CanvasOutboxRow | undefined {
  const database = openCanvasExecutionOutbox();
  try {
    return database.prepare(`
      SELECT intent_uuid as intentUuid, project_uuid as projectUuid, run_uuid as runUuid,
             batch_uuid as batchUuid, origin_device_uuid as originDeviceUuid,
             immutable_request_json as immutableRequestJson, request_digest as requestDigest,
             provider_idempotency_key as providerIdempotencyKey,
             provider_id as providerId, deployment_key as deploymentKey,
             credential_slot_id as credentialSlotId, state
      FROM canvas_execution_outbox
      WHERE project_uuid = ? AND run_uuid = ?
    `).get(projectUuid, runUuid) as CanvasOutboxRow | undefined;
  } finally {
    database.close();
  }
}

export function listReadyCanvasOutbox(projectUuid: string): CanvasOutboxRow[] {
  const database = openCanvasExecutionOutbox();
  try {
    return database.prepare(`
      SELECT intent_uuid as intentUuid, project_uuid as projectUuid, run_uuid as runUuid,
             batch_uuid as batchUuid, origin_device_uuid as originDeviceUuid,
             immutable_request_json as immutableRequestJson, request_digest as requestDigest,
             provider_idempotency_key as providerIdempotencyKey,
             provider_id as providerId, deployment_key as deploymentKey,
             credential_slot_id as credentialSlotId, state
      FROM canvas_execution_outbox
      WHERE project_uuid = ? AND state = 'ready'
      ORDER BY rowid ASC
    `).all(projectUuid) as CanvasOutboxRow[];
  } finally {
    database.close();
  }
}

export function listPendingCanvasOutboxProjectUuids(): string[] {
  const database = openCanvasExecutionOutbox();
  try {
    const rows = database.prepare(`
      SELECT DISTINCT project_uuid as projectUuid
      FROM canvas_execution_outbox
      WHERE state IN ('ready','leased','submitting','submitted','running','outcome_unknown')
        AND project_uuid <> ''
    `).all() as Array<{ projectUuid: string }>;
    return rows.map((row) => row.projectUuid);
  } finally {
    database.close();
  }
}

export function updateCanvasOutboxState(
  projectUuid: string,
  intentUuid: string,
  runUuid: string,
  state: string,
): void {
  const database = openCanvasExecutionOutbox();
  try {
    database.prepare(`
      UPDATE canvas_execution_outbox SET state = ?
      WHERE project_uuid = ? AND intent_uuid = ? AND run_uuid = ?
    `).run(state, projectUuid, intentUuid, runUuid);
  } finally {
    database.close();
  }
}
