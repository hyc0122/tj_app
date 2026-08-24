/**
 * Team checkpoint receipt（与最终 release receipt 分离）。
 * 中文注释：checkpoint 发布成功后保持锁；禁止复用最终释放 receipt 导致误释放。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ManifestObjectDigest } from "./team-release-receipt";
import { computeManifestFingerprint } from "./team-release-receipt";

export type TeamCheckpointPhase =
  | "publishing"
  | "published_pending_finalize"
  | "finalized";

export interface TeamCheckpointReceipt {
  type: "team_checkpoint";
  projectUuid: string;
  lockId: string;
  fencingToken: number;
  phase: TeamCheckpointPhase;
  baseVersion: number;
  expectedVersion: number;
  capturedMutationGeneration: number | "unknown";
  manifestFingerprint: string;
  objects: ManifestObjectDigest[];
  updatedAt: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isEnoent(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

function checkpointDir(dataRoot: string, userSegment: string): string {
  if (!/^[a-f0-9]{32}$/i.test(userSegment)) {
    throw new Error("checkpoint receipt 用户目录标识无效");
  }
  return path.resolve(dataRoot, "runtime-users", userSegment, "team-checkpoint-receipts");
}

function checkpointPath(dataRoot: string, userSegment: string, projectUuid: string): string {
  if (!uuidPattern.test(projectUuid)) throw new Error("checkpoint receipt 项目 UUID 无效");
  const dir = checkpointDir(dataRoot, userSegment);
  const target = path.resolve(dir, `${projectUuid}.json`);
  if (!target.startsWith(dir + path.sep)) throw new Error("checkpoint receipt 路径越界");
  return target;
}

/**
 * 列出当前账号尚未消费的 Team checkpoint receipt。
 * 中文注释：正式 receipt 目录不可读、路径形态异常时必须阻断退出，不能静默漏同步。
 */
export function listTeamCheckpointReceiptProjectUuids(
  dataRoot: string,
  userSegment: string,
): string[] {
  const dir = checkpointDir(dataRoot, userSegment);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw new Error(
      `读取 team checkpoint receipt 目录失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const projectUuids: string[] = [];
  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith(".json")) continue;
    if (!entry.isFile()) {
      throw new Error("team checkpoint receipt 正式路径不是文件");
    }
    const projectUuid = entry.name.slice(0, -5);
    if (!uuidPattern.test(projectUuid)) {
      throw new Error("team checkpoint receipt 文件名中的项目 UUID 无效");
    }
    projectUuids.push(projectUuid.toLowerCase());
  }
  return [...new Set(projectUuids)].sort();
}

export function writeTeamCheckpointReceipt(
  dataRoot: string,
  userSegment: string,
  receipt: Omit<TeamCheckpointReceipt, "type" | "updatedAt" | "manifestFingerprint"> & {
    manifestFingerprint?: string;
  },
): TeamCheckpointReceipt {
  const objects = receipt.objects ?? [];
  const full: TeamCheckpointReceipt = {
    type: "team_checkpoint",
    projectUuid: receipt.projectUuid,
    lockId: receipt.lockId,
    fencingToken: receipt.fencingToken,
    phase: receipt.phase,
    baseVersion: receipt.baseVersion,
    expectedVersion: receipt.expectedVersion,
    capturedMutationGeneration: receipt.capturedMutationGeneration,
    manifestFingerprint: receipt.manifestFingerprint ?? computeManifestFingerprint(objects),
    objects,
    updatedAt: new Date().toISOString(),
  };
  const filename = checkpointPath(dataRoot, userSegment, receipt.projectUuid);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(full, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filename);
  return full;
}

export function readTeamCheckpointReceipt(
  dataRoot: string,
  userSegment: string,
  projectUuid: string,
): TeamCheckpointReceipt | undefined {
  const filename = checkpointPath(dataRoot, userSegment, projectUuid);
  if (!fs.existsSync(filename)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as TeamCheckpointReceipt;
    if (parsed.type !== "team_checkpoint" || parsed.projectUuid !== projectUuid) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function clearTeamCheckpointReceipt(
  dataRoot: string,
  userSegment: string,
  projectUuid: string,
): void {
  const filename = checkpointPath(dataRoot, userSegment, projectUuid);
  fs.rmSync(filename, { force: true });
}
