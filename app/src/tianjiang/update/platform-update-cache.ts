import fs from "node:fs";
import path from "node:path";

import { compareDesktopVersions } from "../../../scripts/platform-release-contract.mjs";
import {
  parsePlatformReleaseEntry,
  type PlatformReleaseEntry,
  type PlatformUpdateChannel,
} from "./platform-release-catalog";

export interface PlatformUpdateCacheRecord {
  cacheVersion: 1;
  currentVersion: string;
  checkedAt: string;
  stableRequiredVersion?: string;
  stable?: PlatformReleaseEntry;
  beta?: PlatformReleaseEntry;
}

export interface PlatformUpdateCacheFileSystem {
  existsSync(filePath: string): boolean;
  lstatSync(filePath: string): PlatformUpdateCacheStat;
  realpathSync(filePath: string): string;
  openSync(filePath: string, flags: number, mode?: number): number;
  fstatSync(fileDescriptor: number): PlatformUpdateCacheStat;
  readSync(
    fileDescriptor: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  writeSync(
    fileDescriptor: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  fsyncSync(fileDescriptor: number): void;
  closeSync(fileDescriptor: number): void;
  mkdirSync(directoryPath: string, options: { recursive: false; mode: number }): unknown;
  renameSync(from: string, to: string): void;
  unlinkSync(filePath: string): void;
}

export interface PlatformUpdateCacheStat {
  size: number;
  dev: number;
  ino: number;
  reparseTag?: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface PlatformUpdateCacheOptions {
  fileSystem?: PlatformUpdateCacheFileSystem;
  now?: () => Date;
  nonce?: () => string;
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024;

interface CachePathIdentity {
  lexicalPath: string;
  realPath: string;
  dev: number;
  ino: number;
  reparseTag?: number;
  kind: "directory" | "file";
}

const nodeFileSystem: PlatformUpdateCacheFileSystem = {
  existsSync: (filePath) => fs.existsSync(filePath),
  lstatSync: (filePath) => fs.lstatSync(filePath),
  realpathSync: (filePath) => fs.realpathSync.native(filePath),
  openSync: (filePath, flags, mode) => fs.openSync(filePath, flags, mode),
  fstatSync: (fileDescriptor) => fs.fstatSync(fileDescriptor),
  readSync: (fileDescriptor, buffer, offset, length, position) =>
    fs.readSync(fileDescriptor, buffer, offset, length, position),
  writeSync: (fileDescriptor, buffer, offset, length, position) =>
    fs.writeSync(fileDescriptor, buffer, offset, length, position),
  fsyncSync: (fileDescriptor) => fs.fsyncSync(fileDescriptor),
  closeSync: (fileDescriptor) => fs.closeSync(fileDescriptor),
  mkdirSync: (directoryPath, options) => fs.mkdirSync(directoryPath, options),
  renameSync: (from, to) => fs.renameSync(from, to),
  unlinkSync: (filePath) => fs.unlinkSync(filePath),
};

export function platformUpdateCachePath(dataRoot: string): string {
  return path.join(dataRoot, "public-cache", "platform-update-v1.json");
}

function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("更新缓存必须是严格对象");
  }
}

function assertCacheKeys(raw: Record<string, unknown>): void {
  const allowed = new Set([
    "cacheVersion",
    "currentVersion",
    "checkedAt",
    "stableRequiredVersion",
    "stable",
    "beta",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new Error("更新缓存含未知字段，严格校验失败");
  }
  for (const required of ["cacheVersion", "currentVersion", "checkedAt"]) {
    if (!(required in raw)) throw new Error(`更新缓存缺少字段：${required}`);
  }
}

function assertVersion(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} 无效`);
  compareDesktopVersions(value, value);
  return value;
}

function requiredStableVersion(
  currentVersion: string,
  stable: PlatformReleaseEntry | undefined,
): string | undefined {
  if (!stable) return undefined;
  return compareDesktopVersions(stable.latest.version, currentVersion) > 0
    ? stable.latest.version
    : undefined;
}

function platformReleaseIdentity(entry: PlatformReleaseEntry): string {
  return JSON.stringify({
    latest: {
      schemaVersion: entry.latest.schemaVersion,
      channel: entry.latest.channel,
      platform: entry.latest.platform,
      arch: entry.latest.arch,
      version: entry.latest.version,
      release: entry.latest.release,
    },
    release: {
      schemaVersion: entry.release.schemaVersion,
      channel: entry.release.channel,
      sourceChannel: entry.release.sourceChannel,
      platform: entry.release.platform,
      arch: entry.release.arch,
      version: entry.release.version,
      tag: entry.release.tag,
      commitSha: entry.release.commitSha,
      nativeMetadata: entry.release.nativeMetadata,
      artifacts: entry.release.artifacts.map((artifact) => ({
        path: artifact.path,
        fileName: artifact.fileName,
        kind: artifact.kind,
        size: artifact.size,
        sha256: artifact.sha256,
      })),
    },
  });
}

/** 同版本只有完整发布身份一致才可复用，避免可变远端对象替换已验证缓存。 */
export function samePlatformReleaseIdentity(
  left: PlatformReleaseEntry,
  right: PlatformReleaseEntry,
): boolean {
  return platformReleaseIdentity(left) === platformReleaseIdentity(right);
}

function higherReleaseEntry(
  previous: PlatformReleaseEntry | undefined,
  incoming: PlatformReleaseEntry | undefined,
): PlatformReleaseEntry | undefined {
  if (!previous) return incoming;
  if (!incoming) return previous;
  const comparison = compareDesktopVersions(incoming.latest.version, previous.latest.version);
  if (comparison > 0) return incoming;
  if (comparison < 0) return previous;
  if (!samePlatformReleaseIdentity(previous, incoming)) {
    throw new Error(`Stable 缓存同版本发布身份冲突：${incoming.latest.version} 不可变`);
  }
  return previous;
}

function parseRecord(raw: unknown, currentVersion: string): PlatformUpdateCacheRecord {
  assertVersion(currentVersion, "当前版本");
  assertPlainObject(raw);
  assertCacheKeys(raw);
  if (raw.cacheVersion !== 1) throw new Error("更新缓存版本无效");
  assertVersion(raw.currentVersion, "缓存当前版本");
  if (typeof raw.checkedAt !== "string" || !Number.isFinite(Date.parse(raw.checkedAt))) {
    throw new Error("更新缓存检查时间无效");
  }
  const stable = raw.stable === undefined
    ? undefined
    : parsePlatformReleaseEntry(raw.stable, "stable");
  const beta = raw.beta === undefined
    ? undefined
    : parsePlatformReleaseEntry(raw.beta, "beta");
  if (raw.stableRequiredVersion !== undefined) {
    assertVersion(raw.stableRequiredVersion, "缓存 Stable 强制版本");
    if (!stable || raw.stableRequiredVersion !== stable.latest.version) {
      throw new Error("缓存 Stable 强制版本与发布快照不一致");
    }
  }
  return {
    cacheVersion: 1,
    currentVersion,
    checkedAt: raw.checkedAt,
    ...(stable ? { stable } : {}),
    ...(beta ? { beta } : {}),
    ...(requiredStableVersion(currentVersion, stable)
      ? { stableRequiredVersion: stable!.latest.version }
      : {}),
  };
}

export class PlatformUpdateCache {
  private readonly fileSystem: PlatformUpdateCacheFileSystem;
  private readonly now: () => Date;
  private readonly nonce: () => string;
  private readonly maxBytes: number;

  constructor(
    private readonly dataRoot: string,
    options: PlatformUpdateCacheOptions = {},
  ) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? (() => `${process.pid}.${Date.now()}`);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  get path(): string {
    return platformUpdateCachePath(path.resolve(this.dataRoot));
  }

  read(currentVersion: string): PlatformUpdateCacheRecord | null {
    let descriptor: number | null = null;
    try {
      const root = this.captureTrustedRoot();
      const directory = this.captureCacheDirectory(root, false);
      if (!directory) return null;
      this.assertRootAndDirectory(root, directory);
      if (!this.fileSystem.existsSync(this.path)) return null;
      this.assertRootAndDirectory(root, directory);
      const before = this.captureControlledFile(this.path, root, directory);
      this.assertRootAndDirectory(root, directory);
      descriptor = this.fileSystem.openSync(
        this.path,
        fs.constants.O_RDONLY | this.noFollowFlag(),
      );
      // 中文注释：打开后只信任同一 fd 的 fstat/read，路径替换不能把检查与读取拆成两个对象。
      const opened = this.fileSystem.fstatSync(descriptor);
      this.assertSameFile(before, opened, "更新缓存文件在打开期间被替换");
      if (!opened.isFile() || opened.size < 0 || opened.size > this.maxBytes) return null;
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= this.maxBytes) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, this.maxBytes + 1 - total));
        const count = this.fileSystem.readSync(descriptor, buffer, 0, buffer.byteLength, null);
        if (count === 0) break;
        total += count;
        if (total > this.maxBytes) return null;
        chunks.push(buffer.subarray(0, count));
      }
      const bytes = Buffer.concat(chunks, total);
      return parseRecord(JSON.parse(bytes.toString("utf8")), currentVersion);
    } catch {
      return null;
    } finally {
      if (descriptor !== null) {
        try { this.fileSystem.closeSync(descriptor); } catch { /* 读取失败时仍尽力回收句柄。 */ }
      }
    }
  }

  writeValidated(
    currentVersion: string,
    updates: Partial<Record<PlatformUpdateChannel, PlatformReleaseEntry>>,
  ): PlatformUpdateCacheRecord {
    assertVersion(currentVersion, "当前版本");
    // 中文注释：所有新增通道先完成同一严格解析，任何失败都发生在创建临时文件之前。
    const validatedStable = updates.stable === undefined
      ? undefined
      : parsePlatformReleaseEntry(updates.stable, "stable");
    const validatedBeta = updates.beta === undefined
      ? undefined
      : parsePlatformReleaseEntry(updates.beta, "beta");
    // 中文注释：trusted root 必须先存在并完成身份验证；在此之前严禁 mkdir 或其他写副作用。
    const root = this.captureTrustedRoot();
    let directory = this.captureCacheDirectory(root, false);
    const previous = directory ? this.read(currentVersion) : null;
    if (directory) this.assertRootAndDirectory(root, directory);
    // 中文注释：Stable 缓存只能单调前进，较低但合法的网络快照不能解除已验证的更高强更。
    const stable = higherReleaseEntry(previous?.stable, validatedStable);
    const beta = validatedBeta ?? previous?.beta;
    const record: PlatformUpdateCacheRecord = {
      cacheVersion: 1,
      currentVersion,
      checkedAt: this.now().toISOString(),
      ...(stable ? { stable } : {}),
      ...(beta ? { beta } : {}),
      ...(requiredStableVersion(currentVersion, stable)
        ? { stableRequiredVersion: stable!.latest.version }
        : {}),
    };
    const bytes = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(bytes, "utf8") > this.maxBytes) {
      throw new Error("更新缓存规范字节超过大小上限");
    }
    directory ??= this.captureCacheDirectory(root, true);
    if (!directory) throw new Error("更新缓存目录创建失败");
    this.assertRootAndDirectory(root, directory);
    const temporary = path.join(directory.lexicalPath, `platform-update.${this.nonce()}.tmp`);
    if (this.fileSystem.existsSync(this.path)) {
      this.assertRootAndDirectory(root, directory);
      this.captureControlledFile(this.path, root, directory);
    }
    let descriptor: number | null = null;
    let temporaryCreated = false;
    let temporaryOpened: PlatformUpdateCacheStat | null = null;
    try {
      this.assertRootAndDirectory(root, directory);
      descriptor = this.fileSystem.openSync(
        temporary,
        fs.constants.O_WRONLY
          | fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | this.noFollowFlag(),
        0o600,
      );
      temporaryCreated = true;
      temporaryOpened = this.fileSystem.fstatSync(descriptor);
      if (!temporaryOpened.isFile() || this.isReparsePoint(temporaryOpened)) {
        throw new Error("更新缓存临时文件不是普通文件");
      }
      const buffer = Buffer.from(bytes, "utf8");
      let written = 0;
      while (written < buffer.byteLength) {
        const count = this.fileSystem.writeSync(
          descriptor,
          buffer,
          written,
          buffer.byteLength - written,
          null,
        );
        if (count <= 0) throw new Error("更新缓存临时文件写入失败");
        written += count;
      }
      this.fileSystem.fsyncSync(descriptor);
      const opened = this.fileSystem.fstatSync(descriptor);
      this.assertSameFile(temporaryOpened, opened, "更新缓存临时文件句柄身份漂移");
      this.fileSystem.closeSync(descriptor);
      descriptor = null;

      this.assertRootAndDirectory(root, directory);
      const temporaryIdentity = this.captureControlledFile(temporary, root, directory);
      this.assertSameFile(opened, temporaryIdentity, "更新缓存临时文件在关闭后被替换");
      if (this.fileSystem.existsSync(this.path)) {
        this.assertRootAndDirectory(root, directory);
        this.captureControlledFile(this.path, root, directory);
      }
      // 中文注释：路径 API 无法消除最后一次身份复核到 rename 间的同用户竞态；检测到任何漂移都 fail closed。
      this.assertRootAndDirectory(root, directory);
      this.assertIdentity(temporaryIdentity, "更新缓存临时文件");
      this.fileSystem.renameSync(temporary, this.path);
      temporaryCreated = false;
    } catch (error) {
      if (descriptor !== null) {
        try { this.fileSystem.closeSync(descriptor); } catch { /* 关闭错误不覆盖原始写入错误。 */ }
      }
      if (temporaryCreated && temporaryOpened) {
        this.cleanupOwnTemporary(root, directory, temporary, temporaryOpened);
      }
      throw error;
    }
    return parseRecord(record, currentVersion);
  }

  private captureTrustedRoot(): CachePathIdentity {
    const root = path.resolve(this.dataRoot);
    if (!this.fileSystem.existsSync(root)) throw new Error("更新缓存 trusted root 不存在");
    const identity = this.captureIdentity(root, "directory", "更新缓存 trusted root");
    if (this.normalize(identity.realPath) !== this.normalize(root)) {
      throw new Error("更新缓存 trusted root 真实路径与词法根不一致");
    }
    return identity;
  }

  private captureCacheDirectory(
    root: CachePathIdentity,
    create: boolean,
  ): CachePathIdentity | null {
    const directoryPath = path.join(root.lexicalPath, "public-cache");
    this.assertIdentity(root, "更新缓存 trusted root");
    if (!this.fileSystem.existsSync(directoryPath)) {
      if (!create) return null;
      this.assertIdentity(root, "更新缓存 trusted root");
      this.fileSystem.mkdirSync(directoryPath, { recursive: false, mode: 0o700 });
      this.assertIdentity(root, "更新缓存 trusted root");
    }
    const directory = this.captureIdentity(directoryPath, "directory", "更新缓存目录");
    if (this.normalize(directory.realPath) !== this.normalize(path.join(root.realPath, "public-cache"))) {
      throw new Error("更新缓存目录真实路径越界");
    }
    this.assertIdentity(root, "更新缓存 trusted root");
    return directory;
  }

  private captureControlledFile(
    filePath: string,
    root: CachePathIdentity,
    directory: CachePathIdentity,
  ): CachePathIdentity {
    this.assertRootAndDirectory(root, directory);
    const resolved = path.resolve(filePath);
    if (path.dirname(resolved) !== directory.lexicalPath) throw new Error("更新缓存文件词法路径越界");
    const identity = this.captureIdentity(resolved, "file", "更新缓存文件");
    if (this.normalize(path.dirname(identity.realPath)) !== this.normalize(directory.realPath)) {
      throw new Error("更新缓存文件真实路径越界");
    }
    return identity;
  }

  private captureIdentity(
    lexicalPath: string,
    kind: "directory" | "file",
    label: string,
  ): CachePathIdentity {
    const resolved = path.resolve(lexicalPath);
    const stat = this.fileSystem.lstatSync(resolved);
    if (this.isReparsePoint(stat)) throw new Error(`${label} 禁止符号链接、Junction 或 reparse point`);
    if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`${label} 类型无效`);
    }
    return {
      lexicalPath: resolved,
      realPath: this.fileSystem.realpathSync(resolved),
      dev: stat.dev,
      ino: stat.ino,
      ...(stat.reparseTag === undefined ? {} : { reparseTag: stat.reparseTag }),
      kind,
    };
  }

  private assertRootAndDirectory(root: CachePathIdentity, directory: CachePathIdentity): void {
    this.assertIdentity(root, "更新缓存 trusted root");
    this.assertIdentity(directory, "更新缓存目录");
  }

  private assertIdentity(expected: CachePathIdentity, label: string): void {
    const current = this.captureIdentity(expected.lexicalPath, expected.kind, label);
    if (
      this.normalize(current.realPath) !== this.normalize(expected.realPath)
      || current.dev !== expected.dev
      || current.ino !== expected.ino
      || current.reparseTag !== expected.reparseTag
    ) {
      throw new Error(`${label} 身份发生漂移`);
    }
  }

  private assertSameFile(
    before: Pick<PlatformUpdateCacheStat, "dev" | "ino" | "reparseTag">,
    after: Pick<PlatformUpdateCacheStat, "dev" | "ino" | "reparseTag">,
    message: string,
  ): void {
    if (before.dev !== after.dev || before.ino !== after.ino || before.reparseTag !== after.reparseTag) {
      throw new Error(message);
    }
  }

  private cleanupOwnTemporary(
    root: CachePathIdentity,
    directory: CachePathIdentity,
    temporary: string,
    opened: PlatformUpdateCacheStat,
  ): void {
    try {
      this.assertRootAndDirectory(root, directory);
      if (!this.fileSystem.existsSync(temporary)) return;
      this.assertRootAndDirectory(root, directory);
      const current = this.captureControlledFile(temporary, root, directory);
      this.assertSameFile(opened, current, "更新缓存临时文件不再属于本轮");
      // 中文注释：最后一次复核后仍存在不可消除的路径竞态；至少绝不在已检测身份漂移后执行 unlink。
      this.assertRootAndDirectory(root, directory);
      this.assertIdentity(current, "更新缓存临时文件");
      this.fileSystem.unlinkSync(temporary);
    } catch {
      // 身份不完整或发生漂移时宁可遗留本轮临时文件，也不能删除外部路径。
    }
  }

  private isReparsePoint(stat: Pick<PlatformUpdateCacheStat, "isSymbolicLink" | "reparseTag">): boolean {
    return stat.isSymbolicLink() || (stat.reparseTag !== undefined && stat.reparseTag !== 0);
  }

  private noFollowFlag(): number {
    // Windows 的 O_NOFOLLOW 可能为 undefined；安全性来自 lstat/realpath/dev+ino 复核，不虚构内核级 nofollow。
    return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  }

  private normalize(value: string): string {
    return process.platform === "win32"
      ? path.resolve(value).toLocaleLowerCase("en-US")
      : path.resolve(value);
  }

}
