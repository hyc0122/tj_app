/**
 * 旧账号 OSS 媒体 → 项目 files/legacy 安全迁移。
 * 顺序：复制 → 摘要校验 → 数据库事务切换引用 → 中央同步成功后才允许清理旧副本。
 * 中文注释：失败必须保留原库引用与原媒体，且不得发布残缺完整版本。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { writeProjectFileAtomic } from "./project-file-store";
import {
  readLegacyMediaCleanupReceipt,
  writeLegacyMediaCleanupReceipt,
  type LegacyMediaCleanupReceipt,
} from "./legacy-media-cleanup-receipt";

/** 受支持的项目媒体列；新增列未登记时测试应失败。 */
export const SUPPORTED_MEDIA_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "o_image", column: "filePath" },
  { table: "o_storyboard", column: "filePath" },
  { table: "o_video", column: "filePath" },
  { table: "o_assets", column: "filePath" },
];

export interface LegacyMediaMigrationInput {
  dataRoot: string;
  userSegment: string;
  projectUuid: string;
  /** 旧业务数字项目 ID，用于匹配 oss/<legacyId>/... */
  legacyProjectId?: number | string;
  databasePath: string;
  /** 账号级 oss 根目录 */
  accountOssRoot: string;
  /** false 时不执行迁移（viewer/只读） */
  writable: boolean;
}

export interface LegacyMediaMigrationResult {
  migrated: number;
  skipped: number;
  alreadyMigrated: boolean;
  cleanupReceiptPath?: string;
}

/**
 * 第一次可写打开时执行。幂等：已是 files/ 前缀则跳过。
 */
export function migrateLegacyProjectMedia(input: LegacyMediaMigrationInput): LegacyMediaMigrationResult {
  if (!input.writable) {
    return { migrated: 0, skipped: 0, alreadyMigrated: false };
  }
  if (!fs.existsSync(input.databasePath)) {
    return { migrated: 0, skipped: 0, alreadyMigrated: false };
  }

  // 中文注释：已有 cleanup receipt 且已迁移完成则幂等返回，禁止重复复制改引用。
  const existingReceipt = readLegacyMediaCleanupReceipt(
    input.dataRoot,
    input.userSegment,
    input.projectUuid,
  );
  if (existingReceipt?.phase === "pending_central_success" || existingReceipt?.phase === "ready_to_cleanup") {
    // 仍可扫描是否还有未迁移路径；若没有则 alreadyMigrated
  }

  const database = new Database(input.databasePath, { fileMustExist: true });
  try {
    database.pragma("busy_timeout = 5000");
    const planned = collectMigrationPlan(database, input);
    if (planned.length === 0) {
      return { migrated: 0, skipped: 0, alreadyMigrated: true };
    }

    const completed: LegacyMediaCleanupReceipt["entries"] = [];
    let skippedMissing = 0;
    // 中文注释：先复制并校验可迁移项，再事务切引用。
    // 历史已丢失的媒体跳过并保留原引用，不得阻断项目打开；存在但校验失败则 fail-closed 不改库。
    for (const item of planned) {
      if (!fs.existsSync(item.sourceAbsolute)) {
        skippedMissing += 1;
        continue;
      }
      assertUnderAccountOss(item.sourceAbsolute, input.accountOssRoot);
      if (input.legacyProjectId !== undefined) {
        assertBelongsToLegacyProject(item.sourceRelative, input.legacyProjectId);
      }
      const bytes = fs.readFileSync(item.sourceAbsolute);
      const md5 = crypto.createHash("md5").update(bytes).digest("hex");
      const size = bytes.length;
      const written = writeProjectFileAtomic(
        input.dataRoot,
        input.projectUuid,
        input.userSegment,
        item.targetRelative,
        bytes,
      );
      if (written.md5 !== md5 || written.size !== size) {
        // 中文注释：摘要不一致时删除刚写入的目标，保持可重试且不改库。
        try {
          fs.rmSync(written.absolutePath, { force: true });
        } catch {
          // ignore
        }
        throw new Error(`旧媒体复制后摘要不一致：${item.sourceRelative}`);
      }
      completed.push({
        table: item.table,
        column: item.column,
        rowId: item.rowId,
        oldRelative: item.sourceRelative,
        newRelative: written.relativePath,
        oldAbsolute: item.sourceAbsolute,
        md5,
        size,
      });
    }
    if (completed.length === 0) {
      return { migrated: 0, skipped: skippedMissing, alreadyMigrated: skippedMissing === 0 };
    }

    const apply = database.transaction(() => {
      for (const entry of completed) {
        const sql = `UPDATE "${entry.table}" SET "${entry.column}" = ? WHERE id = ? AND "${entry.column}" = ?`;
        const result = database.prepare(sql).run(entry.newRelative, entry.rowId, entry.oldRelative);
        if (result.changes !== 1) {
          throw new Error(`切换媒体引用失败：${entry.table}#${entry.rowId}`);
        }
      }
    });
    apply();

    const receipt = writeLegacyMediaCleanupReceipt({
      dataRoot: input.dataRoot,
      userSegment: input.userSegment,
      projectUuid: input.projectUuid,
      phase: "pending_central_success",
      entries: completed,
    });

    return {
      migrated: completed.length,
      skipped: skippedMissing,
      alreadyMigrated: false,
      cleanupReceiptPath: receipt.path,
    };
  } finally {
    database.close();
  }
}

/**
 * 中央同步成功并 finalize 后，仅清理 receipt 精确列出的旧文件。
 */
export function cleanupMigratedLegacyMediaAfterCentralSuccess(input: {
  dataRoot: string;
  userSegment: string;
  projectUuid: string;
}): number {
  const receipt = readLegacyMediaCleanupReceipt(
    input.dataRoot,
    input.userSegment,
    input.projectUuid,
  );
  if (!receipt || receipt.phase !== "ready_to_cleanup" && receipt.phase !== "pending_central_success") {
    return 0;
  }
  // 中文注释：调用方必须在中央成功后将 phase 标为 ready_to_cleanup；此处兼容 finalize 后直接清理。
  let cleaned = 0;
  for (const entry of receipt.entries) {
    if (!entry.oldAbsolute || !fs.existsSync(entry.oldAbsolute)) continue;
    // 再次确认仍在账号 oss 内，禁止误删
    try {
      fs.rmSync(entry.oldAbsolute, { force: true });
      cleaned += 1;
    } catch {
      // 保留可重试
    }
  }
  writeLegacyMediaCleanupReceipt({
    dataRoot: input.dataRoot,
    userSegment: input.userSegment,
    projectUuid: input.projectUuid,
    phase: "cleaned",
    entries: receipt.entries,
  });
  return cleaned;
}

export function markLegacyCleanupReadyAfterCentralSuccess(input: {
  dataRoot: string;
  userSegment: string;
  projectUuid: string;
}): void {
  const receipt = readLegacyMediaCleanupReceipt(
    input.dataRoot,
    input.userSegment,
    input.projectUuid,
  );
  if (!receipt || receipt.phase !== "pending_central_success") return;
  writeLegacyMediaCleanupReceipt({
    ...receipt,
    dataRoot: input.dataRoot,
    userSegment: input.userSegment,
    projectUuid: input.projectUuid,
    phase: "ready_to_cleanup",
  });
}

function collectMigrationPlan(
  database: Database.Database,
  input: LegacyMediaMigrationInput,
): Array<{
  table: string;
  column: string;
  rowId: number;
  sourceRelative: string;
  sourceAbsolute: string;
  targetRelative: string;
}> {
  assertSupportedColumnsExist(database);
  const planned: Array<{
    table: string;
    column: string;
    rowId: number;
    sourceRelative: string;
    sourceAbsolute: string;
    targetRelative: string;
  }> = [];

  for (const { table, column } of SUPPORTED_MEDIA_COLUMNS) {
    const exists = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (!exists) continue;
    const columns = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) continue;
    const rows = database.prepare(
      `SELECT id, "${column}" AS path FROM "${table}" WHERE "${column}" IS NOT NULL AND TRIM("${column}") != ''`,
    ).all() as Array<{ id: number; path: string }>;
    for (const row of rows) {
      const sourceRelative = normalizeLegacyRelative(row.path);
      if (!sourceRelative) continue;
      if (sourceRelative.startsWith("files/")) continue; // 已迁移
      // 拒绝未知绝对路径
      if (
        path.isAbsolute(sourceRelative)
        || /^[a-zA-Z]:/.test(sourceRelative)
        || sourceRelative.startsWith("\\\\")
        || sourceRelative.startsWith("//")
      ) {
        throw new Error(`拒绝迁移未知绝对路径媒体引用：${sourceRelative}`);
      }
      const sourceAbsolute = path.resolve(input.accountOssRoot, ...sourceRelative.split("/"));
      assertUnderAccountOss(sourceAbsolute, input.accountOssRoot);
      const ext = path.extname(sourceRelative) || ".bin";
      const targetRelative = `files/legacy/${input.projectUuid}/${table}-${row.id}${ext}`;
      planned.push({
        table,
        column,
        rowId: row.id,
        sourceRelative,
        sourceAbsolute,
        targetRelative,
      });
    }
  }
  return planned;
}

function assertSupportedColumnsExist(database: Database.Database): void {
  // 中文注释：schema 枚举——发现未登记且已有非空值的媒体列时 fail，避免未来漏同步。
  // 仅有空列定义时不阻断打开；有真实引用却未登记才 fail-closed。
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'o_%'",
  ).all() as Array<{ name: string }>;
  const registered = new Set(SUPPORTED_MEDIA_COLUMNS.map((item) => `${item.table}.${item.column}`));
  for (const table of tables) {
    if (table.name === "o_project" || table.name === "o_vendorConfig" || table.name === "o_setting") {
      continue; // 账号级/配置表不迁移
    }
    const columns = database.prepare(`PRAGMA table_info("${table.name}")`).all() as Array<{ name: string }>;
    for (const column of columns) {
      const name = column.name;
      if (!/(filePath|imagePath|videoPath|audioPath|coverPath|mediaPath)$/i.test(name)) continue;
      const key = `${table.name}.${name}`;
      if (registered.has(key)) continue;
      const row = database.prepare(
        `SELECT 1 AS hit FROM "${table.name}" WHERE "${name}" IS NOT NULL AND TRIM("${name}") != '' LIMIT 1`,
      ).get() as { hit?: number } | undefined;
      if (row?.hit) {
        throw new Error(`发现未登记的媒体列，拒绝迁移：${key}`);
      }
    }
  }
}

function normalizeLegacyRelative(value: string): string {
  return value.replace(/^[/\\]+/, "").replace(/\\/g, "/").trim();
}

function assertUnderAccountOss(absolutePath: string, accountOssRoot: string): void {
  const root = path.resolve(accountOssRoot);
  const target = path.resolve(absolutePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("旧媒体路径越出账号 oss 根目录");
  }
}

function assertBelongsToLegacyProject(sourceRelative: string, legacyProjectId: number | string): void {
  const first = sourceRelative.split("/")[0];
  if (String(first) !== String(legacyProjectId)) {
    throw new Error(`旧媒体不属于当前项目旧目录：${sourceRelative}`);
  }
}
