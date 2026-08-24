/**
 * 供应商源码路径：统一 ID 校验与大小上限，禁止路径逃逸。
 */
import fs from "node:fs";
import path from "node:path";
import isPathInside from "is-path-inside";

/** 读写共用的源码大小上限（字节）。 */
export const MAX_VENDOR_SOURCE_BYTES = 512 * 1024;

/** 允许 volcengineSd2 等大小写混合 ID。 */
const VENDOR_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

interface VendorSourceFileStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface VendorSourceFileSystem {
  existsSync(target: fs.PathLike): boolean;
  lstatSync(target: fs.PathLike): VendorSourceFileStat;
}

const nodeFileSystem: VendorSourceFileSystem = {
  existsSync: (target) => fs.existsSync(target),
  lstatSync: (target) => fs.lstatSync(target),
};

/**
 * 严格校验供应商 ID，拒绝路径分隔符与逃逸。
 * 错误文案不得包含本机绝对路径。
 */
export function assertSafeVendorId(id: unknown): string {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("供应商 ID 无效");
  }
  const value = id.trim();
  if (
    !VENDOR_ID_RE.test(value)
    || value.includes("..")
    || value.includes("/")
    || value.includes("\\")
    || value.includes(":")
    || path.isAbsolute(value)
  ) {
    throw new Error("供应商 ID 无效");
  }
  return value;
}

/** 将供应商 ID 解析为 data/vendor 下的 .ts 文件绝对路径。 */
export function resolveVendorSourceFile(vendorRoot: string, id: unknown): string {
  const safeId = assertSafeVendorId(id);
  const root = path.resolve(vendorRoot);
  const target = path.resolve(root, `${safeId}.ts`);
  if (target === root || !isPathInside(target, root)) {
    throw new Error("供应商源码路径越界");
  }
  return target;
}

/**
 * 校验供应商源码根目录本身不是符号链接或 Junction。
 * 读取和写入都必须先经过此门，避免词法路径位于 data/vendor、真实路径却逃逸。
 */
export function assertSafeVendorSourceRoot(
  vendorRoot: string,
  fileSystem: VendorSourceFileSystem = nodeFileSystem,
): string {
  const root = path.resolve(vendorRoot);
  if (!fileSystem.existsSync(root)) return root;
  const stat = fileSystem.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("供应商源码目录无效");
  }
  return root;
}

/**
 * 解析安全写入目标；既存目标必须是普通文件，严禁跟随符号链接写到目录外。
 */
export function resolveWritableVendorSourceFile(
  vendorRoot: string,
  id: unknown,
  fileSystem: VendorSourceFileSystem = nodeFileSystem,
): string {
  const root = assertSafeVendorSourceRoot(vendorRoot, fileSystem);
  const target = resolveVendorSourceFile(root, id);
  if (!fileSystem.existsSync(target)) return target;
  const stat = fileSystem.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("供应商源码文件无效");
  }
  return target;
}

export function assertVendorSourceSize(source: string): void {
  if (Buffer.byteLength(source, "utf8") > MAX_VENDOR_SOURCE_BYTES) {
    throw new Error("供应商源码超过大小上限");
  }
}

/** 对外错误脱敏：去掉盘符路径。 */
export function sanitizeVendorRouteError(error: unknown, fallback = "供应商源码读取失败"): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.replace(/\s+/g, " ").trim();
  if (!message || /[a-z]:[\\/]|\\\\|https?:\/\/|token|secret|api[_-]?key/i.test(message)) {
    return fallback;
  }
  if (!/[\u3400-\u9fff]/.test(message) && !/供应商|无效|上限|不存在|为空/.test(message)) {
    return fallback;
  }
  return message.slice(0, 120);
}
