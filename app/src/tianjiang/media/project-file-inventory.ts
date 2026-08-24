/**
 * 项目 files 清单构建。
 * 只递归普通文件；读取前后比较 size/mtime；流式计算 MD5 与 mediaType；路径稳定排序。
 * 中文注释：files/** 禁止 readFileSync 全量装入；project.sqlite 由调用方单独处理。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ManifestMediaType } from "../sync/manifest";
import {
  assertOpenProjectFileHandleIdentity,
  closeProjectFileHandle,
  mediaTypeForExtension,
  openProjectFileHandle,
  readProjectFileFdSync,
  type OpenProjectFileHandle,
} from "./project-file-store";

export interface ProjectInventoryObject {
  relativePath: string;
  size: number;
  md5: string;
  mediaType: ManifestMediaType;
}

export interface OpenProjectFileIdentity extends OpenProjectFileHandle {
  md5: string;
}

type PositionalReader = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => number;

const EXCLUDED_DIR_NAMES = new Set([
  ".tmp",
  ".incoming",
  "cache",
  "recovery",
  "node_modules",
  ".git",
]);

const EXCLUDED_FILE_NAMES = new Set([
  "project.sqlite-wal",
  "project.sqlite-shm",
  "app.log",
  ".ds_store",
  "thumbs.db",
]);

/**
 * 从项目根构建 files 清单（不含 project.sqlite）。
 * @param projectRoot 项目工作副本根目录
 */
const ALLOWED_STORYBOARD_PREFIXES = [
  "files/images/",
  "files/videos/",
  "files/audios/",
  "files/thumbnails/",
  "files/references/",
  "files/imports/",
  "files/attachments/",
  "files/legacy/",
];

/** 账号即梦本机状态不得进入项目对象集合。 */
export function isAllowedStoryboardSyncPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized === "project.sqlite") return true;
  if (normalized.includes("o_dreaminaCli") || normalized.includes("db2.sqlite") || normalized.includes("staging/")) {
    return false;
  }
  return ALLOWED_STORYBOARD_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

export function buildProjectFileInventory(projectRoot: string): ProjectInventoryObject[] {
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("项目根目录不存在");
  }
  assertNotLink(root, "项目根");
  const filesRoot = path.join(root, "files");
  if (!fs.existsSync(filesRoot)) return [];
  assertNotLink(filesRoot, "项目 files 根");
  if (!fs.statSync(filesRoot).isDirectory()) {
    throw new Error("项目 files 路径不是目录");
  }

  const objects: ProjectInventoryObject[] = [];
  walkOrdinaryFiles(filesRoot, filesRoot, (absolutePath, relativeUnderFiles) => {
    const relativePath = `files/${relativeUnderFiles.split(path.sep).join("/")}`;
    if (!isAllowedStoryboardSyncPath(relativePath)) return;
    objects.push(hashStableFile(absolutePath, relativePath, filesRoot));
  });
  objects.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return objects;
}

/**
 * 构建完整同步对象集合：project.sqlite + files/**（稳定排序）。
 */
export function buildCompleteProjectObjectSet(input: {
  projectRoot: string;
  sqlitePath: string;
  sqliteMd5: string;
  sqliteSize: number;
}): Array<{ relativePath: string; size: number; md5: string; mediaType?: ManifestMediaType }> {
  const files = buildProjectFileInventory(input.projectRoot);
  const objects: Array<{ relativePath: string; size: number; md5: string; mediaType?: ManifestMediaType }> = [
    {
      relativePath: "project.sqlite",
      size: input.sqliteSize,
      md5: input.sqliteMd5.toLowerCase(),
    },
    ...files.map((file) => ({
      relativePath: file.relativePath,
      size: file.size,
      md5: file.md5,
      mediaType: file.mediaType,
    })),
  ];
  objects.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return objects;
}

function walkOrdinaryFiles(
  filesRoot: string,
  current: string,
  onFile: (absolutePath: string, relativeUnderFiles: string) => void,
): void {
  // 中文注释：枚举前检查当前节点；任何符号链接/重解析点 fail-closed，禁止跟随越界。
  assertNotLink(current, "项目文件枚举路径");
  const entries = fs.readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.name === "." || entry.name === ".." || entry.name.includes("\0")) {
      throw new Error("项目文件路径无效");
    }
    if (EXCLUDED_DIR_NAMES.has(entry.name.toLowerCase()) && entry.isDirectory()) {
      continue;
    }
    if (EXCLUDED_FILE_NAMES.has(entry.name.toLowerCase())) {
      continue;
    }
    // Dirent 在部分平台对 symlink 可能报告为 file；统一 lstat。
    const lst = fs.lstatSync(absolute);
    if (lst.isSymbolicLink() || isReparsePoint(lst)) {
      throw new Error("项目文件路径包含符号链接或重解析点");
    }
    if (lst.isDirectory()) {
      walkOrdinaryFiles(filesRoot, absolute, onFile);
      continue;
    }
    if (!lst.isFile()) {
      // 中文注释：设备节点、socket 等非普通文件不得进入同步清单。
      throw new Error("项目 files 中存在非普通文件");
    }
    if (entry.name.endsWith(".tmp") || entry.name.endsWith(".partial")) {
      continue;
    }
    const relativeUnderFiles = path.relative(filesRoot, absolute);
    if (
      !relativeUnderFiles
      || relativeUnderFiles.startsWith("..")
      || path.isAbsolute(relativeUnderFiles)
    ) {
      throw new Error("项目文件路径越界");
    }
    onFile(absolute, relativeUnderFiles);
  }
}

/**
 * 流式计算 size+MD5；前后比较 size/mtime，变化 fail-closed。
 * 中文注释：图片/视频/音频/附件必须走此路径，禁止 readFileSync。
 */
export function hashFileStreaming(
  absolutePath: string,
  options: { filesRoot?: string } = {},
): { size: number; md5: string } {
  const before = fs.lstatSync(absolutePath, { bigint: true });
  assertStableBigIntIdentity(before);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("项目路径不是安全普通文件");
  const followedBefore = fs.statSync(absolutePath, { bigint: true });
  assertStableBigIntIdentity(followedBefore);
  if (!followedBefore.isFile()
    || followedBefore.size !== before.size
    || followedBefore.dev !== before.dev
    || followedBefore.ino !== before.ino) {
    throw new Error("项目文件路径身份不一致");
  }
  const fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    assertStableBigIntIdentity(opened);
    if (!opened.isFile()
      || opened.size !== before.size
      || opened.dev !== before.dev
      || opened.ino !== before.ino) {
      throw new Error("项目文件句柄身份与路径不一致");
    }
    if (options.filesRoot) assertRealPathWithinRoot(absolutePath, options.filesRoot);
    // 中文注释：边界检查返回后、读取首字节前再次绑定当前路径与已打开 fd；路径替换只能零读取失败。
    assertHashFilePathStillMatchesDescriptor(fd, absolutePath, opened);
    if (options.filesRoot) assertRealPathWithinRoot(absolutePath, options.filesRoot);
    const expectedSize = Number(opened.size);
    const md5 = hashFileDescriptor(fd, expectedSize, fs.readSync);
    const afterDescriptor = fs.fstatSync(fd, { bigint: true });
    assertStableBigIntIdentity(afterDescriptor);
    // 中文注释：第二次 stat 后仍以 lstat/fstat 判定，竞态钩子或真实原子替换都只能失败关闭。
    const followedAfter = fs.statSync(absolutePath, { bigint: true });
    const afterPath = fs.lstatSync(absolutePath, { bigint: true });
    assertStableBigIntIdentity(followedAfter);
    assertStableBigIntIdentity(afterPath);
    if (!afterPath.isFile()
      || afterPath.isSymbolicLink()
      || !followedAfter.isFile()
      || afterDescriptor.size !== opened.size
      || afterDescriptor.mtimeNs !== opened.mtimeNs
      || afterDescriptor.ctimeNs !== opened.ctimeNs
      || followedAfter.size !== opened.size
      || afterPath.size !== opened.size
      || afterDescriptor.dev !== opened.dev
      || afterDescriptor.ino !== opened.ino
      || followedAfter.dev !== opened.dev
      || followedAfter.ino !== opened.ino
      || afterPath.dev !== opened.dev
      || afterPath.ino !== opened.ino) {
      throw new Error("项目文件在校验期间发生变化");
    }
    if (options.filesRoot) assertRealPathWithinRoot(absolutePath, options.filesRoot);
    return { size: expectedSize, md5 };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 安全打开并计算项目文件内容身份；调用方完成 fd 读取后必须 closeProjectFileHandle。
 * 中文注释：哈希前后都复核同一 fd 与项目内路径，路径替换不会导致读取新目标。
 */
export function openProjectFileIdentity(
  dataRoot: string,
  projectUuid: string,
  userSegment: string,
  relativePath: string,
): OpenProjectFileIdentity {
  const handle = openProjectFileHandle(dataRoot, projectUuid, userSegment, relativePath);
  try {
    assertOpenProjectFileHandleIdentity(handle);
    const md5 = hashFileDescriptor(
      handle.fd,
      handle.size,
      (fd, buffer, _offset, length, position) =>
        readProjectFileFdSync(fd, buffer, length, position),
    );
    assertOpenProjectFileHandleIdentity(handle);
    return { ...handle, md5 };
  } catch (error) {
    closeProjectFileHandle(handle.fd);
    throw error;
  }
}

/** 工作台预检只需要摘要时自动关闭安全 fd。 */
export function hashProjectFileIdentity(
  dataRoot: string,
  projectUuid: string,
  userSegment: string,
  relativePath: string,
): { absolutePath: string; size: number; md5: string } {
  const opened = openProjectFileIdentity(dataRoot, projectUuid, userSegment, relativePath);
  try {
    return { absolutePath: opened.absolutePath, size: opened.size, md5: opened.md5 };
  } finally {
    closeProjectFileHandle(opened.fd);
  }
}

function hashFileDescriptor(
  fd: number,
  expectedSize: number,
  reader: PositionalReader,
): string {
  const hash = crypto.createHash("md5");
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < expectedSize) {
    const length = Math.min(buffer.length, expectedSize - position);
    const read = reader(fd, buffer, 0, length, position);
    if (read <= 0) throw new Error("项目文件读取不完整");
    hash.update(buffer.subarray(0, read));
    position += read;
  }
  return hash.digest("hex");
}

function hashStableFile(absolutePath: string, relativePath: string, filesRoot: string): ProjectInventoryObject {
  // 中文注释：流式摘要 + size/mtime 稳定门；禁止对 files/** 使用 readFileSync。
  const digest = hashFileStreaming(absolutePath, { filesRoot });
  const ext = relativePath.includes(".") ? relativePath.split(".").pop()!.toLowerCase() : "";
  return {
    relativePath,
    size: digest.size,
    md5: digest.md5,
    mediaType: mediaTypeForExtension(ext),
  };
}

function assertStableBigIntIdentity(stat: fs.BigIntStats): void {
  // 中文注释：内容身份必须只有一个目录项；nlink 非一时无法证明当前项目/快照路径是唯一绑定。
  if (stat.dev <= 0n
    || stat.ino <= 0n
    || stat.nlink !== 1n
    || stat.size < 0n
    || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("无法取得稳定非零文件身份");
  }
}

function assertHashFilePathStillMatchesDescriptor(
  fd: number,
  absolutePath: string,
  expected: fs.BigIntStats,
): void {
  const descriptor = fs.fstatSync(fd, { bigint: true });
  const followed = fs.statSync(absolutePath, { bigint: true });
  const direct = fs.lstatSync(absolutePath, { bigint: true });
  assertStableBigIntIdentity(descriptor);
  assertStableBigIntIdentity(followed);
  assertStableBigIntIdentity(direct);
  if (!descriptor.isFile()
    || !followed.isFile()
    || !direct.isFile()
    || direct.isSymbolicLink()
    || descriptor.dev !== expected.dev
    || descriptor.ino !== expected.ino
    || descriptor.size !== expected.size
    || descriptor.mtimeNs !== expected.mtimeNs
    || descriptor.ctimeNs !== expected.ctimeNs
    || followed.dev !== expected.dev
    || followed.ino !== expected.ino
    || followed.size !== expected.size
    || direct.dev !== expected.dev
    || direct.ino !== expected.ino
    || direct.size !== expected.size) {
    throw new Error("项目文件在首字节读取前发生变化");
  }
}

function assertRealPathWithinRoot(target: string, filesRoot: string): void {
  const resolvedRoot = path.resolve(filesRoot);
  const realRoot = fs.realpathSync.native(resolvedRoot);
  const realTarget = fs.realpathSync.native(path.resolve(target));
  const relative = path.relative(realRoot, realTarget);
  const rootIdentityChanged = process.platform === "win32"
    ? realRoot.toLowerCase() !== resolvedRoot.toLowerCase()
    : realRoot !== resolvedRoot;
  if (rootIdentityChanged
    || !relative
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error("项目文件真实路径越出 filesRoot");
  }
}

function assertNotLink(target: string, label: string): void {
  if (!fs.existsSync(target)) return;
  const lst = fs.lstatSync(target);
  if (lst.isSymbolicLink() || isReparsePoint(lst)) {
    throw new Error(`${label}包含符号链接或重解析点`);
  }
}

function isReparsePoint(stat: fs.Stats): boolean {
  // Windows reparse：部分 Node 版本通过 lstat 的 isSymbolicLink 覆盖 junction/symlink。
  return Boolean(stat.isSymbolicLink());
}
