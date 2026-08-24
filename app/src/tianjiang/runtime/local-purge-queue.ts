/**
 * 账号本地 durable 队列：中央删除成功后，本地清理失败时持久化 local_purge 待办。
 * 与 upload/download 同步队列分表存放，避免破坏既有 CHECK 约束。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface LocalPurgeTask {
  id: string;
  projectUuid: string;
  status: "queued" | "retry_wait" | "completed" | "failed";
  retryCount: number;
  nextAttemptAt: number;
  errorCode?: string;
}

export class LocalPurgeQueue {
  private readonly database: Database.Database;

  constructor(
    databasePath: string,
    private readonly now: () => number = Date.now,
  ) {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS local_purge_tasks (
        id TEXT PRIMARY KEY,
        project_uuid TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_purge_ready
        ON local_purge_tasks(status, next_attempt_at);
    `);
  }

  /** 幂等入队：同一 project_uuid 已有待办则刷新为可重试。 */
  enqueue(projectUuid: string): string {
    const uuid = projectUuid.trim().toLowerCase();
    if (!uuid) throw new Error("清理任务项目标识不能为空");
    const current = this.now();
    const existing = this.database.prepare(
      "SELECT id FROM local_purge_tasks WHERE project_uuid = ? AND status IN ('queued', 'retry_wait')",
    ).get(uuid) as { id?: string } | undefined;
    if (existing?.id) {
      this.database.prepare(`
        UPDATE local_purge_tasks
        SET status = 'queued', next_attempt_at = ?, updated_at = ?
        WHERE id = ?
      `).run(current, current, existing.id);
      return existing.id;
    }
    const id = crypto.randomUUID();
    this.database.prepare(`
      INSERT INTO local_purge_tasks(
        id, project_uuid, status, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, 'queued', ?, ?, ?)
    `).run(id, uuid, current, current, current);
    return id;
  }

  nextReady(): LocalPurgeTask | undefined {
    const current = this.now();
    const row = this.database.prepare(`
      SELECT * FROM local_purge_tasks
      WHERE status IN ('queued', 'retry_wait') AND next_attempt_at <= ?
      ORDER BY created_at ASC LIMIT 1
    `).get(current) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : undefined;
  }

  complete(projectUuid: string): void {
    this.database.prepare(`
      UPDATE local_purge_tasks
      SET status = 'completed', updated_at = ?
      WHERE project_uuid = ? AND status IN ('queued', 'retry_wait')
    `).run(this.now(), projectUuid.toLowerCase());
  }

  fail(projectUuid: string, errorCode: string, retryable: boolean): void {
    const task = this.database.prepare(
      "SELECT * FROM local_purge_tasks WHERE project_uuid = ? AND status IN ('queued', 'retry_wait')",
    ).get(projectUuid.toLowerCase()) as Record<string, unknown> | undefined;
    if (!task) return;
    const retryCount = Number(task.retry_count ?? 0) + 1;
    const delay = Math.min(300_000, 1_000 * 2 ** Math.min(retryCount - 1, 8));
    const current = this.now();
    this.database.prepare(`
      UPDATE local_purge_tasks
      SET status = ?, retry_count = ?, next_attempt_at = ?, error_code = ?, updated_at = ?
      WHERE id = ?
    `).run(
      retryable ? "retry_wait" : "failed",
      retryCount,
      retryable ? current + delay : current,
      String(errorCode).slice(0, 128),
      current,
      String(task.id),
    );
  }

  pendingProjectUuids(): string[] {
    const rows = this.database.prepare(`
      SELECT project_uuid FROM local_purge_tasks
      WHERE status IN ('queued', 'retry_wait')
    `).all() as Array<{ project_uuid: string }>;
    return rows.map((row) => row.project_uuid);
  }

  close(): void {
    try {
      // Windows 下未 checkpoint 的 WAL 句柄会导致目录删除 EPERM。
      this.database.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // checkpoint 失败仍继续 close
    }
    this.database.close();
  }
}

function mapRow(row: Record<string, unknown>): LocalPurgeTask {
  return {
    id: String(row.id),
    projectUuid: String(row.project_uuid),
    status: row.status as LocalPurgeTask["status"],
    retryCount: Number(row.retry_count ?? 0),
    nextAttemptAt: Number(row.next_attempt_at ?? 0),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
  };
}
