import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import getPath from "@/utils/getPath";
import { currentUserStorage, userStorageRoot } from "../runtime/user-storage-context";

/** 中文注释：raw inbox 只落在当前账号设备本地根，禁止进入项目库存。 */
export function canvasProviderRawInboxPath(): string {
  const ctx = currentUserStorage();
  if (!ctx) throw new Error("缺少中央用户存储上下文");
  return path.join(userStorageRoot(getPath(), ctx), "canvas-provider-raw-inbox.sqlite");
}

export function migrateCanvasProviderRawInbox(databasePath = canvasProviderRawInboxPath()): void {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS canvas_provider_raw_inbox (
        record_id TEXT PRIMARY KEY,
        project_uuid TEXT NOT NULL,
        run_uuid TEXT NOT NULL,
        event_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'captured','normalized','received','asset_ready','processed','purged'
        )),
        created_at TEXT NOT NULL,
        UNIQUE (project_uuid, run_uuid, event_id)
      )
    `);
  } finally {
    db.close();
  }
}
