import crypto from "node:crypto";
import Database from "better-sqlite3";

import { MAX_CANVAS_RAW_PROVIDER_INBOX_BYTES, MAX_PROVIDER_FAILURE_BYTES } from "../contracts";
import { currentUserStorage } from "../runtime/user-storage-context";
import { encryptRawInboxPayload, decryptRawInboxPayload } from "./canvas-provider-raw-inbox-crypto";
import { canvasProviderRawInboxPath, migrateCanvasProviderRawInbox } from "./canvas-provider-raw-inbox-migration";

let consumerStopped = false;
let nowFn = () => Date.now();
let testLimits: { ttlMs: number; quotaBytes: number; maxEventBytes: number } | undefined;

export const RAW_INBOX_TTL_MS = 24 * 60 * 60 * 1000;

export function resumeRawInboxConsumer(): void {
  consumerStopped = false;
  try {
    const db = openInbox();
    try {
      purgeExpiredAndOverflow(db, 0);
    } finally {
      db.close();
    }
  } catch {
    // 中文注释：无账号上下文时不创建 inbox。
  }
}

export function stopRawInboxConsumer(): void {
  consumerStopped = true;
}

export function isRawInboxConsumerStopped(): boolean {
  return consumerStopped;
}

export function setRawInboxClock(fn: () => number): void {
  nowFn = fn;
}

export function setRawInboxLimitsForTest(limits: {
  ttlMs: number;
  quotaBytes: number;
  maxEventBytes: number;
}): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("禁止在生产注入 raw inbox 限额");
  }
  testLimits = limits;
}

function ttlMs(): number {
  return testLimits?.ttlMs ?? RAW_INBOX_TTL_MS;
}

function quotaBytes(): number {
  return testLimits?.quotaBytes ?? MAX_CANVAS_RAW_PROVIDER_INBOX_BYTES;
}

function maxEventBytes(): number {
  return testLimits?.maxEventBytes ?? MAX_PROVIDER_FAILURE_BYTES;
}

function openInbox(): Database.Database {
  migrateCanvasProviderRawInbox();
  return new Database(canvasProviderRawInboxPath());
}

function envelopeByteLength(envelopeJson: string): number {
  return Buffer.byteLength(envelopeJson, "utf8");
}

function purgeExpiredAndOverflow(db: Database.Database, incomingBytes: number): Database.Database {
  const cutoff = new Date(nowFn() - ttlMs()).toISOString();
  // 中文注释：仅已处理/已清除记录允许按 TTL 删除，未处理事件属于付费任务恢复证据。
  db.prepare(`
    DELETE FROM canvas_provider_raw_inbox
    WHERE state = 'purged' OR (state = 'processed' AND created_at < ?)
  `).run(cutoff);
  const rows = db.prepare(`
    SELECT record_id as recordId, envelope_json as envelopeJson, created_at as createdAt, state
    FROM canvas_provider_raw_inbox
    ORDER BY created_at ASC, record_id ASC
  `).all() as Array<{ recordId: string; envelopeJson: string; createdAt: string; state: string }>;
  let used = rows.reduce((sum, row) => sum + envelopeByteLength(row.envelopeJson), 0);
  for (const row of rows) {
    if (used + incomingBytes <= quotaBytes()) break;
    if (row.state !== "processed" && row.state !== "purged") continue;
    db.prepare(`DELETE FROM canvas_provider_raw_inbox WHERE record_id = ?`).run(row.recordId);
    used -= envelopeByteLength(row.envelopeJson);
  }
  if (used + incomingBytes > quotaBytes()) {
    throw new Error("raw inbox 账号配额已满，未处理恢复证据已保留");
  }
  return db;
}

/** 中文注释：主任务状态与产物已经事务提交后，才允许 raw 事件进入可回收状态。 */
export async function markProviderRawEventProcessed(
  projectUuid: string,
  runUuid: string,
  eventId: string,
): Promise<void> {
  const db = openInbox();
  try {
    db.prepare(`
      UPDATE canvas_provider_raw_inbox
      SET state = 'processed'
      WHERE project_uuid = ? AND run_uuid = ? AND event_id = ?
    `).run(projectUuid, runUuid, eventId);
  } finally {
    db.close();
  }
}

export function listRawInboxRecords(): Array<{
  eventId: string;
  envelopeBytes: number;
  createdAt: string;
  state: string;
}> {
  const db = openInbox();
  try {
    const rows = db.prepare(`
      SELECT event_id as eventId, envelope_json as envelopeJson, created_at as createdAt, state
      FROM canvas_provider_raw_inbox
      WHERE state != 'purged'
      ORDER BY created_at ASC
    `).all() as Array<{ eventId: string; envelopeJson: string; createdAt: string; state: string }>;
    return rows.map((row) => ({
      eventId: row.eventId,
      envelopeBytes: envelopeByteLength(row.envelopeJson),
      createdAt: row.createdAt,
      state: row.state,
    }));
  } finally {
    db.close();
  }
}

export async function captureProviderRawEvent(input: {
  projectUuid: string;
  runUuid: string;
  eventId: string;
  payload: unknown;
}): Promise<{ recordId: string; state: string; duplicate?: boolean }> {
  if (consumerStopped) {
    throw new Error("raw inbox 已停止消费");
  }
  const payloadBytes = Buffer.from(JSON.stringify(input.payload), "utf8");
  if (payloadBytes.length > maxEventBytes()) {
    throw new Error("raw inbox 单事件超过大小上限");
  }
  const digest = crypto.createHash("sha256").update(payloadBytes).digest("hex");
  const db = openInbox();
  try {
    const existing = db.prepare(`
      SELECT record_id as recordId, state FROM canvas_provider_raw_inbox
      WHERE project_uuid = ? AND run_uuid = ? AND event_id = ?
    `).get(input.projectUuid, input.runUuid, input.eventId) as { recordId?: string; state?: string } | undefined;
    if (existing?.recordId) {
      return { recordId: existing.recordId, state: String(existing.state), duplicate: true };
    }
    const aad = JSON.stringify({
      account: currentUserStorage()?.userId ?? 0,
      projectUuid: input.projectUuid,
      runUuid: input.runUuid,
      eventId: input.eventId,
      digest,
      schema: 1,
    });
    const envelope = encryptRawInboxPayload(payloadBytes, aad);
    const envelopeJson = JSON.stringify({ ...envelope, aad });
    const incoming = envelopeByteLength(envelopeJson);
    if (incoming > quotaBytes()) {
      throw new Error("raw inbox 单事件超过账号配额");
    }
    purgeExpiredAndOverflow(db, incoming);
    const recordId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO canvas_provider_raw_inbox (
        record_id, project_uuid, run_uuid, event_id, payload_digest, envelope_json, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'captured', ?)
    `).run(
      recordId,
      input.projectUuid,
      input.runUuid,
      input.eventId,
      digest,
      envelopeJson,
      new Date(nowFn()).toISOString(),
    );
    return { recordId, state: "captured" };
  } finally {
    db.close();
  }
}

export async function readProviderRawEvent(projectUuid: string, runUuid: string, eventId: string): Promise<unknown> {
  const db = openInbox();
  try {
    const row = db.prepare(`
      SELECT envelope_json as envelopeJson FROM canvas_provider_raw_inbox
      WHERE project_uuid = ? AND run_uuid = ? AND event_id = ?
    `).get(projectUuid, runUuid, eventId) as { envelopeJson?: string } | undefined;
    if (!row?.envelopeJson) throw new Error("raw inbox 记录不存在或不可见");
    const envelope = JSON.parse(row.envelopeJson) as {
      nonce: string;
      ciphertext: string;
      tag: string;
      aad: string;
    };
    return JSON.parse(decryptRawInboxPayload(envelope, envelope.aad).toString("utf8"));
  } finally {
    db.close();
  }
}
