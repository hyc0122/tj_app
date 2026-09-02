import crypto from "node:crypto";

import { db } from "@/utils/db";
import { runWithProjectStorage } from "../runtime/user-storage-context";
import { upsertPendingMutationJournalInTrx } from "../runtime/legacy-mutation-journal";
import { CanvasRuntimeError, readCanvasDocument, sha256Text } from "./canvas-document-service";
import { registerCanvasResultAsset } from "./canvas-asset-service";
import { captureProviderRawEvent, markProviderRawEventProcessed } from "./canvas-provider-raw-inbox";
import { normalizeProviderEventPayload, redactFailure } from "./canvas-provider-event-normalizer";
import { canonicalizeJcs } from "./canvas-import-export-service";
import { downloadSafeRemoteMedia } from "../media/safe-remote-media";

export const PROGRESS_PERSIST_INTERVAL_MS = 30_000;
const lastProgressPersistAt = new Map<string, number>();
let progressNow = () => Date.now();

export function setCanvasProgressClock(fn: () => number): void {
  progressNow = fn;
}

const CRITICAL_STATES = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "confirmation_required",
  "succeeded",
  "waiting_for_origin_device",
]);

const STATE_RANK: Record<string, number> = {
  draft: 0,
  awaiting_confirmation: 1,
  waiting_for_origin_device: 2,
  queued: 3,
  leased: 4,
  submitting: 5,
  submitted: 6,
  running: 7,
  outcome_unknown: 7,
  succeeded: 8,
  failed: 8,
  canceled: 8,
  result_ready_conflict: 8,
};

export interface CanvasProviderEventInput {
  eventId: string;
  runId: string;
  projectUuid: string;
  providerId: string;
  accountId: string;
  deviceUuid: string;
  sequence: number;
  occurredAt: string;
  schemaVersion: number;
  status: string;
  failureText?: string;
  resultBytes?: Buffer;
  resultMime?: string;
  providerUrl?: string;
  progress?: number;
  ack?: boolean;
}

export interface CanvasProviderEventResult {
  applied: boolean;
  duplicate: boolean;
  assetUuid?: string;
}

function mapStatus(status: string): string {
  if (status === "cancelled" || status === "canceled") return "canceled";
  if (status === "completed") return "succeeded";
  if (status === "succeeded" || status === "failed" || status === "queued" || status === "running") return status;
  return "running";
}

async function ensureEventIndex(): Promise<void> {
  await db.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS canvas_execution_events_provider_run_event
    ON canvas_execution_events(provider_id, run_uuid, provider_event_id)
    WHERE provider_event_id IS NOT NULL
  `);
}

export async function ingestCanvasProviderEvent(input: CanvasProviderEventInput): Promise<CanvasProviderEventResult> {
  return runWithProjectStorage(input.projectUuid, () => ingestInProject(input));
}

async function ingestInProject(input: CanvasProviderEventInput): Promise<CanvasProviderEventResult> {
  await ensureEventIndex();
  const run = await db("canvas_node_runs").where({ run_uuid: input.runId }).first();
  if (!run) {
    throw new CanvasRuntimeError("CANVAS_CONFIRMATION_NOT_FOUND", "执行任务不存在或不可见", 404, false);
  }
  await captureProviderRawEvent({
    projectUuid: input.projectUuid,
    runUuid: input.runId,
    eventId: input.eventId,
    payload: {
      status: input.status,
      providerUrl: input.providerUrl,
      failureText: input.failureText,
    },
  });
  const payloadDigest = sha256Text(canonicalizeJcs({
    eventId: input.eventId,
    runId: input.runId,
    status: input.status,
    sequence: input.sequence,
    failureText: input.failureText ?? "",
  }));
  const existing = await db("canvas_execution_events").where({
    provider_id: input.providerId,
    run_uuid: input.runId,
    provider_event_id: input.eventId,
  }).first();
  if (existing) {
    await markProviderRawEventProcessed(input.projectUuid, input.runId, input.eventId);
    if (String(existing.payload_digest) === payloadDigest) {
      return { applied: false, duplicate: true };
    }
    return { applied: false, duplicate: false };
  }
  const nextState = mapStatus(input.status);
  const currentState = String(run.state);
  const shouldAdvance = (STATE_RANK[nextState] ?? 0) >= (STATE_RANK[currentState] ?? 0);
  const progressOnly = currentState === nextState && nextState === "running" && typeof input.progress === "number";
  const lastProgressAt = lastProgressPersistAt.get(input.runId) ?? 0;
  const nowMs = progressNow();
  if (progressOnly && nowMs - lastProgressAt < PROGRESS_PERSIST_INTERVAL_MS) {
    await markProviderRawEventProcessed(input.projectUuid, input.runId, input.eventId);
    return { applied: false, duplicate: false };
  }
  const criticalImmediate = currentState !== nextState && CRITICAL_STATES.has(nextState);
  if (!progressOnly && !criticalImmediate && currentState === nextState && !input.resultBytes && !input.providerUrl) {
    if (nowMs - lastProgressAt < PROGRESS_PERSIST_INTERVAL_MS) {
      await markProviderRawEventProcessed(input.projectUuid, input.runId, input.eventId);
      return { applied: false, duplicate: false };
    }
  }
  let resultBytes = input.resultBytes;
  if (!resultBytes?.length && input.providerUrl) {
    resultBytes = await downloadSafeRemoteMedia(input.providerUrl);
  }
  let assetUuid: string | undefined;
  if (resultBytes?.length) {
    const registered = await registerCanvasResultAsset(input.projectUuid, resultBytes, input.resultMime ?? "image/png");
    assetUuid = registered.assetUuid;
  }
  const normalized = normalizeProviderEventPayload({
    status: nextState,
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    progress: input.progress,
    assetUuid,
    failureText: input.failureText,
  });
  const now = new Date().toISOString();
  const currentDocument = assetUuid && shouldAdvance && nextState === "succeeded"
    ? await readCanvasDocument(input.projectUuid)
    : undefined;
  await db.transaction(async (trx) => {
    await trx("canvas_execution_events").insert({
      event_uuid: crypto.randomUUID(),
      run_uuid: input.runId,
      provider_id: input.providerId,
      provider_event_id: input.eventId,
      payload_digest: payloadDigest,
      payload_json: JSON.stringify(normalized),
      state: input.ack === false ? "received" : "processed",
      occurred_at: input.occurredAt,
      processed_at: input.ack === false ? null : now,
    });
    if (shouldAdvance) {
      await trx("canvas_node_runs").where({ run_uuid: input.runId }).update({
        state: nextState,
        failure_text: input.failureText ? redactFailure(input.failureText) : run.failure_text,
        updated_at: now,
      });
    }
    if (assetUuid && currentDocument) {
      const nodes = (currentDocument.document.graph.nodes ?? []) as Array<{ nodeUuid?: string; data?: Record<string, unknown> }>;
      const node = nodes.find((item) => item.nodeUuid === String(run.node_uuid));
      if (node) {
        node.data = { ...(node.data ?? {}), assetUuid };
        await trx("canvas_documents").where({ id: 1 }).update({
          graph_json: JSON.stringify({ ...currentDocument.document.graph, nodes }),
          updated_at: now,
        });
      }
    }
    await upsertPendingMutationJournalInTrx(trx, "canvas:execution-event");
  });
  await markProviderRawEventProcessed(input.projectUuid, input.runId, input.eventId);
  if (nextState === "running") {
    lastProgressPersistAt.set(input.runId, nowMs);
  }
  return { applied: true, duplicate: false, assetUuid };
}

export async function listCanvasExecutions(projectUuid: string): Promise<{ runs: Array<Record<string, unknown>> }> {
  const rows = await db("canvas_node_runs").select("*").orderBy("created_at", "asc");
  return {
    runs: rows.map((row) => ({
      runUuid: String(row.run_uuid),
      nodeUuid: String(row.node_uuid),
      state: String(row.state),
      projectUuid,
      sequence: Number(row.run_generation),
      failureText: row.failure_text ? String(row.failure_text) : "",
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    })),
  };
}

export type ProviderResultEventSink = typeof ingestCanvasProviderEvent;
