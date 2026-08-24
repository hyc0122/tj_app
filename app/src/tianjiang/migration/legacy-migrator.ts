import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { ProfileCrypto } from "../crypto/profile-crypto";
import { ProfileStore } from "../data/profile-store";
import { ProjectStore } from "../data/project-store";
import type { MigrationReport, MigrationTableReport } from "./migration-report";

interface LegacyMigratorOptions {
  databasePath: string;
  filesRoot: string;
  targetDataRoot: string;
  userUUID: string;
  userSegment: string;
  profileCrypto: ProfileCrypto;
  failAfterRows?: number;
  availableBytes?: number;
}

export class LegacyMigrator {
  constructor(private readonly options: LegacyMigratorOptions) {}

  async migrate(): Promise<MigrationReport> {
    const migrationId = crypto.randomUUID();
    const targetRoot = path.resolve(this.options.targetDataRoot);
    // 短暂存目录名，避免深层 runtime-users/projects 在 Windows 上触发 MAX_PATH。
    const stageRoot = path.join(targetRoot, `.ms-${migrationId}`);
    let database: Database.Database | undefined;
    const projectStores = new Map<string, ProjectStore>();
    let profileStore: ProfileStore | undefined;
    try {
      this.assertDiskSpace();
      fs.mkdirSync(stageRoot, { recursive: true });
      database = new Database(this.options.databasePath, { readonly: true, fileMustExist: true });
      const integrity = database.pragma("integrity_check") as Array<Record<string, string>>;
      if (!integrity.some((row) => Object.values(row).includes("ok"))) throw new Error("SQLite integrity_check 失败");

      const backupStage = path.join(stageRoot, "legacy", migrationId, "db2.sqlite.readonly.bak");
      fs.mkdirSync(path.dirname(backupStage), { recursive: true });
      await database.backup(backupStage);
      fs.chmodSync(backupStage, 0o444);

      profileStore = new ProfileStore(stageRoot, this.options.userUUID, this.options.profileCrypto);
      const tables = this.listTables(database);
      const tableReports: MigrationTableReport[] = [];
      const projectMappings = this.createProjectMappings(database, tables);
      let processedRows = 0;
      for (const table of tables) {
        const rows = this.readRows(database, table);
        const report = this.migrateTable(stageRoot, table, rows, projectMappings, profileStore, projectStores, migrationId, () => {
          processedRows++;
          if (this.options.failAfterRows && processedRows >= this.options.failAfterRows) {
            throw new Error("模拟迁移中断");
          }
        });
        tableReports.push(report);
      }
      const files = this.migrateFiles(stageRoot, migrationId, projectMappings, projectStores);
      profileStore.close();
      profileStore = undefined;
      for (const store of projectStores.values()) store.close();
      projectStores.clear();
      database.close();
      database = undefined;

      const createdPaths = this.publishStage(stageRoot, targetRoot, migrationId, projectMappings);
      const reportPath = path.join(targetRoot, "legacy", migrationId, "migration-report.json");
      const report: MigrationReport = {
        migrationId,
        sourceDatabase: path.resolve(this.options.databasePath),
        sourceIntegrity: "ok",
        backupPath: path.join(targetRoot, "legacy", migrationId, "db2.sqlite.readonly.bak"),
        reportPath,
        targetDataRoot: targetRoot,
        totalSourceRows: tableReports.reduce((sum, item) => sum + item.sourceRows, 0),
        totalAccountPasswordsMigrated: 0,
        tables: tableReports,
        files,
        projectMappings,
        createdPaths,
        completedAt: new Date().toISOString(),
      };
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
      return report;
    } catch (error) {
      profileStore?.close();
      for (const store of projectStores.values()) store.close();
      database?.close();
      try {
        // Windows 上句柄释放后 stage 目录仍可能短暂 EPERM；清理失败不得掩盖原始迁移错误。
        fs.rmSync(stageRoot, { recursive: true, force: true });
      } catch {
        // 忽略清理竞态，正式目录本就不会被切换。
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`迁移失败: ${message}`);
    }
  }

  async rollback(report: MigrationReport): Promise<void> {
    const root = path.resolve(report.targetDataRoot);
    if (root !== path.resolve(this.options.targetDataRoot) || report.migrationId.length < 16) {
      throw new Error("迁移回滚清单无效");
    }
    for (const created of [...report.createdPaths].reverse()) {
      const target = path.resolve(created);
      // 只允许删除迁移报告明确记录的 UUID/迁移 ID 叶子目录。
      if (!target.startsWith(root + path.sep) || target === root || path.dirname(target) === root) {
        throw new Error("迁移回滚目标越界");
      }
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  private listTables(database: Database.Database): string[] {
    return (database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
  }

  private readRows(database: Database.Database, table: string): Array<Record<string, unknown>> {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    return database.prepare(`SELECT * FROM ${quoted}`).all() as Array<Record<string, unknown>>;
  }

  private createProjectMappings(database: Database.Database, tables: string[]): Record<string, string> {
    if (!tables.includes("o_project")) return {};
    const mappings: Record<string, string> = {};
    for (const row of this.readRows(database, "o_project")) {
      const id = String(row.id);
      mappings[id] = deterministicProjectUUID(id);
    }
    return mappings;
  }

  private migrateTable(
    stageRoot: string,
    table: string,
    rows: Array<Record<string, unknown>>,
    mappings: Record<string, string>,
    profile: ProfileStore,
    projects: Map<string, ProjectStore>,
    migrationId: string,
    checkpoint: () => void,
  ): MigrationTableReport {
    let migratedRows = 0;
    let recoveryRows = 0;
    let excludedRows = 0;
    let classification: MigrationTableReport["classification"] = "recovery";
    const recoveryRowsData: Array<Record<string, unknown>> = [];

    for (const row of rows) {
      checkpoint();
      if (table === "o_user") {
        classification = "account_mapping";
        const { password: _excludedPassword, ...sanitized } = row;
        this.appendJSON(stageRoot, migrationId, "control/users.json", sanitized);
        migratedRows++;
      } else if (["o_setting", "o_vendor", "o_model"].includes(table)) {
        classification = "profile";
        profile.set(`legacy.${table}.${String(row.id)}`, JSON.stringify(row), true);
        migratedRows++;
      } else if (table === "o_project") {
        classification = "project_catalog";
        const projectUUID = mappings[String(row.id)];
        const store = this.projectStore(stageRoot, projectUUID, projects);
        store.setRecord("metadata", "legacy_project", row);
        migratedRows++;
      } else if (row.project_id !== undefined && mappings[String(row.project_id)]) {
        classification = "project_data";
        const store = this.projectStore(stageRoot, mappings[String(row.project_id)], projects);
        store.setRecord(`legacy_${sanitizeNamespace(table)}`, String(row.id ?? migratedRows), row);
        migratedRows++;
      } else {
        recoveryRowsData.push(row);
        recoveryRows++;
      }
    }
    if (recoveryRowsData.length) {
      const target = path.join(stageRoot, "recovery", migrationId, "tables", `${table}.json`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(recoveryRowsData, null, 2), "utf8");
    }
    return { table, sourceRows: rows.length, migratedRows, recoveryRows, excludedRows, classification };
  }

  private migrateFiles(
    stageRoot: string,
    migrationId: string,
    mappings: Record<string, string>,
    projects: Map<string, ProjectStore>,
  ): MigrationReport["files"] {
    const files = fs.existsSync(this.options.filesRoot) ? walkFiles(this.options.filesRoot) : [];
    const aggregate = crypto.createHash("md5");
    let sourceBytes = 0;
    let migratedCount = 0;
    let recoveryCount = 0;
    for (const source of files) {
      const relative = path.relative(this.options.filesRoot, source);
      const normalized = relative.split(path.sep).join("/");
      const content = fs.readFileSync(source);
      sourceBytes += content.length;
      aggregate.update(normalized).update("\0").update(content);
      const [legacyProjectID, ...rest] = normalized.split("/");
      if (mappings[legacyProjectID] && rest.length) {
        const store = this.projectStore(stageRoot, mappings[legacyProjectID], projects);
        const destination = store.resolveFile(rest.join("/"));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
        migratedCount++;
      } else {
        const destination = path.join(stageRoot, "recovery", migrationId, "files", ...normalized.split("/"));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
        recoveryCount++;
      }
    }
    return {
      sourceCount: files.length,
      sourceBytes,
      migratedCount,
      recoveryCount,
      aggregateMD5: aggregate.digest("hex"),
    };
  }

  private projectStore(stageRoot: string, projectUUID: string, stores: Map<string, ProjectStore>): ProjectStore {
    let store = stores.get(projectUUID);
    if (!store) {
      store = new ProjectStore(stageRoot, projectUUID, "readwrite", this.options.userSegment);
      stores.set(projectUUID, store);
    }
    return store;
  }

  private appendJSON(stageRoot: string, migrationId: string, relative: string, row: Record<string, unknown>): void {
    const target = path.join(stageRoot, "recovery", migrationId, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const existing = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) as unknown[] : [];
    existing.push(row);
    fs.writeFileSync(target, JSON.stringify(existing, null, 2), "utf8");
  }

  private publishStage(stageRoot: string, targetRoot: string, migrationId: string, mappings: Record<string, string>): string[] {
    const created: string[] = [];
    const moves: Array<[string, string]> = [
      [path.join(stageRoot, "users", this.options.userUUID), path.join(targetRoot, "users", this.options.userUUID)],
      [path.join(stageRoot, "legacy", migrationId), path.join(targetRoot, "legacy", migrationId)],
      [path.join(stageRoot, "recovery", migrationId), path.join(targetRoot, "recovery", migrationId)],
      ...Object.values(mappings).map((projectUUID) => [
        path.join(stageRoot, "runtime-users", this.options.userSegment, "projects", projectUUID),
        path.join(targetRoot, "runtime-users", this.options.userSegment, "projects", projectUUID),
      ] as [string, string]),
    ];
    for (const [source, destination] of moves) {
      if (!fs.existsSync(source)) continue;
      if (fs.existsSync(destination)) throw new Error(`目标已存在: ${destination}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(source, destination);
      created.push(destination);
    }
    fs.rmSync(stageRoot, { recursive: true, force: true });
    return created;
  }

  private assertDiskSpace(): void {
    if (this.options.availableBytes === undefined) return;
    const databaseBytes = fs.existsSync(this.options.databasePath) ? fs.statSync(this.options.databasePath).size : 0;
    const fileBytes = fs.existsSync(this.options.filesRoot)
      ? walkFiles(this.options.filesRoot).reduce((sum, file) => sum + fs.statSync(file).size, 0)
      : 0;
    if (this.options.availableBytes < (databaseBytes + fileBytes) * 2) throw new Error("磁盘空间不足");
  }
}

function deterministicProjectUUID(legacyID: string): string {
  const hex = crypto.createHash("sha256").update(`tianjiang-legacy-project:${legacyID}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sanitizeNamespace(table: string): string {
  return table.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 48);
}

function walkFiles(root: string): string[] {
  const output: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(target));
    else if (entry.isFile()) output.push(target);
  }
  return output.sort();
}
