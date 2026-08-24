import fs from "node:fs";
import path from "node:path";

import {
  currentUserStorage,
  userStorageRoot,
} from "../runtime/user-storage-context";
import {
  installMissingBuiltinSkills,
  loadBuiltinSkillsManifest,
} from "./builtin-skill-installer";

export interface AccountSkillsStatus {
  skillsRoot: string;
  manifestVersion: number;
  copied: string[];
  skipped: string[];
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/**
 * 从 dataRoot 开始逐级创建账号 Skills 目录，并拒绝任何目录联接/符号链接。
 * 这样即使当前 Windows 用户目录中存在恶意 junction，也不能把账号文件写到目录外。
 */
function ensureUnlinkedDirectoryTree(dataRoot: string, directory: string): void {
  const root = path.resolve(dataRoot);
  const target = path.resolve(directory);
  fs.mkdirSync(root, { recursive: true });
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("账号数据根目录不得为符号链接或目录联接");
  }
  if (!isPathInside(root, target)) throw new Error("账号 Skills 目录越界");

  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    const details = fs.lstatSync(current);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error("账号 Skills 路径包含符号链接或目录联接");
    }
  }
}

/** 单一相对段标识（如风格目录名 artStyle），禁止路径穿越。 */
export function assertSafeSkillSegment(segment: string, label = "Skills"): string {
  const value = String(segment ?? "").trim();
  if (
    !value
    || value.includes("\0")
    || value.includes("/")
    || value.includes("\\")
    || value === "."
    || value === ".."
    || path.isAbsolute(value)
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
  ) {
    throw new Error(`${label} 标识无效`);
  }
  return value;
}

/**
 * 将相对路径解析到当前账号 Skills 根下。
 * kind=file|directory|any；禁止绝对路径、..、符号链接/目录联接逃逸。
 */
export function resolveAccountSkillPath(
  skillsRoot: string,
  relativePath: string,
  options: { mustExist?: boolean; kind?: "file" | "directory" | "any" } = {},
): string {
  if (
    typeof relativePath !== "string"
    || !relativePath.trim()
    || relativePath.includes("\0")
    || path.isAbsolute(relativePath)
  ) {
    throw new Error("Skills 路径无效或越界");
  }
  const root = path.resolve(skillsRoot);
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("Skills 路径越界");
  }
  const candidate = path.resolve(root, ...normalized.split("/"));
  if (!isPathInside(root, candidate)) throw new Error("Skills 路径越界");
  if (!fs.existsSync(root)) throw new Error("当前账号 Skills 目录不存在");
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("当前账号 Skills 目录不得为符号链接或目录联接");
  }

  const kind = options.kind ?? "any";
  let current = root;
  const segments = path.relative(root, candidate).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    if (!fs.existsSync(current)) {
      if (options.mustExist !== false) {
        throw new Error(kind === "directory" ? "Skills 目录不存在" : "Skills 文件不存在");
      }
      break;
    }
    const details = fs.lstatSync(current);
    if (details.isSymbolicLink()) throw new Error("Skills 路径包含符号链接或目录联接");
    const isLast = index === segments.length - 1;
    if (!isLast && !details.isDirectory()) {
      throw new Error("Skills 路径无效");
    }
    if (isLast) {
      if (kind === "file" && !details.isFile()) throw new Error("Skills 目标不是普通文件");
      if (kind === "directory" && !details.isDirectory()) throw new Error("Skills 目标不是目录");
    }
  }
  return candidate;
}

/** 将用户提交的 Skills 相对路径解析为当前账号内的普通文件。 */
export function resolveAccountSkillFile(
  skillsRoot: string,
  relativePath: string,
  options: { mustExist?: boolean } = {},
): string {
  return resolveAccountSkillPath(skillsRoot, relativePath, {
    mustExist: options.mustExist,
    kind: "file",
  });
}

/**
 * 封面等静态资源的公开 URL。
 * 必须位于 /api/skills：登录 Cookie 的 Path=/api，普通 <img> 请求不会额外注入认证头。
 */
export function accountSkillPublicUrl(relativeUnderSkills: string): string {
  const safe = relativeUnderSkills.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!safe || safe.includes("..") || path.isAbsolute(safe) || /^[a-zA-Z]:/.test(safe)) {
    throw new Error("Skills 公开路径无效");
  }
  if (process.env.NODE_ENV === "dev") {
    return `http://127.0.0.1:10588/api/skills/${safe}`;
  }
  if (typeof process.versions?.electron !== "undefined" && process.env.PORT) {
    return `http://127.0.0.1:${process.env.PORT}/api/skills/${safe}`;
  }
  return `/api/skills/${safe}`;
}

export function currentAccountSkillsRoot(dataRoot: string): string {
  const identity = currentUserStorage();
  if (!identity) throw new Error("缺少当前账号 Skills 存储上下文");
  return path.join(userStorageRoot(dataRoot, identity), "skills");
}

export function resolveBuiltinSkillsResources(options: {
  moduleDir?: string;
  cwd?: string;
} = {}): { builtinRoot: string; manifestPath: string } {
  const moduleDir = options.moduleDir ?? __dirname;
  const cwd = options.cwd ?? process.cwd();
  const configuredRoot = process.env.TJ_BUILTIN_SKILLS_ROOT;
  const configuredManifest = process.env.TJ_BUILTIN_SKILLS_MANIFEST;
  const candidates = [
    configuredRoot || configuredManifest
      ? {
        builtinRoot: configuredRoot ? path.resolve(configuredRoot) : "",
        manifestPath: configuredManifest ? path.resolve(configuredManifest) : "",
      }
      : null,
    // 打包后 app.js 位于 resources/data/serve，内置基线位于同级 data 目录。
    {
      builtinRoot: path.resolve(moduleDir, "..", "builtin-skills"),
      manifestPath: path.resolve(moduleDir, "..", "builtin-skills-manifest.json"),
    },
    // 源码与 tsx 测试路径。
    {
      builtinRoot: path.resolve(moduleDir, "builtin"),
      manifestPath: path.resolve(moduleDir, "builtin-skills-manifest.json"),
    },
    {
      builtinRoot: path.resolve(cwd, "src", "tianjiang", "skills", "builtin"),
      manifestPath: path.resolve(cwd, "src", "tianjiang", "skills", "builtin-skills-manifest.json"),
    },
  ].filter((item): item is { builtinRoot: string; manifestPath: string } => item !== null);

  for (const candidate of candidates) {
    if (candidate.builtinRoot && candidate.manifestPath
      && fs.existsSync(candidate.builtinRoot) && fs.existsSync(candidate.manifestPath)) {
      return candidate;
    }
  }
  throw new Error("安装包内置 Skills 基线或 manifest 缺失");
}

let ensureBuiltinSkillsCallCount = 0;

/** 中文注释：批次观测用，禁止把未修改内置 Skill 重复 ensure 当作同步成功证据。 */
export function resetEnsureBuiltinSkillsCallCount(): void {
  ensureBuiltinSkillsCallCount = 0;
}

export function takeEnsureBuiltinSkillsCallCount(): number {
  const value = ensureBuiltinSkillsCallCount;
  ensureBuiltinSkillsCallCount = 0;
  return value;
}

export async function ensureCurrentAccountBuiltinSkills(
  dataRoot: string,
): Promise<AccountSkillsStatus> {
  ensureBuiltinSkillsCallCount += 1;
  const skillsRoot = currentAccountSkillsRoot(dataRoot);
  ensureUnlinkedDirectoryTree(dataRoot, skillsRoot);
  const resources = resolveBuiltinSkillsResources();
  const manifest = loadBuiltinSkillsManifest(resources.manifestPath);
  const result = await installMissingBuiltinSkills({
    builtinRoot: resources.builtinRoot,
    targetRoot: skillsRoot,
    manifest,
  });
  return {
    skillsRoot,
    manifestVersion: manifest.version,
    ...result,
  };
}
