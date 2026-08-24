/**
 * 旧媒体清理回执：仅列出已迁移且等待中央成功后可删除的旧绝对路径。
 * 中文注释：在中央 finalize 成功前不得删除用户原文件。
 */
import fs from "node:fs";
import path from "node:path";

export type LegacyCleanupPhase =
  | "pending_central_success"
  | "ready_to_cleanup"
  | "cleaned";

export interface LegacyMediaCleanupEntry {
  table: string;
  column: string;
  rowId: number;
  oldRelative: string;
  newRelative: string;
  oldAbsolute: string;
  md5: string;
  size: number;
}

export interface LegacyMediaCleanupReceipt {
  projectUuid: string;
  phase: LegacyCleanupPhase;
  entries: LegacyMediaCleanupEntry[];
  updatedAt: string;
  path?: string;
}

export function legacyMediaCleanupReceiptPath(
  dataRoot: string,
  userSegment: string,
  projectUuid: string,
): string {
  return path.join(
    dataRoot,
    "runtime-users",
    userSegment,
    "sync",
    "legacy-media-cleanup",
    projectUuid,
    "receipt.json",
  );
}

export function readLegacyMediaCleanupReceipt(
  dataRoot: string,
  userSegment: string,
  projectUuid: string,
): LegacyMediaCleanupReceipt | undefined {
  const filename = legacyMediaCleanupReceiptPath(dataRoot, userSegment, projectUuid);
  if (!fs.existsSync(filename)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as LegacyMediaCleanupReceipt;
    if (parsed.projectUuid !== projectUuid || !Array.isArray(parsed.entries)) return undefined;
    return { ...parsed, path: filename };
  } catch {
    return undefined;
  }
}

export function writeLegacyMediaCleanupReceipt(input: {
  dataRoot: string;
  userSegment: string;
  projectUuid: string;
  phase: LegacyCleanupPhase;
  entries: LegacyMediaCleanupEntry[];
}): LegacyMediaCleanupReceipt {
  const filename = legacyMediaCleanupReceiptPath(
    input.dataRoot,
    input.userSegment,
    input.projectUuid,
  );
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const receipt: LegacyMediaCleanupReceipt = {
    projectUuid: input.projectUuid,
    phase: input.phase,
    entries: input.entries,
    updatedAt: new Date().toISOString(),
    path: filename,
  };
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filename);
  return receipt;
}
