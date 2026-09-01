import crypto from "node:crypto";
import type { Knex } from "knex";

import { db } from "@/utils/db";
import { upsertPendingMutationJournalInTrx } from "../runtime/legacy-mutation-journal";
import { CANVAS_LIMITS } from "../contracts";
import { emptyCanvasDocument, serializeCanvasGraph, type CanvasDocument } from "./canvas-contracts";
import { RuntimePermissionError } from "../runtime/sync-coordinator";

export class CanvasRuntimeError extends Error {
  readonly status: number;
  readonly errorCode: string;
  readonly retryable: boolean;

  constructor(errorCode: string, message: string, status: number, retryable = false) {
    super(message);
    this.name = "CanvasRuntimeError";
    this.errorCode = errorCode;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface CanvasDocumentEnvelope {
  projectUuid: string;
  revision: number;
  updatedAt: string;
  document: CanvasDocument;
}

export interface SaveCanvasDocumentOptions {
  actor?: string;
  homeInitializationState?: "pending" | "consumed" | "disabled";
  /** 中文注释：与文档 CAS 同事务提交计划/回执，避免崩溃后出现半应用状态。 */
  afterSaveInTransaction?: (
    trx: Knex.Transaction,
    saved: CanvasDocumentEnvelope,
  ) => Promise<void>;
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function payloadBytes(graph: string, viewport: string, preferences: string): number {
  return Buffer.byteLength(graph, "utf8") + Buffer.byteLength(viewport, "utf8") + Buffer.byteLength(preferences, "utf8");
}

function parseRow(projectUuid: string, row: {
  revision: number;
  graph_json: string;
  viewport_json: string;
  preferences_json: string;
  updated_at: string;
}): CanvasDocumentEnvelope {
  return {
    projectUuid,
    revision: Number(row.revision),
    updatedAt: String(row.updated_at),
    document: {
      schemaVersion: 1,
      graph: JSON.parse(String(row.graph_json)),
      viewport: JSON.parse(String(row.viewport_json)),
      preferences: JSON.parse(String(row.preferences_json)),
    },
  };
}

export async function readCanvasDocument(projectUuid: string): Promise<CanvasDocumentEnvelope> {
  const row = await db("canvas_documents").where({ id: 1 }).first();
  if (!row) {
    const empty = emptyCanvasDocument();
    return {
      projectUuid,
      revision: 0,
      updatedAt: new Date().toISOString(),
      document: empty,
    };
  }
  return parseRow(projectUuid, row as never);
}

export async function saveCanvasDocument(
  projectUuid: string,
  input: { baseRevision: number; clientMutationId: string; document: CanvasDocument },
  actorOrOptions: string | SaveCanvasDocumentOptions = "canvas-owner",
): Promise<CanvasDocumentEnvelope> {
  const options = typeof actorOrOptions === "string"
    ? { actor: actorOrOptions }
    : actorOrOptions;
  const actor = options.actor ?? "canvas-owner";
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0) {
    throw new CanvasRuntimeError("CANVAS_REVISION_CONFLICT", "画布文档版本已变化", 409, true);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.clientMutationId)) {
    throw new CanvasRuntimeError("PERMISSION_DENIED", "项目不存在或不可见", 403, false);
  }
  const graph = serializeCanvasGraph(input.document?.graph ?? { nodes: [], edges: [] });
  const document: CanvasDocument = {
    schemaVersion: 1,
    graph,
    viewport: input.document?.viewport ?? { x: 0, y: 0, zoom: 1 },
    preferences: input.document?.preferences ?? { wheelMode: "zoom", snapToGrid: true, gridSize: 16 },
  };
  const graphJson = JSON.stringify(document.graph);
  const viewportJson = JSON.stringify(document.viewport);
  const preferencesJson = JSON.stringify(document.preferences);
  if (Buffer.byteLength(graphJson, "utf8") > CANVAS_LIMITS.MAX_CANVAS_GRAPH_JSON_BYTES) {
    throw new CanvasRuntimeError("CANVAS_BODY_TOO_LARGE", "请求体超过画布上限", 413, false);
  }
  const requestDigest = sha256Text(JSON.stringify({
    baseRevision: input.baseRevision,
    document,
  }));
  const envelope = await db.transaction(async (trx) => {
    const existing = await trx("canvas_document_mutations").where({
      client_mutation_id: input.clientMutationId,
    }).first();
    if (existing) {
      if (String(existing.request_digest) !== requestDigest) {
        throw new CanvasRuntimeError(
          "CANVAS_MUTATION_IDEMPOTENCY_CONFLICT",
          "相同文档变更 ID 的摘要与首次请求不一致",
          409,
          false,
        );
      }
      return JSON.parse(String(existing.response_json)) as CanvasDocumentEnvelope;
    }
    const current = await trx("canvas_documents").where({ id: 1 }).first();
    const currentRevision = Number(current?.revision ?? 0);
    if (currentRevision !== input.baseRevision) {
      throw new CanvasRuntimeError("CANVAS_REVISION_CONFLICT", "画布文档版本已变化", 409, true);
    }
    const nextRevision = currentRevision + 1;
    const updatedAt = new Date().toISOString();
    const affected = await trx("canvas_documents").where({ id: 1, revision: input.baseRevision }).update({
      revision: nextRevision,
      graph_json: graphJson,
      viewport_json: viewportJson,
      preferences_json: preferencesJson,
      home_initialization_state: options.homeInitializationState
        ?? (current?.home_initialization_state === "pending" ? "disabled" : current?.home_initialization_state),
      updated_at: updatedAt,
    });
    if (Number(affected) !== 1) {
      throw new CanvasRuntimeError("CANVAS_REVISION_CONFLICT", "画布文档版本已变化", 409, true);
    }
    const bytes = payloadBytes(graphJson, viewportJson, preferencesJson);
    await enforceRevisionBudget(trx, bytes);
    const revisionUuid = crypto.randomUUID();
    await trx("canvas_revisions").insert({
      revision_uuid: revisionUuid,
      document_revision: nextRevision,
      graph_json: graphJson,
      viewport_json: viewportJson,
      preferences_json: preferencesJson,
      snapshot_kind: "manual",
      payload_bytes: bytes,
      document_sha256: sha256Text(graphJson + viewportJson + preferencesJson),
      is_pinned: 0,
      pin_reason: null,
      pinned_at: null,
      created_by: actor,
      created_at: updatedAt,
    });
    const saved: CanvasDocumentEnvelope = {
      projectUuid,
      revision: nextRevision,
      updatedAt,
      document,
    };
    await trx("canvas_document_mutations").insert({
      client_mutation_id: input.clientMutationId,
      request_digest: requestDigest,
      base_revision: input.baseRevision,
      applied_revision: nextRevision,
      response_json: JSON.stringify(saved),
      created_at: updatedAt,
    });
    if (options.afterSaveInTransaction) {
      await options.afterSaveInTransaction(trx, saved);
    }
    await upsertPendingMutationJournalInTrx(trx, "canvas:document");
    return saved;
  });
  try {
    const { syncCoordinator } = await import("../runtime/runtime");
    syncCoordinator.markLegacyMutation(projectUuid);
  } catch {
    // 中文注释：业务事务已提交，markEdited 失败不得回滚，启动恢复从 journal 唤醒。
  }
  return envelope;
}

async function enforceRevisionBudget(trx: typeof db, incomingBytes: number): Promise<void> {
  const rows = await trx("canvas_revisions").select("payload_bytes", "is_pinned");
  const used = rows.reduce((sum, row) => sum + Number(row.payload_bytes ?? 0), 0) + incomingBytes;
  if (used <= CANVAS_LIMITS.MAX_CANVAS_REVISION_TOTAL_BYTES) return;
  const unpinned = await trx("canvas_revisions").where({ is_pinned: 0 }).orderBy("created_at", "asc");
  let current = used;
  for (const row of unpinned) {
    if (current <= CANVAS_LIMITS.MAX_CANVAS_REVISION_TOTAL_BYTES) break;
    await trx("canvas_revisions").where({ revision_uuid: row.revision_uuid }).del();
    current -= Number(row.payload_bytes ?? 0);
  }
  if (current > CANVAS_LIMITS.MAX_CANVAS_REVISION_TOTAL_BYTES) {
    throw new CanvasRuntimeError("CANVAS_REVISION_STORAGE_LIMIT", "画布历史占用已达到硬上限", 507, false);
  }
}

export async function listCanvasRevisions(): Promise<Array<{
  revisionUuid: string;
  documentRevision: number;
  snapshotKind: string;
  isPinned: boolean;
  createdAt: string;
}>> {
  const rows = await db("canvas_revisions").select(
    "revision_uuid",
    "document_revision",
    "snapshot_kind",
    "is_pinned",
    "created_at",
  ).orderBy("document_revision", "desc");
  return rows.map((row) => ({
    revisionUuid: String(row.revision_uuid),
    documentRevision: Number(row.document_revision),
    snapshotKind: String(row.snapshot_kind),
    isPinned: Number(row.is_pinned) === 1,
    createdAt: String(row.created_at),
  }));
}

export async function restoreCanvasRevision(
  projectUuid: string,
  revisionUuid: string,
  input: { baseRevision: number; clientMutationId: string },
): Promise<CanvasDocumentEnvelope> {
  const row = await db("canvas_revisions").where({ revision_uuid: revisionUuid }).first();
  if (!row) throw new RuntimePermissionError("项目不存在或不可见", "PERMISSION_DENIED");
  const document: CanvasDocument = {
    schemaVersion: 1,
    graph: JSON.parse(String(row.graph_json)),
    viewport: JSON.parse(String(row.viewport_json)),
    preferences: JSON.parse(String(row.preferences_json)),
  };
  return saveCanvasDocument(projectUuid, {
    baseRevision: input.baseRevision,
    clientMutationId: input.clientMutationId,
    document,
  });
}

export { sha256Text };
