/**
 * 账号/项目作用域的持久化 legacy mutation intent。
 * 用于 project.sqlite 已提交但 runtime.dirty 登记失败或进程中断时的恢复。
 * 无密钥、无路径逃逸、按 userSegment + projectUuid 隔离、幂等 upsert。
 */
import fs from "node:fs";
import path from "node:path";

export type PendingLegacyMutationKind = "personal" | "team";

export interface PendingLegacyMutationIntent {
  projectUuid: string;
  kind: PendingLegacyMutationKind;
  /** 业务来源，如 scriptAgent */
  source: string;
  createdAt: string;
  updatedAt: string;
  status: "pending";
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertSegment(userSegment: string): void {
  if (!/^[a-f0-9]{32}$/i.test(userSegment)) {
    throw new Error("pending mutation 用户目录标识无效");
  }
}

function assertProjectUuid(projectUuid: string): void {
  if (!uuidPattern.test(projectUuid)) {
    throw new Error("pending mutation 项目 UUID 无效");
  }
}

export function pendingLegacyMutationDir(dataRoot: string, userSegment: string): string {
  assertSegment(userSegment);
  const root = path.resolve(dataRoot, "runtime-users", userSegment, "pending-legacy-mutations");
  const expected = path.resolve(dataRoot, "runtime-users", userSegment) + path.sep;
  if (!root.startsWith(expected) && root !== path.resolve(dataRoot, "runtime-users", userSegment, "pending-legacy-mutations")) {
    // 越界保护
    const base = path.resolve(dataRoot, "runtime-users", userSegment);
    if (!root.startsWith(base + path.sep) && root !== base) {
      throw new Error("pending mutation 目录越界");
    }
  }
  return root;
}

function intentPath(dataRoot: string, userSegment: string, projectUuid: string): string {
  assertProjectUuid(projectUuid);
  const dir = pendingLegacyMutationDir(dataRoot, userSegment);
  const target = path.resolve(dir, `${projectUuid}.json`);
  if (!target.startsWith(dir + path.sep)) throw new Error("pending mutation 路径越界");
  return target;
}

/** 幂等写入/刷新 pending intent（事务成功后必须先于或伴随 runtime mark） */
export function recordPendingLegacyMutationIntent(input: {
  dataRoot: string;
  userSegment: string;
  projectUuid: string;
  kind: PendingLegacyMutationKind;
  source: string;
}): PendingLegacyMutationIntent {
  const dir = pendingLegacyMutationDir(input.dataRoot, input.userSegment);
  fs.mkdirSync(dir, { recursive: true });
  const file = intentPath(input.dataRoot, input.userSegment, input.projectUuid);
  const now = new Date().toISOString();
  let createdAt = now;
  if (fs.existsSync(file)) {
    try {
      const prev = JSON.parse(fs.readFileSync(file, "utf8")) as PendingLegacyMutationIntent;
      if (prev.createdAt) createdAt = prev.createdAt;
    } catch {
      // 损坏则重建
    }
  }
  const intent: PendingLegacyMutationIntent = {
    projectUuid: input.projectUuid,
    kind: input.kind,
    source: input.source.slice(0, 64),
    createdAt,
    updatedAt: now,
    status: "pending",
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(intent, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return intent;
}

export function readPendingLegacyMutationIntent(
  dataRoot: string,
  userSegment: string,
  projectUuid: string,
): PendingLegacyMutationIntent | null {
  const file = intentPath(dataRoot, userSegment, projectUuid);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PendingLegacyMutationIntent;
    if (parsed.status !== "pending" || parsed.projectUuid !== projectUuid) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hasPendingLegacyMutationIntent(
  dataRoot: string,
  userSegment: string,
  projectUuid: string,
): boolean {
  return readPendingLegacyMutationIntent(dataRoot, userSegment, projectUuid) != null;
}

/**
 * 清除 sidecar intent。删除后必须验证文件不存在；
 * 失败抛出稳定错误，禁止吞掉 fs 错误并伪装成功。
 */
export function clearPendingLegacyMutationIntent(
  dataRoot: string,
  userSegment: string,
  projectUuid: string,
): void {
  const file = intentPath(dataRoot, userSegment, projectUuid);
  if (!fs.existsSync(file)) return;
  try {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      throw new Error("mutation intent 路径异常为目录，清理失败");
    }
    fs.rmSync(file, { force: false });
  } catch (err) {
    if (fs.existsSync(file)) {
      const msg = err instanceof Error ? err.message : "清理 mutation intent 失败";
      throw new Error(msg.includes("mutation intent") ? msg : `清理 mutation intent 失败: ${msg}`);
    }
    // 竞态：已不存在则视为成功
    return;
  }
  if (fs.existsSync(file)) {
    throw new Error("清理 mutation intent 后文件仍存在");
  }
}

export function listPendingLegacyMutationIntents(
  dataRoot: string,
  userSegment: string,
  options?: { failClosed?: boolean },
): PendingLegacyMutationIntent[] {
  const dir = pendingLegacyMutationDir(dataRoot, userSegment);
  if (options?.failClosed) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (
        error
        && typeof error === "object"
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw new Error("读取 pending mutation intent 目录失败");
    }

    const strictOut: PendingLegacyMutationIntent[] = [];
    for (const entry of entries) {
      // 中文注释：原子写入遗留的临时文件不是已提交事实，只严格校验正式 JSON。
      if (!entry.name.toLowerCase().endsWith(".json")) continue;
      const fileProjectUuid = entry.name.slice(0, -5);
      if (!entry.isFile() || !uuidPattern.test(fileProjectUuid)) {
        throw new Error(`pending mutation intent 损坏: ${entry.name}`);
      }
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(dir, entry.name), "utf8"),
        ) as PendingLegacyMutationIntent;
        if (
          parsed.status !== "pending"
          || !uuidPattern.test(parsed.projectUuid)
          || parsed.projectUuid.toLowerCase() !== fileProjectUuid.toLowerCase()
          || (parsed.kind !== "personal" && parsed.kind !== "team")
        ) {
          throw new Error("invalid intent");
        }
        strictOut.push(parsed);
      } catch {
        throw new Error(`pending mutation intent 损坏: ${entry.name}`);
      }
    }
    return strictOut.sort((a, b) => a.projectUuid.localeCompare(b.projectUuid));
  }

  if (!fs.existsSync(dir)) return [];
  const out: PendingLegacyMutationIntent[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as PendingLegacyMutationIntent;
      if (parsed.status === "pending" && uuidPattern.test(parsed.projectUuid)) {
        out.push(parsed);
      }
    } catch {
      // skip corrupt
    }
  }
  return out.sort((a, b) => a.projectUuid.localeCompare(b.projectUuid));
}
