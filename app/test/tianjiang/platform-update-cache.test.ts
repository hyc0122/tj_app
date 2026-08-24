import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  PlatformUpdateCache,
  platformUpdateCachePath,
  type PlatformUpdateCacheFileSystem,
} from "../../src/tianjiang/update/platform-update-cache";
import type { PlatformReleaseEntry } from "../../src/tianjiang/update/platform-release-catalog";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function entry(channel: "stable" | "beta", version: string): PlatformReleaseEntry {
  const prefix = `desktop/${channel}/windows/x64`;
  const installerName = `tianjiang-${version}-win-x64-setup.exe`;
  return {
    latest: {
      schemaVersion: 2,
      channel,
      platform: "windows",
      arch: "x64",
      version,
      release: `${prefix}/catalog/releases/${version}/release.json`,
    },
    release: {
      schemaVersion: 2,
      channel,
      sourceChannel: channel,
      platform: "windows",
      arch: "x64",
      version,
      tag: `v${version}`,
      commitSha: "b".repeat(40),
      nativeMetadata: `${prefix}/latest.yml`,
      artifacts: [
        { path: `${prefix}/${installerName}`, fileName: installerName, kind: "installer", size: 18, sha256: sha256("installer-content") },
        { path: `${prefix}/${installerName}.blockmap`, fileName: `${installerName}.blockmap`, kind: "blockmap", size: 16, sha256: sha256("blockmap-content") },
      ],
    },
  };
}

class MemoryFileSystem implements PlatformUpdateCacheFileSystem {
  readonly files = new Map<string, Buffer>();
  readonly directories = new Set<string>();
  readonly identities = new Map<string, number>();
  readonly writes: string[] = [];
  readonly renames: Array<[string, string]> = [];
  readonly symbolicLinks = new Set<string>();
  readonly realpaths = new Map<string, string>();
  readonly descriptors = new Map<number, { path: string; position: number; replaced: boolean }>();
  readonly openFlags: Array<string | number> = [];
  readonly fsynced: number[] = [];
  readonly closed: number[] = [];
  readonly mkdirs: Array<{ directoryPath: string; options: { recursive: false; mode: number } }> = [];
  readonly unlinks: string[] = [];
  readFileCalls = 0;
  readCalls = 0;
  lstatCalls = 0;
  replaceIdentityOnReadOpen = false;
  growOnReadOpen = false;
  reparseDirectoryOnFsync = false;
  redirectDirectoryOnFsync: { directory: string; outside: string } | null = null;
  private nextDescriptor = 10;
  private nextIdentity = 100;

  constructor() {
    for (const root of [
      "C:\\fake-user-data\\data",
      "C:\\fake-user-data\\other",
      "C:\\linked-user-data\\data",
    ]) {
      this.addDirectory(root);
    }
  }

  existsSync(filePath: string) {
    const resolved = path.resolve(filePath);
    return this.files.has(resolved) || this.directories.has(resolved);
  }
  statSync(filePath: string) { return { size: this.files.get(filePath)?.byteLength ?? 0 }; }
  readFileSync(filePath: string) {
    this.readFileCalls += 1;
    const value = this.files.get(filePath);
    if (!value) throw new Error("ENOENT");
    return Buffer.from(value);
  }
  mkdirSync(directoryPath: string, options: { recursive: false; mode: number }) {
    const resolved = path.resolve(directoryPath);
    if (this.existsSync(resolved)) throw new Error("EEXIST");
    this.mkdirs.push({ directoryPath: resolved, options });
    this.addDirectory(resolved);
  }
  writeFileSync(filePath: string, data: string | Uint8Array) {
    this.writes.push(filePath);
    this.files.set(filePath, Buffer.from(data));
  }
  renameSync(from: string, to: string) {
    const resolvedFrom = this.resolveRedirectedPath(from);
    const resolvedTo = this.resolveRedirectedPath(to);
    const value = this.files.get(resolvedFrom);
    if (!value) throw new Error("ENOENT");
    this.renames.push([resolvedFrom, resolvedTo]);
    this.files.set(resolvedTo, value);
    this.files.delete(resolvedFrom);
    this.identities.set(resolvedTo, this.identity(resolvedFrom));
    this.identities.delete(resolvedFrom);
  }
  rmSync(filePath: string) { this.files.delete(filePath); }
  realpathSync(filePath: string) {
    const resolved = path.resolve(filePath);
    const exact = this.realpaths.get(resolved);
    if (exact) return exact;
    for (const [source, target] of this.realpaths) {
      const relative = path.relative(source, resolved);
      if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return path.join(target, relative);
      }
    }
    return resolved;
  }
  lstatSync(filePath: string) {
    this.lstatCalls += 1;
    const resolved = path.resolve(filePath);
    const file = this.files.has(resolved);
    const directory = this.directories.has(resolved);
    if (!file && !directory && !this.symbolicLinks.has(resolved)) throw new Error("ENOENT");
    return {
      size: this.files.get(resolved)?.byteLength ?? 0,
      dev: 1,
      ino: this.identity(resolved),
      ...(this.symbolicLinks.has(resolved) ? { reparseTag: 0xa000000c } : {}),
      isSymbolicLink: () => this.symbolicLinks.has(resolved),
      isDirectory: () => directory,
      isFile: () => file,
    };
  }
  openSync(filePath: string, flags: string | number) {
    this.openFlags.push(flags);
    if (typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0 && this.files.has(filePath)) throw new Error("EEXIST");
    if (!this.files.has(filePath)) this.files.set(filePath, Buffer.alloc(0));
    this.identity(filePath);
    const reading = typeof flags === "number" && (flags & fs.constants.O_WRONLY) === 0;
    if (reading && this.growOnReadOpen) this.files.set(filePath, Buffer.alloc(513, 0x20));
    const descriptor = this.nextDescriptor++;
    this.descriptors.set(descriptor, {
      path: filePath,
      position: 0,
      replaced: reading && this.replaceIdentityOnReadOpen,
    });
    return descriptor;
  }
  fstatSync(descriptor: number) {
    const opened = this.descriptors.get(descriptor);
    if (!opened) throw new Error("EBADF");
    const value = this.files.get(opened.path) ?? Buffer.alloc(0);
    return {
      size: value.byteLength,
      dev: opened.replaced ? 2 : 1,
      ino: this.identity(opened.path),
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    };
  }
  readSync(descriptor: number, buffer: Uint8Array, offset: number, length: number, position: number | null) {
    this.readCalls += 1;
    const opened = this.descriptors.get(descriptor)!;
    const value = this.files.get(opened.path) ?? Buffer.alloc(0);
    const start = position ?? opened.position;
    const count = Math.min(length, Math.max(0, value.byteLength - start));
    value.copy(buffer as Buffer, offset, start, start + count);
    opened.position = start + count;
    return count;
  }
  writeSync(descriptor: number, data: Uint8Array, offset: number, length: number, position: number | null) {
    const opened = this.descriptors.get(descriptor)!;
    const old = this.files.get(opened.path) ?? Buffer.alloc(0);
    const start = position ?? opened.position;
    const next = Buffer.alloc(Math.max(old.byteLength, start + length));
    old.copy(next);
    Buffer.from(data).copy(next, start, offset, offset + length);
    this.files.set(opened.path, next);
    opened.position = start + length;
    return length;
  }
  fsyncSync(descriptor: number) {
    this.fsynced.push(descriptor);
    if (this.reparseDirectoryOnFsync) {
      this.symbolicLinks.add(path.dirname(this.descriptors.get(descriptor)!.path));
    }
    if (this.redirectDirectoryOnFsync) {
      const { directory, outside } = this.redirectDirectoryOnFsync;
      this.symbolicLinks.add(directory);
      this.realpaths.set(directory, outside);
    }
  }
  closeSync(descriptor: number) { this.closed.push(descriptor); this.descriptors.delete(descriptor); }
  unlinkSync(filePath: string) {
    const resolved = this.resolveRedirectedPath(filePath);
    this.unlinks.push(resolved);
    this.files.delete(resolved);
    this.identities.delete(resolved);
  }

  private addDirectory(directoryPath: string): void {
    const resolved = path.resolve(directoryPath);
    this.directories.add(resolved);
    this.identity(resolved);
  }

  private identity(filePath: string): number {
    const resolved = path.resolve(filePath);
    const existing = this.identities.get(resolved);
    if (existing !== undefined) return existing;
    const created = this.nextIdentity++;
    this.identities.set(resolved, created);
    return created;
  }

  private resolveRedirectedPath(filePath: string): string {
    const resolved = path.resolve(filePath);
    const redirectedDirectory = this.realpaths.get(path.dirname(resolved));
    return redirectedDirectory
      ? path.join(redirectedDirectory, path.basename(resolved))
      : resolved;
  }
}

test("验证成功的双通道快照以规范字节在同目录原子替换", () => {
  const fileSystem = new MemoryFileSystem();
  const dataRoot = "C:\\fake-user-data\\data";
  const cache = new PlatformUpdateCache(dataRoot, {
    fileSystem,
    now: () => new Date("2026-08-24T01:02:03.000Z"),
    nonce: () => "fixed",
  });

  const record = cache.writeValidated("1.1.10-beta.14", {
    stable: entry("stable", "1.1.11"),
    beta: entry("beta", "1.1.12-beta.1"),
  });
  const target = platformUpdateCachePath(dataRoot);

  assert.equal(record.cacheVersion, 1);
  assert.equal(record.stableRequiredVersion, "1.1.11");
  assert.equal(fileSystem.renames.length, 1);
  assert.equal(path.dirname(fileSystem.renames[0][0]), path.dirname(target));
  assert.equal(fileSystem.renames[0][1], target);
  assert.equal(fileSystem.files.get(target)?.toString("utf8").endsWith("\n"), true);
  assert.deepEqual(cache.read("1.1.10-beta.14"), record);
});

test("失败或非法响应不能覆盖最后有效缓存", () => {
  const fileSystem = new MemoryFileSystem();
  const cache = new PlatformUpdateCache("C:\\fake-user-data\\data", {
    fileSystem,
    now: () => new Date("2026-08-24T01:02:03.000Z"),
    nonce: () => "fixed",
  });
  cache.writeValidated("1.1.10-beta.14", { stable: entry("stable", "1.1.11") });
  const target = cache.path;
  const before = Buffer.from(fileSystem.files.get(target)!);
  const invalid = entry("stable", "1.1.11") as PlatformReleaseEntry & { injectedUrl?: string };
  invalid.injectedUrl = "https://evil.example/catalog.json";

  assert.throws(() => cache.writeValidated("1.1.10-beta.14", { stable: invalid }), /未知字段|严格/);
  assert.deepEqual(fileSystem.files.get(target), before);
  assert.equal(fileSystem.renames.length, 1);
});

test("缓存严格校验版本、字段和大小上限，当前版本达到 Stable 要求后解除门禁", () => {
  const fileSystem = new MemoryFileSystem();
  const cache = new PlatformUpdateCache("C:\\fake-user-data\\data", {
    fileSystem,
    maxBytes: 512,
    now: () => new Date("2026-08-24T01:02:03.000Z"),
    nonce: () => "fixed",
  });
  fileSystem.files.set(cache.path, Buffer.alloc(513, 0x20));
  assert.equal(cache.read("1.1.10-beta.14"), null);

  const validCache = new PlatformUpdateCache("C:\\fake-user-data\\other", {
    fileSystem,
    maxBytes: 64 * 1024,
    now: () => new Date("2026-08-24T01:02:03.000Z"),
    nonce: () => "fixed",
  });
  validCache.writeValidated("1.1.10-beta.14", { stable: entry("stable", "1.1.11") });
  const raw = JSON.parse(fileSystem.files.get(validCache.path)!.toString("utf8"));
  fileSystem.files.set(validCache.path, Buffer.from(JSON.stringify({ ...raw, cacheVersion: 2 })));
  assert.equal(validCache.read("1.1.10-beta.14"), null);
  fileSystem.files.set(validCache.path, Buffer.from(JSON.stringify({ ...raw, extra: true })));
  assert.equal(validCache.read("1.1.10-beta.14"), null);
  fileSystem.files.set(validCache.path, Buffer.from(JSON.stringify(raw)));
  assert.equal(validCache.read("1.1.11")?.stableRequiredVersion, undefined);
});

test("单通道网络失败时只合并验证成功通道，不清除另一通道有效记录", () => {
  const fileSystem = new MemoryFileSystem();
  let minute = 0;
  const cache = new PlatformUpdateCache("C:\\fake-user-data\\data", {
    fileSystem,
    now: () => new Date(`2026-08-24T01:0${minute++}:00.000Z`),
    nonce: () => String(minute),
  });
  cache.writeValidated("1.1.10-beta.14", {
    stable: entry("stable", "1.1.11"),
    beta: entry("beta", "1.1.12-beta.1"),
  });
  cache.writeValidated("1.1.10-beta.14", {
    beta: entry("beta", "1.1.13-beta.1"),
  });
  const record = cache.read("1.1.10-beta.14");

  assert.equal(record?.stable?.latest.version, "1.1.11");
  assert.equal(record?.beta?.latest.version, "1.1.13-beta.1");
  assert.equal(record?.stableRequiredVersion, "1.1.11");
});

test("Stable 缓存写入单调：较低网络版本不能覆盖已验证的更高强更", () => {
  const fileSystem = new MemoryFileSystem();
  const cache = new PlatformUpdateCache("C:\\fake-user-data\\data", {
    fileSystem,
    nonce: () => "stable-monotonic",
  });

  cache.writeValidated("1.1.11", { stable: entry("stable", "1.1.12") });
  const written = cache.writeValidated("1.1.11", { stable: entry("stable", "1.1.11") });

  assert.equal(written.stable?.latest.version, "1.1.12");
  assert.equal(written.stableRequiredVersion, "1.1.12");
  assert.equal(cache.read("1.1.11")?.stable?.latest.version, "1.1.12");
});

test("Stable 缓存同版本发布身份不可变，任何身份冲突都 fail-closed 并保留原记录", () => {
  const conflictCases: Array<{
    name: string;
    mutate: (candidate: PlatformReleaseEntry) => void;
  }> = [
    {
      name: "commitSha",
      mutate: (candidate) => { candidate.release.commitSha = "c".repeat(40); },
    },
    {
      name: "artifact sha256",
      mutate: (candidate) => { candidate.release.artifacts[0].sha256 = sha256("other-installer"); },
    },
    {
      name: "artifact size",
      mutate: (candidate) => { candidate.release.artifacts[0].size += 1; },
    },
    {
      name: "artifact path/fileName",
      mutate: (candidate) => {
        candidate.release.artifacts[0].fileName = "alternate-setup.exe";
        candidate.release.artifacts[0].path = "desktop/stable/windows/x64/alternate-setup.exe";
      },
    },
    {
      name: "artifact kind",
      mutate: (candidate) => {
        candidate.release.artifacts[0].kind = "blockmap";
        candidate.release.artifacts[1].kind = "installer";
      },
    },
    {
      name: "release path",
      mutate: (candidate) => { candidate.latest.release = "desktop/stable/windows/x64/catalog/releases/1.1.12/other.json"; },
    },
    {
      name: "sourceChannel",
      mutate: (candidate) => { candidate.release.sourceChannel = "beta"; },
    },
    {
      name: "nativeMetadata",
      mutate: (candidate) => { candidate.release.nativeMetadata = "desktop/stable/windows/x64/other.yml"; },
    },
  ];

  for (const conflictCase of conflictCases) {
    const fileSystem = new MemoryFileSystem();
    const cache = new PlatformUpdateCache("C:\\fake-user-data\\data", {
      fileSystem,
      nonce: () => `same-version-${conflictCase.name.replace(/[^a-z]/gi, "-")}`,
    });
    const cachedStable = entry("stable", "1.1.12");
    cache.writeValidated("1.1.11", { stable: cachedStable });
    const before = Buffer.from(fileSystem.files.get(cache.path)!);
    const conflictingStable = structuredClone(cachedStable);
    conflictCase.mutate(conflictingStable);

    assert.throws(
      () => cache.writeValidated("1.1.11", { stable: conflictingStable }),
      /同版本|冲突|不可变|路径无效|sourceChannel|nativeMetadata/,
      conflictCase.name,
    );
    assert.deepEqual(fileSystem.files.get(cache.path), before, conflictCase.name);
    assert.deepEqual(cache.read("1.1.11")?.stable, cachedStable, conflictCase.name);
    assert.equal(fileSystem.renames.length, 1, conflictCase.name);
  }
});

test("缓存读取使用同一 fd 的 fstat 与有界 read，禁止 stat 后按路径整包读取", () => {
  const fileSystem = new MemoryFileSystem();
  const cache = new PlatformUpdateCache("C:\\fake-user-data\\data", {
    fileSystem,
    maxBytes: 64 * 1024,
    now: () => new Date("2026-08-24T01:02:03.000Z"),
    nonce: () => "fd",
  });
  cache.writeValidated("1.1.10-beta.14", { stable: entry("stable", "1.1.11") });
  fileSystem.readFileCalls = 0;
  fileSystem.readCalls = 0;
  const record = cache.read("1.1.10-beta.14");
  assert.equal(record?.stableRequiredVersion, "1.1.11");
  assert.equal(fileSystem.readFileCalls, 0);
  assert.ok(fileSystem.readCalls > 0);
  assert.ok(fileSystem.closed.length > 0);
});

test("缓存拒绝目录、目标文件 symlink/Junction 与真实路径越界", () => {
  const dataRoot = "C:\\fake-user-data\\data";
  for (const targetKind of ["directory", "file", "escape"] as const) {
    const fileSystem = new MemoryFileSystem();
    const cache = new PlatformUpdateCache(dataRoot, {
      fileSystem,
      now: () => new Date("2026-08-24T01:02:03.000Z"),
      nonce: () => targetKind,
    });
    cache.writeValidated("1.1.10-beta.14", { stable: entry("stable", "1.1.11") });
    const before = Buffer.from(fileSystem.files.get(cache.path)!);
    if (targetKind === "directory") fileSystem.symbolicLinks.add(path.dirname(cache.path));
    if (targetKind === "file") fileSystem.symbolicLinks.add(cache.path);
    if (targetKind === "escape") fileSystem.realpaths.set(path.dirname(cache.path), "C:\\outside\\cache");
    assert.equal(cache.read("1.1.10-beta.14"), null);
    assert.throws(
      () => cache.writeValidated("1.1.10-beta.14", { beta: entry("beta", "1.1.12-beta.1") }),
      /符号链接|Junction|reparse|真实路径|越界/i,
    );
    assert.deepEqual(fileSystem.files.get(cache.path), before);
  }
});

test("缓存写入使用同目录排他临时文件、fsync/close，并在 rename 前复核目录", () => {
  const fileSystem = new MemoryFileSystem();
  const cache = new PlatformUpdateCache("C:\\fake-user-data\\data", {
    fileSystem,
    now: () => new Date("2026-08-24T01:02:03.000Z"),
    nonce: () => "exclusive",
  });
  cache.writeValidated("1.1.10-beta.14", { stable: entry("stable", "1.1.11") });
  assert.equal(
    fileSystem.openFlags.some((flag) => typeof flag === "number" && (flag & fs.constants.O_EXCL) !== 0),
    true,
  );
  assert.ok(fileSystem.fsynced.length > 0);
  assert.ok(fileSystem.closed.length > 0);
  assert.ok(fileSystem.lstatCalls >= 2);
});

test("缓存读取拒绝打开期间文件替换与 fstat 后超限对象", () => {
  for (const mode of ["replace", "oversized"] as const) {
    const fileSystem = new MemoryFileSystem();
    const cache = new PlatformUpdateCache("C:\\fake-user-data\\data", {
      fileSystem,
      maxBytes: 512,
      now: () => new Date("2026-08-24T01:02:03.000Z"),
      nonce: () => mode,
    });
    const raw = Buffer.from(JSON.stringify({
      cacheVersion: 1,
      currentVersion: "1.1.10-beta.14",
      checkedAt: "2026-08-24T01:02:03.000Z",
    }));
    fileSystem.mkdirSync(path.dirname(cache.path), { recursive: false, mode: 0o700 });
    fileSystem.files.set(cache.path, raw);
    fileSystem.replaceIdentityOnReadOpen = mode === "replace";
    fileSystem.growOnReadOpen = mode === "oversized";
    assert.equal(cache.read("1.1.10-beta.14"), null);
    assert.equal(fileSystem.readCalls, 0);
    assert.ok(fileSystem.closed.length > 0);
  }
});

test("rename 前目录变为 reparse 时保留旧缓存，并且不删除他人同名临时文件", () => {
  const fileSystem = new MemoryFileSystem();
  const dataRoot = "C:\\fake-user-data\\data";
  const cache = new PlatformUpdateCache(dataRoot, {
    fileSystem,
    now: () => new Date("2026-08-24T01:02:03.000Z"),
    nonce: () => "race",
  });
  cache.writeValidated("1.1.10-beta.14", { stable: entry("stable", "1.1.11") });
  const before = Buffer.from(fileSystem.files.get(cache.path)!);
  fileSystem.reparseDirectoryOnFsync = true;
  assert.throws(
    () => cache.writeValidated("1.1.10-beta.14", { beta: entry("beta", "1.1.12-beta.1") }),
    /Junction|reparse|符号链接/i,
  );
  assert.deepEqual(fileSystem.files.get(cache.path), before);
  assert.equal(
    [...fileSystem.files.keys()].some((filePath) => filePath.endsWith("platform-update.race.tmp")),
    true,
  );
  assert.equal(fileSystem.unlinks.some((filePath) => filePath.endsWith("platform-update.race.tmp")), false);

  fileSystem.reparseDirectoryOnFsync = false;
  fileSystem.symbolicLinks.clear();
  const collision = path.join(path.dirname(cache.path), "platform-update.collision.tmp");
  fileSystem.files.set(collision, Buffer.from("other-process"));
  const collisionCache = new PlatformUpdateCache(dataRoot, {
    fileSystem,
    now: () => new Date("2026-08-24T01:02:03.000Z"),
    nonce: () => "collision",
  });
  assert.throws(
    () => collisionCache.writeValidated("1.1.10-beta.14", { beta: entry("beta", "1.1.12-beta.1") }),
    /EEXIST/,
  );
  assert.equal(fileSystem.files.get(collision)?.toString("utf8"), "other-process");
  assert.deepEqual(fileSystem.files.get(cache.path), before);
});

test("目录被 Junction 重定向后，失败清理绝不删除外部同名文件", () => {
  const fileSystem = new MemoryFileSystem();
  const dataRoot = "C:\\fake-user-data\\data";
  const cache = new PlatformUpdateCache(dataRoot, {
    fileSystem,
    now: () => new Date("2026-08-24T01:02:03.000Z"),
    nonce: () => "redirected",
  });
  cache.writeValidated("1.1.10-beta.14", { stable: entry("stable", "1.1.11") });
  const directory = path.dirname(cache.path);
  const outside = "C:\\outside\\attacker-cache";
  const outsideTemporary = path.join(outside, "platform-update.redirected.tmp");
  fileSystem.files.set(outsideTemporary, Buffer.from("external-file"));
  fileSystem.redirectDirectoryOnFsync = { directory, outside };

  assert.throws(
    () => cache.writeValidated("1.1.10-beta.14", { beta: entry("beta", "1.1.12-beta.1") }),
    /Junction|reparse|符号链接|身份/i,
  );
  assert.equal(fileSystem.files.get(outsideTemporary)?.toString("utf8"), "external-file");
  assert.equal(fileSystem.unlinks.includes(outsideTemporary), false);
  assert.equal(
    fileSystem.renames.some(([from, to]) => from.startsWith(outside) || to.startsWith(outside)),
    false,
  );
});

test("trusted root 验证失败前不得 mkdir，固定 cache 子目录只能非递归创建", () => {
  const invalidFileSystem = new MemoryFileSystem();
  const invalidRoot = "C:\\linked-user-data\\data";
  invalidFileSystem.symbolicLinks.add(invalidRoot);
  invalidFileSystem.realpaths.set(invalidRoot, "C:\\outside\\data");
  const invalidCache = new PlatformUpdateCache(invalidRoot, {
    fileSystem: invalidFileSystem,
    nonce: () => "invalid-root",
  });
  assert.throws(
    () => invalidCache.writeValidated("1.1.10-beta.14", { stable: entry("stable", "1.1.11") }),
    /root|根|符号链接|Junction|reparse|真实路径/i,
  );
  assert.deepEqual(invalidFileSystem.mkdirs, []);

  const validFileSystem = new MemoryFileSystem();
  const validRoot = "C:\\fake-user-data\\data";
  const validCache = new PlatformUpdateCache(validRoot, {
    fileSystem: validFileSystem,
    nonce: () => "fixed-child",
  });
  validCache.writeValidated("1.1.10-beta.14", { stable: entry("stable", "1.1.11") });
  assert.equal(validFileSystem.mkdirs.length, 1);
  assert.equal((validFileSystem.mkdirs[0].options as { recursive: boolean }).recursive, false);
  assert.equal(validFileSystem.mkdirs[0].directoryPath, path.join(validRoot, "public-cache"));
});

test("真实 Node fs 在普通根读写，并在 symlink/Junction 根验证前保持外部目录不变", (t) => {
  const worktreeRoot = process.env.TIANJIANG_TEST_WORKTREE_ROOT || path.resolve(process.cwd(), "..");
  const controlledTempRoot = path.resolve(worktreeRoot, ".tmp");
  const temporaryParent = path.resolve(controlledTempRoot, "task4-platform-cache");
  assert.equal(path.relative(controlledTempRoot, temporaryParent), "task4-platform-cache");
  if (!fs.existsSync(controlledTempRoot)) {
    // 全新公开克隆没有预建 .tmp；只允许在已验证的普通工作树根下非递归创建固定子目录。
    assert.equal(fs.lstatSync(worktreeRoot).isSymbolicLink(), false);
    fs.mkdirSync(controlledTempRoot, { recursive: false });
  }
  assert.equal(fs.lstatSync(controlledTempRoot).isSymbolicLink(), false);
  fs.mkdirSync(temporaryParent, { recursive: true });
  assert.equal(fs.lstatSync(temporaryParent).isSymbolicLink(), false);
  const controlledTempRootReal = fs.realpathSync.native(controlledTempRoot);
  const temporaryParentReal = fs.realpathSync.native(temporaryParent);
  assert.equal(path.dirname(temporaryParentReal).toLocaleLowerCase("en-US"), controlledTempRootReal.toLocaleLowerCase("en-US"));
  const container = fs.mkdtempSync(path.join(temporaryParent, "smoke-"));
  t.after(() => {
    if (!fs.existsSync(temporaryParent)) return;
    // 中文注释：只清理本测试固定父目录；身份或真实路径漂移时立即失败，绝不沿重定向删除。
    assert.equal(path.relative(controlledTempRoot, temporaryParent), "task4-platform-cache");
    assert.equal(fs.lstatSync(temporaryParent).isSymbolicLink(), false);
    assert.equal(
      fs.realpathSync.native(temporaryParent).toLocaleLowerCase("en-US"),
      temporaryParentReal.toLocaleLowerCase("en-US"),
    );
    fs.rmSync(temporaryParent, { recursive: true, force: true });
  });

  const trustedRoot = path.join(container, "data");
  fs.mkdirSync(trustedRoot);
  const cache = new PlatformUpdateCache(trustedRoot, {
    now: () => new Date("2026-08-24T01:02:03.000Z"),
    nonce: () => "node-fs",
  });
  cache.writeValidated("1.1.10-beta.14", { stable: entry("stable", "1.1.11") });
  assert.equal(cache.read("1.1.10-beta.14")?.stableRequiredVersion, "1.1.11");

  const outside = path.join(container, "outside");
  const linkedRoot = path.join(container, "linked-data");
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.diagnostic("当前环境不允许创建 Junction/symlink，普通目录 smoke 已完成");
      return;
    }
    throw error;
  }
  const linkedCache = new PlatformUpdateCache(linkedRoot, { nonce: () => "linked" });
  assert.throws(
    () => linkedCache.writeValidated("1.1.10-beta.14", { stable: entry("stable", "1.1.11") }),
    /root|根|符号链接|Junction|reparse|真实路径/i,
  );
  assert.equal(fs.existsSync(path.join(outside, "public-cache")), false);
});
