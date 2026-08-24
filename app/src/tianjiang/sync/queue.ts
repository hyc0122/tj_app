import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type SyncTaskType = "upload" | "download";
export type SyncTaskStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "cancelled"
  | "session_expired"
  | "completed"
  | "failed";

export interface EnqueueSyncTask {
  type: SyncTaskType;
  projectUUID: string;
  sessionExpiresAt: number;
}

export interface SyncTask {
  id: string;
  type: SyncTaskType;
  projectUUID: string;
  status: SyncTaskStatus;
  progress: {
    completed: number;
    total: number;
  };
  sessionExpiresAt: number;
  retryCount: number;
  nextAttemptAt: number;
  errorCode?: string;
}

interface SyncTaskRow {
  id: string;
  task_type: SyncTaskType;
  project_uuid: string;
  status: SyncTaskStatus;
  completed_bytes: number;
  total_bytes: number;
  session_expires_at: number;
  retry_count: number;
  next_attempt_at: number;
  error_code: string | null;
}

export class SyncQueue {
  private readonly database: Database.Database;

  constructor(
    databasePath: string,
    private readonly now: () => number = Date.now,
  ) {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sync_tasks (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL CHECK (task_type IN ('upload', 'download')),
        project_uuid TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_bytes INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        session_expires_at INTEGER NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sync_tasks_ready
        ON sync_tasks(status, next_attempt_at, created_at);
    `);
    this.expireSessions();
  }

  enqueue(input: EnqueueSyncTask): string {
    if (!input.projectUUID.trim()) throw new Error("同步任务项目标识不能为空");
    if (!Number.isFinite(input.sessionExpiresAt)) throw new Error("同步会话过期时间无效");
    const id = crypto.randomUUID();
    const current = this.now();
    const status: SyncTaskStatus = input.sessionExpiresAt <= current ? "session_expired" : "queued";
    this.database.prepare(`
      INSERT INTO sync_tasks(
        id, task_type, project_uuid, status, session_expires_at,
        next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.type,
      input.projectUUID,
      status,
      input.sessionExpiresAt,
      current,
      current,
      current,
    );
    return id;
  }

  get(id: string): SyncTask | undefined {
    const row = this.database.prepare("SELECT * FROM sync_tasks WHERE id = ?").get(id) as
      | SyncTaskRow
      | undefined;
    return row ? mapTask(row) : undefined;
  }

  updateProgress(id: string, completed: number, total: number): void {
    if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || completed < 0 || total < completed) {
      throw new Error("同步任务进度无效");
    }
    const result = this.database.prepare(`
      UPDATE sync_tasks
      SET completed_bytes = ?, total_bytes = ?, updated_at = ?
      WHERE id = ? AND status NOT IN ('cancelled', 'completed', 'failed', 'session_expired')
    `).run(completed, total, this.now(), id);
    if (result.changes !== 1) throw new Error("同步任务不存在或已结束");
  }

  fail(id: string, errorCode: string, retryable: boolean): void {
    const task = this.get(id);
    if (!task) throw new Error("同步任务不存在");
    if (["cancelled", "completed", "session_expired"].includes(task.status)) {
      throw new Error("同步任务已结束");
    }
    const current = this.now();
    const retryCount = task.retryCount + 1;
    // 退避上限为五分钟，应用重启后仍由数据库中的 next_attempt_at 继续等待。
    const retryDelay = Math.min(300_000, 1_000 * 2 ** Math.min(retryCount - 1, 8));
    this.database.prepare(`
      UPDATE sync_tasks
      SET status = ?, retry_count = ?, next_attempt_at = ?, error_code = ?, updated_at = ?
      WHERE id = ?
    `).run(
      retryable ? "retry_wait" : "failed",
      retryCount,
      retryable ? current + retryDelay : current,
      errorCode.slice(0, 128),
      current,
      id,
    );
  }

  cancel(id: string): void {
    const result = this.database.prepare(`
      UPDATE sync_tasks SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status NOT IN ('completed', 'failed', 'session_expired')
    `).run(this.now(), id);
    if (result.changes !== 1) throw new Error("同步任务不存在或已结束");
  }

  nextReady(): SyncTask | undefined {
    this.expireSessions();
    const current = this.now();
    const row = this.database.prepare(`
      SELECT * FROM sync_tasks
      WHERE status IN ('queued', 'retry_wait')
        AND next_attempt_at <= ?
        AND session_expires_at > ?
      ORDER BY created_at ASC
      LIMIT 1
    `).get(current, current) as SyncTaskRow | undefined;
    return row ? mapTask(row) : undefined;
  }

  markRunning(id: string): void {
    const current = this.now();
    const result = this.database.prepare(`
      UPDATE sync_tasks SET status = 'running', updated_at = ?
      WHERE id = ? AND status IN ('queued', 'retry_wait') AND session_expires_at > ?
    `).run(current, id, current);
    if (result.changes !== 1) throw new Error("同步任务当前不可执行");
  }

  complete(id: string): void {
    const result = this.database.prepare(`
      UPDATE sync_tasks
      SET status = 'completed', completed_bytes = total_bytes, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(this.now(), id);
    if (result.changes !== 1) throw new Error("同步任务当前不可完成");
  }

  /**
   * 退出时把 interrupted running 安全回退为 queued（产品语义 pending）。
   * 返回受影响行数。
   */
  requeueRunningAsPending(): number {
    const current = this.now();
    const result = this.database.prepare(`
      UPDATE sync_tasks
      SET status = 'queued', next_attempt_at = ?, updated_at = ?
      WHERE status = 'running'
    `).run(current, current);
    return Number(result.changes ?? 0);
  }

  /** 未完成任务数：queued / running / retry_wait（产品统称 pending）。 */
  countPending(): number {
    this.expireSessions();
    const row = this.database.prepare(`
      SELECT COUNT(1) AS c FROM sync_tasks
      WHERE status IN ('queued', 'running', 'retry_wait')
    `).get() as { c: number };
    return Number(row?.c ?? 0);
  }

  /** 同一项目是否仍有未结束的 upload 任务。 */
  hasActiveUpload(projectUUID: string): boolean {
    const row = this.database.prepare(`
      SELECT id FROM sync_tasks
      WHERE project_uuid = ?
        AND task_type = 'upload'
        AND status IN ('queued', 'running', 'retry_wait')
      LIMIT 1
    `).get(projectUUID) as { id: string } | undefined;
    return Boolean(row?.id);
  }

  /**
   * 幂等入队 upload：已有活跃任务则返回已有 id，避免重复与版本抖动。
   */
  ensureUploadQueued(projectUUID: string, sessionExpiresAt: number): string {
    if (!projectUUID.trim()) throw new Error("同步任务项目标识不能为空");
    if (!Number.isFinite(sessionExpiresAt)) throw new Error("同步会话过期时间无效");
    const ensure = this.database.transaction(() => {
      const current = this.now();
      const existing = this.database.prepare(`
        SELECT id, status FROM sync_tasks
        WHERE project_uuid = ?
          AND task_type = 'upload'
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `).get(projectUUID) as { id: string; status: SyncTaskStatus } | undefined;
      if (
        existing?.id
        && ["queued", "running", "retry_wait", "session_expired"].includes(existing.status)
      ) {
        const revived = existing.status === "session_expired" && sessionExpiresAt > current;
        const nextStatus: SyncTaskStatus = sessionExpiresAt <= current
          ? "session_expired"
          : revived
            ? "queued"
            : existing.status;
        // 中文注释：同账号新会话原地续期，包括已过期任务；复用任务 ID，禁止制造重复 upload。
        this.database.prepare(`
          UPDATE sync_tasks
          SET session_expires_at = ?, status = ?,
              next_attempt_at = CASE WHEN ? THEN ? ELSE next_attempt_at END,
              error_code = CASE WHEN ? THEN NULL ELSE error_code END,
              updated_at = ?
          WHERE id = ?
        `).run(
          sessionExpiresAt,
          nextStatus,
          revived ? 1 : 0,
          current,
          revived ? 1 : 0,
          current,
          existing.id,
        );
        return existing.id;
      }
      return this.enqueue({
        type: "upload",
        projectUUID,
        sessionExpiresAt,
      });
    });
    return ensure();
  }

  /**
   * 仅迁移旧版本遗留的通用 Error/SYNC_ERROR 终态。
   * 调用方必须先证明当前项目是 Personal 且仍有 journal/sidecar 待同步事实。
   */
  reviveLegacyGenericUploadFailure(
    projectUUID: string,
    sessionExpiresAt: number,
  ): string | undefined {
    if (!projectUUID.trim() || !Number.isFinite(sessionExpiresAt)) return undefined;
    const revive = this.database.transaction(() => {
      const latest = this.database.prepare(`
        SELECT id, status, error_code
        FROM sync_tasks
        WHERE project_uuid = ? AND task_type = 'upload'
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `).get(projectUUID) as {
        id: string;
        status: SyncTaskStatus;
        error_code: string | null;
      } | undefined;
      if (
        !latest
        || latest.status !== "failed"
        || !/^(Error|SYNC_ERROR)$/i.test(latest.error_code ?? "")
      ) {
        return undefined;
      }
      const current = this.now();
      if (sessionExpiresAt <= current) return undefined;
      const result = this.database.prepare(`
        UPDATE sync_tasks
        SET status = 'queued', session_expires_at = ?, retry_count = 0,
            next_attempt_at = ?, error_code = NULL, updated_at = ?
        WHERE id = ? AND status = 'failed'
      `).run(sessionExpiresAt, current, current, latest.id);
      return result.changes === 1 ? latest.id : undefined;
    });
    return revive();
  }

  /** Team 永不进入 Personal upload 队列；登录对账时终止历史活跃脏任务。 */
  terminalizeActiveUploadsForProject(projectUUID: string, errorCode: string): number {
    const current = this.now();
    const result = this.database.prepare(`
      UPDATE sync_tasks
      SET status = 'failed', next_attempt_at = ?, error_code = ?, updated_at = ?
      WHERE project_uuid = ? AND task_type = 'upload'
        AND status IN ('queued', 'running', 'retry_wait')
    `).run(current, errorCode.slice(0, 128), current, projectUUID);
    return Number(result.changes ?? 0);
  }

  /** 返回指定项目最新创建的 upload 任务；最新终态对更旧兄弟行具有权威性。 */
  getLatestUploadTask(projectUUID: string): SyncTask | undefined {
    const row = this.database.prepare(`
      SELECT * FROM sync_tasks
      WHERE project_uuid = ? AND task_type = 'upload'
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(projectUUID) as SyncTaskRow | undefined;
    return row ? mapTask(row) : undefined;
  }

  /**
   * 返回仍有效任务中最早的可执行时间，供进程内定时唤醒 retry_wait。
   * 仅查询持久化事实，不抢占任务，也不把过期会话继续调度。
   */
  nextRunnableAt(): number | undefined {
    this.expireSessions();
    const current = this.now();
    const row = this.database.prepare(`
      SELECT MIN(next_attempt_at) AS next_attempt_at
      FROM sync_tasks
      WHERE status IN ('queued', 'retry_wait')
        AND session_expires_at > ?
    `).get(current) as { next_attempt_at?: number | null } | undefined;
    if (row?.next_attempt_at == null) return undefined;
    const value = Number(row?.next_attempt_at);
    return Number.isFinite(value) ? value : undefined;
  }

  /**
   * 登录对账使用：返回仍可能恢复的 upload 项目，包括因旧会话过期而暂停的任务。
   * completed / cancelled / fatal failed 属于终态，不得被新登录静默复活。
   */
  listRecoverableUploadProjectUuids(): string[] {
    this.expireSessions();
    const rows = this.database.prepare(`
      WITH ranked AS (
        SELECT project_uuid, status,
               ROW_NUMBER() OVER (
                 PARTITION BY project_uuid
                 ORDER BY created_at DESC, rowid DESC
               ) AS authority_rank
        FROM sync_tasks
        WHERE task_type = 'upload'
      )
      SELECT project_uuid
      FROM ranked
      WHERE authority_rank = 1
        AND status IN ('queued', 'running', 'retry_wait', 'session_expired')
      ORDER BY project_uuid ASC
    `).all() as Array<{ project_uuid: string }>;
    return rows.map((row) => row.project_uuid);
  }

  /**
   * 原子领取下一条 ready 任务并标记 running。
   * 账号隔离依赖「每账号独立 queue 文件」，本方法不再跨库认领。
   */
  claimNextReady(): SyncTask | undefined {
    const ready = this.nextReady();
    if (!ready) return undefined;
    this.markRunning(ready.id);
    return this.get(ready.id);
  }

  /** 测试/恢复探测：列出未完成任务 id。 */
  listPendingIds(): string[] {
    this.expireSessions();
    const rows = this.database.prepare(`
      SELECT id FROM sync_tasks
      WHERE status IN ('queued', 'running', 'retry_wait')
      ORDER BY created_at ASC
    `).all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
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

  private expireSessions(): void {
    const current = this.now();
    this.database.prepare(`
      UPDATE sync_tasks
      SET status = 'session_expired', updated_at = ?
      WHERE session_expires_at <= ?
        AND status IN ('queued', 'running', 'retry_wait')
    `).run(current, current);
  }
}

function mapTask(row: SyncTaskRow): SyncTask {
  return {
    id: row.id,
    type: row.task_type,
    projectUUID: row.project_uuid,
    status: row.status,
    progress: {
      completed: row.completed_bytes,
      total: row.total_bytes,
    },
    sessionExpiresAt: row.session_expires_at,
    retryCount: row.retry_count,
    nextAttemptAt: row.next_attempt_at,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  };
}
