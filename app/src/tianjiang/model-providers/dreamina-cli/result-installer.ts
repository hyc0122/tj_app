import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Knex } from "knex";

import {
  installStoryboardCandidate,
  readWorkbenchGenerationOrigin,
  type WorkbenchGenerationOrigin,
} from "@/tianjiang/storyboard/storyboard-generation-service";
import getPath from "@/utils/getPath";
import { db as activeDb } from "@/utils/db";
import { currentUserStorage, runWithProjectStorage } from "@/tianjiang/runtime/user-storage-context";
import { projectDirectory } from "@/tianjiang/data/paths";
import {
  assertAdoptableMp4Fd,
  assertOpenedFileIdentity,
  hashOpenFile,
  openAdoptableStagingVideo,
} from "@/tianjiang/media/adoptable-generated-video";

let afterSourceValidatedForTests: (() => void) | null = null;

interface InstalledDestinationIdentity {
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

interface OpenInstalledDestination {
  fd: number;
  identity: InstalledDestinationIdentity;
}

interface WorkbenchVideoHistoryBinding {
  id: number;
  projectId: number;
  scriptId: number;
  trackId: number;
  filePath: string | null;
  state: string | null;
}

interface InstallParentIdentity {
  absolutePath: string;
  device: bigint;
  inode: bigint;
}

interface OpenInstallSource {
  fd: number;
  absolutePath: string;
  rootPath?: string;
  device: bigint;
  inode: bigint;
  size: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export function setAfterDreaminaResultValidatedForTests(hook: (() => void) | null): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  afterSourceValidatedForTests = hook;
}

/**
 * 把已完成的即梦结果从账号 staging 校验后绑定写入项目 files/**。
 * 文件为空或校验失败不得标记业务完成；后处理失败不得重新占槽或再次提交。
 */
export async function installDreaminaResult(input: {
  projectUuid: string;
  taskUuid: string;
  shotUuid: string;
  mediaType: "image" | "video";
  stagingDirectory: string;
  files?: readonly string[];
}): Promise<{ relativePath: string } | null> {
  const context = currentUserStorage();
  if (!context) throw Object.assign(new Error("缺少账号上下文，无法安装生成结果"), { status: 403 });
  try {
    const projectRoot = projectDirectory(getPath(), input.projectUuid, context.segment);
    const folder = input.mediaType === "video" ? "videos" : "images";
    const taskRow = await runWithProjectStorage(input.projectUuid, () =>
      activeDb("o_storyboardGenerationTask").where({ taskUuid: input.taskUuid }).first());
    let parsedRequest: unknown = null;
    try {
      parsedRequest = JSON.parse(String(taskRow?.parametersJson ?? "{}"));
    } catch {
      parsedRequest = null;
    }
    const workbench = readWorkbenchGenerationOrigin(parsedRequest);
    const initialBinding = workbench
      // 中文注释：打开最终目标前必须在当前项目库中确认唯一且精确的工作台来源绑定。
      ? await assertWorkbenchVideoHistoryBinding(input.projectUuid, input.taskUuid, workbench)
      : null;
    if (workbench && initialBinding) {
      // 中文注释：完整结果已经由精确四元绑定耐久化时，先验证同一项目文件，再幂等返回且不依赖 staging。
      const completed = adoptCompletedWorkbenchResult(
        projectRoot,
        input.taskUuid,
        input.mediaType,
        initialBinding,
      );
      if (completed) return completed as { relativePath: string };
    }
    const fallbackSource = path.join(
      input.stagingDirectory,
      input.mediaType === "video" ? "result.mp4" : "result.png",
    );
    const source = (input.files ?? []).find((file) => file && fs.existsSync(file))
      ?? (fs.existsSync(fallbackSource) ? fallbackSource : "");
    if (!source || !fs.existsSync(source)) {
      throw Object.assign(new Error("完成证据缺少可安装文件"), {
        status: 422,
        code: "DREAMINA_RESULT_FILE_MISSING",
      });
    }
    const ext = input.mediaType === "video" ? ".mp4" : (path.extname(source) || ".png");
    // 中文注释：工作台结果写入 files/videos/workbench，禁止冒充分镜候选或伪造 shot 行。
    const destDir = workbench
      ? path.join(projectRoot, "files", folder, "workbench")
      : path.join(projectRoot, "files", folder, "storyboard", input.shotUuid);
    fs.mkdirSync(destDir, { recursive: true });
    // 中文注释：每次尝试使用项目目录内随机 O_EXCL 名；半写残留不能阻塞下一次安装。
    const attemptFileName = `${input.taskUuid}.${crypto.randomUUID()}${ext}`;
    const dest = path.join(destDir, attemptFileName);
    const openedSource = openInstallSource(source, input.mediaType, input.stagingDirectory);
    let digest: { size: number; md5: string };
    let installedDestination: OpenInstalledDestination | undefined;
    try {
      const sourceDigest = hashOpenFile(openedSource.fd, openedSource.size);
      if (afterSourceValidatedForTests) afterSourceValidatedForTests();
      assertValidatedInstallSource(openedSource, input.mediaType);
      if (hashOpenFile(openedSource.fd, openedSource.size) !== sourceDigest) {
        throw input.mediaType === "video" ? resultVideoInvalidError() : new Error("安装源文件内容已变化");
      }
      digest = { size: openedSource.size, md5: hashOpenFileMd5(openedSource.fd, openedSource.size) };
      assertValidatedInstallSource(openedSource, input.mediaType);
      // 中文注释：最终目标自身用 O_EXCL 打开，首字节前绑定 fd/父目录/路径，随后只写已打开 fd，禁止路径 rename。
      installedDestination = installOpenSourceToBoundDestination(openedSource, dest, input.mediaType, digest);
      assertInstalledDestinationHandleIdentity(installedDestination);
      assertInstalledDestinationIdentity(installedDestination.identity);
    } finally {
      fs.closeSync(openedSource.fd);
    }
    const relativePath = workbench
      ? `files/${folder}/workbench/${attemptFileName}`
      : `files/${folder}/storyboard/${input.shotUuid}/${attemptFileName}`;
    try {
      if (workbench && initialBinding) {
        let boundResult: { relativePath: string; md5: string; size: number };
        try {
          boundResult = await runWithProjectStorage(input.projectUuid, () =>
            activeDb.transaction(async (trx) => {
              // 中文注释：目标 fd 跨越事务；绑定前后均复核 fd/路径/父目录，漂移会回滚数据库更新。
              const binding = await assertWorkbenchVideoHistoryBindingInCurrentProject(
                input.taskUuid,
                workbench,
                trx,
              );
              if (binding.id !== initialBinding.id) throw workbenchHistoryMissingError();
              if (binding.state !== initialBinding.state || binding.filePath !== initialBinding.filePath) {
                const adopted = adoptCompletedWorkbenchResult(
                  projectRoot,
                  input.taskUuid,
                  input.mediaType,
                  binding,
                );
                if (adopted) return adopted;
                throw new Error("工作台结果绑定已变化");
              }
              assertInstalledDestinationHandleIdentity(installedDestination!);
              let update = trx("o_video").where({
                id: binding.id,
                generationTaskUuid: input.taskUuid,
                projectId: workbench.projectId,
                scriptId: workbench.scriptId,
                videoTrackId: workbench.trackId,
              });
              update = initialBinding.filePath === null
                ? update.whereNull("filePath")
                : update.andWhere("filePath", initialBinding.filePath);
              update = initialBinding.state === null
                ? update.whereNull("state")
                : update.andWhere("state", initialBinding.state);
              const updated = await update.update({
                filePath: relativePath,
                state: "生成成功",
                errorReason: null,
              });
              if (updated !== 1) throw new Error("工作台结果绑定已变化");
              assertInstalledDestinationHandleIdentity(installedDestination!);
              return { relativePath, md5: digest.md5, size: digest.size };
            }));
        } catch (bindingError) {
          // 中文注释：SQLite CAS/快照若输给并发完成者，事务外重新读取精确四元绑定；
          // 只采用已完整验真的赢家，其他失败仍保留原错误与本次随机残留。
          try {
            const latestBinding = await assertWorkbenchVideoHistoryBinding(
              input.projectUuid,
              input.taskUuid,
              workbench,
            );
            const adopted = adoptCompletedWorkbenchResult(
              projectRoot,
              input.taskUuid,
              input.mediaType,
              latestBinding,
            );
            if (adopted) return adopted;
          } catch {
            // 中文注释：重读失败不能掩盖最初 CAS/事务错误。
          }
          throw bindingError;
        }
        if (boundResult.relativePath === relativePath) {
          assertInstalledDestinationHandleIdentity(installedDestination);
          assertInstalledDestinationIdentity(installedDestination.identity);
        }
        return boundResult as { relativePath: string };
      }
      assertInstalledDestinationHandleIdentity(installedDestination);
      await installStoryboardCandidate({
        projectUuid: input.projectUuid,
        shotUuid: input.shotUuid,
        mediaType: input.mediaType,
        relativePath,
        select: true,
        // 中文注释：一个收费任务只允许形成一条候选；重启重放复用同一 taskUuid。
        candidateUuid: input.taskUuid,
      });
      assertInstalledDestinationHandleIdentity(installedDestination);
      return { relativePath, md5: digest.md5, size: digest.size } as { relativePath: string };
    } finally {
      // 中文注释：目标 fd 一直持有到数据库绑定完成；关闭后仍不按路径删除任何失败残留。
      fs.closeSync(installedDestination.fd);
    }
  } catch (error) {
    // 中文注释：Node/Windows 无 unlinkat；失败目标与 staging 源均保留，禁止检查后再 rm(path) 误删替换对象。
    throw normalizeResultInstallError(error);
  }
}

function adoptCompletedWorkbenchResult(
  projectRoot: string,
  taskUuid: string,
  mediaType: "image" | "video",
  binding: WorkbenchVideoHistoryBinding,
): { relativePath: string; md5: string; size: number } | null {
  if (mediaType !== "video" || binding.state !== "生成成功" || !binding.filePath) return null;
  const relativePath = binding.filePath;
  const expectedPrefix = "files/videos/workbench/";
  if (relativePath.includes("\\")
    || !relativePath.startsWith(expectedPrefix)
    || path.posix.normalize(relativePath) !== relativePath) {
    return null;
  }
  const fileName = relativePath.slice(expectedPrefix.length);
  const escapedTaskUuid = taskUuid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const allowedName = new RegExp(
    `^${escapedTaskUuid}(?:\\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?\\.mp4$`,
    "i",
  );
  if (!allowedName.test(fileName)) return null;
  const destination = path.resolve(projectRoot, ...relativePath.split("/"));
  const expectedDirectory = path.resolve(projectRoot, "files", "videos", "workbench");
  if (!sameNativeInstallPath(path.dirname(destination), expectedDirectory)) return null;
  try {
    const parent = captureInstallParentIdentity(destination);
    const fd = fs.openSync(destination, fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW ?? 0));
    try {
      const before = captureInstalledDestinationIdentity(fd, destination, parent);
      if (before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      const size = Number(before.size);
      assertAdoptableMp4Fd(fd, size);
      const md5 = hashOpenFileMd5(fd, size);
      const after = captureInstalledDestinationIdentity(fd, destination, parent);
      if (after.size !== before.size
        || after.mtimeNs !== before.mtimeNs
        || after.ctimeNs !== before.ctimeNs) {
        return null;
      }
      assertInstalledDestinationIdentity(after);
      return { relativePath, md5, size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // 中文注释：旧绑定缺失、损坏或身份不稳定时不采用；若 staging 仍在则由新的随机尝试修复。
    return null;
  }
}

function captureInstallParentIdentity(destination: string): InstallParentIdentity {
  const parentPath = path.resolve(path.dirname(destination));
  const parentStat = fs.lstatSync(parentPath, { bigint: true });
  assertStableInstallNodeIdentity(parentStat);
  if (!parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || !sameNativeInstallPath(fs.realpathSync.native(parentPath), parentPath)) {
    throw new Error("生成结果安装目标身份不安全");
  }
  return {
    absolutePath: parentPath,
    device: parentStat.dev,
    inode: parentStat.ino,
  };
}

function installOpenSourceToBoundDestination(
  source: OpenInstallSource,
  destination: string,
  mediaType: "image" | "video",
  digest: { size: number; md5: string },
): OpenInstalledDestination {
  const parent = captureInstallParentIdentity(destination);
  const fd = fs.openSync(
    destination,
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  let keepOpen = false;
  try {
    // 中文注释：open 可能命中新替换的同名父目录；在写入首字节前必须绑定父目录、路径与目标 fd。
    assertOpenedDestinationBound(fd, destination, parent);
    copyOpenSourceToFd(source.fd, fd, source.size);
    fs.fsyncSync(fd);
    assertValidatedInstallSource(source, mediaType);
    const identity = captureInstalledDestinationIdentity(fd, destination, parent);
    if (identity.size !== BigInt(digest.size)
      || hashOpenFileMd5(fd, digest.size) !== digest.md5) {
      throw new Error("生成结果安装目标内容不完整");
    }
    if (mediaType === "video") assertAdoptableMp4Fd(fd, digest.size);
    const completed = captureInstalledDestinationIdentity(fd, destination, parent);
    if (completed.size !== identity.size
      || completed.mtimeNs !== identity.mtimeNs
      || completed.ctimeNs !== identity.ctimeNs) {
      throw new Error("生成结果安装目标身份已变化");
    }
    keepOpen = true;
    return { fd, identity: completed };
  } finally {
    // 中文注释：失败立即关闭但不删路径；成功句柄由调用方持有到数据库绑定完成。
    if (!keepOpen) fs.closeSync(fd);
  }
}

function captureInstalledDestinationIdentity(
  fd: number,
  destination: string,
  parent: InstallParentIdentity,
): InstalledDestinationIdentity {
  const descriptor = assertOpenedDestinationBound(fd, destination, parent);
  return {
    absolutePath: path.resolve(destination),
    parentPath: parent.absolutePath,
    device: descriptor.dev,
    inode: descriptor.ino,
    nlink: descriptor.nlink,
    parentDevice: parent.device,
    parentInode: parent.inode,
    size: descriptor.size,
    mtimeNs: descriptor.mtimeNs,
    ctimeNs: descriptor.ctimeNs,
  };
}

function assertOpenedDestinationBound(
  fd: number,
  destination: string,
  parent: InstallParentIdentity,
): fs.BigIntStats {
  const parentStat = fs.lstatSync(parent.absolutePath, { bigint: true });
  const descriptor = fs.fstatSync(fd, { bigint: true });
  const targetStat = fs.lstatSync(destination, { bigint: true });
  assertStableInstallNodeIdentity(parentStat);
  assertStableInstallFileIdentity(descriptor);
  assertStableInstallFileIdentity(targetStat);
  if (!parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || parentStat.dev !== parent.device
    || parentStat.ino !== parent.inode
    || !sameNativeInstallPath(fs.realpathSync.native(parent.absolutePath), parent.absolutePath)
    || !descriptor.isFile()
    || !targetStat.isFile()
    || targetStat.isSymbolicLink()
    || descriptor.dev !== targetStat.dev
    || descriptor.ino !== targetStat.ino) {
    throw new Error("生成结果安装目标身份已变化");
  }
  return descriptor;
}

function assertInstalledDestinationIdentity(identity: InstalledDestinationIdentity): void {
  const parentStat = fs.lstatSync(identity.parentPath, { bigint: true });
  const targetStat = fs.lstatSync(identity.absolutePath, { bigint: true });
  assertStableInstallNodeIdentity(parentStat);
  assertStableInstallFileIdentity(targetStat);
  if (!parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || parentStat.dev !== identity.parentDevice
    || parentStat.ino !== identity.parentInode
    || !sameNativeInstallPath(fs.realpathSync.native(identity.parentPath), identity.parentPath)
    || !targetStat.isFile()
    || targetStat.isSymbolicLink()
    || targetStat.dev !== identity.device
    || targetStat.ino !== identity.inode
    || targetStat.nlink !== identity.nlink
    || targetStat.size !== identity.size
    || targetStat.mtimeNs !== identity.mtimeNs
    || targetStat.ctimeNs !== identity.ctimeNs) {
    throw new Error("生成结果安装目标身份已变化");
  }
}

function assertInstalledDestinationHandleIdentity(destination: OpenInstalledDestination): void {
  const identity = destination.identity;
  const descriptor = assertOpenedDestinationBound(destination.fd, identity.absolutePath, {
    absolutePath: identity.parentPath,
    device: identity.parentDevice,
    inode: identity.parentInode,
  });
  if (descriptor.dev !== identity.device
    || descriptor.ino !== identity.inode
    || descriptor.nlink !== identity.nlink
    || descriptor.size !== identity.size
    || descriptor.mtimeNs !== identity.mtimeNs
    || descriptor.ctimeNs !== identity.ctimeNs) {
    throw new Error("生成结果安装目标身份已变化");
  }
}

function assertStableInstallFileIdentity(stat: fs.BigIntStats): void {
  assertStableInstallNodeIdentity(stat);
  // 中文注释：安装源和目标都只接受唯一目录项，nlink 非一时无法证明项目路径是唯一绑定。
  if (stat.nlink !== 1n || stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("生成结果安装目标身份不稳定");
  }
}

function assertStableInstallNodeIdentity(stat: fs.BigIntStats): void {
  if (stat.dev <= 0n || stat.ino <= 0n) throw new Error("生成结果安装目标身份不稳定");
}

function sameNativeInstallPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

async function assertWorkbenchVideoHistoryBinding(
  projectUuid: string,
  taskUuid: string,
  origin: WorkbenchGenerationOrigin,
): Promise<WorkbenchVideoHistoryBinding> {
  return runWithProjectStorage(projectUuid, () =>
    assertWorkbenchVideoHistoryBindingInCurrentProject(taskUuid, origin));
}

async function assertWorkbenchVideoHistoryBindingInCurrentProject(
  taskUuid: string,
  origin: WorkbenchGenerationOrigin,
  database: Knex | Knex.Transaction = activeDb,
): Promise<WorkbenchVideoHistoryBinding> {
  if (!(await database.schema.hasColumn("o_video", "generationTaskUuid"))) {
    throw workbenchHistoryMissingError();
  }
  const rows = await database("o_video")
    .where({ generationTaskUuid: taskUuid })
    .select("id", "projectId", "scriptId", "videoTrackId", "filePath", "state")
    .limit(2);
  const id = Number(rows[0]?.id);
  if (rows.length !== 1
    || !Number.isSafeInteger(id)
    || id <= 0
    || Number(rows[0]?.projectId) !== origin.projectId
    || Number(rows[0]?.scriptId) !== origin.scriptId
    || Number(rows[0]?.videoTrackId) !== origin.trackId) {
    throw workbenchHistoryMissingError();
  }
  return {
    id,
    projectId: Number(rows[0]?.projectId),
    scriptId: Number(rows[0]?.scriptId),
    trackId: Number(rows[0]?.videoTrackId),
    filePath: rows[0]?.filePath === null || rows[0]?.filePath === undefined
      ? null
      : String(rows[0].filePath),
    state: rows[0]?.state === null || rows[0]?.state === undefined
      ? null
      : String(rows[0].state),
  };
}

function workbenchHistoryMissingError(): Error {
  return Object.assign(new Error("工作台历史记录缺失"), {
    status: 409,
    code: "WORKBENCH_VIDEO_HISTORY_MISSING",
  });
}

function resultInstallFailedError(): Error {
  return Object.assign(new Error("生成结果安装失败，请重试"), {
    status: 500,
    code: "DREAMINA_RESULT_INSTALL_FAILED",
  });
}

function normalizeResultInstallError(error: unknown): Error {
  const candidate = error as { status?: unknown; code?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  if (code === "WORKBENCH_VIDEO_HISTORY_MISSING"
    || code === "DREAMINA_RESULT_VIDEO_INVALID"
    || code === "DREAMINA_RESULT_FILE_MISSING") {
    return error as Error;
  }
  // 中文注释：未知 errno、SQL、路径和堆栈统一折叠为稳定中文业务错误。
  return resultInstallFailedError();
}

function openInstallSource(
  source: string,
  mediaType: "image" | "video",
  stagingDirectory: string,
): OpenInstallSource {
  if (mediaType === "video") {
    const opened = openAdoptableStagingVideo(source, stagingDirectory);
    try {
      return captureOpenInstallSource(opened.fd, opened.absolutePath, path.resolve(stagingDirectory));
    } catch (error) {
      fs.closeSync(opened.fd);
      throw error;
    }
  }
  const absolutePath = path.resolve(source);
  const stagingRoot = path.resolve(stagingDirectory);
  const scoped = path.relative(stagingRoot, absolutePath);
  if (!scoped || scoped.startsWith("..") || path.isAbsolute(scoped)) {
    // 中文注释：图片与视频共享同一受信 staging 根，禁止 CLI 返回本机任意文件路径。
    throw new Error("生成结果安装源文件不在受信 staging 目录");
  }
  const nofollow = Number(fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | nofollow);
  try {
    return captureOpenInstallSource(fd, absolutePath, stagingRoot);
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function captureOpenInstallSource(fd: number, absolutePath: string, rootPath?: string): OpenInstallSource {
  const descriptor = fs.fstatSync(fd, { bigint: true });
  const target = fs.lstatSync(absolutePath, { bigint: true });
  assertStableInstallFileIdentity(descriptor);
  assertStableInstallFileIdentity(target);
  if (!descriptor.isFile()
    || !target.isFile()
    || target.isSymbolicLink()
    || descriptor.dev !== target.dev
    || descriptor.ino !== target.ino
    || descriptor.size !== target.size
    || descriptor.size <= 0n
    || descriptor.size > BigInt(Number.MAX_SAFE_INTEGER)
    || !sameNativeInstallPath(fs.realpathSync.native(absolutePath), absolutePath)) {
    throw new Error("生成结果安装源文件身份不安全");
  }
  if (rootPath) {
    const scoped = path.relative(rootPath, absolutePath);
    if (!scoped || scoped.startsWith("..") || path.isAbsolute(scoped)) throw resultVideoInvalidError();
  }
  return {
    fd,
    absolutePath,
    rootPath,
    device: descriptor.dev,
    inode: descriptor.ino,
    size: Number(descriptor.size),
    mtimeNs: descriptor.mtimeNs,
    ctimeNs: descriptor.ctimeNs,
  };
}

function assertValidatedInstallSource(source: OpenInstallSource, mediaType: "image" | "video"): void {
  try {
    const descriptor = fs.fstatSync(source.fd, { bigint: true });
    const target = fs.lstatSync(source.absolutePath, { bigint: true });
    assertStableInstallFileIdentity(descriptor);
    assertStableInstallFileIdentity(target);
    if (!descriptor.isFile()
      || !target.isFile()
      || target.isSymbolicLink()
      || descriptor.dev !== source.device
      || descriptor.ino !== source.inode
      || descriptor.size !== BigInt(source.size)
      || descriptor.mtimeNs !== source.mtimeNs
      || descriptor.ctimeNs !== source.ctimeNs
      || target.dev !== source.device
      || target.ino !== source.inode
      || !sameNativeInstallPath(fs.realpathSync.native(source.absolutePath), source.absolutePath)) {
      throw new Error("生成结果安装源文件身份已变化");
    }
    if (source.rootPath) {
      assertOpenedFileIdentity(source.fd, source.absolutePath, source.rootPath);
    }
  } catch (error) {
    if (mediaType === "video") throw resultVideoInvalidError();
    throw error;
  }
}

function copyOpenSourceToFd(sourceFd: number, destinationFd: number, size: number): void {
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (position < size) {
    const read = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, size - position), position);
    if (read <= 0) throw new Error("生成结果安装源文件读取不完整");
    let written = 0;
    while (written < read) {
      const count = fs.writeSync(destinationFd, buffer, written, read - written, position + written);
      if (count <= 0) throw new Error("生成结果安装目标写入不完整");
      written += count;
    }
    position += read;
  }
}

function hashOpenFileMd5(fd: number, size: number): string {
  const hash = crypto.createHash("md5");
  const buffer = Buffer.alloc(64 * 1024);
  let remaining = size;
  let position = 0;
  while (remaining > 0) {
    const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), position);
    if (read <= 0) throw new Error("生成结果安装文件读取不完整");
    hash.update(buffer.subarray(0, read));
    remaining -= read;
    position += read;
  }
  return hash.digest("hex");
}

function resultVideoInvalidError(): Error {
  return Object.assign(new Error("生成结果不是可采用的视频"), {
    status: 422,
    code: "DREAMINA_RESULT_VIDEO_INVALID",
  });
}
