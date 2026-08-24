import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Knex } from "knex";

export interface SqliteMigration {
  version: number;
  name: string;
  checksumSource: string;
  compatibleChecksumSources?: string[];
  up(database: Knex | Knex.Transaction): Promise<void>;
}

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

export interface SqliteMigrationResult {
  appliedVersions: number[];
  backupPath?: string;
}

interface MigrateOptions {
  database: Knex;
  databasePath: string;
  migrations: SqliteMigration[];
  backup?: (databasePath: string, currentVersion: number) => Promise<string>;
}

/**
 * SQLite 版本迁移总入口。
 * 校验、备份、逐版本事务和版本记录顺序固定，任何一步失败都禁止继续启动。
 */
export async function migrateSQLite(options: MigrateOptions): Promise<SqliteMigrationResult> {
  validateDefinitions(options.migrations);
  // 每个迁移连接先启用统一 SQLite 安全/并发参数，再读取任何版本状态。
  await options.database.raw("PRAGMA foreign_keys = ON");
  await options.database.raw("PRAGMA journal_mode = WAL");
  await options.database.raw("PRAGMA busy_timeout = 5000");
  const hasMigrationTable = await options.database.schema.hasTable("schema_migrations");
  const applied = hasMigrationTable
    ? await options.database<AppliedMigrationRow>("schema_migrations").orderBy("version")
    : [];
  const definedByVersion = new Map(options.migrations.map((migration) => [
    migration.version,
    { migration, checksum: migrationChecksum(migration) },
  ]));
  for (const row of applied) {
    const defined = definedByVersion.get(Number(row.version));
    if (!defined) throw new Error(`数据库包含未知迁移版本: ${row.version}`);
    const compatibleChecksums = new Set([
      defined.checksum,
      ...(defined.migration.compatibleChecksumSources ?? [])
        .map((source) => migrationChecksum({
          ...defined.migration,
          checksumSource: source,
        })),
    ]);
    if (
      defined.migration.name !== row.name
      || !compatibleChecksums.has(row.checksum)
    ) {
      throw new Error(`SQLite 迁移校验和漂移: version=${row.version} name=${row.name}`);
    }
  }

  const appliedVersions = new Set(applied.map((row) => Number(row.version)));
  const pending = options.migrations.filter((migration) => !appliedVersions.has(migration.version));
  if (pending.length === 0) return { appliedVersions: [] };

  const currentVersion = applied.length === 0 ? 0 : Math.max(...appliedVersions);
  const backup = options.backup ?? backupDatabase;
  // 迁移表本身也属于写入；必须先完成一致性备份再创建。
  const backupPath = await backup(options.databasePath, currentVersion);

  if (!hasMigrationTable) {
    await options.database.schema.createTable("schema_migrations", (table) => {
      table.integer("version").primary();
      table.text("name").notNullable();
      table.text("checksum").notNullable();
      table.text("applied_at").notNullable();
    });
  }

  const completed: number[] = [];
  for (const migration of pending) {
    const checksum = migrationChecksum(migration);
    await options.database.transaction(async (trx) => {
      await migration.up(trx);
      await trx("schema_migrations").insert({
        version: migration.version,
        name: migration.name,
        checksum,
        applied_at: new Date().toISOString(),
      });
    });
    completed.push(migration.version);
  }
  return { appliedVersions: completed, backupPath };
}

export function migrationChecksum(migration: SqliteMigration): string {
  return crypto
    .createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.checksumSource}`)
    .digest("hex");
}

/** Windows 深路径：为 better-sqlite3 / fs 启用 \\?\ 长路径前缀 */
function winLongPath(target: string): string {
  if (process.platform !== "win32") return target;
  const resolved = path.resolve(target);
  if (resolved.startsWith("\\\\?\\")) return resolved;
  if (resolved.startsWith("\\\\")) return `\\\\?\\UNC\\${resolved.slice(2)}`;
  return `\\\\?\\${resolved}`;
}

async function backupDatabase(databasePath: string, currentVersion: number): Promise<string> {
  const absolute = path.resolve(databasePath);
  if (!fs.existsSync(absolute)) throw new Error("SQLite 迁移源数据库不存在");
  const backupDirectory = path.join(path.dirname(absolute), "migration-backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  // 短备份文件名：完整 basename+ISO 时间戳在深嵌套 Windows 路径上会触发 MAX_PATH。
  const timestamp = Date.now().toString(36);
  const destination = path.join(
    backupDirectory,
    `v${currentVersion}-${timestamp}.sqlite`,
  );
  // 中文注释：长工作树路径下必须用 \\?\，否则 Backup API 报 SQLITE_CANTOPEN
  const source = new Database(winLongPath(absolute), { fileMustExist: true });
  try {
    // 使用 SQLite Backup API，确保活跃 WAL 中已提交内容也进入唯一迁移备份。
    await source.backup(winLongPath(destination));
  } finally {
    source.close();
  }
  fs.writeFileSync(winLongPath(`${destination}.json`), JSON.stringify({
    source: path.basename(absolute),
    version: currentVersion,
    createdAt: new Date().toISOString(),
  }, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  return destination;
}

function validateDefinitions(migrations: SqliteMigration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.version)
      || migration.version <= previous
      || !/^[a-z0-9][a-z0-9_-]{1,79}$/i.test(migration.name)
      || migration.checksumSource.length === 0
      || migration.compatibleChecksumSources?.some((source) => source.length === 0)
    ) {
      throw new Error("SQLite 迁移定义无效或版本未严格递增");
    }
    previous = migration.version;
  }
}
