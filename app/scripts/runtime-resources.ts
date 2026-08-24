import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const WEB_MANIFEST_NAME = ".tianjiang-web-package.json";
const WEB_MANIFEST_SCHEMA_VERSION = 1;
const TEXT_RESOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".txt",
]);
const LEGACY_RUNTIME_GUIDANCE =
  /管理员运行|以管理员身份运行|手工安装\s*(?:Microsoft\s*)?(?:Visual\s*C\+\+|VC\+\+)|32\s*位下载|64\s*位下载/i;

interface WebManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface WebManifest {
  readonly schemaVersion: number;
  readonly sourceFiles: readonly WebManifestFile[];
}

export interface PackagedRuntimeResources {
  readonly dataRoot: string;
  readonly webRoot: string;
  readonly webEntry: string;
  readonly serveEntry: string;
}

export class RuntimeResourceError extends Error {
  readonly code = "STARTUP_RESOURCE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeResourceError";
  }
}

function fail(message: string): never {
  throw new RuntimeResourceError(message);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function normalizeManifestPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) {
    fail("包内 web 资源清单包含无效路径");
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === "."
    || normalized.startsWith("../")
    || path.posix.isAbsolute(normalized)
    || /^[A-Za-z]:/.test(normalized)
  ) {
    fail(`包内 web 资源路径越界：${value}`);
  }
  return normalized;
}

function parseManifest(manifestPath: string): WebManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`包内 web 资源清单无效：${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || (parsed as Partial<WebManifest>).schemaVersion !== WEB_MANIFEST_SCHEMA_VERSION
    || !Array.isArray((parsed as Partial<WebManifest>).sourceFiles)
    || (parsed as Partial<WebManifest>).sourceFiles?.length === 0
  ) {
    fail("包内 web 资源清单 schema 无效");
  }
  return parsed as WebManifest;
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function collectFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      const details = fs.lstatSync(absolutePath);
      if (details.isSymbolicLink()) fail(`包内 web 资源禁止符号链接：${relativePath}`);
      if (details.isDirectory()) {
        visit(absolutePath);
      } else if (details.isFile() && relativePath !== WEB_MANIFEST_NAME) {
        result.push(relativePath);
      }
    }
  };
  visit(root);
  return result.sort((left, right) => left.localeCompare(right, "en"));
}

function validateWebResources(webRoot: string): void {
  const manifestPath = path.join(webRoot, WEB_MANIFEST_NAME);
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    fail("包内 web 资源缺少校验清单");
  }
  const manifest = parseManifest(manifestPath);
  const expectedPaths: string[] = [];
  const uniquePaths = new Set<string>();
  for (const declared of manifest.sourceFiles) {
    const relativePath = normalizeManifestPath(declared?.path);
    if (uniquePaths.has(relativePath)) fail(`包内 web 资源清单存在重复路径：${relativePath}`);
    uniquePaths.add(relativePath);
    expectedPaths.push(relativePath);
    if (
      !Number.isSafeInteger(declared?.size)
      || declared.size < 0
      || typeof declared?.sha256 !== "string"
      || !/^[a-f0-9]{64}$/i.test(declared.sha256)
    ) {
      fail(`包内 web 资源清单条目无效：${relativePath}`);
    }

    const filePath = path.resolve(webRoot, ...relativePath.split("/"));
    if (!isInside(webRoot, filePath) || !fs.existsSync(filePath)) {
      fail(`包内 web 资源缺失：${relativePath}`);
    }
    const details = fs.lstatSync(filePath);
    if (!details.isFile() || details.isSymbolicLink()) {
      fail(`包内 web 资源不是普通文件：${relativePath}`);
    }
    if (details.size !== declared.size) {
      fail(`包内 web 资源大小不匹配：${relativePath}`);
    }
    if (sha256File(filePath).toLowerCase() !== declared.sha256.toLowerCase()) {
      fail(`包内 web 资源 SHA-256 摘要不匹配：${relativePath}`);
    }
    if (TEXT_RESOURCE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
      const content = fs.readFileSync(filePath, "utf8");
      if (LEGACY_RUNTIME_GUIDANCE.test(content)) {
        fail(`包内 web 资源包含误导性旧运行指引：${relativePath}`);
      }
    }
  }

  const actualPaths = collectFiles(webRoot);
  const sortedExpectedPaths = expectedPaths.sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualPaths) !== JSON.stringify(sortedExpectedPaths)) {
    fail("包内 web 资源文件集合与校验清单不一致");
  }
  if (!uniquePaths.has("index.html")) fail("包内 web 资源清单缺少 index.html");
}

/**
 * 生产运行时只读取安装包资源；用户 data 目录从此不参与 web/serve 更新。
 */
export function resolvePackagedRuntimeResources(
  resourcesPath: string,
): PackagedRuntimeResources {
  const dataRoot = path.resolve(resourcesPath, "data");
  const webRoot = path.join(dataRoot, "web");
  const webEntry = path.join(webRoot, "index.html");
  const serveEntry = path.join(dataRoot, "serve", "app.js");

  if (!fs.existsSync(webRoot) || !fs.statSync(webRoot).isDirectory()) {
    fail("安装包缺少 web 资源目录");
  }
  validateWebResources(webRoot);
  if (
    !fs.existsSync(serveEntry)
    || !fs.lstatSync(serveEntry).isFile()
    || fs.lstatSync(serveEntry).isSymbolicLink()
    || fs.statSync(serveEntry).size === 0
  ) {
    fail("安装包缺少有效的本地服务入口");
  }
  return { dataRoot, webRoot, webEntry, serveEntry };
}
