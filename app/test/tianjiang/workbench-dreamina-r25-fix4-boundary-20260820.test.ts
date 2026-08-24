import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";

import {
  accountDb,
  activateUserDatabase,
  db as activeDb,
  destroyAllDatabaseHandles,
  destroyProjectDatabaseHandle,
  initializeWorkspaceProject,
  prepareProjectDatabase,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { getStableDeviceUUID } from "../../src/tianjiang/auth/device";
import { rebuildMissingDreaminaDispatch } from "../../src/tianjiang/model-providers/dreamina-cli/recovery";
import { projectDirectory, projectFilesDirectory } from "../../src/tianjiang/data/paths";
import {
  assertManagedPathChainHasNoLinks,
  resolveProjectFilePath,
  writeProjectFileAtomic,
} from "../../src/tianjiang/media/project-file-store";
import getPath from "../../src/utils/getPath";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
  userStorageSegment,
} from "../../src/tianjiang/runtime/user-storage-context";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2584 };
const PROJECT = "b0252584-2584-4524-a524-252225842584";
const PROJECT_ID = 2584;
const SEGMENT = userStorageSegment(IDENTITY);
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");

async function withRuntime(name: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = path.join(workspaceTempRoot, `${name}-${process.pid}-${crypto.randomUUID()}`);
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "test";
  resetDatabaseRuntimeForServe();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: PROJECT_ID,
        name: "R25-fix4 boundary",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await run(root);
    });
  } finally {
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function prepareLegacyTask(): Promise<string> {
  const taskUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const now = Date.now();
  await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").insert({
    taskUuid,
    shotUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    parentTaskUuid: null,
    originDeviceUuid: getStableDeviceUUID(getPath()),
    mediaType: "image",
    providerId: "dreamina-cli",
    providerTaskId: null,
    providerSessionId: null,
    mode: "text2image",
    modelName: "dreamina-cli:text2image",
    parametersJson: JSON.stringify({ prompt: "sqlite boundary" }),
    requestDigest: "d".repeat(64),
    status: "queued",
    paidBatchConfirmedAt: null,
    providerCompletedAt: null,
    resultLocatorDigest: null,
    progress: 0,
    errorCode: null,
    errorSummary: null,
    createdAt: now,
    updatedAt: now,
  }));
  return taskUuid;
}

for (const kind of ["hardlink"] as const) {
  test(`prepare/recovery 拒绝 project.sqlite ${kind}，不投影外部库`, async () => {
    await withRuntime(`r25f4-sqlite-${kind}`, async (root) => {
      const taskUuid = await prepareLegacyTask();
      const projectRoot = projectDirectory(getPath(), PROJECT, SEGMENT);
      const databasePath = path.join(projectRoot, "project.sqlite");
      await destroyProjectDatabaseHandle(SEGMENT, PROJECT);
      const outsideDatabase = path.join(root, `outside-${kind}.sqlite`);
      fs.mkdirSync(path.dirname(outsideDatabase), { recursive: true });
      fs.copyFileSync(databasePath, outsideDatabase);
      fs.rmSync(databasePath, { force: true });
      fs.linkSync(outsideDatabase, databasePath);
      const before = fs.statSync(outsideDatabase, { bigint: true });

      try {
        await assert.rejects(() => prepareProjectDatabase(PROJECT), /项目|文件|链接|重解析|硬链接|安全|SQLite|Sqlite|database|打开/i);
        await rebuildMissingDreaminaDispatch();
        const projected = await accountDb("o_dreaminaCliDispatch")
          .where({ projectUuid: PROJECT, taskUuid })
          .select("taskUuid");
        assert.deepEqual(projected, [], "外部 project.sqlite 不得进入当前账号 dispatch");
        const after = fs.statSync(outsideDatabase, { bigint: true });
        assert.equal(after.ino, before.ino);
        assert.equal(after.size, before.size);
        assert.equal(after.mtimeNs, before.mtimeNs);
      } finally {
        await destroyProjectDatabaseHandle(SEGMENT, PROJECT).catch(() => undefined);
        if (fs.existsSync(databasePath) && fs.lstatSync(databasePath).isSymbolicLink()) fs.unlinkSync(databasePath);
        else if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
        fs.rmSync(outsideDatabase, { force: true });
      }
    });
  });
}

test("project 目录 realpath 检查后被替换为 junction 时，SQLite 打开必须失败", async () => {
  await withRuntime("r25f4-sqlite-parent-race", async (root) => {
    await prepareLegacyTask();
    const projectRoot = projectDirectory(getPath(), PROJECT, SEGMENT);
    await destroyProjectDatabaseHandle(SEGMENT, PROJECT);
    const outsideRoot = path.join(root, "outside-project");
    const originalRoot = `${projectRoot}.original-${crypto.randomUUID()}`;
    fs.cpSync(projectRoot, outsideRoot, { recursive: true });
    const originalRealpath = fs.realpathSync.native;
    let swapped = false;
    (fs.realpathSync as typeof fs.realpathSync & { native: typeof fs.realpathSync.native }).native = ((value: fs.PathLike) => {
      const resolved = originalRealpath(value);
      if (!swapped && path.resolve(String(value)) === path.resolve(projectRoot)) {
        fs.renameSync(projectRoot, originalRoot);
        fs.symlinkSync(outsideRoot, projectRoot, "junction");
        swapped = true;
      }
      return resolved;
    }) as typeof fs.realpathSync.native;
    syncBuiltinESMExports();
    try {
      let thrown: unknown;
      try {
        await prepareProjectDatabase(PROJECT);
      } catch (error) {
        thrown = error;
      }
      assert.equal(swapped, true, "夹具必须命中 realpath 检查后的父目录替换窗口");
      assert.ok(thrown, "父目录替换后不得继续按可变路径打开 SQLite");
    } finally {
      (fs.realpathSync as typeof fs.realpathSync & { native: typeof fs.realpathSync.native }).native = originalRealpath;
      syncBuiltinESMExports();
      await destroyProjectDatabaseHandle(SEGMENT, PROJECT).catch(() => undefined);
      if (fs.existsSync(projectRoot) && fs.lstatSync(projectRoot).isSymbolicLink()) fs.unlinkSync(projectRoot);
      if (fs.existsSync(originalRoot)) fs.renameSync(originalRoot, projectRoot);
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});

test("writer 实际写入前父目录被 junction 替换时，项目外不得出现 payload", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "r25f4-writer-rename-race-"));
  const projectUuid = "e0252584-2584-4524-a524-252225842584";
  const filesRoot = projectFilesDirectory(dataRoot, projectUuid, SEGMENT);
  const targetDirectory = path.join(filesRoot, "images");
  const originalDirectory = `${targetDirectory}.original-${crypto.randomUUID()}`;
  const outsideDirectory = path.join(dataRoot, "outside");
  fs.mkdirSync(outsideDirectory, { recursive: true });
  fs.writeFileSync(path.join(outsideDirectory, "race.png"), Buffer.from("OUTSIDE-VICTIM"));
  const originalWriteSync = fs.writeSync;
  let writeHookHit = false;
  fs.writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
    if (!writeHookHit) {
      writeHookHit = true;
      fs.renameSync(targetDirectory, originalDirectory);
      fs.symlinkSync(outsideDirectory, targetDirectory, "junction");
    }
    return originalWriteSync(...args);
  }) as typeof fs.writeSync;
  try {
    let thrown: unknown;
    try {
      writeProjectFileAtomic(dataRoot, projectUuid, SEGMENT, "files/images/race.png", Buffer.from("SECRET-RENAME-RACE"));
    } catch (error) {
      thrown = error;
    }
    assert.equal(writeHookHit, true, "夹具必须命中实际写入前的竞态窗口");
    assert.equal(fs.readFileSync(path.join(outsideDirectory, "race.png")).toString(), "OUTSIDE-VICTIM",
      "父目录替换后不得把 payload 写到项目外或清理外部文件");
    assert.ok(thrown, "父目录替换后必须 fail-closed");
  } finally {
    fs.writeSync = originalWriteSync;
    if (fs.existsSync(targetDirectory) && fs.lstatSync(targetDirectory).isSymbolicLink()) fs.unlinkSync(targetDirectory);
    if (fs.existsSync(originalDirectory) && !fs.existsSync(targetDirectory)) fs.renameSync(originalDirectory, targetDirectory);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("writer 既有文件写入失败时用同一 fd 恢复旧内容", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "r25f4-writer-existing-failure-"));
  const projectUuid = "e1252584-2584-4524-a524-252225842584";
  const destination = path.join(projectFilesDirectory(dataRoot, projectUuid, SEGMENT), "images", "existing.png");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from("ORIGINAL-CONTENT"));
  const originalWriteSync = fs.writeSync;
  let writeHookHit = false;
  fs.writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
    if (!writeHookHit) {
      writeHookHit = true;
      throw new Error("injected write failure");
    }
    return originalWriteSync(...args);
  }) as unknown as typeof fs.writeSync;
  try {
    assert.throws(
      () => writeProjectFileAtomic(dataRoot, projectUuid, SEGMENT, "files/images/existing.png", Buffer.from("NEW-CONTENT")),
      /injected|写入/,
    );
    assert.equal(writeHookHit, true, "夹具必须命中实际 fd 写入");
    assert.deepEqual(fs.readFileSync(destination), Buffer.from("ORIGINAL-CONTENT"),
      "写入失败不得先截断既有文件");
  } finally {
    fs.writeSync = originalWriteSync;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("resolveProjectFilePath 对预存在 dangling symlink 必须无条件 lstat 并拒绝", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "r25f6-dangling-link-"));
  const projectUuid = "d0252584-2584-4524-a524-252225842584";
  const filesRoot = projectFilesDirectory(dataRoot, projectUuid, SEGMENT);
  const candidate = path.join(filesRoot, "videos", "dangling.mp4");
  const missingTarget = path.join(dataRoot, "missing-target.mp4");
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  let restore: (() => void) | undefined;
  try {
    try {
      fs.symlinkSync(missingTarget, candidate, "file");
    } catch {
      // 中文注释：Windows 无创建 symlink 权限时，用确定性 lstat mock 覆盖同一安全分支。
      const originalLstatSync = fs.lstatSync;
      const mutableFs = fs as typeof fs & { lstatSync: typeof fs.lstatSync };
      mutableFs.lstatSync = ((target: fs.PathLike) => {
        if (path.resolve(String(target)) === path.resolve(candidate)) {
          return { isSymbolicLink: () => true, isDirectory: () => false } as unknown as ReturnType<typeof fs.lstatSync>;
        }
        return originalLstatSync(target);
      }) as typeof fs.lstatSync;
      restore = () => { mutableFs.lstatSync = originalLstatSync; };
    }
    assert.throws(
      () => resolveProjectFilePath(dataRoot, projectUuid, SEGMENT, "files/videos/dangling.mp4"),
      /符号链接|重解析|安全/,
    );
  } finally {
    restore?.();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("父目录链 dangling symlink 必须被两个路径检查拒绝", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "r25f7-parent-dangling-"));
  const projectUuid = "d1252584-2584-4524-a524-252225842584";
  const filesRoot = projectFilesDirectory(dataRoot, projectUuid, SEGMENT);
  const danglingParent = path.join(filesRoot, "videos");
  const candidate = path.join(danglingParent, "clip.mp4");
  fs.mkdirSync(filesRoot, { recursive: true });
  const originalLstatSync = fs.lstatSync;
  const mutableFs = fs as typeof fs & { lstatSync: typeof fs.lstatSync };
  let lstatHit = false;
  mutableFs.lstatSync = ((target: fs.PathLike) => {
    if (path.resolve(String(target)) === path.resolve(danglingParent)) {
      lstatHit = true;
      return { isSymbolicLink: () => true, isDirectory: () => false } as unknown as ReturnType<typeof fs.lstatSync>;
    }
    return originalLstatSync(target);
  }) as typeof fs.lstatSync;
  try {
    assert.throws(
      () => assertManagedPathChainHasNoLinks(filesRoot, candidate),
      /符号链接|重解析|安全/,
    );
    assert.throws(
      () => resolveProjectFilePath(dataRoot, projectUuid, SEGMENT, "files/videos/clip.mp4"),
      /符号链接|重解析|安全/,
    );
    assert.equal(lstatHit, true, "父目录检查必须实际调用 lstat");
  } finally {
    mutableFs.lstatSync = originalLstatSync;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("父链 lstat 的权限或 IO 错误不得被 exists 判断吞掉", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "r25f7-parent-io-"));
  const projectUuid = "d2252584-2584-4524-a524-252225842584";
  const filesRoot = projectFilesDirectory(dataRoot, projectUuid, SEGMENT);
  const candidate = path.join(filesRoot, "videos", "io-error.mp4");
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  const originalLstatSync = fs.lstatSync;
  const mutableFs = fs as typeof fs & { lstatSync: typeof fs.lstatSync };
  mutableFs.lstatSync = ((target: fs.PathLike) => {
    if (path.resolve(String(target)) === path.resolve(candidate)) {
      const error = Object.assign(new Error("injected lstat EACCES"), { code: "EACCES" });
      throw error;
    }
    return originalLstatSync(target);
  }) as typeof fs.lstatSync;
  try {
    assert.throws(
      () => resolveProjectFilePath(dataRoot, projectUuid, SEGMENT, "files/videos/io-error.mp4"),
      /EACCES|lstat/,
    );
  } finally {
    mutableFs.lstatSync = originalLstatSync;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// R26 残余记录（非执行门禁）：同一 Windows 用户在两个 Node syscall 间替换目录，须由 native handle-bound lease 解决。

test("writer 拒绝指向项目外的目标 hardlink，保留外部文件内容", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "r25f4-writer-hardlink-"));
  const projectUuid = "f0252584-2584-4524-a524-252225842584";
  const destination = path.join(projectFilesDirectory(dataRoot, projectUuid, SEGMENT), "images", "hardlink.png");
  const outside = path.join(dataRoot, "outside-victim.png");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(outside, Buffer.from("OUTSIDE-VICTIM"));
  fs.linkSync(outside, destination);
  try {
    assert.throws(
      () => writeProjectFileAtomic(dataRoot, projectUuid, SEGMENT, "files/images/hardlink.png", Buffer.from("SECRET-HARDLINK")),
      /项目|文件|硬链接|身份|安全/,
    );
    assert.deepEqual(fs.readFileSync(outside), Buffer.from("OUTSIDE-VICTIM"));
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("writer 新文件成功后只返回项目内完整内容", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "r25f5-writer-new-file-"));
  const projectUuid = "f1252584-2584-4524-a524-252225842584";
  const relativePath = "files/images/new.png";
  const payload = Buffer.from("NEW-FILE-PAYLOAD");
  try {
    const result = writeProjectFileAtomic(dataRoot, projectUuid, SEGMENT, relativePath, payload);
    assert.equal(result.size, payload.length);
    assert.deepEqual(fs.readFileSync(result.absolutePath), payload);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("writer 覆盖期间外部观察只能看到旧或新完整版本", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "r25f5-writer-atomic-visibility-"));
  const projectUuid = "f2252584-2584-4524-a524-252225842584";
  const destination = path.join(projectFilesDirectory(dataRoot, projectUuid, SEGMENT), "images", "visible.png");
  const oldContent = Buffer.from("OLD-CONTENT-0123456789");
  const newContent = Buffer.from("NEW-CONTENT-9876543210");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, oldContent);
  const originalWriteSync = fs.writeSync;
  const observations: Buffer[] = [];
  let limitedWrite = false;
  (fs as typeof fs & { writeSync: typeof fs.writeSync }).writeSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offsetOrOptions?: number | fs.WriteOptions, length?: number, position?: number) => {
    const offset = typeof offsetOrOptions === "number" ? offsetOrOptions : 0;
    const requested = typeof offsetOrOptions === "number" ? length ?? 0 : 0;
    const boundedLength = !limitedWrite && requested > 3 ? 3 : requested;
    const written = originalWriteSync(fd, buffer, offset, boundedLength, position);
    if (!limitedWrite && requested > 3) {
      limitedWrite = true;
      observations.push(fs.readFileSync(destination));
    }
    return written;
  }) as typeof fs.writeSync;
  try {
    writeProjectFileAtomic(dataRoot, projectUuid, SEGMENT, "files/images/visible.png", newContent);
    observations.push(fs.readFileSync(destination));
    assert.ok(observations.length >= 1, "必须在实际写入期间观察目标");
    for (const observed of observations) {
      assert.ok(observed.equals(oldContent) || observed.equals(newContent),
        `目标不可暴露半截内容：${observed.toString()}`);
    }
    assert.deepEqual(fs.readFileSync(destination), newContent);
  } finally {
    fs.writeSync = originalWriteSync;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("writer flush 失败时既有目标旧内容保持不变", () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "r25f5-writer-flush-failure-"));
  const projectUuid = "f3252584-2584-4524-a524-252225842584";
  const destination = path.join(projectFilesDirectory(dataRoot, projectUuid, SEGMENT), "images", "flush.png");
  const oldContent = Buffer.from("OLD-FLUSH-CONTENT");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, oldContent);
  const originalFsyncSync = fs.fsyncSync;
  let flushHookHit = false;
  fs.fsyncSync = ((fd: number) => {
    flushHookHit = true;
    throw new Error("injected flush failure");
  }) as typeof fs.fsyncSync;
  try {
    assert.throws(
      () => writeProjectFileAtomic(dataRoot, projectUuid, SEGMENT, "files/images/flush.png", Buffer.from("NEW-FLUSH-CONTENT")),
      /flush|写入/,
    );
    assert.equal(flushHookHit, true, "夹具必须命中真实 fsync");
    assert.deepEqual(fs.readFileSync(destination), oldContent, "flush 失败不得改变既有目标");
  } finally {
    fs.fsyncSync = originalFsyncSync;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
