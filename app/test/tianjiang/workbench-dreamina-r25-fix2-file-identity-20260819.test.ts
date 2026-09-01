/**
 * R25-fix2：项目/快照/安装必须绑定同一安全文件身份；随机 O_EXCL 尝试允许失败后恢复，
 * 任何不能证明所有权的本地残留都不得按可变路径删除。
 */
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
  initializeWorkspaceProject,
  prepareProjectDatabase,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { invalidateDreaminaCapabilityCache } from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import { resetDreaminaStartupStatusCheckForTests } from "../../src/tianjiang/model-providers/dreamina-cli/cli-truth";
import {
  installDreaminaResult,
  setAfterDreaminaResultValidatedForTests,
} from "../../src/tianjiang/model-providers/dreamina-cli/result-installer";
import {
  stopDreaminaSchedulerLoop,
  tickDreaminaScheduler,
} from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import {
  closeProjectFileHandle,
  copyOpenProjectFileHandleToExclusivePath,
  openProjectFileHandle,
  resolveProjectFilePath,
  setProjectFileAfterStatHookForTests,
  writeProjectFileAtomic,
} from "../../src/tianjiang/media/project-file-store";
import {
  buildProjectFileInventory,
  hashFileStreaming,
} from "../../src/tianjiang/media/project-file-inventory";
import { prepareModelMediaReferences } from "../../src/tianjiang/media/model-media-reference";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import getPath from "../../src/utils/getPath";
import {
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
  userStorageSegment,
} from "../../src/tianjiang/runtime/user-storage-context";
import { enqueueWorkbenchDreaminaVideos } from "../../src/tianjiang/workbench/dreamina-workbench-enqueue";
import { resolveDreaminaReferenceForExecution } from "../../src/tianjiang/storyboard/storyboard-generation-service";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import { writeReadyDreaminaTestCapability } from "./helpers/dreamina-capability";
import { buildMinimalAdoptableMp4 } from "./helpers/minimal-mp4";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 2523 };
const PROJECT = "b0252523-2523-4523-a523-252325232523";
const PROJECT_ID = 2523;
const SCRIPT_ID = 23;
const TRACK_ID = 73;
const REFERENCE_PATH = "files/images/workbench/r25-fix2-file.png";
const FAKE_CLI = path.resolve(__dirname, "fixtures/fake-dreamina-cli.cjs");

function tinyPng(marker = 0): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, marker,
  ]);
}

function workbenchItem(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    scriptId: SCRIPT_ID,
    trackId: TRACK_ID,
    prompt: "R25-fix2 文件身份",
    model: "dreamina-cli:seedance2.0fast",
    mode: "singleImage",
    resolution: "720p",
    duration: 5,
    audio: false,
    uploadData: [{ id: 103, sources: "storyboard" }],
    ...overrides,
  };
}

async function withRuntime(name: string, run: () => Promise<void>): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `${name}-${process.pid}-${crypto.randomUUID()}`);
  const previousCwd = process.cwd();
  const previousEnvironment = {
    NODE_ENV: process.env.NODE_ENV,
    DREAMINA_TEST_EXECUTABLE: process.env.DREAMINA_TEST_EXECUTABLE,
    DREAMINA_FAKE_LOG: process.env.DREAMINA_FAKE_LOG,
  };
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  resetDatabaseRuntimeForServe();
  resetDreaminaStartupStatusCheckForTests();
  invalidateDreaminaCapabilityCache();
  stopDreaminaSchedulerLoop();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: PROJECT_ID,
        name: "R25-fix2-file-identity",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await prepareProjectDatabase(PROJECT);
      await writeDreaminaCliSettings({
        enabled: true,
        executablePath: FAKE_CLI,
        pauseNewClaims: true,
        maxConcurrency: 1,
      });
      writeReadyDreaminaTestCapability();
      writeProjectFileAtomic(
        getPath(),
        PROJECT,
        userStorageSegment(IDENTITY),
        REFERENCE_PATH,
        tinyPng(),
      );
      await runWithProjectStorage(PROJECT, async () => {
        await activeDb("o_storyboard").insert({
          id: 103,
          scriptId: SCRIPT_ID,
          projectId: PROJECT_ID,
          filePath: REFERENCE_PATH,
          state: "已完成",
          prompt: "安全参考图",
        });
        await activeDb("o_videoTrack").insert({
          id: TRACK_ID,
          projectId: PROJECT_ID,
          scriptId: SCRIPT_ID,
          prompt: "安全轨道",
          state: "未生成",
          duration: 5,
        });
        await run();
      });
    });
  } finally {
    setProjectFileAfterStatHookForTests(null);
    setAfterDreaminaResultValidatedForTests(null);
    stopDreaminaSchedulerLoop();
    resetDreaminaStartupStatusCheckForTests();
    invalidateDreaminaCapabilityCache();
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // 中文注释：测试根已经由固定工作树 .tmp 构造，清理前不接受外部输入。
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不覆盖主断言。 */ }
  }
}

function statWithIdentity<T extends fs.Stats | fs.BigIntStats>(
  stat: T,
  device: bigint,
  inode: bigint,
): T {
  const bigint = typeof stat.ino === "bigint";
  return new Proxy(stat, {
    get(target, property, receiver) {
      if (property === "dev") return bigint ? device : Number(device);
      if (property === "ino") return bigint ? inode : Number(inode);
      return Reflect.get(target, property, receiver);
    },
  });
}

function patchFileIdentityStats(targetFile: string, identity: {
  device: bigint;
  inode: bigint;
}): { restore: () => void } {
  const originalOpenSync = fs.openSync;
  const originalFstatSync = fs.fstatSync;
  const originalLstatSync = fs.lstatSync;
  const originalStatSync = fs.statSync;
  let targetFd = -1;
  (fs as unknown as { openSync: typeof fs.openSync }).openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const fd = originalOpenSync(...args);
    if (path.resolve(String(args[0])) === path.resolve(targetFile)) targetFd = fd;
    return fd;
  }) as typeof fs.openSync;
  (fs as unknown as { fstatSync: typeof fs.fstatSync }).fstatSync = ((fd: number, options?: unknown) => {
    const stat = originalFstatSync(fd, options as never) as fs.Stats | fs.BigIntStats;
    return fd === targetFd ? statWithIdentity(stat, identity.device, identity.inode) : stat;
  }) as typeof fs.fstatSync;
  (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
    const stat = originalLstatSync(...args) as fs.Stats | fs.BigIntStats;
    return path.resolve(String(args[0])) === path.resolve(targetFile)
      ? statWithIdentity(stat, identity.device, identity.inode)
      : stat;
  }) as typeof fs.lstatSync;
  (fs as unknown as { statSync: typeof fs.statSync }).statSync = ((...args: Parameters<typeof fs.statSync>) => {
    const stat = originalStatSync(...args) as fs.Stats | fs.BigIntStats;
    return path.resolve(String(args[0])) === path.resolve(targetFile)
      ? statWithIdentity(stat, identity.device, identity.inode)
      : stat;
  }) as typeof fs.statSync;
  return {
    restore: () => {
      (fs as unknown as { openSync: typeof fs.openSync }).openSync = originalOpenSync;
      (fs as unknown as { fstatSync: typeof fs.fstatSync }).fstatSync = originalFstatSync;
      (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = originalLstatSync;
      (fs as unknown as { statSync: typeof fs.statSync }).statSync = originalStatSync;
    },
  };
}

test("项目文件身份必须直接使用 bigint Stats，禁止先经 number 舍入", () => {
  const dataRoot = fs.mkdtempSync(path.resolve(__dirname, "../../../.tmp", "r25f2-bigint-"));
  const segment = "b".repeat(32);
  const relativePath = "files/images/workbench/bigint.png";
  writeProjectFileAtomic(dataRoot, PROJECT, segment, relativePath, tinyPng());
  const target = resolveProjectFilePath(dataRoot, PROJECT, segment, relativePath);
  const exactInode = 29836347534051695n;
  assert.notEqual(BigInt(Number(exactInode)), exactInode, "夹具必须真实复现 NTFS inode number 舍入");
  const patched = patchFileIdentityStats(target, { device: 73n, inode: exactInode });
  let opened: ReturnType<typeof openProjectFileHandle> | undefined;
  try {
    opened = openProjectFileHandle(dataRoot, PROJECT, segment, relativePath);
    assert.equal(opened.inode, exactInode, "文件身份不得先转为 number 再恢复 BigInt");
  } finally {
    if (opened) closeProjectFileHandle(opened.fd);
    patched.restore();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("无法取得稳定非零文件身份时必须 fail-closed", () => {
  const dataRoot = fs.mkdtempSync(path.resolve(__dirname, "../../../.tmp", "r25f2-zero-identity-"));
  const segment = "c".repeat(32);
  const relativePath = "files/images/workbench/zero.png";
  writeProjectFileAtomic(dataRoot, PROJECT, segment, relativePath, tinyPng());
  const target = resolveProjectFilePath(dataRoot, PROJECT, segment, relativePath);
  const patched = patchFileIdentityStats(target, { device: 0n, inode: 0n });
  let opened: ReturnType<typeof openProjectFileHandle> | undefined;
  try {
    assert.throws(() => {
      opened = openProjectFileHandle(dataRoot, PROJECT, segment, relativePath);
    }, /身份/);
  } finally {
    if (opened) closeProjectFileHandle(opened.fd);
    patched.restore();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

function installParentJunctionSwap(targetFile: string): {
  outsideOpenAttempts: () => number;
  restore: () => void;
} {
  const targetDirectory = path.dirname(targetFile);
  const originalDirectory = `${targetDirectory}.original-${crypto.randomUUID()}`;
  const outsideDirectory = path.join(process.cwd(), `outside-reference-${crypto.randomUUID()}`);
  fs.mkdirSync(outsideDirectory, { recursive: true });
  fs.writeFileSync(path.join(outsideDirectory, path.basename(targetFile)), tinyPng(0x7f));
  const originalOpenSync = fs.openSync;
  let unsafeOpenAttempts = 0;
  let swapped = false;

  (fs as unknown as { openSync: typeof fs.openSync }).openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (path.resolve(String(args[0])) === path.resolve(targetFile)
      && fs.existsSync(targetDirectory)
      && fs.lstatSync(targetDirectory).isSymbolicLink()) {
      unsafeOpenAttempts += 1;
      // 中文注释：测试禁止真正读取项目外字节；若生产代码企图跟随 junction，立即截断 I/O。
      throw new Error("检测到项目外读取尝试");
    }
    return originalOpenSync(...args);
  }) as typeof fs.openSync;

  setProjectFileAfterStatHookForTests(() => {
    setProjectFileAfterStatHookForTests(null);
    fs.renameSync(targetDirectory, originalDirectory);
    fs.symlinkSync(outsideDirectory, targetDirectory, "junction");
    swapped = true;
  });

  return {
    outsideOpenAttempts: () => unsafeOpenAttempts,
    restore: () => {
      setProjectFileAfterStatHookForTests(null);
      (fs as unknown as { openSync: typeof fs.openSync }).openSync = originalOpenSync;
      if (swapped && fs.existsSync(targetDirectory) && fs.lstatSync(targetDirectory).isSymbolicLink()) {
        fs.unlinkSync(targetDirectory);
      }
      if (fs.existsSync(originalDirectory) && !fs.existsSync(targetDirectory)) {
        fs.renameSync(originalDirectory, targetDirectory);
      }
    },
  };
}

test("工作台引用预检在父目录替换为 junction 时必须失败且不得读取项目外字节", async () => {
  await withRuntime("r25f2-workbench-file-identity", async () => {
    const target = resolveProjectFilePath(
      getPath(),
      PROJECT,
      currentUserStorage()!.segment,
      REFERENCE_PATH,
    );
    const attack = installParentJunctionSwap(target);
    try {
      await assert.rejects(
        () => enqueueWorkbenchDreaminaVideos({
          projectUuid: PROJECT,
          clientOperationId: "31313131-3131-4131-a131-313131313131",
          paidBatchConfirmed: false,
          items: [workbenchItem()],
        }),
        (error: unknown) => (error as { code?: unknown })?.code === "WORKBENCH_REFERENCE_UNSAFE",
      );
      assert.equal(attack.outsideOpenAttempts(), 0, "安全预检不得尝试打开 junction 外的目标");
      assert.equal((await activeDb("o_storyboardGenerationTask").select()).length, 0, "失败前不得持久化任务");
    } finally {
      attack.restore();
    }
  });
});

test("项目清单哈希在 open 前父目录换 junction 时不得读取 filesRoot 外硬链接", async () => {
  await withRuntime("r25f2-inventory-root-boundary", async () => {
    const projectRoot = projectDirectory(getPath(), PROJECT, currentUserStorage()!.segment);
    const target = resolveProjectFilePath(
      getPath(),
      PROJECT,
      currentUserStorage()!.segment,
      REFERENCE_PATH,
    );
    const targetDirectory = path.dirname(target);
    const originalDirectory = `${targetDirectory}.inventory-${crypto.randomUUID()}`;
    const outsideDirectory = path.join(process.cwd(), `outside-inventory-${crypto.randomUUID()}`);
    const outsideFile = path.join(outsideDirectory, path.basename(target));
    fs.mkdirSync(outsideDirectory, { recursive: true });
    // 中文注释：同卷硬链接保持 dev/ino 完全一致，单靠 fstat 对比无法证明仍在项目 filesRoot 内。
    fs.linkSync(target, outsideFile);
    const originalOpenSync = fs.openSync;
    const originalReadSync = fs.readSync;
    let outsideFd = -1;
    let outsideReads = 0;
    let swapped = false;
    (fs as unknown as { openSync: typeof fs.openSync }).openSync = ((...args: Parameters<typeof fs.openSync>) => {
      if (!swapped && path.resolve(String(args[0])) === path.resolve(target)) {
        fs.renameSync(targetDirectory, originalDirectory);
        fs.symlinkSync(outsideDirectory, targetDirectory, "junction");
        swapped = true;
      }
      const fd = originalOpenSync(...args);
      if (path.resolve(String(args[0])) === path.resolve(target)) outsideFd = fd;
      return fd;
    }) as typeof fs.openSync;
    (fs as unknown as { readSync: typeof fs.readSync }).readSync = ((...args: Parameters<typeof fs.readSync>) => {
      if (args[0] === outsideFd) outsideReads += 1;
      return originalReadSync(...args);
    }) as typeof fs.readSync;
    try {
      assert.throws(() => buildProjectFileInventory(projectRoot));
      assert.equal(outsideReads, 0, "边界复核必须发生在任何项目外 fd 内容读取之前");
    } finally {
      (fs as unknown as { openSync: typeof fs.openSync }).openSync = originalOpenSync;
      (fs as unknown as { readSync: typeof fs.readSync }).readSync = originalReadSync;
      if (swapped && fs.existsSync(targetDirectory) && fs.lstatSync(targetDirectory).isSymbolicLink()) {
        fs.unlinkSync(targetDirectory);
      }
      if (fs.existsSync(originalDirectory) && !fs.existsSync(targetDirectory)) {
        fs.renameSync(originalDirectory, targetDirectory);
      }
    }
  });
});

test("storyboard 引用复核必须复用带项目根边界的安全 fd 合同", async () => {
  await withRuntime("r25f2-storyboard-root-boundary", async () => {
    const bytes = tinyPng();
    const target = resolveProjectFilePath(
      getPath(),
      PROJECT,
      currentUserStorage()!.segment,
      REFERENCE_PATH,
    );
    const attack = installParentJunctionSwap(target);
    try {
      assert.throws(() => resolveDreaminaReferenceForExecution(PROJECT, {
        relativePath: REFERENCE_PATH,
        mediaType: "image",
        md5: crypto.createHash("md5").update(bytes).digest("hex"),
        size: bytes.length,
      }));
      assert.equal(attack.outsideOpenAttempts(), 0, "storyboard 引用不得回退到普通路径 open");
    } finally {
      attack.restore();
    }
  });
});

test("scheduler 执行复核在父目录替换为 junction 时必须零 CLI 失败收口", async () => {
  await withRuntime("r25f2-scheduler-file-identity", async () => {
    const created = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId: "32323232-3232-4232-a232-323232323232",
      paidBatchConfirmed: false,
      items: [workbenchItem()],
    });
    const taskUuid = String(created[0]?.taskId ?? "");
    const target = resolveProjectFilePath(
      getPath(),
      PROJECT,
      currentUserStorage()!.segment,
      REFERENCE_PATH,
    );
    const fakeLog = path.join(process.cwd(), "r25f2-file-identity-cli.jsonl");
    process.env.DREAMINA_FAKE_LOG = fakeLog;
    await writeDreaminaCliSettings({
      enabled: true,
      executablePath: FAKE_CLI,
      pauseNewClaims: false,
      maxConcurrency: 1,
    });
    const attack = installParentJunctionSwap(target);
    try {
      await tickDreaminaScheduler();
      const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
      const calls = fs.existsSync(fakeLog)
        ? fs.readFileSync(fakeLog, "utf8").trim().split(/\r?\n/).filter(Boolean)
        : [];
      assert.equal(attack.outsideOpenAttempts(), 0, "执行复核不得尝试打开 junction 外的目标");
      assert.deepEqual({
        queueState: dispatch?.queueState,
        providerState: dispatch?.providerState,
        slotHeld: Number(dispatch?.slotHeld ?? -1),
        cliCalls: calls.length,
      }, {
        queueState: "terminal",
        providerState: "failed",
        slotHeld: 0,
        cliCalls: 0,
      });
    } finally {
      attack.restore();
    }
  });
});

test("scheduler 快照目标目录在 open 前换 junction 时不得向项目外写入素材字节", async () => {
  await withRuntime("r25f2-snapshot-target-identity", async () => {
    const created = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId: "34343434-3434-4434-a434-343434343434",
      paidBatchConfirmed: false,
      items: [workbenchItem()],
    });
    const taskUuid = String(created[0]?.taskId ?? "");
    const referencesRoot = path.join(
      getPath(),
      "runtime-users",
      currentUserStorage()!.segment,
      "staging",
      taskUuid,
      "references",
    );
    const outsideDirectory = path.join(process.cwd(), `outside-snapshot-${crypto.randomUUID()}`);
    fs.mkdirSync(outsideDirectory, { recursive: true });
    const fakeLog = path.join(process.cwd(), "r25f2-snapshot-target-cli.jsonl");
    process.env.DREAMINA_FAKE_LOG = fakeLog;
    await writeDreaminaCliSettings({
      enabled: true,
      executablePath: FAKE_CLI,
      pauseNewClaims: false,
      maxConcurrency: 1,
    });
    const originalOpenSync = fs.openSync;
    let snapshotDirectory = "";
    let originalSnapshotDirectory = "";
    let swapped = false;
    (fs as unknown as { openSync: typeof fs.openSync }).openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const candidate = path.resolve(String(args[0]));
      if (!swapped
        && candidate.startsWith(`${path.resolve(referencesRoot)}${path.sep}`)
        && path.basename(candidate) === "000.png") {
        snapshotDirectory = path.dirname(candidate);
        originalSnapshotDirectory = `${snapshotDirectory}.original-${crypto.randomUUID()}`;
        fs.renameSync(snapshotDirectory, originalSnapshotDirectory);
        fs.symlinkSync(outsideDirectory, snapshotDirectory, "junction");
        swapped = true;
      }
      return originalOpenSync(...args);
    }) as typeof fs.openSync;
    try {
      await tickDreaminaScheduler();
      const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
      const persisted = String(dispatch?.providerResultJson ?? "");
      assert.equal(swapped, true, "夹具必须命中目标目录检查后、目标 open 前窗口");
      const outsideSnapshot = path.join(outsideDirectory, "000.png");
      assert.deepEqual(
        fs.readdirSync(outsideDirectory),
        fs.existsSync(outsideSnapshot) ? ["000.png"] : [],
        "零字节占位只能使用本任务独占快照名，替换目录不得出现其他文件",
      );
      assert.equal(
        fs.existsSync(outsideSnapshot) ? fs.statSync(outsideSnapshot).size : 0,
        0,
        "无法原子删除时可保留零字节占位，但项目外不得写入任何素材字节",
      );
      assert.equal(persisted.includes(path.resolve(referencesRoot)), false);
      assert.equal(persisted.includes(path.resolve(outsideDirectory)), false);
      assert.equal(/SELECT |SQLITE|cookie|sk-|at\s+\S+\.(ts|js)/i.test(persisted), false);
      assert.deepEqual({
        queueState: dispatch?.queueState,
        providerState: dispatch?.providerState,
        slotHeld: Number(dispatch?.slotHeld ?? -1),
      }, { queueState: "terminal", providerState: "failed", slotHeld: 0 });
    } finally {
      (fs as unknown as { openSync: typeof fs.openSync }).openSync = originalOpenSync;
      if (swapped && fs.existsSync(snapshotDirectory) && fs.lstatSync(snapshotDirectory).isSymbolicLink()) {
        fs.unlinkSync(snapshotDirectory);
      }
      if (originalSnapshotDirectory
        && fs.existsSync(originalSnapshotDirectory)
        && !fs.existsSync(snapshotDirectory)) {
        fs.renameSync(originalSnapshotDirectory, snapshotDirectory);
      }
    }
  });
});

test("结果安装缺少绑定时失败关闭，修复后随机目标不覆盖既有文件且可幂等重试", async () => {
  await withRuntime("r25f2-installer-retry", async () => {
    const created = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId: "33333333-3333-4333-a333-333333333333",
      paidBatchConfirmed: false,
      items: [workbenchItem({ mode: "text", uploadData: [] })],
    });
    const taskUuid = String(created[0]?.taskId ?? "");
    const task = await activeDb("o_storyboardGenerationTask").where({ taskUuid }).first();
    const binding = await activeDb("o_video").where({ generationTaskUuid: taskUuid }).first();
    assert.ok(binding, "夹具必须先建立工作台历史绑定");

    const stagingDirectory = path.join(process.cwd(), "staging", taskUuid);
    const source = path.join(stagingDirectory, "result.mp4");
    fs.mkdirSync(stagingDirectory, { recursive: true });
    fs.writeFileSync(source, buildMinimalAdoptableMp4(Buffer.from("R25-FIX2")));
    const projectRoot = projectDirectory(getPath(), PROJECT, currentUserStorage()!.segment);
    const incomingDirectory = path.join(projectRoot, ".incoming", taskUuid);
    const destination = path.join(projectRoot, "files", "videos", "workbench", `${taskUuid}.mp4`);

    // 中文注释：仅在夹具内撤下 Task1 的数据库保护，模拟旧版本留下的缺绑定损坏态。
    await activeDb.raw("DROP TRIGGER IF EXISTS trg_o_video_workbench_ready_delete_guard");
    await activeDb.raw("DROP TRIGGER IF EXISTS trg_o_video_workbench_ready_identity_guard");
    await activeDb("o_video").where({ generationTaskUuid: taskUuid }).delete();
    await assert.rejects(
      () => installDreaminaResult({
        projectUuid: PROJECT,
        taskUuid,
        shotUuid: String(task?.shotUuid ?? ""),
        mediaType: "video",
        stagingDirectory,
        files: [source],
      }),
      (error: unknown) => (error as { code?: unknown })?.code === "WORKBENCH_VIDEO_HISTORY_MISSING",
    );
    assert.equal(fs.existsSync(incomingDirectory), false, "缺绑定不得留下 incoming");

    await activeDb("o_video").insert(binding);
    const existingVictim = Buffer.from("EXISTING-DESTINATION-MUST-STAY");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, existingVictim);
    const retried = await installDreaminaResult({
      projectUuid: PROJECT,
      taskUuid,
      shotUuid: String(task?.shotUuid ?? ""),
      mediaType: "video",
      stagingDirectory,
      files: [source],
    });
    assert.match(String(retried?.relativePath), new RegExp(`^files/videos/workbench/${taskUuid}\\.[0-9a-f-]{36}\\.mp4$`));
    assert.equal(fs.readFileSync(destination).equals(existingVictim), true, "随机 O_EXCL 尝试不得覆盖既有未知文件");
    const installed = path.join(projectRoot, ...String(retried?.relativePath ?? "").split("/"));
    assert.equal(fs.existsSync(installed), true, "修复绑定后同一任务必须可重试成功");
    const replayed = await installDreaminaResult({
      projectUuid: PROJECT,
      taskUuid,
      shotUuid: String(task?.shotUuid ?? ""),
      mediaType: "video",
      stagingDirectory,
      files: [source],
    });
    assert.equal(replayed?.relativePath, retried?.relativePath, "合法完整绑定应幂等返回而不再安装");
    assert.equal(fs.existsSync(incomingDirectory), false);
  });
});

test("结果安装必须核对唯一精确绑定，写入后改绑失败须保留完整目标并可修复重试", async () => {
  await withRuntime("r25f2-installer-exact-binding", async () => {
    const created = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId: "35353535-3535-4535-a535-353535353535",
      paidBatchConfirmed: false,
      items: [workbenchItem({ mode: "text", uploadData: [] })],
    });
    const taskUuid = String(created[0]?.taskId ?? "");
    const task = await activeDb("o_storyboardGenerationTask").where({ taskUuid }).first();
    const binding = await activeDb("o_video").where({ generationTaskUuid: taskUuid }).first();
    assert.ok(binding);
    const projectRoot = projectDirectory(getPath(), PROJECT, currentUserStorage()!.segment);
    const stagingDirectory = path.join(process.cwd(), "staging", taskUuid);
    const source = path.join(stagingDirectory, "result.mp4");
    const incomingDirectory = path.join(projectRoot, ".incoming", taskUuid);
    const destinationDirectory = path.join(projectRoot, "files", "videos", "workbench");
    fs.mkdirSync(stagingDirectory, { recursive: true });
    fs.writeFileSync(source, buildMinimalAdoptableMp4(Buffer.from("EXACT-BINDING")));
    await activeDb.raw("DROP TRIGGER IF EXISTS trg_o_video_workbench_ready_delete_guard");
    await activeDb.raw("DROP TRIGGER IF EXISTS trg_o_video_workbench_ready_identity_guard");

    await activeDb("o_video").where({ id: binding.id }).update({ videoTrackId: TRACK_ID + 1 });
    await assert.rejects(
      () => installDreaminaResult({
        projectUuid: PROJECT,
        taskUuid,
        shotUuid: String(task?.shotUuid ?? ""),
        mediaType: "video",
        stagingDirectory,
        files: [source],
      }),
      (error: unknown) => (error as { code?: unknown })?.code === "WORKBENCH_VIDEO_HISTORY_MISSING",
    );
    assert.deepEqual(fs.existsSync(destinationDirectory) ? fs.readdirSync(destinationDirectory) : [], [], "错绑必须在安装前失败");
    assert.equal(fs.existsSync(incomingDirectory), false);

    await activeDb("o_video").where({ id: binding.id }).update({ videoTrackId: TRACK_ID });
    await activeDb.raw("DROP INDEX IF EXISTS idx_o_video_generation_task_uuid_unique");
    const { id: _bindingId, ...duplicateBinding } = binding;
    const [duplicateId] = await activeDb("o_video").insert({
      ...duplicateBinding,
      time: Number(binding.time ?? Date.now()) + 1,
    });
    await assert.rejects(
      () => installDreaminaResult({
        projectUuid: PROJECT,
        taskUuid,
        shotUuid: String(task?.shotUuid ?? ""),
        mediaType: "video",
        stagingDirectory,
        files: [source],
      }),
      (error: unknown) => (error as { code?: unknown })?.code === "WORKBENCH_VIDEO_HISTORY_MISSING",
    );
    assert.deepEqual(fs.existsSync(destinationDirectory) ? fs.readdirSync(destinationDirectory) : [], [], "重复绑定不得由 first() 静默选一行");
    await activeDb("o_video").where({ id: duplicateId }).delete();

    setAfterDreaminaResultValidatedForTests(() => {
      const Database = require("better-sqlite3") as new (filename: string) => {
        prepare: (sql: string) => { run: (...params: unknown[]) => unknown };
        close: () => void;
      };
      const direct = new Database(path.join(projectRoot, "project.sqlite"));
      try {
        direct.prepare("UPDATE o_video SET videoTrackId = ? WHERE generationTaskUuid = ?")
          .run(TRACK_ID + 1, taskUuid);
      } finally {
        direct.close();
      }
    });
    await assert.rejects(
      () => installDreaminaResult({
        projectUuid: PROJECT,
        taskUuid,
        shotUuid: String(task?.shotUuid ?? ""),
        mediaType: "video",
        stagingDirectory,
        files: [source],
      }),
      (error: unknown) => (error as { code?: unknown })?.code === "WORKBENCH_VIDEO_HISTORY_MISSING",
    );
    setAfterDreaminaResultValidatedForTests(null);
    const failedAttemptFiles = fs.readdirSync(destinationDirectory).filter((name) => name.startsWith(`${taskUuid}.`));
    assert.equal(failedAttemptFiles.length, 1, "无法原子按身份撤销时必须保留已完整写入的随机尝试文件");
    const failedAttempt = path.join(destinationDirectory, failedAttemptFiles[0]!);
    assert.equal(fs.readFileSync(failedAttempt).equals(fs.readFileSync(source)), true);
    assert.equal(fs.existsSync(incomingDirectory), false);

    await activeDb("o_video").where({ id: binding.id }).update({ videoTrackId: TRACK_ID });
    const retried = await installDreaminaResult({
      projectUuid: PROJECT,
      taskUuid,
      shotUuid: String(task?.shotUuid ?? ""),
      mediaType: "video",
      stagingDirectory,
      files: [source],
    });
    assert.match(String(retried?.relativePath), new RegExp(`^files/videos/workbench/${taskUuid}\\.[0-9a-f-]{36}\\.mp4$`));
    const recoveredAbsolute = path.join(projectRoot, ...String(retried?.relativePath ?? "").split("/"));
    assert.notEqual(path.resolve(recoveredAbsolute), path.resolve(failedAttempt), "修复后必须用新的随机尝试收敛");
    assert.equal(fs.existsSync(recoveredAbsolute), true, "修复精确绑定后原任务必须收敛成功");
    const recoveredBinding = await activeDb("o_video").where({ generationTaskUuid: taskUuid }).first();
    assert.deepEqual({
      generationTaskUuid: recoveredBinding?.generationTaskUuid,
      projectId: Number(recoveredBinding?.projectId),
      scriptId: Number(recoveredBinding?.scriptId),
      trackId: Number(recoveredBinding?.videoTrackId),
      filePath: recoveredBinding?.filePath,
    }, {
      generationTaskUuid: taskUuid,
      projectId: PROJECT_ID,
      scriptId: SCRIPT_ID,
      trackId: TRACK_ID,
      filePath: retried?.relativePath,
    }, "随机完整尝试仍必须收敛到当前项目的精确工作台绑定");
  });
});

test("项目清单安全打开后路径再替换必须在首字节前失败", async () => {
  await withRuntime("r25f2-r3-inventory-before-first-read", async () => {
    const target = resolveProjectFilePath(getPath(), PROJECT, currentUserStorage()!.segment, REFERENCE_PATH);
    const filesRoot = path.join(projectDirectory(getPath(), PROJECT, currentUserStorage()!.segment), "files");
    const originalFile = `${target}.r3-${crypto.randomUUID()}`;
    const outsideDirectory = path.join(process.cwd(), `outside-r3-inventory-${crypto.randomUUID()}`);
    fs.mkdirSync(outsideDirectory, { recursive: true });
    const outsideFile = path.join(outsideDirectory, path.basename(target));
    fs.writeFileSync(outsideFile, tinyPng(0x7d));
    const originalNative = fs.realpathSync.native;
    const originalReadSync = fs.readSync;
    let swapped = false;
    let reads = 0;
    (fs.realpathSync as typeof fs.realpathSync & { native: typeof fs.realpathSync.native }).native = ((value: fs.PathLike) => {
      const resolved = originalNative(value);
      if (!swapped && path.resolve(String(value)) === path.resolve(target)) {
        // 中文注释：边界检查刚返回后替换当前路径；已打开 fd 仍指向原文件，首读前必须发现 dev/ino 不一致。
        fs.renameSync(target, originalFile);
        fs.linkSync(outsideFile, target);
        swapped = true;
      }
      return resolved;
    }) as typeof fs.realpathSync.native;
    (fs as unknown as { readSync: typeof fs.readSync }).readSync = ((...args: Parameters<typeof fs.readSync>) => {
      reads += 1;
      return originalReadSync(...args);
    }) as typeof fs.readSync;
    syncBuiltinESMExports();
    try {
      let failure: unknown;
      try { hashFileStreaming(target, { filesRoot }); } catch (error) { failure = error; }
      assert.ok(failure);
      assert.equal(reads, 0, "安全 fd 打开后的路径替换必须在读取首字节前被发现");
    } finally {
      (fs.realpathSync as typeof fs.realpathSync & { native: typeof fs.realpathSync.native }).native = originalNative;
      (fs as unknown as { readSync: typeof fs.readSync }).readSync = originalReadSync;
      syncBuiltinESMExports();
      if (swapped) {
        fs.rmSync(target, { force: true });
        fs.renameSync(originalFile, target);
      }
    }
  });
});

test("内联模型媒体必须用同一安全 fd 完成摘要与内容读取", async () => {
  await withRuntime("r25f2-r3-inline-same-fd", async () => {
    const originalBytes = tinyPng(0x21);
    writeProjectFileAtomic(getPath(), PROJECT, currentUserStorage()!.segment, REFERENCE_PATH, originalBytes);
    const target = resolveProjectFilePath(getPath(), PROJECT, currentUserStorage()!.segment, REFERENCE_PATH);
    const backup = `${target}.verified-${crypto.randomUUID()}`;
    const replacement = tinyPng(0x7e);
    const originalStatSync = fs.statSync;
    const originalReadFileSync = fs.readFileSync;
    let swapped = false;
    let pathReads = 0;
    (fs as unknown as { statSync: typeof fs.statSync }).statSync = ((...args: Parameters<typeof fs.statSync>) => {
      const options = args[1] as { bigint?: boolean } | undefined;
      if (!swapped && path.resolve(String(args[0])) === path.resolve(target) && options?.bigint !== true) {
        fs.renameSync(target, backup);
        fs.writeFileSync(target, replacement);
        swapped = true;
      }
      return originalStatSync(...args);
    }) as typeof fs.statSync;
    (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      if (path.resolve(String(args[0])) === path.resolve(target)) pathReads += 1;
      return originalReadFileSync(...args);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      const prepared = await prepareModelMediaReferences([{
        type: "image" as const,
        media: {
          projectUuid: PROJECT,
          relativePath: REFERENCE_PATH,
          md5: crypto.createHash("md5").update(originalBytes).digest("hex"),
          size: originalBytes.length,
        },
      }], { supportsUrl: false, supportsInline: true });
      assert.equal(pathReads, 0, "安全摘要后不得再按路径读取媒体内容");
      assert.equal(Buffer.from(prepared[0]!.base64.split(",")[1]!, "base64").equals(originalBytes), true);
    } finally {
      (fs as unknown as { statSync: typeof fs.statSync }).statSync = originalStatSync;
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = originalReadFileSync;
      syncBuiltinESMExports();
      if (swapped) {
        fs.rmSync(target, { force: true });
        fs.renameSync(backup, target);
      }
    }
  });
});

test("项目文件复制失败时不得在身份检查后再按可变路径删除", () => {
  const dataRoot = fs.mkdtempSync(path.resolve(__dirname, "../../../.tmp", "r25f2-r3-copy-cleanup-"));
  const segment = "d".repeat(32);
  const relativePath = "files/images/workbench/source.png";
  writeProjectFileAtomic(dataRoot, PROJECT, segment, relativePath, tinyPng(0x33));
  const opened = openProjectFileHandle(dataRoot, PROJECT, segment, relativePath);
  const outputDirectory = path.join(dataRoot, "snapshot-output");
  const destination = path.join(outputDirectory, "target.png");
  const createdBackup = path.join(outputDirectory, "created-by-copy.png");
  const victim = Buffer.from("UNKNOWN-VICTIM");
  fs.mkdirSync(outputDirectory, { recursive: true });
  const preexisting = path.join(outputDirectory, "preexisting.png");
  const preexistingBytes = Buffer.from("PREEXISTING-MUST-STAY");
  fs.writeFileSync(preexisting, preexistingBytes);
  assert.throws(() => copyOpenProjectFileHandleToExclusivePath(opened, preexisting));
  assert.equal(fs.readFileSync(preexisting).equals(preexistingBytes), true, "O_EXCL 不得覆盖已有目标文件");
  const originalOpenSync = fs.openSync;
  const originalWriteSync = fs.writeSync;
  const originalCloseSync = fs.closeSync;
  const originalRmSync = fs.rmSync;
  let destinationFd = -1;
  let replaced = false;
  (fs as unknown as { openSync: typeof fs.openSync }).openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const fd = originalOpenSync(...args);
    if (path.resolve(String(args[0])) === path.resolve(destination)) destinationFd = fd;
    return fd;
  }) as typeof fs.openSync;
  (fs as unknown as { writeSync: typeof fs.writeSync }).writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
    if (!replaced && args[0] === destinationFd) {
      throw Object.assign(new Error("模拟写入失败，路径不得外泄"), { code: "EIO" });
    }
    return originalWriteSync(...args);
  }) as typeof fs.writeSync;
  (fs as unknown as { rmSync: typeof fs.rmSync }).rmSync = ((...args: Parameters<typeof fs.rmSync>) => {
    if (!replaced && path.resolve(String(args[0])) === path.resolve(destination)) {
      // 中文注释：身份检查已经返回、rmSync 真正按路径执行前替换对象，确定性复现 check/use 窗口。
      fs.renameSync(destination, createdBackup);
      const victimFd = originalOpenSync(destination, "wx", 0o600);
      try { originalWriteSync(victimFd, victim, 0, victim.length, 0); } finally { originalCloseSync(victimFd); }
      replaced = true;
    }
    return originalRmSync(...args);
  }) as typeof fs.rmSync;
  try {
    assert.throws(() => copyOpenProjectFileHandleToExclusivePath(opened, destination));
    assert.equal(fs.existsSync(destination), true, "失败时必须保留本次目标或替换进来的未知文件");
    if (replaced) assert.equal(fs.readFileSync(destination).equals(victim), true);
  } finally {
    (fs as unknown as { openSync: typeof fs.openSync }).openSync = originalOpenSync;
    (fs as unknown as { writeSync: typeof fs.writeSync }).writeSync = originalWriteSync;
    (fs as unknown as { rmSync: typeof fs.rmSync }).rmSync = originalRmSync;
    closeProjectFileHandle(opened.fd);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("结果安装回滚不得在身份检查后再按可变路径删除", async () => {
  await withRuntime("r25f2-r3-installer-cleanup-identity", async () => {
    const created = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId: "36363636-3636-4636-a636-363636363636",
      paidBatchConfirmed: false,
      items: [workbenchItem({ mode: "text", uploadData: [] })],
    });
    const taskUuid = String(created[0]?.taskId ?? "");
    const task = await activeDb("o_storyboardGenerationTask").where({ taskUuid }).first();
    const binding = await activeDb("o_video").where({ generationTaskUuid: taskUuid }).first();
    const projectRoot = projectDirectory(getPath(), PROJECT, currentUserStorage()!.segment);
    const stagingDirectory = path.join(process.cwd(), "staging", taskUuid);
    const source = path.join(stagingDirectory, "result.mp4");
    const destination = path.join(projectRoot, "files", "videos", "workbench", `${taskUuid}.mp4`);
    const victim = Buffer.from("UNKNOWN-INSTALLER-VICTIM");
    fs.mkdirSync(stagingDirectory, { recursive: true });
    fs.writeFileSync(source, buildMinimalAdoptableMp4(Buffer.from("R3-INSTALLER")));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, victim);
    await activeDb.raw("DROP TRIGGER IF EXISTS trg_o_video_workbench_ready_identity_guard");
    const originalRmSync = fs.rmSync;
    let installPathRmAttempts = 0;
    (fs as unknown as { rmSync: typeof fs.rmSync }).rmSync = ((...args: Parameters<typeof fs.rmSync>) => {
      const candidate = path.resolve(String(args[0]));
      if (path.dirname(candidate) === path.resolve(path.dirname(destination))
        && path.basename(candidate).startsWith(taskUuid)) {
        installPathRmAttempts += 1;
      }
      return originalRmSync(...args);
    }) as typeof fs.rmSync;
    setAfterDreaminaResultValidatedForTests(() => {
      const Database = require("better-sqlite3") as new (filename: string) => {
        prepare: (sql: string) => { run: (...params: unknown[]) => unknown };
        close: () => void;
      };
      const direct = new Database(path.join(projectRoot, "project.sqlite"));
      try {
        direct.prepare("UPDATE o_video SET videoTrackId = ? WHERE generationTaskUuid = ?")
          .run(TRACK_ID + 1, taskUuid);
      } finally {
        direct.close();
      }
    });
    try {
      await assert.rejects(() => installDreaminaResult({
        projectUuid: PROJECT,
        taskUuid,
        shotUuid: String(task?.shotUuid ?? ""),
        mediaType: "video",
        stagingDirectory,
        files: [source],
      }), (error: unknown) => {
        const code = (error as { code?: unknown })?.code;
        return code === "WORKBENCH_VIDEO_HISTORY_MISSING" || code === "DREAMINA_RESULT_INSTALL_FAILED";
      });
      assert.equal(fs.readFileSync(destination).equals(victim), true, "失败处理不得覆盖或删除既有未知文件");
      assert.equal(installPathRmAttempts, 0, "失败后禁止按任何可变安装路径回滚");
      const retainedAttempts = fs.readdirSync(path.dirname(destination))
        .filter((name) => name.startsWith(`${taskUuid}.`) && name !== path.basename(destination));
      assert.equal(retainedAttempts.length, 1, "数据库改绑失败后应保留本次完整随机尝试文件");
      assert.equal(
        fs.readFileSync(path.join(path.dirname(destination), retainedAttempts[0]!)).equals(fs.readFileSync(source)),
        true,
      );
    } finally {
      (fs as unknown as { rmSync: typeof fs.rmSync }).rmSync = originalRmSync;
      setAfterDreaminaResultValidatedForTests(null);
      if (binding) {
        await activeDb("o_video").where({ id: binding.id }).update({ videoTrackId: TRACK_ID });
      }
    }
  });
});

test("结果安装目标父目录在绑定后变化时不得把结果移动到替换目录", async () => {
  await withRuntime("r25f2-r4-installer-parent-binding", async () => {
    const created = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId: "37373737-3737-4737-a737-373737373737",
      paidBatchConfirmed: false,
      items: [workbenchItem({ mode: "text", uploadData: [] })],
    });
    const taskUuid = String(created[0]?.taskId ?? "");
    const task = await activeDb("o_storyboardGenerationTask").where({ taskUuid }).first();
    const projectRoot = projectDirectory(getPath(), PROJECT, currentUserStorage()!.segment);
    const stagingDirectory = path.join(process.cwd(), "staging", taskUuid);
    const source = path.join(stagingDirectory, "result.mp4");
    const destinationDirectory = path.join(projectRoot, "files", "videos", "workbench");
    const destination = path.join(destinationDirectory, `${taskUuid}.mp4`);
    const originalDestinationDirectory = `${destinationDirectory}.bound-${crypto.randomUUID()}`;
    fs.mkdirSync(stagingDirectory, { recursive: true });
    fs.writeFileSync(source, buildMinimalAdoptableMp4(Buffer.from("R4-PARENT-BINDING")));

    const originalNative = fs.realpathSync.native;
    let swapped = false;
    (fs.realpathSync as typeof fs.realpathSync & { native: typeof fs.realpathSync.native }).native = ((value: fs.PathLike) => {
      const resolved = originalNative(value);
      if (!swapped && path.resolve(String(value)) === path.resolve(destinationDirectory)) {
        // 中文注释：父目录身份与 realpath 都已捕获后、最终路径操作前替换目录。
        fs.renameSync(destinationDirectory, originalDestinationDirectory);
        fs.mkdirSync(destinationDirectory, { recursive: true });
        swapped = true;
      }
      return resolved;
    }) as typeof fs.realpathSync.native;
    syncBuiltinESMExports();
    try {
      await assert.rejects(() => installDreaminaResult({
        projectUuid: PROJECT,
        taskUuid,
        shotUuid: String(task?.shotUuid ?? ""),
        mediaType: "video",
        stagingDirectory,
        files: [source],
      }), (error: unknown) => {
        const candidate = error as { code?: unknown; status?: unknown; message?: unknown };
        return candidate.code === "DREAMINA_RESULT_INSTALL_FAILED"
          && candidate.status === 500
          && candidate.message === "生成结果安装失败，请重试";
      });
      assert.equal(swapped, true, "夹具必须命中父目录捕获后、最终路径操作前窗口");
      assert.equal(fs.existsSync(source), true, "失败关闭必须保留 staging 中的本任务结果");
      const replacementFiles = fs.readdirSync(destinationDirectory);
      assert.equal(replacementFiles.length <= 1, true, "替换目录最多只能出现本次随机独占目标名");
      if (replacementFiles.length === 1) {
        assert.match(replacementFiles[0]!, new RegExp(`^${taskUuid}\\.[0-9a-f-]{36}\\.mp4$`));
        assert.equal(fs.statSync(path.join(destinationDirectory, replacementFiles[0]!)).size, 0,
          "父目录身份失配必须在写入首字节前失败");
      }
    } finally {
      (fs.realpathSync as typeof fs.realpathSync & { native: typeof fs.realpathSync.native }).native = originalNative;
      syncBuiltinESMExports();
      if (swapped) {
        fs.rmSync(destinationDirectory, { recursive: true, force: true });
        if (fs.existsSync(originalDestinationDirectory)) {
          fs.renameSync(originalDestinationDirectory, destinationDirectory);
        }
      }
    }
  });
});

test("scheduler 快照物化失败后只能保留未知替换文件并记录待清理状态", async () => {
  await withRuntime("r25f2-r5-snapshot-failed-cleanup", async () => {
    const created = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId: "38383838-3838-4838-a838-383838383838",
      paidBatchConfirmed: false,
      items: [workbenchItem()],
    });
    const taskUuid = String(created[0]?.taskId ?? "");
    const referencesRoot = path.join(
      getPath(),
      "runtime-users",
      currentUserStorage()!.segment,
      "staging",
      taskUuid,
      "references",
    );
    const fakeLog = path.join(process.cwd(), "r25f2-r5-snapshot-cleanup-cli.jsonl");
    process.env.DREAMINA_FAKE_LOG = fakeLog;
    await writeDreaminaCliSettings({
      enabled: true,
      executablePath: FAKE_CLI,
      pauseNewClaims: false,
      maxConcurrency: 1,
    });

    const originalOpenSync = fs.openSync;
    const originalWriteSync = fs.writeSync;
    const originalCloseSync = fs.closeSync;
    let snapshotFd = -1;
    let snapshotPath = "";
    let originalPartialPath = "";
    const victim = Buffer.from("UNKNOWN-SNAPSHOT-VICTIM");
    let replaced = false;
    (fs as unknown as { openSync: typeof fs.openSync }).openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpenSync(...args);
      const candidate = path.resolve(String(args[0]));
      if (snapshotFd < 0
        && candidate.startsWith(`${path.resolve(referencesRoot)}${path.sep}`)
        && path.basename(candidate) === "000.png") {
        snapshotFd = fd;
        snapshotPath = candidate;
        originalPartialPath = `${candidate}.owned-partial`;
      }
      return fd;
    }) as typeof fs.openSync;
    (fs as unknown as { writeSync: typeof fs.writeSync }).writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
      if (args[0] === snapshotFd) {
        throw Object.assign(new Error("模拟快照写入失败"), { code: "EIO" });
      }
      return originalWriteSync(...args);
    }) as typeof fs.writeSync;
    (fs as unknown as { closeSync: typeof fs.closeSync }).closeSync = ((fd: number) => {
      originalCloseSync(fd);
      if (!replaced && fd === snapshotFd && fs.existsSync(snapshotPath)) {
        // 中文注释：复制 fd 关闭后、scheduler 外层清理前换入未知文件，确定性复现路径枚举误删。
        fs.renameSync(snapshotPath, originalPartialPath);
        const victimFd = originalOpenSync(snapshotPath, "wx", 0o600);
        try { originalWriteSync(victimFd, victim, 0, victim.length, 0); } finally { originalCloseSync(victimFd); }
        replaced = true;
      }
    }) as typeof fs.closeSync;
    try {
      await tickDreaminaScheduler();
      const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
      const persisted = JSON.parse(String(dispatch?.providerResultJson ?? "{}")) as Record<string, unknown>;
      const calls = fs.existsSync(fakeLog)
        ? fs.readFileSync(fakeLog, "utf8").trim().split(/\r?\n/).filter(Boolean)
        : [];
      assert.equal(replaced, true, "夹具必须在物化失败后换入未知文件");
      assert.equal(fs.existsSync(snapshotPath), true, "异常清理不得删除替换进来的未知文件");
      assert.equal(fs.readFileSync(snapshotPath).equals(victim), true);
      assert.equal(fs.existsSync(originalPartialPath), true, "失败尝试的本次占位应留待非阻塞清理");
      assert.equal(persisted.referenceSnapshotCleanupPending, true, "必须记录稳定且不含路径的待清理状态");
      assert.equal(JSON.stringify(persisted).includes(path.resolve(referencesRoot)), false);
      assert.equal(calls.length, 0, "快照物化失败不得调用 CLI");
    } finally {
      (fs as unknown as { openSync: typeof fs.openSync }).openSync = originalOpenSync;
      (fs as unknown as { writeSync: typeof fs.writeSync }).writeSync = originalWriteSync;
      (fs as unknown as { closeSync: typeof fs.closeSync }).closeSync = originalCloseSync;
    }
  });
});

test("结果安装半写失败后必须用新的随机独占文件名重试收敛", async () => {
  await withRuntime("r25f2-r5-installer-random-retry", async () => {
    const created = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId: "39393939-3939-4939-a939-393939393939",
      paidBatchConfirmed: false,
      items: [workbenchItem({ mode: "text", uploadData: [] })],
    });
    const taskUuid = String(created[0]?.taskId ?? "");
    const task = await activeDb("o_storyboardGenerationTask").where({ taskUuid }).first();
    const projectRoot = projectDirectory(getPath(), PROJECT, currentUserStorage()!.segment);
    const destinationDirectory = path.join(projectRoot, "files", "videos", "workbench");
    const stagingDirectory = path.join(process.cwd(), "staging", taskUuid);
    const source = path.join(stagingDirectory, "result.mp4");
    fs.mkdirSync(stagingDirectory, { recursive: true });
    fs.writeFileSync(source, buildMinimalAdoptableMp4(Buffer.from("R5-RANDOM-RETRY")));

    const originalOpenSync = fs.openSync;
    const originalWriteSync = fs.writeSync;
    let destinationFd = -1;
    let failedPath = "";
    (fs as unknown as { openSync: typeof fs.openSync }).openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpenSync(...args);
      const candidate = path.resolve(String(args[0]));
      if (path.dirname(candidate) === path.resolve(destinationDirectory)
        && path.basename(candidate).startsWith(`${taskUuid}`)) {
        destinationFd = fd;
        failedPath = candidate;
      }
      return fd;
    }) as typeof fs.openSync;
    (fs as unknown as { writeSync: typeof fs.writeSync }).writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
      if (args[0] === destinationFd) {
        const [, buffer, offset, requestedLength, position] = args as unknown as [
          number,
          Uint8Array,
          number,
          number,
          number,
        ];
        const length = Math.min(8, requestedLength);
        originalWriteSync(destinationFd, buffer, offset, length, position);
        throw Object.assign(new Error("模拟结果半写失败"), { code: "EIO" });
      }
      return originalWriteSync(...args);
    }) as typeof fs.writeSync;
    try {
      await assert.rejects(() => installDreaminaResult({
        projectUuid: PROJECT,
        taskUuid,
        shotUuid: String(task?.shotUuid ?? ""),
        mediaType: "video",
        stagingDirectory,
        files: [source],
      }), (error: unknown) => (error as { code?: unknown })?.code === "DREAMINA_RESULT_INSTALL_FAILED");
    } finally {
      (fs as unknown as { openSync: typeof fs.openSync }).openSync = originalOpenSync;
      (fs as unknown as { writeSync: typeof fs.writeSync }).writeSync = originalWriteSync;
    }
    assert.equal(fs.existsSync(failedPath), true, "半写文件必须保留且不得被路径回滚误删");
    assert.equal(fs.statSync(failedPath).size, 8);

    const retried = await installDreaminaResult({
      projectUuid: PROJECT,
      taskUuid,
      shotUuid: String(task?.shotUuid ?? ""),
      mediaType: "video",
      stagingDirectory,
      files: [source],
    });
    const retriedAbsolute = path.join(projectRoot, ...String(retried?.relativePath ?? "").split("/"));
    assert.match(String(retried?.relativePath), new RegExp(`^files/videos/workbench/${taskUuid}\\.[0-9a-f-]{36}\\.mp4$`));
    assert.notEqual(path.resolve(retriedAbsolute), path.resolve(failedPath), "重试必须使用新的随机独占文件名");
    assert.equal(fs.readFileSync(retriedAbsolute).equals(fs.readFileSync(source)), true);
    const binding = await activeDb("o_video").where({ generationTaskUuid: taskUuid }).first();
    assert.equal(binding?.filePath, retried?.relativePath, "数据库只能绑定已完整校验的新文件");
  });
});

test("工作台已绑定合法完整结果时必须精确校验后幂等返回", async () => {
  await withRuntime("r25f2-r5-installer-idempotent", async () => {
    const created = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId: "40404040-4040-4040-a040-404040404040",
      paidBatchConfirmed: false,
      items: [workbenchItem({ mode: "text", uploadData: [] })],
    });
    const taskUuid = String(created[0]?.taskId ?? "");
    const task = await activeDb("o_storyboardGenerationTask").where({ taskUuid }).first();
    const projectRoot = projectDirectory(getPath(), PROJECT, currentUserStorage()!.segment);
    const destinationDirectory = path.join(projectRoot, "files", "videos", "workbench");
    const stagingDirectory = path.join(process.cwd(), "staging", taskUuid);
    const source = path.join(stagingDirectory, "result.mp4");
    fs.mkdirSync(stagingDirectory, { recursive: true });
    fs.writeFileSync(source, buildMinimalAdoptableMp4(Buffer.from("R5-IDEMPOTENT")));

    const first = await installDreaminaResult({
      projectUuid: PROJECT,
      taskUuid,
      shotUuid: String(task?.shotUuid ?? ""),
      mediaType: "video",
      stagingDirectory,
      files: [source],
    });
    const firstFiles = fs.readdirSync(destinationDirectory).sort();
    fs.rmSync(source, { force: true });

    // 中文注释：已完成捷径仍必须核对 task/project/script/track，不能仅凭 filePath 提前返回。
    await activeDb.raw("DROP TRIGGER IF EXISTS trg_o_video_workbench_ready_identity_guard");
    await activeDb("o_video").where({ generationTaskUuid: taskUuid }).update({ videoTrackId: TRACK_ID + 1 });
    await assert.rejects(() => installDreaminaResult({
      projectUuid: PROJECT,
      taskUuid,
      shotUuid: String(task?.shotUuid ?? ""),
      mediaType: "video",
      stagingDirectory,
      files: [source],
    }), (error: unknown) => (error as { code?: unknown })?.code === "WORKBENCH_VIDEO_HISTORY_MISSING");
    await activeDb("o_video").where({ generationTaskUuid: taskUuid }).update({ videoTrackId: TRACK_ID });

    const replayed = await installDreaminaResult({
      projectUuid: PROJECT,
      taskUuid,
      shotUuid: String(task?.shotUuid ?? ""),
      mediaType: "video",
      stagingDirectory,
      files: [source],
    });
    assert.equal(replayed?.relativePath, first?.relativePath, "完整精确绑定必须直接幂等返回原路径");
    assert.deepEqual(fs.readdirSync(destinationDirectory).sort(), firstFiles, "幂等重放不得创建第二个安装文件");
  });
});

test("旧安装流发现较新的合法完整绑定时必须采用而不得覆盖", async () => {
  await withRuntime("r25f2-r5-installer-concurrent-binding", async () => {
    const created = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId: "42424242-4242-4242-a242-424242424242",
      paidBatchConfirmed: false,
      items: [workbenchItem({ mode: "text", uploadData: [] })],
    });
    const taskUuid = String(created[0]?.taskId ?? "");
    const task = await activeDb("o_storyboardGenerationTask").where({ taskUuid }).first();
    const projectRoot = projectDirectory(getPath(), PROJECT, currentUserStorage()!.segment);
    const destinationDirectory = path.join(projectRoot, "files", "videos", "workbench");
    const newerFileName = `${taskUuid}.${crypto.randomUUID()}.mp4`;
    const newerRelativePath = `files/videos/workbench/${newerFileName}`;
    const newerAbsolutePath = path.join(destinationDirectory, newerFileName);
    const newerBytes = buildMinimalAdoptableMp4(Buffer.from("R5-NEWER-BINDING"));
    const stagingDirectory = path.join(process.cwd(), "staging", taskUuid);
    const source = path.join(stagingDirectory, "result.mp4");
    fs.mkdirSync(stagingDirectory, { recursive: true });
    fs.mkdirSync(destinationDirectory, { recursive: true });
    fs.writeFileSync(source, buildMinimalAdoptableMp4(Buffer.from("R5-OLDER-FLOW")));
    fs.writeFileSync(newerAbsolutePath, newerBytes);

    setAfterDreaminaResultValidatedForTests(() => {
      const Database = require("better-sqlite3") as new (filename: string, options?: { timeout?: number }) => {
        prepare: (sql: string) => { run: (...params: unknown[]) => unknown };
        close: () => void;
      };
      const sqlitePath = path.join(projectRoot, "project.sqlite");
      let lastError: unknown;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const direct = new Database(sqlitePath, { timeout: 5000 });
          try {
            direct.prepare("UPDATE o_video SET state = ?, filePath = ? WHERE generationTaskUuid = ?")
              .run("生成成功", newerRelativePath, taskUuid);
          } finally {
            direct.close();
          }
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
      }
      if (lastError) throw lastError;
    });
    const installed = await installDreaminaResult({
      projectUuid: PROJECT,
      taskUuid,
      shotUuid: String(task?.shotUuid ?? ""),
      mediaType: "video",
      stagingDirectory,
      files: [source],
    });
    setAfterDreaminaResultValidatedForTests(null);
    assert.equal(installed?.relativePath, newerRelativePath, "旧流必须采用已经耐久的较新完整绑定");
    const binding = await activeDb("o_video").where({ generationTaskUuid: taskUuid }).first();
    assert.equal(binding?.filePath, newerRelativePath, "旧流不得用自己的随机尝试覆盖较新绑定");
    assert.equal(fs.readFileSync(newerAbsolutePath).equals(newerBytes), true);
  });
});

test("工作台绑定 CAS 输给并发完整结果后必须重新读取并幂等采用", async () => {
  await withRuntime("r25f2-r5-installer-cas-lost", async () => {
    const created = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId: "43434343-4343-4343-a343-434343434343",
      paidBatchConfirmed: false,
      items: [workbenchItem({ mode: "text", uploadData: [] })],
    });
    const taskUuid = String(created[0]?.taskId ?? "");
    const task = await activeDb("o_storyboardGenerationTask").where({ taskUuid }).first();
    const projectRoot = projectDirectory(getPath(), PROJECT, currentUserStorage()!.segment);
    const destinationDirectory = path.join(projectRoot, "files", "videos", "workbench");
    const winnerFileName = `${taskUuid}.${crypto.randomUUID()}.mp4`;
    const winnerRelativePath = `files/videos/workbench/${winnerFileName}`;
    const winnerAbsolutePath = path.join(destinationDirectory, winnerFileName);
    const winnerBytes = buildMinimalAdoptableMp4(Buffer.from("R5-CAS-WINNER"));
    const stagingDirectory = path.join(process.cwd(), "staging", taskUuid);
    const source = path.join(stagingDirectory, "result.mp4");
    fs.mkdirSync(stagingDirectory, { recursive: true });
    fs.mkdirSync(destinationDirectory, { recursive: true });
    fs.writeFileSync(source, buildMinimalAdoptableMp4(Buffer.from("R5-CAS-LOSER")));
    fs.writeFileSync(winnerAbsolutePath, winnerBytes);

    let bindingReads = 0;
    let concurrentWinnerWritten = false;
    const injectWinnerAfterTransactionRead = (
      _response: unknown,
      query: { sql?: string; bindings?: unknown[] },
    ) => {
      const sql = String(query.sql ?? "");
      const bindings = Array.isArray(query.bindings) ? query.bindings.map(String) : [];
      if (!sql.trimStart().toLowerCase().startsWith("select")
        || !sql.includes("o_video")
        || !bindings.includes(taskUuid)) return;
      bindingReads += 1;
      if (bindingReads !== 2) return;
      // 中文注释：事务已读到旧绑定后，由独立连接提交合法完整赢家，令旧事务的 CAS 丢失。
      const Database = require("better-sqlite3") as new (filename: string) => {
        prepare: (statement: string) => { run: (...params: unknown[]) => unknown };
        close: () => void;
      };
      const direct = new Database(path.join(projectRoot, "project.sqlite"));
      try {
        direct.prepare("UPDATE o_video SET state = ?, filePath = ? WHERE generationTaskUuid = ?")
          .run("生成成功", winnerRelativePath, taskUuid);
        concurrentWinnerWritten = true;
      } finally {
        direct.close();
      }
    };
    activeDb.on("query-response", injectWinnerAfterTransactionRead);
    try {
      const installed = await installDreaminaResult({
        projectUuid: PROJECT,
        taskUuid,
        shotUuid: String(task?.shotUuid ?? ""),
        mediaType: "video",
        stagingDirectory,
        files: [source],
      });
      const binding = await activeDb("o_video").where({ generationTaskUuid: taskUuid }).first();
      assert.deepEqual({
        concurrentWinnerWritten,
        relativePath: installed?.relativePath,
        bindingPath: binding?.filePath,
        winnerIntact: fs.readFileSync(winnerAbsolutePath).equals(winnerBytes),
      }, {
        concurrentWinnerWritten: true,
        relativePath: winnerRelativePath,
        bindingPath: winnerRelativePath,
        winnerIntact: true,
      });
    } finally {
      activeDb.off("query-response", injectWinnerAfterTransactionRead);
    }
  });
});

test("项目源文件与安装目标的硬链接数非一时必须写前写后失败关闭", async () => {
  const dataRoot = fs.mkdtempSync(path.resolve(__dirname, "../../../.tmp", "r25f2-r5-source-nlink-"));
  const segment = "e".repeat(32);
  const relativePath = "files/images/workbench/nlink-source.png";
  writeProjectFileAtomic(dataRoot, PROJECT, segment, relativePath, tinyPng(0x45));
  const sourcePath = resolveProjectFilePath(dataRoot, PROJECT, segment, relativePath);
  const sourceLink = `${sourcePath}.hardlink`;
  fs.linkSync(sourcePath, sourceLink);
  try {
    assert.throws(
      () => openProjectFileHandle(dataRoot, PROJECT, segment, relativePath),
      /身份|链接数|安全/,
      "项目源文件在首字节前必须拒绝 nlink 非一",
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  await withRuntime("r25f2-r5-destination-nlink", async () => {
    const created = await enqueueWorkbenchDreaminaVideos({
      projectUuid: PROJECT,
      clientOperationId: "41414141-4141-4141-a141-414141414141",
      paidBatchConfirmed: false,
      items: [workbenchItem({ mode: "text", uploadData: [] })],
    });
    const taskUuid = String(created[0]?.taskId ?? "");
    const task = await activeDb("o_storyboardGenerationTask").where({ taskUuid }).first();
    const projectRoot = projectDirectory(getPath(), PROJECT, currentUserStorage()!.segment);
    const destinationDirectory = path.join(projectRoot, "files", "videos", "workbench");
    const stagingDirectory = path.join(process.cwd(), "staging", taskUuid);
    const source = path.join(stagingDirectory, "result.mp4");
    fs.mkdirSync(stagingDirectory, { recursive: true });
    fs.writeFileSync(source, buildMinimalAdoptableMp4(Buffer.from("R5-NLINK")));

    const originalOpenSync = fs.openSync;
    const originalFsyncSync = fs.fsyncSync;
    let destinationFd = -1;
    let destination = "";
    let hardlink = "";
    (fs as unknown as { openSync: typeof fs.openSync }).openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpenSync(...args);
      const candidate = path.resolve(String(args[0]));
      if (path.dirname(candidate) === path.resolve(destinationDirectory)
        && path.basename(candidate).startsWith(`${taskUuid}`)) {
        destinationFd = fd;
        destination = candidate;
        hardlink = `${candidate}.hardlink`;
      }
      return fd;
    }) as typeof fs.openSync;
    (fs as unknown as { fsyncSync: typeof fs.fsyncSync }).fsyncSync = ((fd: number) => {
      originalFsyncSync(fd);
      if (fd === destinationFd && destination && !fs.existsSync(hardlink)) {
        // 中文注释：在完整写入与 flush 后增加同卷硬链接，写后身份栅栏必须看到 nlink=2。
        fs.linkSync(destination, hardlink);
      }
    }) as typeof fs.fsyncSync;
    try {
      await assert.rejects(() => installDreaminaResult({
        projectUuid: PROJECT,
        taskUuid,
        shotUuid: String(task?.shotUuid ?? ""),
        mediaType: "video",
        stagingDirectory,
        files: [source],
      }), (error: unknown) => (error as { code?: unknown })?.code === "DREAMINA_RESULT_INSTALL_FAILED");
    } finally {
      (fs as unknown as { openSync: typeof fs.openSync }).openSync = originalOpenSync;
      (fs as unknown as { fsyncSync: typeof fs.fsyncSync }).fsyncSync = originalFsyncSync;
    }
    assert.equal(fs.existsSync(destination), true, "无法原子回滚时保留本次完整文件");
    assert.equal(fs.existsSync(hardlink), true);
    const binding = await activeDb("o_video").where({ generationTaskUuid: taskUuid }).first();
    assert.notEqual(binding?.state, "生成成功", "nlink 异常文件绝不能进入数据库完成绑定");
    assert.notEqual(binding?.filePath, path.relative(projectRoot, destination).split(path.sep).join("/"));
  });
});
