import Database from "better-sqlite3";

const MEDIA_DATA_URL = /data:(?:image|video|audio)\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/i;
const BARE_BASE64 = /^[a-z0-9+/]+={0,2}$/i;

/**
 * 发布前扫描 SQLite 所有文本列，禁止图片 Base64 进入项目版本和同步对象。
 */
export function assertSQLiteHasNoImageBase64(databasePath: string): void {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const quotedTable = quoteIdentifier(name);
      const columns = database.prepare(`PRAGMA table_info(${quotedTable})`).all() as Array<{
        name: string;
        type: string;
      }>;
      for (const column of columns) {
        if (!/CHAR|CLOB|TEXT|JSON/i.test(column.type || "TEXT")) continue;
        const quotedColumn = quoteIdentifier(column.name);
        const rows = database.prepare(
          `SELECT rowid AS rowId, ${quotedColumn} AS value FROM ${quotedTable} WHERE typeof(${quotedColumn}) = 'text'`,
        ).all() as Array<{ rowId?: number; value: string }>;
        for (const row of rows) {
          if (!containsImageBase64(row.value)) continue;
          throw new Error(`项目 SQLite 禁止持久化媒体 Base64: ${name}.${column.name} rowid=${row.rowId}`);
        }
      }
    }
  } finally {
    database.close();
  }
}

/**
 * 下载记录、同步 JSON 和日志值都必须在落盘或输出前递归检查。
 */
export function assertNoImageBase64(value: unknown, location = "同步数据"): void {
  const visited = new Set<object>();
  const walk = (current: unknown, path: string): void => {
    if (typeof current === "string") {
      if (containsImageBase64(current)) {
        throw new Error(`${location} 禁止包含媒体 Base64: ${path}`);
      }
      return;
    }
    if (!current || typeof current !== "object" || visited.has(current as object)) return;
    visited.add(current as object);
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      walk(item, `${path}.${key}`);
    }
  };
  walk(value, "$");
}

export function containsImageBase64(value: string): boolean {
  if (MEDIA_DATA_URL.test(value)) return true;
  const normalized = value.replace(/\s+/g, "");
  if (normalized.length < 64 || normalized.length % 4 !== 0 || !BARE_BASE64.test(normalized)) {
    return false;
  }
  try {
    const bytes = Buffer.from(normalized, "base64");
    if (bytes.length < 12 || bytes.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
      return false;
    }
    return (
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
      || ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
      || (bytes.subarray(0, 4).toString("ascii") === "RIFF"
        && bytes.subarray(8, 12).toString("ascii") === "WEBP")
      || bytes.subarray(0, 2).toString("ascii") === "BM"
      || bytes.subarray(0, 3).toString("ascii") === "ID3"
      || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
      || (bytes.subarray(0, 4).toString("ascii") === "RIFF"
        && bytes.subarray(8, 12).toString("ascii") === "WAVE")
      || bytes.subarray(0, 4).toString("ascii") === "OggS"
      || bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      || bytes.subarray(4, 8).toString("ascii") === "ftyp"
    );
  } catch {
    return false;
  }
}

export function sanitizeMediaLog(value: unknown): unknown {
  if (typeof value === "string") {
    if (containsImageBase64(value)) return "[REDACTED_MEDIA_DATA]";
    // 短签 URL 的查询串可能含签名、令牌和有效期，日志只保留对象路径。
    return value.replace(
      /(https:\/\/[^?\s"'<>]+)\?[^\s"'<>]*(?:signature|token|credential|expires)[^\s"'<>]*/gi,
      "$1?[REDACTED_SIGNED_QUERY]",
    );
  }
  if (Array.isArray(value)) return value.map(sanitizeMediaLog);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, sanitizeMediaLog(item)]),
    );
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}
