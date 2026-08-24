/**
 * 团队发布/释放本机 receipt（不上云）。
 * phase:
 * - acquired_release_pending：仅已取锁、从未 publish；只允许幂等 release
 * - publishing：已写意图尚未确认中央证据
 * - published_release_pending：中央版本+摘要已确认，仅 release
 * - released_cleanup_pending：release 已成功；须先 finalize journal/sidecar，最后才删 receipt
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type TeamReceiptPhase =
  | "acquired_release_pending"
  | "publishing"
  | "published_release_pending"
  | "released_cleanup_pending";

export interface ManifestObjectDigest {
  relativePath: string;
  md5: string;
  size?: number;
}

export interface TeamReleaseReceipt {
  projectUuid: string;
  lockId: string;
  fencingToken: number;
  phase: TeamReceiptPhase;
  publishedAt: string;
  /** 发布前本地基线版本 */
  baseVersion?: number;
  /** 期望中央版本（通常 base+1） */
  expectedVersion?: number;
  /** 与 artifact 同事务 generation */
  capturedMutationGeneration?: number | "unknown";
  /** 对象摘要指纹（排序后 sha256） */
  manifestFingerprint?: string;
  /** 期望对象列表，供 getProject 对照 */
  objects?: ManifestObjectDigest[];
}

export type ReceiptReadResult =
  | { kind: "missing" }
  | { kind: "ok"; receipt: TeamReleaseReceipt };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHASES = new Set<TeamReceiptPhase>([
  "acquired_release_pending",
  "publishing",
  "published_release_pending",
  "released_cleanup_pending",
]);

function receiptDir(dataRoot: string, userSegment: string): string {
  if (!/^[a-f0-9]{32}$/i.test(userSegment)) {
    throw new Error("release receipt 用户目录标识无效");
  }
  return path.resolve(dataRoot, "runtime-users", userSegment, "team-release-receipts");
}

function receiptPath(dataRoot: string, userSegment: string, projectUuid: string): string {
  if (!uuidPattern.test(projectUuid)) throw new Error("release receipt 项目 UUID 无效");
  const dir = receiptDir(dataRoot, userSegment);
  const target = path.resolve(dir, `${projectUuid}.json`);
  if (!target.startsWith(dir + path.sep)) throw new Error("release receipt 路径越界");
  return target;
}

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT");
}

/**
 * 列出当前账号尚未消费的 Team release receipt。
 * 中文注释：退出门不能只遍历已打开 runtime；重启后 receipt 可能是唯一持久事实。
 * 目录不可读或正式 JSON 文件名非法时必须失败关闭，禁止把未知状态当作“没有 pending”。
 */
export function listTeamReleaseReceiptProjectUuids(
  dataRoot: string,
  userSegment: string,
): string[] {
  const dir = receiptDir(dataRoot, userSegment);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw new Error(
      `读取 team release receipt 目录失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const projectUuids: string[] = [];
  for (const entry of entries) {
    // 原子写入遗留的 .tmp 不属于已提交 receipt；只识别正式 .json。
    if (!entry.name.toLowerCase().endsWith(".json")) continue;
    if (!entry.isFile()) {
      throw new Error("team release receipt 正式路径不是文件");
    }
    const projectUuid = entry.name.slice(0, -5);
    if (!uuidPattern.test(projectUuid)) {
      throw new Error("team release receipt 文件名中的项目 UUID 无效");
    }
    projectUuids.push(projectUuid.toLowerCase());
  }
  return [...new Set(projectUuids)].sort();
}

/** 排序 path+md5+size 后 sha256，禁止仅依赖版本号 */
export function computeManifestFingerprint(objects: ManifestObjectDigest[]): string {
  const norm = [...objects]
    .map((o) => `${o.relativePath}\0${String(o.md5).toLowerCase()}\0${o.size ?? ""}`)
    .sort();
  return crypto.createHash("sha256").update(norm.join("\n")).digest("hex");
}

export function evidenceMatchesReceipt(
  receipt: TeamReleaseReceipt,
  evidence: { version: number; objects: ManifestObjectDigest[] },
): boolean {
  if (!Number.isFinite(evidence.version)) return false;
  if (receipt.expectedVersion == null || !Number.isFinite(receipt.expectedVersion)) return false;
  if (evidence.version !== receipt.expectedVersion) return false;
  if (!receipt.manifestFingerprint) return false;
  const fp = computeManifestFingerprint(evidence.objects ?? []);
  return fp === receipt.manifestFingerprint;
}

/**
 * 原子写入：tmp → fsync → rename → 再打开校验。
 */
export function writeTeamReleaseReceipt(
  dataRoot: string,
  userSegment: string,
  receipt: TeamReleaseReceipt,
): void {
  if (!receipt.lockId || !Number.isFinite(receipt.fencingToken)) {
    throw new Error("release receipt 字段非法");
  }
  if (!PHASES.has(receipt.phase)) {
    throw new Error("release receipt phase 非法");
  }
  if (receipt.phase === "publishing") {
    // 中文注释：publishing 必须带 generation、版本与指纹，否则无法崩溃恢复
    if (receipt.capturedMutationGeneration === undefined) {
      throw new Error("publishing receipt 缺少 capturedMutationGeneration");
    }
    if (receipt.baseVersion == null || receipt.expectedVersion == null) {
      throw new Error("publishing receipt 缺少 base/expected version");
    }
    if (!receipt.manifestFingerprint) {
      throw new Error("publishing receipt 缺少 manifestFingerprint");
    }
  }
  if (receipt.phase === "released_cleanup_pending") {
    // 中文注释：cleanup 恢复依赖持久化 capture；缺失则禁止写入该 phase
    if (receipt.capturedMutationGeneration === undefined) {
      throw new Error("released_cleanup_pending receipt 缺少 capturedMutationGeneration");
    }
  }
  const file = receiptPath(dataRoot, userSegment, receipt.projectUuid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify(receipt, null, 2);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const verify = fs.readFileSync(file, "utf8");
  if (verify !== payload) {
    throw new Error("release receipt 写入后校验失败");
  }
}

export function readTeamReleaseReceipt(
  dataRoot: string,
  userSegment: string,
  projectUuid: string,
): TeamReleaseReceipt | null {
  try {
    const r = readTeamReleaseReceiptStrict(dataRoot, userSegment, projectUuid);
    return r.kind === "ok" ? r.receipt : null;
  } catch {
    return null;
  }
}

export function readTeamReleaseReceiptStrict(
  dataRoot: string,
  userSegment: string,
  projectUuid: string,
): ReceiptReadResult {
  const file = receiptPath(dataRoot, userSegment, projectUuid);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (isEnoent(err)) return { kind: "missing" };
    throw new Error(
      `读取 release receipt 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: TeamReleaseReceipt;
  try {
    parsed = JSON.parse(raw) as TeamReleaseReceipt;
  } catch {
    throw new Error("release receipt 损坏：JSON 非法");
  }
  if (parsed.projectUuid !== projectUuid || !parsed.lockId) {
    throw new Error("release receipt 字段非法：projectUuid/lockId");
  }
  if (!Number.isFinite(parsed.fencingToken)) {
    throw new Error("release receipt 字段非法：fencingToken");
  }
  if (!PHASES.has(parsed.phase as TeamReceiptPhase)) {
    if (!(parsed as { phase?: string }).phase) {
      parsed = { ...parsed, phase: "published_release_pending" };
    } else {
      throw new Error("release receipt 字段非法：phase");
    }
  }
  return { kind: "ok", receipt: parsed };
}

/** 删除失败必须抛出；禁止静默成功 */
export function clearTeamReleaseReceipt(
  dataRoot: string,
  userSegment: string,
  projectUuid: string,
): void {
  const file = receiptPath(dataRoot, userSegment, projectUuid);
  try {
    const st = fs.statSync(file);
    if (st.isDirectory()) {
      throw new Error("release receipt 路径为目录，清理失败");
    }
  } catch (err) {
    if (isEnoent(err)) return;
    throw err instanceof Error ? err : new Error("访问 release receipt 失败");
  }
  try {
    fs.rmSync(file, { force: false });
  } catch (err) {
    throw new Error(
      `清理 team release receipt 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    fs.statSync(file);
    throw new Error("清理 team release receipt 后文件仍存在");
  } catch (err) {
    if (isEnoent(err)) return;
    throw err instanceof Error ? err : new Error("清理 receipt 校验失败");
  }
}
