/**
 * 生成视频可采用性校验。
 * 中文注释：按 fd 有界扫描顶层 ISO-BMFF，跳过大型 mdat，不得把整部视频读入 Buffer。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DREAMINA_INVALID_VIDEO_CODE = "DREAMINA_RESULT_VIDEO_INVALID";
export const DREAMINA_INVALID_VIDEO_MESSAGE = "生成结果不是可采用的视频";

const MAX_MOOV_BYTES = 512 * 1024;

function rejectInvalid(): never {
  throw Object.assign(new Error(DREAMINA_INVALID_VIDEO_MESSAGE), {
    status: 422,
    code: DREAMINA_INVALID_VIDEO_CODE,
  });
}

export function assertPathInsideRoot(candidate: string, root: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const scoped = path.relative(resolvedRoot, resolved);
  if (!scoped || scoped.startsWith("..") || path.isAbsolute(scoped)) rejectInvalid();
  return resolved;
}

export function fileIdentity(stat: fs.Stats): { dev: bigint; ino: bigint } {
  const bigintStat = stat as fs.Stats & { dev: number | bigint; ino: number | bigint };
  return {
    dev: BigInt(bigintStat.dev),
    ino: BigInt(bigintStat.ino),
  };
}

export function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  const a = fileIdentity(left);
  const b = fileIdentity(right);
  return a.dev === b.dev && a.ino === b.ino;
}

export function hashOpenFile(fd: number, size: number): string {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let remaining = size;
  let position = 0;
  while (remaining > 0) {
    const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), position);
    if (read <= 0) break;
    hash.update(buffer.subarray(0, read));
    remaining -= read;
    position += read;
  }
  return hash.digest("hex");
}

export function assertAdoptableMp4Bytes(bytes: Buffer): void {
  if (bytes.length < 16) rejectInvalid();
  const boxes = parseBoxes(bytes, 0, bytes.length);
  if (!boxes.some((box) => box.type === "ftyp")) rejectInvalid();
  const moov = boxes.find((box) => box.type === "moov");
  if (!moov) rejectInvalid();
  assertMoovHasVideoTrack(bytes, moov.start, moov.end);
}

function assertMoovHasVideoTrack(bytes: Buffer, start: number, end: number): void {
  const inner = parseBoxes(bytes, start + 8, end);
  const tracks = inner.filter((box) => box.type === "trak");
  if (tracks.length === 0) rejectInvalid();
  const hasVideo = tracks.some((track) => {
    const media = parseBoxes(bytes, track.start + 8, track.end);
    const mdia = media.find((box) => box.type === "mdia");
    if (!mdia) return false;
    const mdiaBoxes = parseBoxes(bytes, mdia.start + 8, mdia.end);
    if (mdiaBoxes.some((box) => box.type === "minf" && hasVmhd(bytes, box))) return true;
    const hdlr = mdiaBoxes.find((box) => box.type === "hdlr");
    if (!hdlr || hdlr.end - hdlr.start < 16) return false;
    return bytes.subarray(hdlr.start + 16, hdlr.start + 20).toString("ascii") === "vide";
  });
  if (!hasVideo) rejectInvalid();
}

function hasVmhd(bytes: Buffer, minf: { start: number; end: number }): boolean {
  return parseBoxes(bytes, minf.start + 8, minf.end).some((box) => box.type === "vmhd");
}

function readUInt64BE(bytes: Buffer, offset: number): number {
  if (offset + 8 > bytes.length) rejectInvalid();
  const high = bytes.readUInt32BE(offset);
  const low = bytes.readUInt32BE(offset + 4);
  if (high > 0x1fffff) rejectInvalid();
  const value = high * 0x1_0000_0000 + low;
  if (!Number.isSafeInteger(value) || value <= 0) rejectInvalid();
  return value;
}

function parseBoxes(bytes: Buffer, start: number, end: number): Array<{ type: string; start: number; end: number }> {
  const boxes: Array<{ type: string; start: number; end: number }> = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    let header = 8;
    let boxSize = size;
    if (size === 1) {
      if (offset + 16 > end) rejectInvalid();
      boxSize = readUInt64BE(bytes, offset + 8);
      header = 16;
    }
    const boxEnd = size === 0 ? end : offset + boxSize;
    if (size !== 0 && boxSize < header) rejectInvalid();
    if (boxEnd > end || boxEnd <= offset) rejectInvalid();
    boxes.push({ type, start: offset, end: boxEnd });
    if (size === 0) break;
    offset = boxEnd;
  }
  return boxes;
}

export function assertAdoptableMp4Fd(fd: number, fileSize: number): void {
  if (fileSize < 16) rejectInvalid();
  let offset = 0;
  let sawFtyp = false;
  let sawMoov = false;
  const header = Buffer.alloc(16);
  while (offset + 8 <= fileSize) {
    const headRead = fs.readSync(fd, header, 0, 8, offset);
    if (headRead < 8) rejectInvalid();
    const size = header.readUInt32BE(0);
    const type = header.subarray(4, 8).toString("ascii");
    let headerSize = 8;
    let boxSize = size;
    if (size === 1) {
      const wide = fs.readSync(fd, header, 8, 8, offset + 8);
      if (wide < 8) rejectInvalid();
      boxSize = readUInt64BE(header, 8);
      headerSize = 16;
    }
    const boxEnd = size === 0 ? fileSize : offset + boxSize;
    if (size !== 0 && boxSize < headerSize) rejectInvalid();
    if (boxEnd > fileSize || boxEnd <= offset) rejectInvalid();
    if (type === "ftyp") sawFtyp = true;
    if (type === "moov") {
      const moovSize = boxEnd - offset;
      if (moovSize > MAX_MOOV_BYTES) rejectInvalid();
      const moov = Buffer.alloc(moovSize);
      const read = fs.readSync(fd, moov, 0, moovSize, offset);
      if (read !== moovSize) rejectInvalid();
      assertMoovHasVideoTrack(moov, 0, moov.length);
      sawMoov = true;
    }
    if (size === 0) break;
    offset = boxEnd;
  }
  if (!sawFtyp || !sawMoov) rejectInvalid();
}

export function openNoFollowRead(absolutePath: string): number {
  const nofollow = Number(fs.constants.O_NOFOLLOW ?? 0);
  return fs.openSync(absolutePath, fs.constants.O_RDONLY | nofollow);
}

export function assertOpenedFileIdentity(fd: number, absolutePath: string, root?: string): fs.Stats {
  const opened = fs.fstatSync(fd);
  if (!opened.isFile()) rejectInvalid();
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(absolutePath);
  } catch {
    rejectInvalid();
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) rejectInvalid();
  if (!sameFileIdentity(opened, pathStat)) rejectInvalid();
  if (root) {
    let real: string;
    try {
      real = fs.realpathSync.native(absolutePath);
    } catch {
      rejectInvalid();
    }
    assertPathInsideRoot(real, root);
  }
  return opened;
}

export function copyFdToExclusivePath(sourceFd: number, destPath: string, size: number): void {
  const destFd = fs.openSync(
    destPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let remaining = size;
    let position = 0;
    while (remaining > 0) {
      const read = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, remaining), position);
      if (read <= 0) rejectInvalid();
      fs.writeSync(destFd, buffer, 0, read);
      remaining -= read;
      position += read;
    }
  } finally {
    fs.closeSync(destFd);
  }
}

export function assertAdoptableStagingVideo(source: string, stagingDirectory: string): void {
  const opened = openAdoptableStagingVideo(source, stagingDirectory);
  fs.closeSync(opened.fd);
}

export function openAdoptableStagingVideo(source: string, stagingDirectory: string): {
  fd: number;
  size: number;
  identity: { dev: bigint; ino: bigint };
  absolutePath: string;
} {
  const stagingRoot = path.resolve(stagingDirectory);
  const resolved = assertPathInsideRoot(source, stagingRoot);
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== ".mp4") rejectInvalid();
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    rejectInvalid();
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) rejectInvalid();
  let real: string;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    rejectInvalid();
  }
  assertPathInsideRoot(real, stagingRoot);
  const fd = openNoFollowRead(resolved);
  try {
    const opened = assertOpenedFileIdentity(fd, resolved, stagingRoot);
    if (opened.size <= 0) rejectInvalid();
    assertAdoptableMp4Fd(fd, opened.size);
    return { fd, size: opened.size, identity: fileIdentity(opened), absolutePath: resolved };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function assertAdoptableProjectVideoFile(absolutePath: string): void {
  const ext = path.extname(absolutePath).toLowerCase();
  if (ext !== ".mp4") rejectInvalid();
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) rejectInvalid();
  const fd = openNoFollowRead(absolutePath);
  try {
    const opened = assertOpenedFileIdentity(fd, absolutePath);
    assertAdoptableMp4Fd(fd, opened.size);
  } finally {
    fs.closeSync(fd);
  }
}
