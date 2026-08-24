/**
 * 项目文件安全存储。
 * 所有项目归属媒体必须落在 runtime-users/<segment>/projects/<uuid>/files/ 内。
 * 路径解析 fail-closed：拒绝绝对路径、盘符、UNC、..、NUL、符号链接与重解析点。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { projectDirectory, projectFilesDirectory } from "../data/paths";
import type { ManifestMediaType } from "../sync/manifest";

export type ProjectFileCategory =
  | "images"
  | "videos"
  | "audios"
  | "thumbnails"
  | "references"
  | "imports"
  | "attachments"
  | "legacy";

export interface ProjectFileWriteResult {
  /** 相对项目根的稳定路径，统一使用 /，例如 files/images/a.png */
  relativePath: string;
  size: number;
  md5: string;
  mediaType: ManifestMediaType;
  absolutePath: string;
}

export interface OpenProjectFileHandle {
  fd: number;
  size: number;
  absolutePath: string;
  filesRoot: string;
  device: bigint;
  inode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface ExclusiveDestinationIdentity {
  absolutePath: string;
  parentPath: string;
  device: bigint;
  inode: bigint;
  nlink: bigint;
  parentDevice: bigint;
  parentInode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

const CATEGORY_BY_EXT: Record<string, ProjectFileCategory> = {
  png: "images",
  jpg: "images",
  jpeg: "images",
  gif: "images",
  webp: "images",
  avif: "images",
  bmp: "images",
  mp4: "videos",
  webm: "videos",
  mov: "videos",
  mkv: "videos",
  avi: "videos",
  mp3: "audios",
  wav: "audios",
  m4a: "audios",
  aac: "audios",
  flac: "audios",
  ogg: "audios",
  txt: "imports",
  md: "imports",
  json: "imports",
  pdf: "attachments",
  zip: "attachments",
};

/**
 * 将业务相对路径解析为项目 files 下的绝对路径。
 * 中文注释：项目归属边界——任何跨用户、跨项目或越出 files 的路径都必须失败，禁止静默回落到账号 oss。
 */
export function resolveProjectFilePath(
  dataRoot: string,
  projectUuid: string,
  userSegment: string,
  relativePath: string,
): string {
  const normalized = normalizeProjectRelativePath(relativePath);
  const rawFilesRoot = projectFilesDirectory(dataRoot, projectUuid, userSegment);
  // 中文注释：必须在 realpath 前检查原始链，否则 files 根 junction 会被 canonicalize 后隐身。
  assertManagedPathChainHasNoLinks(dataRoot, rawFilesRoot);
  fs.mkdirSync(rawFilesRoot, { recursive: true });
  assertManagedPathChainHasNoLinks(dataRoot, rawFilesRoot);
  const filesRoot = path.resolve(rawFilesRoot);
  // 中文注释：清单对象以 files/ 为前缀；存储接口同时接受 files/ 前缀与 files 内相对段。
  const underFiles = normalized.startsWith("files/")
    ? normalized.slice("files/".length)
    : normalized;
  if (!underFiles || underFiles.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("项目文件相对路径无效");
  }
  const candidate = path.resolve(filesRoot, ...underFiles.split("/"));
  const scoped = path.relative(filesRoot, candidate);
  if (!scoped || scoped.startsWith("..") || path.isAbsolute(scoped)) {
    throw new Error("项目文件路径越出当前项目 files 目录");
  }
  // 中文注释：最终目标必须无条件 lstat；只有 ENOENT 才代表尚未创建，避免 dangling symlink 被 existsSync 隐藏。
  if (lstatIfPresent(candidate)) {
    assertNotSymlinkOrReparse(candidate, filesRoot);
  } else {
    // 父目录链也不得穿越链接
    assertParentChainSafe(path.dirname(candidate), filesRoot);
  }
  return candidate;
}

/**
 * 验证 anchor 到 target 的原始现存路径链，拒绝 symlink、Junction 与重定向 reparse point。
 * target 后续段允许尚未创建；调用方创建后必须再次验证。
 */
export function assertManagedPathChainHasNoLinks(anchorPath: string, targetPath: string): void {
  const anchor = path.resolve(anchorPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(anchor, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("受管路径越出安全根");
  }
  let current = anchor;
  const components = relative ? relative.split(path.sep).filter(Boolean) : [];
  for (const component of ["", ...components]) {
    if (component) current = path.join(current, component);
    // 中文注释：路径链每一段都必须 lstat；仅 ENOENT 允许继续，权限/IO 错误必须向上抛出。
    const details = lstatIfPresent(current);
    if (!details) break;
    if (details.isSymbolicLink() || isReparsePoint(details)) {
      throw new Error("受管路径包含符号链接、Junction 或重解析点");
    }
    if (current !== target && !details.isDirectory()) {
      throw new Error("受管路径父链不是目录");
    }
    const realCurrent = fs.realpathSync.native(current);
    if (!sameNativePath(current, realCurrent)) {
      throw new Error("受管路径包含重定向 reparse point");
    }
  }
}

export function classifyProjectFile(
  relativePath: string,
  mimeHint?: string,
): { category: ProjectFileCategory; mediaType: ManifestMediaType } {
  const lower = relativePath.toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  if (lower.includes("/thumbnails/") || lower.startsWith("thumbnails/")) {
    return { category: "thumbnails", mediaType: "image" };
  }
  if (lower.includes("/references/") || lower.startsWith("references/")) {
    return { category: "references", mediaType: mediaTypeForExtension(ext) === "image" ? "image" : "binary" };
  }
  if (lower.includes("/legacy/") || lower.startsWith("legacy/")) {
    return { category: "legacy", mediaType: mediaTypeForExtension(ext) };
  }
  if (mimeHint?.startsWith("image/")) return { category: "images", mediaType: "image" };
  if (mimeHint?.startsWith("video/")) return { category: "videos", mediaType: "video" };
  if (mimeHint?.startsWith("audio/")) return { category: "audios", mediaType: "audio" };
  const category = CATEGORY_BY_EXT[ext] ?? "attachments";
  return { category, mediaType: mediaTypeForExtension(ext) };
}

export function mediaTypeForExtension(ext: string): ManifestMediaType {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"].includes(e)) return "image";
  // 中文注释：与工作台上传/预览允许的视频扩展保持一致，避免 AVI 前端可选而后端判为 binary。
  if (["mp4", "webm", "mov", "mkv", "avi"].includes(e)) return "video";
  if (["mp3", "wav", "m4a", "aac", "flac", "ogg"].includes(e)) return "audio";
  if (["txt", "md", "json", "yaml", "yml", "csv", "srt", "vtt"].includes(e)) return "text";
  return "binary";
}

/**
 * 原子写入项目文件：同目录临时文件 → flush/close → rename。
 * 中文注释：只在 rename 成功后发布目标，读者只能看到旧版本或完整新版本。
 * R25 不声称抵御同一 Windows 用户在 syscall 间替换目录；handle-bound 提交留给 R26。
 */
export function writeProjectFileAtomic(
  dataRoot: string,
  projectUuid: string,
  userSegment: string,
  relativePath: string,
  data: Buffer | string,
): ProjectFileWriteResult {
  const absolutePath = resolveProjectFilePath(dataRoot, projectUuid, userSegment, relativePath);
  const buffer = typeof data === "string"
    ? Buffer.from(data.replace(/^data:[^;]+;base64,/, ""), "base64")
    : data;
  const parentPath = path.dirname(absolutePath);
  fs.mkdirSync(parentPath, { recursive: true });
  // 中文注释：mkdir 后必须重新绑定父目录身份；父链被 junction/reparse 替换时不得创建临时文件。
  assertManagedPathChainHasNoLinks(dataRoot, parentPath);
  const parentIdentity = captureSafeDestinationParent(parentPath);
  const existing = lstatIfPresent(absolutePath, { bigint: true });
  if (existing) {
    // 中文注释：覆盖前仍拒绝预置硬链接；R25 不把替换既有链接当作安全覆盖。
    assertStableBigIntFileIdentity(existing);
  }
  const temporary = `${absolutePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = fs.openSync(temporary, "wx", 0o600);
  let temporaryIdentity: fs.BigIntStats | undefined;
  let closed = false;
  let committed = false;
  try {
    // 中文注释：首字节前绑定临时 fd、目标父目录与唯一身份，避免链接目标承接项目内容。
    temporaryIdentity = assertExclusiveDestinationIdentity(handle, temporary, parentIdentity);
    writeBufferToFd(handle, buffer);
    fs.fsyncSync(handle);
    // 中文注释：提交前再次确认父目录、fd 与临时路径身份；漂移时保持 fail-closed。
    assertSameFileIdentity(
      temporaryIdentity,
      assertExclusiveDestinationIdentity(handle, temporary, parentIdentity),
    );
    fs.closeSync(handle);
    closed = true;
    assertManagedPathChainHasNoLinks(dataRoot, parentPath);
    assertClosedTemporaryIdentity(temporary, parentIdentity, temporaryIdentity);
    fs.renameSync(temporary, absolutePath);
    committed = true;
  } catch (error) {
    if (!closed) {
      try { fs.closeSync(handle); } catch { /* 句柄已失效时继续保留临时文件 */ }
      closed = true;
    }
    if (!committed && temporaryIdentity) {
      // 中文注释：只在父目录与临时文件仍匹配创建时身份时清理；身份未知时宁可保留残留。
      try {
        assertManagedPathChainHasNoLinks(dataRoot, parentPath);
        assertClosedTemporaryIdentity(temporary, parentIdentity, temporaryIdentity);
        fs.rmSync(temporary, { force: true });
      } catch {
        // 身份失效后禁止按未知路径清理，避免误删外部替换对象。
      }
    }
    throw error;
  }
  const md5 = crypto.createHash("md5").update(buffer).digest("hex");
  const logical = toProjectRootRelative(relativePath);
  const { mediaType } = classifyProjectFile(logical);
  return {
    relativePath: logical,
    size: buffer.length,
    md5,
    mediaType,
    absolutePath,
  };
}

function writeBufferToFd(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
    if (written <= 0) throw new Error("项目文件写入不完整");
    offset += written;
  }
}

function assertClosedTemporaryIdentity(
  temporary: string,
  parent: SafeDestinationParentIdentity,
  expected: fs.BigIntStats,
): void {
  const parentStat = fs.lstatSync(parent.absolutePath, { bigint: true });
  assertStableBigIntNodeIdentity(parentStat);
  const temporaryStat = fs.lstatSync(temporary, { bigint: true });
  assertStableBigIntFileIdentity(temporaryStat);
  assertSameFileIdentity(expected, temporaryStat);
  if (!parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || parentStat.dev !== parent.device
    || parentStat.ino !== parent.inode
    || !sameNativePath(fs.realpathSync.native(parent.absolutePath), parent.absolutePath)
    || temporaryStat.dev !== parentStat.dev
    || !sameNativePath(fs.realpathSync.native(temporary), temporary)) {
    throw new Error("项目文件临时目标身份已变化");
  }
}

function assertSameFileIdentity(expected: fs.BigIntStats, actual: fs.BigIntStats): void {
  if (expected.dev !== actual.dev
    || expected.ino !== actual.ino
    || expected.nlink !== actual.nlink) {
    throw new Error("项目文件 fd 与路径身份不一致");
  }
}

export function readProjectFile(
  dataRoot: string,
  projectUuid: string,
  userSegment: string,
  relativePath: string,
): Buffer {
  const absolutePath = resolveProjectFilePath(dataRoot, projectUuid, userSegment, relativePath);
  if (!lstatIfPresent(absolutePath)) throw new Error("项目文件不存在");
  assertNotSymlinkOrReparse(absolutePath, projectFilesDirectory(dataRoot, projectUuid, userSegment));
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) throw new Error("项目路径不是普通文件");
  return fs.readFileSync(absolutePath);
}

let afterProjectFileStatForTests: (() => void) | null = null;
let beforeProjectFileOpenForTests: (() => void) | null = null;
let afterProjectFileOpenForTests: (() => void) | null = null;
let projectFileReadSyncForTests: ((
  fd: number,
  target: Buffer,
  length: number,
  position: number,
) => number) | null = null;
let projectFileCloseCountForTests = 0;

export function setProjectFileAfterStatHookForTests(hook: (() => void) | null): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  afterProjectFileStatForTests = hook;
}

export function setProjectFileBeforeOpenHookForTests(hook: (() => void) | null): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  beforeProjectFileOpenForTests = hook;
}

export function setProjectFileAfterOpenHookForTests(hook: (() => void) | null): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  afterProjectFileOpenForTests = hook;
}

export function setProjectFileReadSyncHookForTests(
  hook: ((fd: number, target: Buffer, length: number, position: number) => number) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  projectFileReadSyncForTests = hook;
}

export function resetProjectFileCloseCountForTests(): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  projectFileCloseCountForTests = 0;
}

export function readProjectFileCloseCountForTests(): number {
  return projectFileCloseCountForTests;
}

export function readProjectFileFdSync(
  fd: number,
  target: Buffer,
  length: number,
  position: number,
): number {
  if (projectFileReadSyncForTests) return projectFileReadSyncForTests(fd, target, length, position);
  return fs.readSync(fd, target, 0, length, position);
}

export function openProjectFileHandle(
  dataRoot: string,
  projectUuid: string,
  userSegment: string,
  relativePath: string,
): OpenProjectFileHandle {
  const filesRoot = projectFilesDirectory(dataRoot, projectUuid, userSegment);
  const absolutePath = resolveProjectFilePath(dataRoot, projectUuid, userSegment, relativePath);
  if (!lstatIfPresent(absolutePath)) throw new Error("项目文件不存在");
  assertNotSymlinkOrReparse(absolutePath, filesRoot);
  // 中文注释：测试钩子模拟校验后替换；真正打开必须只发生一次，禁止随后按原路径 reopen。
  if (afterProjectFileStatForTests) afterProjectFileStatForTests();
  assertNotSymlinkOrReparse(absolutePath, filesRoot);
  if (beforeProjectFileOpenForTests) beforeProjectFileOpenForTests();
  const nofollow = Number(fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | nofollow);
  if (afterProjectFileOpenForTests) afterProjectFileOpenForTests();
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    assertStableBigIntFileIdentity(stat);
    if (!stat.isFile()) throw new Error("项目路径不是普通文件");
    const pathStat = fs.lstatSync(absolutePath, { bigint: true });
    assertStableBigIntFileIdentity(pathStat);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error("项目文件路径包含符号链接或重解析点");
    }
    if (stat.size !== pathStat.size || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new Error("项目文件句柄身份与路径不一致");
    }
    const real = fs.realpathSync.native(absolutePath);
    const scoped = path.relative(path.resolve(filesRoot), real);
    if (!scoped || scoped.startsWith("..") || path.isAbsolute(scoped)) {
      throw new Error("项目文件路径越出当前项目 files 目录");
    }
    return {
      fd,
      size: Number(stat.size),
      absolutePath: real,
      filesRoot: path.resolve(filesRoot),
      device: stat.dev,
      inode: stat.ino,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/**
 * 复核已打开 fd 仍对应最初项目文件身份；任何路径或父目录替换都必须失败。
 * 中文注释：边界只用于验证，后续内容读取始终使用同一个 fd，禁止按路径 reopen。
 */
export function assertOpenProjectFileHandleIdentity(handle: OpenProjectFileHandle): void {
  const descriptorStat = fs.fstatSync(handle.fd, { bigint: true });
  assertStableBigIntFileIdentity(descriptorStat);
  if (!descriptorStat.isFile()
    || descriptorStat.size !== BigInt(handle.size)
    || descriptorStat.mtimeNs !== handle.mtimeNs
    || descriptorStat.ctimeNs !== handle.ctimeNs
    || descriptorStat.dev !== handle.device
    || descriptorStat.ino !== handle.inode) {
    throw new Error("项目文件句柄身份已变化");
  }
  // 中文注释：stat 仅复核当前路径身份、不读取内容；随后 lstat 再捕获 stat 返回后的原子替换。
  const followedPathStat = fs.statSync(handle.absolutePath, { bigint: true });
  const pathStat = fs.lstatSync(handle.absolutePath, { bigint: true });
  assertStableBigIntFileIdentity(followedPathStat);
  assertStableBigIntFileIdentity(pathStat);
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || isReparsePoint(pathStat)) {
    throw new Error("项目文件路径包含符号链接或重解析点");
  }
  if (!followedPathStat.isFile()
    || followedPathStat.size !== BigInt(handle.size)
    || pathStat.size !== BigInt(handle.size)
    || followedPathStat.dev !== handle.device
    || followedPathStat.ino !== handle.inode
    || pathStat.dev !== handle.device
    || pathStat.ino !== handle.inode) {
    throw new Error("项目文件句柄身份与路径不一致");
  }
  const real = fs.realpathSync.native(handle.absolutePath);
  const scoped = path.relative(handle.filesRoot, real);
  if (!scoped || scoped.startsWith("..") || path.isAbsolute(scoped) || !sameNativePath(real, handle.absolutePath)) {
    throw new Error("项目文件路径越出当前项目 files 目录");
  }
}

/** 从同一安全项目文件 fd 复制到独占目标；失败时保留已打开对象，禁止按可变路径清理。 */
export function copyOpenProjectFileHandleToExclusivePath(
  handle: OpenProjectFileHandle,
  destination: string,
): ExclusiveDestinationIdentity {
  assertOpenProjectFileHandleIdentity(handle);
  const destinationParent = captureSafeDestinationParent(path.dirname(destination));
  const destinationFd = fs.openSync(destination, "wx", 0o600);
  try {
    // 中文注释：目标刚打开后、写入首字节前绑定 fd、路径及父目录身份；junction 竞态最多留下零字节占位。
    assertExclusiveDestinationIdentity(destinationFd, destination, destinationParent);
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < handle.size) {
      const length = Math.min(buffer.length, handle.size - position);
      const read = readProjectFileFdSync(handle.fd, buffer, length, position);
      if (read <= 0) throw new Error("项目文件读取不完整");
      let written = 0;
      while (written < read) {
        const count = fs.writeSync(destinationFd, buffer, written, read - written, position + written);
        if (count <= 0) throw new Error("项目文件复制不完整");
        written += count;
      }
      position += read;
    }
    // 中文注释：读取完成后再次比对源 fd、目标 fd/路径与父目录，任何漂移都失败关闭。
    assertOpenProjectFileHandleIdentity(handle);
    assertExclusiveDestinationIdentity(destinationFd, destination, destinationParent);
    fs.fsyncSync(destinationFd);
    assertOpenProjectFileHandleIdentity(handle);
    const completed = assertExclusiveDestinationIdentity(destinationFd, destination, destinationParent);
    return {
      absolutePath: path.resolve(destination),
      parentPath: destinationParent.absolutePath,
      device: completed.dev,
      inode: completed.ino,
      nlink: completed.nlink,
      parentDevice: destinationParent.device,
      parentInode: destinationParent.inode,
      size: completed.size,
      mtimeNs: completed.mtimeNs,
      ctimeNs: completed.ctimeNs,
    };
  } finally {
    // 中文注释：Node/Windows 没有基于目录 fd 的 unlinkat；身份检查后再 rm(path) 仍有窗口，失败时保留本次对象。
    fs.closeSync(destinationFd);
  }
}

interface SafeDestinationParentIdentity {
  absolutePath: string;
  device: bigint;
  inode: bigint;
}

function captureSafeDestinationParent(directory: string): SafeDestinationParentIdentity {
  const absolutePath = path.resolve(directory);
  const stat = fs.lstatSync(absolutePath, { bigint: true });
  assertStableBigIntNodeIdentity(stat);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameNativePath(fs.realpathSync.native(absolutePath), absolutePath)) {
    throw new Error("项目快照目标目录不安全");
  }
  return { absolutePath, device: stat.dev, inode: stat.ino };
}

function assertExclusiveDestinationIdentity(
  fd: number,
  destination: string,
  parent: SafeDestinationParentIdentity,
): fs.BigIntStats {
  const parentStat = fs.lstatSync(parent.absolutePath, { bigint: true });
  assertStableBigIntNodeIdentity(parentStat);
  const targetStat = fs.fstatSync(fd, { bigint: true });
  const pathStat = fs.lstatSync(destination, { bigint: true });
  assertStableBigIntFileIdentity(targetStat);
  assertStableBigIntFileIdentity(pathStat);
  if (!parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || parentStat.dev !== parent.device
    || parentStat.ino !== parent.inode
    || !sameNativePath(fs.realpathSync.native(parent.absolutePath), parent.absolutePath)
    || !targetStat.isFile()
    || !pathStat.isFile()
    || pathStat.isSymbolicLink()
    || targetStat.dev !== pathStat.dev
    || targetStat.ino !== pathStat.ino) {
    throw new Error("项目快照目标文件身份不安全");
  }
  return targetStat;
}

function assertStableBigIntFileIdentity(stat: fs.BigIntStats): void {
  assertStableBigIntNodeIdentity(stat);
  // 中文注释：普通项目文件只接受唯一目录项；硬链接数非一时无法证明路径仍是本次唯一绑定。
  if (stat.nlink !== 1n || stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("无法取得稳定非零文件身份");
  }
}

function assertStableBigIntNodeIdentity(stat: fs.BigIntStats): void {
  if (stat.dev <= 0n || stat.ino <= 0n) throw new Error("无法取得稳定非零文件身份");
}

export function closeProjectFileHandle(fd: number): void {
  if (process.env.NODE_TEST_CONTEXT) projectFileCloseCountForTests += 1;
  try { fs.closeSync(fd); } catch { /* ignore */ }
}

export function statProjectFile(
  dataRoot: string,
  projectUuid: string,
  userSegment: string,
  relativePath: string,
): { absolutePath: string; size: number } {
  const handle = openProjectFileHandle(dataRoot, projectUuid, userSegment, relativePath);
  closeProjectFileHandle(handle.fd);
  return { absolutePath: handle.absolutePath, size: handle.size };
}

export function openProjectFileReadStream(
  dataRoot: string,
  projectUuid: string,
  userSegment: string,
  relativePath: string,
  range?: { start: number; end: number },
): { stream: fs.ReadStream; size: number; absolutePath: string; fd: number } {
  const handle = openProjectFileHandle(dataRoot, projectUuid, userSegment, relativePath);
  const stream = fs.createReadStream("", {
    fd: handle.fd,
    start: range?.start ?? 0,
    end: range?.end ?? Math.max(0, handle.size - 1),
    autoClose: true,
  });
  return { stream, size: handle.size, absolutePath: handle.absolutePath, fd: handle.fd };
}

export function readProjectFileRange(
  dataRoot: string,
  projectUuid: string,
  userSegment: string,
  relativePath: string,
  start: number,
  end: number,
): Buffer {
  const handle = openProjectFileHandle(dataRoot, projectUuid, userSegment, relativePath);
  try {
    if (start < 0 || end < start || start >= handle.size) {
      throw new Error("项目文件区间无效");
    }
    const length = Math.min(end, handle.size - 1) - start + 1;
    const bytes = Buffer.alloc(length);
    const read = fs.readSync(handle.fd, bytes, 0, length, start);
    return read === length ? bytes : bytes.subarray(0, read);
  } finally {
    closeProjectFileHandle(handle.fd);
  }
}

export function deleteProjectFile(
  dataRoot: string,
  projectUuid: string,
  userSegment: string,
  relativePath: string,
): void {
  const absolutePath = resolveProjectFilePath(dataRoot, projectUuid, userSegment, relativePath);
  if (!lstatIfPresent(absolutePath)) return;
  assertNotSymlinkOrReparse(absolutePath, projectFilesDirectory(dataRoot, projectUuid, userSegment));
  fs.rmSync(absolutePath, { force: true });
}

export function projectFileExists(
  dataRoot: string,
  projectUuid: string,
  userSegment: string,
  relativePath: string,
): boolean {
  try {
    const absolutePath = resolveProjectFilePath(dataRoot, projectUuid, userSegment, relativePath);
    if (!lstatIfPresent(absolutePath)) return false;
    assertNotSymlinkOrReparse(absolutePath, projectFilesDirectory(dataRoot, projectUuid, userSegment));
    return fs.statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

/** 业务写入时按类型生成稳定相对路径（含 files/ 前缀）。 */
export function buildProjectFileRelativePath(
  category: ProjectFileCategory,
  fileName: string,
): string {
  const safeName = sanitizeFileName(fileName);
  return `files/${category}/${safeName}`;
}

export function projectRootFor(
  dataRoot: string,
  projectUuid: string,
  userSegment: string,
): string {
  return projectDirectory(dataRoot, projectUuid, userSegment);
}

function normalizeProjectRelativePath(relativePath: string): string {
  if (typeof relativePath !== "string" || !relativePath) {
    throw new Error("项目文件相对路径无效");
  }
  // 中文注释：拒绝 Windows 盘符、UNC、绝对路径与反斜杠，统一协议为 POSIX 相对段。
  if (
    relativePath.startsWith("/")
    || relativePath.startsWith("\\")
    || relativePath.includes("\\")
    || /^[a-zA-Z]:/.test(relativePath)
    || relativePath.startsWith("//")
    || relativePath.startsWith("\\\\")
    || relativePath.includes("\0")
    || /^(nul|con|prn|aux)(\.|$)/i.test(relativePath.split("/").pop() ?? "")
  ) {
    throw new Error("项目文件相对路径无效");
  }
  const normalized = relativePath.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized !== path.posix.normalize(normalized) && path.posix.normalize(normalized) !== normalized.replace(/^\.\//, "")) {
    // 继续用分段校验
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === "NUL" || /^nul$/i.test(part))) {
    throw new Error("项目文件相对路径无效");
  }
  return normalized;
}

function toProjectRootRelative(relativePath: string): string {
  const normalized = normalizeProjectRelativePath(relativePath);
  return normalized.startsWith("files/") ? normalized : `files/${normalized}`;
}

function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[<>:"|?*\u0000-\u001f]/g, "_");
  if (!base || base === "." || base === ".." || /^nul$/i.test(base)) {
    throw new Error("项目文件名无效");
  }
  return base;
}

function sameNativePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/**
 * 对最终目标做不跟随链接的存在性检查。
 * 中文注释：dangling symlink 的 lstat 会成功，只有真正的 ENOENT 才能当作“尚未创建”。
 */
function lstatIfPresent(target: fs.PathLike): fs.Stats | null;
function lstatIfPresent(target: fs.PathLike, options: fs.BigIntOptions): fs.BigIntStats | null;
function lstatIfPresent(target: fs.PathLike, options?: fs.BigIntOptions): fs.Stats | fs.BigIntStats | null {
  try {
    return options ? fs.lstatSync(target, options) : fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertNotSymlinkOrReparse(target: string, filesRoot: string): void {
  const root = path.resolve(filesRoot);
  let current = path.resolve(target);
  while (current.startsWith(root)) {
    const lst = lstatIfPresent(current);
    if (lst) {
      // 中文注释：fail-closed——符号链接与 Windows reparse point（含 junction）一律拒绝。
      if (lst.isSymbolicLink() || isReparsePoint(lst)) {
        throw new Error("项目文件路径包含符号链接或重解析点");
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    if (parent.length < root.length) break;
    current = parent;
  }
}

function assertParentChainSafe(directory: string, filesRoot: string): void {
  const root = path.resolve(filesRoot);
  let current = path.resolve(directory);
  while (current.startsWith(root)) {
    // 中文注释：父目录 dangling symlink 也要被 lstat 捕获，不能由 existsSync 静默当作不存在。
    const lst = lstatIfPresent(current);
    if (lst) {
      if (lst.isSymbolicLink() || isReparsePoint(lst)) {
        throw new Error("项目文件路径包含符号链接或重解析点");
      }
    }
    const parent = path.dirname(current);
    if (parent === current || parent.length < root.length) break;
    current = parent;
  }
}

function isReparsePoint(stat: fs.Stats | fs.BigIntStats): boolean {
  // 中文注释：bigint Stats 与普通 Stats 都必须执行同一重解析点判断。
  const mode = Number(stat.mode ?? 0);
  return Boolean((stat as { isSymbolicLink?: () => boolean }).isSymbolicLink?.())
    || ((mode & 0o170000) === 0 && false)
    || Boolean(stat.ino && (stat as unknown as { reparseTag?: number }).reparseTag);
}
