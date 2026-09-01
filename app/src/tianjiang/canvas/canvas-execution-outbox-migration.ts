import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import getPath from "@/utils/getPath";
import { currentUserStorage, userStorageRoot } from "../runtime/user-storage-context";

/** 中文注释：设备 outbox 在账号本地根，文件名 canvas-execution-outbox.sqlite，禁止进入项目库存。 */
export function canvasExecutionOutboxPath(): string {
  const ctx = currentUserStorage();
  if (!ctx) throw new Error("缺少中央用户存储上下文");
  return path.join(userStorageRoot(getPath(), ctx), "canvas-execution-outbox.sqlite");
}

export function migrateCanvasExecutionOutbox(databasePath = canvasExecutionOutboxPath()): void {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS canvas_execution_outbox (
        intent_uuid TEXT PRIMARY KEY,
        project_uuid TEXT NOT NULL,
        run_uuid TEXT NOT NULL,
        batch_uuid TEXT NOT NULL,
        origin_device_uuid TEXT NOT NULL,
        immutable_request_json TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        provider_idempotency_key TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        deployment_key TEXT NOT NULL,
        credential_slot_id TEXT NOT NULL,
        quote_id TEXT,
        quote_expires_at TEXT,
        quote_amount_minor TEXT,
        quote_maximum_amount_minor TEXT,
        quote_currency TEXT,
        quote_minor_unit INTEGER,
        submission_generation INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        dispatch_started_at TEXT,
        remote_task_id TEXT,
        attempt INTEGER NOT NULL,
        next_attempt_at TEXT,
        state TEXT NOT NULL CHECK (state IN (
          'ready','leased','submitting','submitted','running','succeeded','failed','canceled','outcome_unknown'
        )),
        UNIQUE (project_uuid, run_uuid)
      )
    `);
  } finally {
    db.close();
  }
}
