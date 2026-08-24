import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface BuiltinSkillEntry {
  path: string;
  version: string;
  sha256: string;
  /** 普通文件字节数；manifest 全覆盖时必填。 */
  size?: number;
}

export interface BuiltinSkillsManifest {
  version: number;
  files: BuiltinSkillEntry[];
}

function normalizeManifestPath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    !value
    || normalized === "."
    || normalized.startsWith("../")
    || normalized.includes("/../")
    || path.posix.isAbsolute(normalized)
  ) {
    throw new Error("内置 Skills 路径越界");
  }
  return normalized;
}

function assertFileInside(root: string, filePath: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("内置 Skills 路径越界");
  }
}

/** 拒绝根目录或任一已存在路径段中的符号链接/Windows 目录联接。 */
function assertNoLinkedPathSegments(root: string, filePath: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(filePath);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("内置 Skills 根目录不得为符号链接或目录联接");
  }
  if (resolvedFile === resolvedRoot) return;
  assertFileInside(resolvedRoot, resolvedFile);
  let current = resolvedRoot;
  for (const segment of path.relative(resolvedRoot, resolvedFile).split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("内置 Skills 路径包含符号链接或目录联接");
    }
  }
}

/**
 * 将安装包内置 Skills 基线复制到当前账号 Skills 目录。
 * 仅补缺失文件，不覆盖用户已编辑内容。
 * 大批量复制时周期性让出事件循环，避免阻塞 Socket/HTTP。
 */
export async function installMissingBuiltinSkills(options: {
  builtinRoot: string;
  targetRoot: string;
  manifest: BuiltinSkillsManifest;
}): Promise<{ copied: string[]; skipped: string[] }> {
  const copied: string[] = [];
  const skipped: string[] = [];
  fs.mkdirSync(options.targetRoot, { recursive: true });
  assertNoLinkedPathSegments(options.targetRoot, options.targetRoot);
  assertNoLinkedPathSegments(options.builtinRoot, options.builtinRoot);
  const seen = new Set<string>();
  let processed = 0;
  for (const entry of options.manifest.files) {
    const relative = normalizeManifestPath(entry.path);
    if (seen.has(relative)) throw new Error(`内置 Skills manifest 路径重复：${relative}`);
    seen.add(relative);
    if (!entry.version.trim()) throw new Error(`内置 Skills 缺少版本：${relative}`);
    if (!/^[a-f0-9]{64}$/i.test(entry.sha256)) throw new Error(`内置 Skills SHA-256 无效：${relative}`);
    const source = path.join(options.builtinRoot, ...relative.split("/"));
    const target = path.join(options.targetRoot, ...relative.split("/"));
    assertFileInside(options.builtinRoot, source);
    assertFileInside(options.targetRoot, target);
    assertNoLinkedPathSegments(options.builtinRoot, source);
    assertNoLinkedPathSegments(options.targetRoot, target);
    if (!fs.existsSync(source)) throw new Error(`内置 Skills 源文件缺失：${relative}`);
    const sourceStat = fs.lstatSync(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`内置 Skills 源文件类型无效：${relative}`);
    }
    if (hashFileSha256(source).toLowerCase() !== entry.sha256.toLowerCase()) {
      throw new Error(`内置 Skills SHA-256 摘要不匹配：${relative}`);
    }
    if (fs.existsSync(target)) {
      const targetStat = fs.lstatSync(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        throw new Error(`当前账号 Skills 目标文件类型无效：${relative}`);
      }
      skipped.push(relative);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // 创建目录后再复核一次，缩小检查与写入之间的目录替换窗口。
      assertNoLinkedPathSegments(options.targetRoot, target);
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if (hashFileSha256(target).toLowerCase() !== entry.sha256.toLowerCase()) {
        fs.rmSync(target, { force: true });
        throw new Error(`内置 Skills 复制后摘要不匹配：${relative}`);
      }
      copied.push(relative);
    }
    processed += 1;
    // 每处理若干文件让出事件循环，避免大批量同步 I/O 饿死 Socket 鉴权与 chat 注册。
    if (processed % 8 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return { copied, skipped };
}

export function hashFileSha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function loadBuiltinSkillsManifest(manifestPath: string): BuiltinSkillsManifest {
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BuiltinSkillsManifest;
  if (!Number.isSafeInteger(raw.version) || raw.version < 1 || !Array.isArray(raw.files)) {
    throw new Error("内置 Skills manifest 无效");
  }
  for (const entry of raw.files) {
    if (!entry || typeof entry.path !== "string" || typeof entry.version !== "string" || typeof entry.sha256 !== "string") {
      throw new Error("内置 Skills manifest 条目无效");
    }
    normalizeManifestPath(entry.path);
    if (!entry.version.trim() || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      throw new Error(`内置 Skills manifest 摘要或版本无效：${entry.path}`);
    }
  }
  return raw;
}
