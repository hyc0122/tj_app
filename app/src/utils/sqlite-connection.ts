export interface SQLitePragmaConnection {
  pragma(statement: string): unknown;
  close(): void;
}

export type SQLiteAfterCreateDone = (
  error: Error | null,
  connection?: SQLitePragmaConnection,
) => void;

/**
 * 配置 Knex 创建的 better-sqlite3 原生连接。
 * 任一 PRAGMA 失败都必须先关闭原生句柄，否则 Windows 上会遗留 WAL/SHM 锁，
 * 让同一数据目录的下一次启动继续报 disk I/O error。
 */
export function configureSQLiteConnection(
  connection: SQLitePragmaConnection,
  done: SQLiteAfterCreateDone,
): void {
  try {
    connection.pragma("foreign_keys = ON");
    connection.pragma("journal_mode = WAL");
    connection.pragma("busy_timeout = 5000");
    done(null, connection);
  } catch (error) {
    try {
      connection.close();
    } catch {
      // 关闭失败不能覆盖最先发生的 SQLite 初始化错误。
    }
    done(error instanceof Error ? error : new Error(String(error)));
  }
}

const SQLITE_STARTUP_RETRY_DELAYS_MS = [50, 150] as const;
const RETRYABLE_SQLITE_STARTUP_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_IOERR_TRUNCATE",
]);

/** 只识别明确允许的 SQLite 瞬时错误，禁止把损坏、权限或普通 IOERR 自动重试掉。 */
export function isRetryableSQLiteStartupError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
    if (RETRYABLE_SQLITE_STARTUP_CODES.has(code)) return true;
    current = candidate.cause;
  }
  return false;
}

/**
 * 活动账号启动迁移的有限重试门。
 * 每次 attempt 必须自行创建并在失败时销毁全新句柄，避免复用已经失败的 Knex 池。
 */
export async function runWithSQLiteStartupRetry<T>(
  attempt: () => Promise<T>,
  wait: (delayMs: number) => Promise<void> = (delayMs) => new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  }),
): Promise<T> {
  for (let retryIndex = 0; ; retryIndex += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (
        !isRetryableSQLiteStartupError(error)
        || retryIndex >= SQLITE_STARTUP_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      await wait(SQLITE_STARTUP_RETRY_DELAYS_MS[retryIndex]);
    }
  }
}
