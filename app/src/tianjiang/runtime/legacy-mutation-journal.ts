/**
 * 项目库 o_legacyMutationJournal：与 artifact 同事务的权威 mutation 事实。
 * - generation 单调递增；中央确认后仅清除 <= capturedGeneration
 * - captured：0=快照无 pending；正整数=已捕获；unknown 禁止 finalize
 * - 禁止 undefined 清全部；探测仅 ENOENT 视为 missing
 * - 上传快照必须从副本读 generation 后再剥离 journal
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Knex } from "knex";

export type MutationJournalStatus = "pending" | "cleared";

/** 快照捕获的 mutation generation 状态 */
export type MutationCapture =
  | { kind: "none"; value: 0 }
  | { kind: "captured"; value: number }
  | { kind: "unknown"; reason: string };

export type MutationJournalProbe =
  | {
      ok: true;
      pending: boolean;
      maxGeneration: number | null;
      missing?: boolean;
    }
  | {
      ok: false;
      reason: "locked" | "corrupt" | "unreadable";
      pending: true;
      maxGeneration: null;
    };

export type ClearJournalOptions = {
  /** 必须显式给出；0=不清除任何正整数 generation；禁止省略 */
  captured: number;
};

/** 在已有 knex 事务中插入新的 pending generation（与 plan 产物同事务） */
export async function upsertPendingMutationJournalInTrx(
  trx: Knex.Transaction,
  source = "scriptAgent",
): Promise<number> {
  const now = Date.now();
  // 中文注释：每次真实 artifact 提交插入新 generation，禁止覆盖旧 pending
  const maxRow = await trx("o_legacyMutationJournal").max("generation as maxGen").first();
  const maxGen = Number((maxRow as { maxGen?: number | null } | undefined)?.maxGen ?? 0);
  const generation = (Number.isFinite(maxGen) ? maxGen : 0) + 1;
  await trx("o_legacyMutationJournal").insert({
    source,
    status: "pending",
    generation,
    createdAt: now,
    updatedAt: now,
  });
  return generation;
}

/** 清除 generation <= maxGeneration 的 pending（须显式 maxGeneration） */
export async function clearPendingMutationJournalInTrx(
  trx: Knex.Transaction | Knex,
  maxGeneration: number,
): Promise<void> {
  if (!Number.isFinite(maxGeneration) || maxGeneration < 0) {
    throw new Error("清理 journal 必须提供有效 captured generation");
  }
  const now = Date.now();
  await trx("o_legacyMutationJournal")
    .where({ status: "pending" })
    .andWhere("generation", "<=", maxGeneration)
    .update({ status: "cleared", updatedAt: now });
}

export async function hasPendingMutationJournal(db: Knex): Promise<boolean> {
  if (!(await db.schema.hasTable("o_legacyMutationJournal"))) return false;
  const row = await db("o_legacyMutationJournal").where({ status: "pending" }).first();
  return Boolean(row);
}

export async function maxPendingMutationGeneration(db: Knex): Promise<number | null> {
  if (!(await db.schema.hasTable("o_legacyMutationJournal"))) return null;
  const row = await db("o_legacyMutationJournal")
    .where({ status: "pending" })
    .max("generation as maxGen")
    .first();
  const v = Number((row as { maxGen?: number | null } | undefined)?.maxGen);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function isMissingFileError(err: unknown): boolean {
  if (err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT") {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  // better-sqlite3 在 fileMustExist 时可能不带 ENOENT code
  return /ENOENT|no such file|does not exist|cannot open database because the directory does not exist/i.test(
    msg,
  );
}

/**
 * 直接打开 project.sqlite 探测 pending journal。
 * 仅明确 ENOENT（含 stat）视为 missing；禁止 existsSync 捷径，其余 fail-closed。
 */
export function probeProjectMutationJournal(databasePath: string): MutationJournalProbe {
  try {
    fs.statSync(databasePath);
  } catch (err) {
    if (isMissingFileError(err)) {
      return { ok: true, pending: false, maxGeneration: null, missing: true };
    }
    return { ok: false, reason: "unreadable", pending: true, maxGeneration: null };
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const table = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("o_legacyMutationJournal") as { ok?: number } | undefined;
    if (!table) {
      return { ok: true, pending: false, maxGeneration: null };
    }
    const cols = db.prepare("PRAGMA table_info(o_legacyMutationJournal)").all() as Array<{
      name: string;
    }>;
    const hasGen = cols.some((c) => c.name === "generation");
    if (!hasGen) {
      // 中文注释：无 generation 列须经显式迁移；探测时 fail-closed 禁止伪报无 pending
      return { ok: false, reason: "unreadable", pending: true, maxGeneration: null };
    }
    const row = db
      .prepare(
        "SELECT MAX(generation) AS maxGen FROM o_legacyMutationJournal WHERE status = ?",
      )
      .get("pending") as { maxGen?: number | null } | undefined;
    const maxGen = row?.maxGen != null ? Number(row.maxGen) : null;
    const pending = maxGen != null && Number.isFinite(maxGen) && maxGen > 0;
    return {
      ok: true,
      pending,
      maxGeneration: pending ? maxGen : null,
    };
  } catch (err) {
    if (isMissingFileError(err)) {
      return { ok: true, pending: false, maxGeneration: null, missing: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    const reason =
      /locked|busy|SQLITE_BUSY/i.test(msg)
        ? "locked"
        : /not a database|malformed|corrupt/i.test(msg)
          ? "corrupt"
          : "unreadable";
    return { ok: false, reason, pending: true, maxGeneration: null };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/** @deprecated 使用 probeProjectMutationJournal */
export function projectFileHasPendingMutationJournal(databasePath: string): boolean {
  const probe = probeProjectMutationJournal(databasePath);
  return probe.pending === true;
}

/**
 * 从任意 sqlite 文件读取 mutation capture（用于 snapshot 副本，禁止 backup 后读 live）。
 */
export function readMutationCaptureFromSqliteFile(databasePath: string): MutationCapture {
  const probe = probeProjectMutationJournal(databasePath);
  if (!probe.ok) {
    return { kind: "unknown", reason: probe.reason };
  }
  if (probe.missing) {
    return { kind: "none", value: 0 };
  }
  if (!probe.pending || probe.maxGeneration == null) {
    return { kind: "none", value: 0 };
  }
  if (!Number.isFinite(probe.maxGeneration) || probe.maxGeneration <= 0) {
    return { kind: "unknown", reason: "invalid_generation" };
  }
  return { kind: "captured", value: probe.maxGeneration };
}

/**
 * 清除 live 库中 generation <= captured 的 pending。
 * 必须显式 options.captured；禁止省略（旧「清全部」语义已删除）。
 */
export function clearPendingMutationJournalOnFile(
  databasePath: string,
  options?: ClearJournalOptions | number,
): { cleared: number; remainingPending: number; maxRemaining: number | null } {
  let captured: number | undefined;
  if (typeof options === "number") {
    captured = options;
  } else if (options && typeof options === "object" && "captured" in options) {
    const c = (options as ClearJournalOptions).captured;
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0) {
      throw new Error("清理 journal 必须提供有效 captured generation（含 0）");
    }
    captured = c;
  } else {
    throw new Error("清理 journal 禁止省略 captured；生产不得清全部 pending");
  }

  try {
    fs.statSync(databasePath);
  } catch (err) {
    if (isMissingFileError(err)) {
      return { cleared: 0, remainingPending: 0, maxRemaining: null };
    }
    throw err instanceof Error ? err : new Error("访问项目 journal 失败");
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(databasePath, { fileMustExist: true });
  } catch (err) {
    if (isMissingFileError(err)) {
      return { cleared: 0, remainingPending: 0, maxRemaining: null };
    }
    throw err instanceof Error ? err : new Error("打开项目 journal 失败");
  }
  try {
    const table = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("o_legacyMutationJournal");
    if (!table) {
      return { cleared: 0, remainingPending: 0, maxRemaining: null };
    }
    const cols = db.prepare("PRAGMA table_info(o_legacyMutationJournal)").all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "generation")) {
      throw new Error("o_legacyMutationJournal 缺少 generation 列，须先迁移");
    }
    const now = Date.now();
    // captured=0：不清除任何 generation>=1 的 pending
    const info = db
      .prepare(
        "UPDATE o_legacyMutationJournal SET status = ?, updatedAt = ? WHERE status = ? AND generation <= ?",
      )
      .run("cleared", now, "pending", captured);
    const cleared = Number(info.changes ?? 0);
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c, MAX(generation) AS maxGen FROM o_legacyMutationJournal WHERE status = ?",
      )
      .get("pending") as { c: number; maxGen: number | null };
    const remainingPending = Number(row.c ?? 0);
    const maxRemaining =
      row.maxGen != null && Number.isFinite(Number(row.maxGen)) ? Number(row.maxGen) : null;
    return { cleared, remainingPending, maxRemaining };
  } finally {
    db.close();
  }
}

/**
 * 在临时上传快照中清空 mutation journal 行，保留表结构；
 * VACUUM INTO → 校验 → 原子替换；任一步失败必须抛错中止上传。
 */
export async function stripMutationJournalFromSnapshotFile(snapshotPath: string): Promise<void> {
  let db: Database.Database | undefined;
  try {
    db = new Database(snapshotPath, { fileMustExist: true });
  } catch (err) {
    if (isMissingFileError(err)) {
      throw new Error("快照文件不存在，禁止上传");
    }
    throw err instanceof Error ? err : new Error("打开快照失败");
  }
  try {
    const table = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("o_legacyMutationJournal");
    if (table) {
      // 中文注释：清空行但保留表结构以兼容已记录迁移版本
      db.exec("DELETE FROM o_legacyMutationJournal");
      // 中文注释：VACUUM 清除 freelist，避免 sentinel 文本残留在页中
      db.exec("VACUUM");
    }
  } finally {
    db.close();
  }
  // 中文注释：backup 到临时文件再原子替换，失败必须中止上传
  const vacPath = path.join(
    path.dirname(snapshotPath),
    `.strip-${process.pid}-${Date.now()}.sqlite`,
  );
  try {
    const vac = new Database(snapshotPath, { fileMustExist: true });
    try {
      vac.pragma("wal_checkpoint(TRUNCATE)");
      await vac.backup(vacPath);
    } finally {
      vac.close();
    }
    const check = new Database(vacPath, { readonly: true, fileMustExist: true });
    try {
      const integ = check.pragma("integrity_check") as Array<{ integrity_check: string }>;
      if (integ[0]?.integrity_check !== "ok") {
        throw new Error(`快照重写后 integrity_check 失败: ${integ[0]?.integrity_check}`);
      }
      const hasTable = check
        .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?")
        .get("o_legacyMutationJournal");
      if (hasTable) {
        const cnt = check.prepare("SELECT COUNT(*) AS c FROM o_legacyMutationJournal").get() as {
          c: number;
        };
        if (Number(cnt.c) !== 0) {
          throw new Error("快照 journal 行数非 0，禁止上传");
        }
      }
    } finally {
      check.close();
    }
    fs.renameSync(vacPath, snapshotPath);
    const finalDb = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      const integ = finalDb.pragma("integrity_check") as Array<{ integrity_check: string }>;
      if (integ[0]?.integrity_check !== "ok") {
        throw new Error("快照替换后 integrity_check 失败");
      }
      const hasTable = finalDb
        .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?")
        .get("o_legacyMutationJournal");
      if (hasTable) {
        const cnt = finalDb.prepare("SELECT COUNT(*) AS c FROM o_legacyMutationJournal").get() as {
          c: number;
        };
        if (Number(cnt.c) !== 0) {
          throw new Error("快照最终 journal 行数非 0");
        }
      }
    } finally {
      finalDb.close();
    }
  } catch (err) {
    try {
      fs.rmSync(vacPath, { force: true });
    } catch {
      // 清理临时文件不得掩盖主错误
    }
    throw err instanceof Error ? err : new Error("快照剥离 journal 失败，已中止上传");
  }
}

/** @deprecated 请用 readMutationCaptureFromSqliteFile；禁止 backup 后读 live */
export function readMaxPendingGenerationOnFile(databasePath: string): number | null {
  const cap = readMutationCaptureFromSqliteFile(databasePath);
  if (cap.kind === "captured") return cap.value;
  if (cap.kind === "none") return null;
  return null;
}

/** 将 MutationCapture 规范为 PersonalManifest 上的数字或 unknown 标记 */
export function captureToManifestField(
  cap: MutationCapture,
): number | "unknown" {
  if (cap.kind === "none") return 0;
  if (cap.kind === "captured") return cap.value;
  return "unknown";
}

export function isFinalizeAllowedCapture(
  captured: number | "unknown" | undefined | null,
): captured is number {
  return typeof captured === "number" && Number.isFinite(captured) && captured >= 0;
}

/** 确保目录存在（receipt 等） */
export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
