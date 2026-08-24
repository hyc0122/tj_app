import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { projectDirectory, resolveProjectFile } from "./paths";
import type { LegacyResourceTable } from "../runtime/legacy-project-guard";
import { assertNoImageBase64 } from "../media/media-safety";

export type ProjectOpenMode = "readonly" | "readwrite";

interface RecordRow {
  value_json: string;
}

const LEGACY_RESOURCE_TABLES = new Set<LegacyResourceTable>([
  "o_script",
  "o_assets",
  "o_storyboard",
  "o_novel",
  "o_videoTrack",
  "o_video",
  "o_imageFlow",
]);

export class ProjectStore {
  readonly databasePath: string;
  private database!: Database.Database;
  private mode: ProjectOpenMode;

  constructor(
    private readonly dataRoot: string,
    readonly projectUUID: string,
    mode: ProjectOpenMode,
    private readonly userSegment?: string,
  ) {
    const directory = userSegment
      ? projectDirectory(dataRoot, projectUUID, userSegment)
      : legacyProjectDirectory(dataRoot, projectUUID);
    if (mode === "readwrite") fs.mkdirSync(path.join(directory, "files"), { recursive: true });
    this.databasePath = path.join(directory, "project.sqlite");
    this.mode = mode;
    this.open();
  }

  setRecord(namespace: string, key: string, value: unknown): void {
    this.assertWritable();
    validateRecordKey(namespace, key);
    assertNoImageBase64(value, "项目记录");
    const serialized = JSON.stringify(value);
    const transaction = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO project_records(namespace, record_key, value_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(namespace, record_key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(namespace, key, serialized, new Date().toISOString());
    });
    transaction();
  }

  getRecord(namespace: string, key: string): unknown | undefined {
    validateRecordKey(namespace, key);
    const row = this.database.prepare(
      "SELECT value_json FROM project_records WHERE namespace = ? AND record_key = ?",
    ).get(namespace, key) as RecordRow | undefined;
    return row ? JSON.parse(row.value_json) : undefined;
  }

  resolveFile(relativePath: string): string {
    if (this.userSegment) {
      return resolveProjectFile(this.dataRoot, this.projectUUID, relativePath, this.userSegment);
    }
    return resolveLegacyProjectFile(this.dataRoot, this.projectUUID, relativePath);
  }

  hasLegacyResource(table: LegacyResourceTable, id: number): boolean {
    if (!LEGACY_RESOURCE_TABLES.has(table)) throw new Error("旧业务资源表不受支持");
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("旧业务资源 ID 无效");
    const exists = this.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (!exists) return false;
    // 表名来自上方固定白名单，ID 始终作为绑定参数，不接受请求拼接 SQL。
    return Boolean(this.database.prepare(`SELECT 1 FROM "${table}" WHERE id = ? LIMIT 1`).get(id));
  }

  switchMode(mode: ProjectOpenMode): void {
    if (mode === this.mode) return;
    this.database.close();
    this.mode = mode;
    this.open();
  }

  close(): void {
    if (this.database?.open !== false) this.database.close();
  }

  async backupTo(destination: string): Promise<void> {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // 使用 SQLite Backup API 获取一致的已提交快照，不能直接复制活跃 WAL 文件。
    await this.database.backup(destination);
  }

  private open(): void {
    this.database = new Database(this.databasePath, {
      readonly: this.mode === "readonly",
      fileMustExist: this.mode === "readonly",
    });
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    if (this.mode === "readwrite") {
      this.database.pragma("journal_mode = WAL");
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS project_records (
          namespace TEXT NOT NULL,
          record_key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(namespace, record_key)
        );
        CREATE TABLE IF NOT EXISTS project_metadata (
          metadata_key TEXT PRIMARY KEY,
          metadata_value TEXT NOT NULL
        );
        INSERT INTO project_metadata(metadata_key, metadata_value)
        VALUES ('project_uuid', '${this.projectUUID}')
        ON CONFLICT(metadata_key) DO NOTHING;
        PRAGMA user_version = 1;
      `);
    }
  }

  private assertWritable(): void {
    if (this.mode !== "readwrite") throw new Error("项目当前为只读模式");
  }
}

function legacyProjectDirectory(dataRoot: string, projectUUID: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(projectUUID)) throw new Error("项目 UUID 无效");
  return path.resolve(dataRoot, "projects", projectUUID);
}

function resolveLegacyProjectFile(dataRoot: string, projectUUID: string, relativePath: string): string {
  const filesRoot = path.join(legacyProjectDirectory(dataRoot, projectUUID), "files");
  const target = path.resolve(filesRoot, ...relativePath.split("/"));
  if (!target.startsWith(path.resolve(filesRoot) + path.sep)) throw new Error("项目文件相对路径无效");
  return target;
}

function validateRecordKey(namespace: string, key: string): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(namespace) || !/^[^\u0000-\u001f]{1,160}$/.test(key)) {
    throw new Error("项目记录键无效");
  }
}
