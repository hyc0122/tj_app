import { readFile, writeFile } from "fs/promises";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import knex, { type Knex } from "knex";

import type { DB } from "@/types/database";
import getPath from "@/utils/getPath";
import { projectDirectory } from "@/tianjiang/data/paths";
import { assertManagedPathChainHasNoLinks } from "@/tianjiang/media/project-file-store";
import { assertSafeProjectDatabasePath } from "@/tianjiang/tasks/safe-project-db-path";
import {
  buildApplicationMigrations,
  type ApplicationMigrationOptions,
} from "@/tianjiang/data/application-migrations";
import { migrateSQLite } from "@/tianjiang/data/sqlite-migrator";
import {
  recoverGenerationTasks,
  registeredGenerationTaskPoller,
} from "@/tianjiang/tasks/generation-task-recovery";
import { cleanupStaleGenerationStaging } from "@/tianjiang/tasks/generation-artifact-downloader";
import {
  createBackgroundTaskSupervisor,
  getProcessBackgroundTaskSupervisor,
  setProcessBackgroundTaskSupervisor,
  stopProcessBackgroundTaskSupervisor,
  type SupervisorProjectSource,
} from "@/tianjiang/tasks/background-task-supervisor";
import { registerProductionGenerationStatusAdapters } from "@/tianjiang/tasks/vendor-status-adapters";
import { ensureCurrentAccountBuiltinSkills } from "@/tianjiang/skills/account-skills";
import {
  configureSQLiteConnection,
  runWithSQLiteStartupRetry,
} from "@/utils/sqlite-connection";
import {
  currentUserStorage,
  migrateLegacyUserStorageRoot,
  runWithProjectStorage,
  runWithUserStorage,
  userStorageRoot,
  type UserStorageIdentity,
} from "@/tianjiang/runtime/user-storage-context";

type TableName = keyof DB & string;
type RowType<TName extends TableName> = DB[TName];

interface DatabaseHandle {
  client: Knex;
  ready: Promise<void>;
  recoveryReady?: Promise<void>;
}

const handles = new Map<string, DatabaseHandle>();
const projectHandles = new Map<string, DatabaseHandle>();
export type ProjectDatabaseLeaseHolder = "ui" | "supervisor" | "scheduler";

interface ProjectHandleLeaseCounts {
  ui: number;
  supervisor: number;
  scheduler: number;
}

/** 工作区 UI / 后台监督器 / scheduler 分别持有 lease；计数归零后才能销毁句柄。 */
const projectHandleLeases = new Map<string, ProjectHandleLeaseCounts>();
const projectHandlesDestroying = new Set<string>();
let generationRecoveryTimer: NodeJS.Timeout | undefined;
let generationRecoveryPoller: (() => Promise<void>) | undefined;
let generationRecoveryCycle: Promise<void> | undefined;
let generationRecoveryPaused = false;
let databaseRuntimeClosing = false;
const generationRecoveryTasks = new Set<Promise<void>>();

export interface DatabaseRuntimeSnapshot {
  userHandleCount: number;
  projectHandleCount: number;
  generationRecoveryTimerActive: boolean;
}

/** 只读生命周期诊断：用于退出门和运行时健康检查确认数据库已经静止。 */
export function databaseRuntimeSnapshot(): DatabaseRuntimeSnapshot {
  return {
    userHandleCount: handles.size,
    projectHandleCount: projectHandles.size,
    generationRecoveryTimerActive: generationRecoveryTimer !== undefined,
  };
}

/** 关闭开始后禁止创建任何新句柄，已经存在的句柄仍可供活动请求排空。 */
export function beginDatabaseShutdown(): void {
  databaseRuntimeClosing = true;
}

/** 新一轮本地服务启动前重新开放句柄创建。 */
export function resetDatabaseRuntimeForServe(): void {
  if (generationRecoveryTasks.size > 0) {
    throw new Error("生成任务恢复仍在运行，不能重新开放数据库");
  }
  databaseRuntimeClosing = false;
  projectHandleLeases.clear();
}

/** 统一登记恢复任务，使关闭流程能等待已经进入的异步恢复查询。 */
export function trackGenerationTaskRecovery(operation: () => Promise<void>): Promise<void> {
  if (databaseRuntimeClosing || generationRecoveryPaused) {
    return Promise.reject(new Error("数据库正在安全关闭"));
  }
  const task = Promise.resolve().then(operation);
  const settled = task.then(() => undefined, () => undefined);
  generationRecoveryTasks.add(settled);
  void settled.finally(() => generationRecoveryTasks.delete(settled));
  return task;
}

/** 可恢复暂停：清 timer 并等待在途恢复；不 beginDatabaseShutdown。 */
export async function pauseGenerationTaskRecovery(): Promise<void> {
  // 中文注释：项目关闭前必须排空 generation 写库，阻断后可 resume。
  generationRecoveryPaused = true;
  getProcessBackgroundTaskSupervisor()?.pause();
  if (generationRecoveryTimer) {
    clearInterval(generationRecoveryTimer);
    generationRecoveryTimer = undefined;
  }
  while (generationRecoveryTasks.size > 0) {
    await Promise.all([...generationRecoveryTasks]);
  }
}

/** 项目关闭阻断后恢复轮询（仅当仍有 poller 且未进入不可逆 DB 关闭）。 */
export function resumeGenerationTaskRecovery(): void {
  if (databaseRuntimeClosing) {
    throw new Error("数据库正在安全关闭，禁止恢复生成任务轮询");
  }
  generationRecoveryPaused = false;
  getProcessBackgroundTaskSupervisor()?.resume();
  armGenerationRecoveryTimer();
}

function armGenerationRecoveryTimer(): void {
  if (databaseRuntimeClosing || generationRecoveryPaused || !generationRecoveryPoller) {
    return;
  }
  if (generationRecoveryTimer) clearInterval(generationRecoveryTimer);
  generationRecoveryTimer = setInterval(() => {
    const poller = generationRecoveryPoller;
    if (!poller || generationRecoveryPaused || databaseRuntimeClosing) return;
    if (generationRecoveryCycle) return;
    // 中文注释：账号任务与项目监督器组成同一恢复周期，防止定时器在慢网络下重入。
    const cycle = trackGenerationTaskRecovery(poller);
    const settled = cycle.finally(() => {
      if (generationRecoveryCycle === settled) generationRecoveryCycle = undefined;
    });
    generationRecoveryCycle = settled;
    void settled.catch((error) => console.error("生成任务恢复轮询失败:", error));
  }, 30_000);
  generationRecoveryTimer.unref();
}

/** 退出阶段停止恢复轮询，并等待所有已开始的恢复查询落定。 */
export async function stopGenerationTaskRecovery(): Promise<void> {
  beginDatabaseShutdown();
  generationRecoveryPaused = true;
  generationRecoveryPoller = undefined;
  if (generationRecoveryTimer) {
    clearInterval(generationRecoveryTimer);
    generationRecoveryTimer = undefined;
  }
  while (generationRecoveryTasks.size > 0) {
    await Promise.all([...generationRecoveryTasks]);
  }
  await stopProcessBackgroundTaskSupervisor();
}

/** 最终同步成功后销毁所有账号/项目 Knex 池；重复调用保持幂等。 */
export async function destroyAllDatabaseHandles(): Promise<void> {
  try {
    const { disposeEmbedding } = await import("@/utils/agent/embedding");
    await disposeEmbedding();
  } catch {
    // ignore
  }
  try {
    const { stopDreaminaSchedulerLoop, drainDreaminaSubmitCriticalSection } = await import(
      "@/tianjiang/model-providers/dreamina-cli/scheduler"
    );
    // 先停调度循环并抽干 submit，避免后台 tick 继续占用即将关闭的账号库。
    stopDreaminaSchedulerLoop();
    await drainDreaminaSubmitCriticalSection();
  } catch {
    // 调度器未加载时没有可停的循环。
  }
  try {
    const {
      drainVendorGenerationScheduler,
      stopVendorGenerationScheduler,
    } = await import("@/tianjiang/storyboard/vendor-generation-scheduler");
    // 中文注释：先禁止新领取并等待普通供应商任务写回，避免关闭项目库后后台继续请求或写库。
    stopVendorGenerationScheduler();
    await drainVendorGenerationScheduler();
  } catch {
    // 普通供应商调度器未加载时无需处理。
  }
  await destroyDatabaseHandleMap(projectHandles);
  await destroyDatabaseHandleMap(handles);
}

/**
 * 在替换单个项目 SQLite 前精确关闭该项目的旧业务连接。
 * 中文注释：Windows 会阻止移动仍被 Knex 占用的 project.sqlite，禁止为此关闭其他项目或账号库。
 */
export async function destroyProjectDatabaseHandle(
  userSegment: string,
  projectUuid: string,
): Promise<void> {
  const key = `${userSegment}:${projectUuid}`;
  projectHandleLeases.delete(key);
  const handle = projectHandles.get(key);
  if (!handle) return;

  let readyError: unknown;
  try {
    await handle.ready;
  } catch (error) {
    readyError = error;
  }
  await handle.client.destroy();
  projectHandles.delete(key);
  if (readyError) throw readyError;
}

/** 句柄只有在 destroy 成功后才删除；失败项完整保留给下一次关闭重试。 */
export async function destroyDatabaseHandleMap(
  entries: Map<string, DatabaseHandle>,
): Promise<void> {
  for (const [key, handle] of [...entries]) {
    let readyError: unknown;
    try {
      await handle.ready;
    } catch (error) {
      readyError = error;
    }
    try {
      // WAL 未 checkpoint 时 Windows 会锁住 -wal/-shm，rmSync 目录会 EPERM。
      await handle.client.raw("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // 连接已坏或非 WAL 时继续 destroy，不能把关闭本身吞掉。
    }
    await handle.client.destroy();
    entries.delete(key);
    if (readyError) throw readyError;
  }
}

/**
 * 中央认证用户的数据库在独立目录初始化；同一进程可保留多个句柄，但永不跨用户复用。
 */
export async function prepareUserDatabase(identity: UserStorageIdentity): Promise<void> {
  const context = runWithUserStorage(identity, () => currentUserStorage()!);
  let handle = handles.get(context.segment);
  if (!handle) {
    assertDatabaseHandleCreationAllowed();
    migrateLegacyUserStorageRoot(getPath(), identity);
    const databasePath = path.join(userStorageRoot(getPath(), identity), "db2.sqlite");
    handle = createHandle(databasePath, { captureProfileSettings: true });
    handles.set(context.segment, handle);
    // 先登记句柄再初始化，fixDB 内部通过 u.db 发出的查询才能解析回同一用户。
    handle.ready = runWithUserStorage(
      identity,
      () => initializeDatabase(handle!.client, databasePath, {
        role: "account",
        skipEmbeddingInit: true,
      }),
    );
  }
  await handle.ready;
}

/**
 * 新账号全部本地状态准备完成后再切换活动数据库。
 * 旧账号句柄先关闭，目录只移动到恢复区，不在切换过程中删除唯一副本。
 */
export async function activateUserDatabase(identity: UserStorageIdentity): Promise<void> {
  // 账号切换前释放 embedding extractor，避免 B 复用 A 的模型管道
  try {
    const { disposeEmbedding } = await import("@/utils/agent/embedding");
    await disposeEmbedding();
  } catch {
    // embedding 未初始化时忽略
  }
  await prepareUserDatabase(identity);
  // 中文注释：设置/提示词/Skill 被当作有效状态读取前，先完成本地 apply 崩溃恢复，禁止等待网络。
  await runWithUserStorage(identity, async () => {
    const { recoverProfileApplyJournal } = await import("@/tianjiang/sync/profile-settings-adapter");
    await recoverProfileApplyJournal();
  });
  const activeContext = runWithUserStorage(identity, () => currentUserStorage()!);
  const activeHandle = handles.get(activeContext.segment)!;
  // 数据库准备成功后立即补装当前账号缺失的内置 Skills；已有用户文件绝不覆盖。
  await runWithUserStorage(identity, () => ensureCurrentAccountBuiltinSkills(getPath()));
  // 先从当前用户私密配置登记“只查状态”适配器，再恢复未终态任务。
  // 显式注入账号库，避免在适配器内部再次解析 accountDatabase 时出现环依赖/时序问题。
  await runWithUserStorage(identity, () =>
    registerProductionGenerationStatusAdapters(activeHandle.client, {
      accountConfigDatabase: activeHandle.client,
    }));
  // 新登录或应用重启后立即恢复一次，只查询已持久化的远端任务 ID。
  await runWithUserStorage(identity, () =>
    recoverGenerationTasks(activeHandle.client, registeredGenerationTaskPoller));
  await runWithUserStorage(identity, () => cleanupStaleGenerationStaging(activeHandle.client));
  try {
    const { ensureDreaminaSchedulerStarted } = await import(
      "@/tianjiang/model-providers/dreamina-cli/scheduler"
    );
    const { recoverDreaminaSlots } = await import(
      "@/tianjiang/model-providers/dreamina-cli/recovery"
    );
    await runWithUserStorage(identity, () => ensureDreaminaSchedulerStarted());
    // 中文注释：恢复扫描/隔离任一步失败时必须保持调度静默，禁止 catch 后仍唤醒真实付费领取。
    // 中文注释：账号激活是唯一允许清理上次 lifecycle_drain 的恢复入口。
    await runWithUserStorage(identity, () => recoverDreaminaSlots({ recoverLifecycleDrain: true }));
  } catch {
    // 即梦调度器未就绪时不阻断账号激活。
  }
  let resumeVendorSchedulerAfterSwitch: (() => void) | undefined;
  try {
    const {
      drainVendorGenerationScheduler,
      resumeVendorGenerationScheduler,
      stopVendorGenerationScheduler,
    } = await import("@/tianjiang/storyboard/vendor-generation-scheduler");
    // 中文注释：旧账号任务必须在关闭或移动其 SQLite 前收敛；新领取直到目录切换完成后再开放。
    stopVendorGenerationScheduler();
    await drainVendorGenerationScheduler();
    resumeVendorSchedulerAfterSwitch = resumeVendorGenerationScheduler;
  } catch {
    // 调度器尚未加载时没有可排空的普通供应商任务。
  }
  try {
    for (const [segment, handle] of [...handles]) {
      if (segment === activeContext.segment) continue;
      await handle.ready;
      await handle.client.destroy();
      handles.delete(segment);
    }
    for (const [key, handle] of [...projectHandles]) {
      if (key.startsWith(`${activeContext.segment}:`)) continue;
      await handle.ready;
      await handle.client.destroy();
      projectHandles.delete(key);
    }

    const usersRoot = path.join(getPath(), "runtime-users");
    fs.mkdirSync(usersRoot, { recursive: true });
    const recoveryRoot = path.join(
      getPath(),
      "runtime-recovery",
      "account-switch",
      `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    );
    const moved: Array<{ source: string; destination: string }> = [];
    try {
      for (const entry of fs.readdirSync(usersRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === activeContext.segment) continue;
        const source = path.join(usersRoot, entry.name);
        const destination = path.join(recoveryRoot, entry.name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.renameSync(source, destination);
        moved.push({ source, destination });
      }
      const marker = path.join(usersRoot, "active-user.json");
      const temporary = `${marker}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({
        segment: activeContext.segment,
        switchedAt: new Date().toISOString(),
      }, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, marker);
    } catch (error) {
      // 原子切换失败时按逆序恢复已移动目录，避免出现半切换活动区。
      for (const item of moved.reverse()) {
        if (fs.existsSync(item.destination) && !fs.existsSync(item.source)) {
          fs.renameSync(item.destination, item.source);
        }
      }
      throw error;
    }
  } finally {
    resumeVendorSchedulerAfterSwitch?.();
  }
  await recoverDiscoveredProjectDatabases(identity);
  try {
    const {
      recoverDurableVendorGenerationOperations,
      resumeVendorGenerationScheduler,
    } = await import(
      "@/tianjiang/storyboard/vendor-generation-scheduler"
    );
    // 中文注释：切库完成并重新开放领取后才扫描新账号；恢复只负责唤醒，账号激活绝不 drain 新任务。
    await runWithUserStorage(identity, async () => {
      resumeVendorGenerationScheduler();
      await recoverDurableVendorGenerationOperations();
    });
  } catch {
    // 单个项目库损坏或调度器未就绪不阻断账号激活，耐久记录保留供下次恢复。
  }
  const supervisor = createBackgroundTaskSupervisor({
    accountKey: `${identity.issuer}:${identity.userId}`,
    now: () => Date.now(),
    poll: (task) => registeredGenerationTaskPoller.poll(task),
    listSources: async () => listBackgroundTaskSources(identity, activeContext.segment),
    openDatabase: async (databasePath) => knex({
      client: "better-sqlite3",
      connection: { filename: databasePath },
      useNullAsDefault: true,
    }),
    closeDatabase: async (database) => {
      await database.destroy();
    },
    runInProjectContext: async (projectUuid, run) =>
      runWithUserStorage(identity, () => runWithProjectStorage(projectUuid, run)),
    acquireProjectLease: (projectUuid) => runWithUserStorage(identity, () =>
      acquireProjectDatabaseLease(projectUuid, "supervisor")),
    releaseProjectLease: async (projectUuid) => runWithUserStorage(identity, () =>
      releaseProjectDatabaseLease(projectUuid, "supervisor")),
    onProjectIdle: async (projectUuid) => {
      await runWithUserStorage(identity, () => releaseProjectDatabaseHandleIfIdle(projectUuid));
    },
  });
  setProcessBackgroundTaskSupervisor(supervisor);
  await supervisor.restoreFromPersistence();
  generationRecoveryPoller = () =>
    runWithUserStorage(identity, async () => {
      await recoverGenerationTasks(activeHandle.client, registeredGenerationTaskPoller);
      const activeSupervisor = getProcessBackgroundTaskSupervisor();
      if (activeSupervisor) await activeSupervisor.tick();
      else await recoverAllCurrentUserGenerationTasks(identity, activeContext.segment, activeHandle);
      await cleanupStaleGenerationStaging(activeHandle.client);
    });
  generationRecoveryPaused = false;
  armGenerationRecoveryTimer();
  await runWithUserStorage(identity, async () => {
    const { canvasExecutionRuntime } = await import("@/tianjiang/canvas/canvas-execution-runtime");
    await canvasExecutionRuntime.resume();
  });
  // 中文注释：账号库激活成功后必须恢复 raw inbox，覆盖仅调用 activateUserDatabase、不经过 login.ts 的路径。
  await runWithUserStorage(identity, async () => {
    const { resumeRawInboxConsumer } = await import("@/tianjiang/canvas/canvas-provider-raw-inbox");
    resumeRawInboxConsumer();
  });
}

/**
 * 旧 UI 的项目业务表直接落入项目快照库，避免与同步层维护两份事实来源。
 */
export async function prepareProjectDatabase(
  projectUuid: string,
  options: { retain?: boolean; holder?: ProjectDatabaseLeaseHolder } = {},
): Promise<void> {
  const context = currentUserStorage();
  if (!context) throw new Error("缺少中央用户存储上下文");
  const key = `${context.segment}:${projectUuid}`;
  while (projectHandlesDestroying.has(key)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const holder = options.holder ?? (options.retain === true ? "ui" : undefined);
  if (holder) bumpProjectDatabaseLease(key, holder);
  const projectRoot = projectDirectory(getPath(), projectUuid, context.segment);
  const databasePath = path.join(projectRoot, "project.sqlite");
  // 中文注释：SQLite 无法安全绑定 Node fd；每次复用或新建句柄前只做静态链接、硬链接与真实路径校验。
  assertManagedPathChainHasNoLinks(getPath(), projectRoot);
  let databaseEntryExists = false;
  try {
    fs.lstatSync(databasePath);
    databaseEntryExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (databaseEntryExists) assertSafeProjectDatabasePath(getPath(), databasePath);
  let handle = projectHandles.get(key);
  if (!handle) {
    assertDatabaseHandleCreationAllowed();
    handle = createHandle(databasePath);
    projectHandles.set(key, handle);
    const created = handle;
    handle.ready = runWithProjectStorage(
      projectUuid,
      () => initializeDatabase(created.client, databasePath, {
        role: "project",
        skipEmbeddingInit: true,
      }),
    );
    void handle.ready.catch(async () => {
      if (projectHandles.get(key) === created && projectDatabaseLeaseTotal(key) === 0) {
        try { await created.client.destroy(); } catch { /* ignore */ }
        if (projectHandles.get(key) === created) projectHandles.delete(key);
      }
    });
  }
  await handle.ready;
  if (!handle.recoveryReady) {
    // 每个项目库独立登记供应商查询器并在首次打开时恢复；供应商/密钥始终读账号库。
    // 失败时清空 recoveryReady，避免被拒的 Promise 永久毒化后续 open/登录恢复。
    const recovery = runWithProjectStorage(projectUuid, async () => {
      const userDb = accountDatabase();
      await registerProductionGenerationStatusAdapters(handle!.client, {
        accountConfigDatabase: userDb,
      });
      await recoverGenerationTasks(handle!.client, registeredGenerationTaskPoller);
    });
    handle.recoveryReady = recovery;
    try {
      await recovery;
    } catch (error) {
      if (handle.recoveryReady === recovery) handle.recoveryReady = undefined;
      throw error;
    }
    return;
  }
  await handle.recoveryReady;
}

export type LegacyWorkspaceProjectType = "novel" | "script" | "storyboard";

export interface WorkspaceProjectMetadata {
  id: number;
  name: string;
  projectType: LegacyWorkspaceProjectType;
  userId: number;
}

/** 通用项目库初始化：目录、数据库和素材根，不含影视 o_project。 */
export async function initializeProjectRuntimeBase(projectUuid: string): Promise<void> {
  await acquireProjectDatabaseLease(projectUuid, "ui");
}

/** 个人画布启动钩子；具体表由后续 Runtime 计划安装。 */
export async function initializeCanvasWorkspace(projectUuid: string): Promise<void> {
  await initializeProjectRuntimeBase(projectUuid);
}

/**
 * 中央目录校验通过后，将稳定项目映射写入现有 o_project。
 * 旧工作区随后读取的就是该项目库，不依赖 renderer 自行拼装项目状态。
 */
export async function initializeWorkspaceProject(
  projectUuid: string,
  metadata: WorkspaceProjectMetadata,
): Promise<void> {
  await acquireProjectDatabaseLease(projectUuid, "ui");
  if (metadata.projectType !== "novel" && metadata.projectType !== "script" && metadata.projectType !== "storyboard") {
    throw new Error("影视旧工作区只接受 novel、script 或 storyboard");
  }
  await runWithProjectStorage(projectUuid, async () => {
    const current = await dbClient("o_project").where({ id: metadata.id }).first();
    if (current) {
      await dbClient("o_project").where({ id: metadata.id }).update({
        name: metadata.name,
        projectType: metadata.projectType,
      });
      return;
    }
    await dbClient("o_project").insert({
      id: metadata.id,
      name: metadata.name,
      projectType: metadata.projectType,
      intro: "",
      type: "",
      artStyle: null,
      videoRatio: null,
      createTime: 0,
      imageModel: "",
      videoModel: "",
      imageQuality: "",
      mode: "",
      directorManual: "",
      userId: metadata.userId,
    });
  });
}

async function recoverDiscoveredProjectDatabases(_identity: UserStorageIdentity): Promise<void> {
  // 中文注释：扫描恢复只确认项目目录存在；路径由监督器按需短开短关，禁止把全部项目装进 projectHandles。
}

export async function acquireProjectDatabaseLease(
  projectUuid: string,
  holder: ProjectDatabaseLeaseHolder,
): Promise<Knex> {
  const context = currentUserStorage();
  if (!context) throw new Error("缺少中央用户存储上下文");
  const key = `${context.segment}:${projectUuid}`;
  try {
    await prepareProjectDatabase(projectUuid);
    bumpProjectDatabaseLease(key, holder);
    const handle = projectHandles.get(key);
    if (!handle) throw new Error("项目数据库句柄缺失");
    return handle.client;
  } catch (error) {
    if (projectDatabaseLeaseTotal(key) === 0) {
      await destroyProjectDatabaseHandleIfNoLeases(context.segment, projectUuid).catch(() => undefined);
    }
    throw error;
  }
}

export async function releaseProjectDatabaseLease(
  projectUuid: string,
  holder: ProjectDatabaseLeaseHolder,
): Promise<void> {
  const context = currentUserStorage();
  if (!context) return;
  const key = `${context.segment}:${projectUuid}`;
  dropProjectDatabaseLease(key, holder);
  if (projectDatabaseLeaseTotal(key) > 0) return;
  await destroyProjectDatabaseHandleIfNoLeases(context.segment, projectUuid);
}

export function projectDatabaseLeaseSnapshot(projectUuid: string): ProjectHandleLeaseCounts {
  const context = currentUserStorage();
  if (!context) return { ui: 0, supervisor: 0, scheduler: 0 };
  const counts = projectHandleLeases.get(`${context.segment}:${projectUuid}`);
  return counts ? { ...counts } : { ui: 0, supervisor: 0, scheduler: 0 };
}

export async function releaseProjectDatabaseHandleIfIdle(projectUuid: string): Promise<void> {
  const context = currentUserStorage();
  if (!context) return;
  const key = `${context.segment}:${projectUuid}`;
  if (projectDatabaseLeaseTotal(key) > 0) return;
  await destroyProjectDatabaseHandleIfNoLeases(context.segment, projectUuid);
}

async function destroyProjectDatabaseHandleIfNoLeases(
  userSegment: string,
  projectUuid: string,
): Promise<void> {
  const key = `${userSegment}:${projectUuid}`;
  const handle = projectHandles.get(key);
  if (!handle) return;
  projectHandlesDestroying.add(key);
  try {
    let readyError: unknown;
    try {
      await handle.ready;
    } catch (error) {
      readyError = error;
    }
    if (projectDatabaseLeaseTotal(key) > 0) {
      if (readyError) throw readyError;
      return;
    }
    try {
      await handle.client.raw("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // ignore
    }
    await handle.client.destroy();
    if (projectHandles.get(key) === handle) projectHandles.delete(key);
    if (readyError) throw readyError;
  } finally {
    projectHandlesDestroying.delete(key);
  }
}

function bumpProjectDatabaseLease(key: string, holder: ProjectDatabaseLeaseHolder): void {
  const current = projectHandleLeases.get(key) ?? { ui: 0, supervisor: 0, scheduler: 0 };
  current[holder] += 1;
  projectHandleLeases.set(key, current);
}

function dropProjectDatabaseLease(key: string, holder: ProjectDatabaseLeaseHolder): void {
  const current = projectHandleLeases.get(key);
  if (!current) return;
  current[holder] = Math.max(0, current[holder] - 1);
  if (projectDatabaseLeaseTotal(key) === 0) projectHandleLeases.delete(key);
  else projectHandleLeases.set(key, current);
}

function projectDatabaseLeaseTotal(key: string): number {
  const current = projectHandleLeases.get(key);
  if (!current) return 0;
  return current.ui + current.supervisor + current.scheduler;
}

function listBackgroundTaskSources(
  identity: UserStorageIdentity,
  segment: string,
): SupervisorProjectSource[] {
  const sources: SupervisorProjectSource[] = [];
  const seen = new Set<string>();
  const projectsRoot = path.join(userStorageRoot(getPath(), identity), "projects");
  if (!fs.existsSync(projectsRoot)) return sources;
  for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const projectUuid = entry.name.toLowerCase();
    if (seen.has(projectUuid)) continue;
    const databasePath = path.join(
      projectDirectory(getPath(), projectUuid, segment),
      "project.sqlite",
    );
    if (!fs.existsSync(databasePath)) continue;
    try {
      assertSafeProjectDatabasePath(getPath(), databasePath);
    } catch {
      continue;
    }
    seen.add(projectUuid);
    const retainedKey = `${segment}:${projectUuid}`;
    if (projectHandles.has(retainedKey) && projectDatabaseLeaseTotal(retainedKey) > 0) {
      sources.push({
        projectUuid,
        database: projectHandles.get(retainedKey)!.client,
        databasePath,
      });
    } else {
      sources.push({ projectUuid, databasePath });
    }
  }
  return sources;
}

async function recoverAllCurrentUserGenerationTasks(
  identity: UserStorageIdentity,
  segment: string,
  userHandle: DatabaseHandle,
): Promise<void> {
  await runWithUserStorage(identity, async () => {
    await registerProductionGenerationStatusAdapters(userHandle.client, {
      accountConfigDatabase: userHandle.client,
    });
    await recoverGenerationTasks(userHandle.client, registeredGenerationTaskPoller);
    for (const [key, handle] of projectHandles) {
      if (!key.startsWith(`${segment}:`)) continue;
      const projectUuid = key.slice(segment.length + 1);
      await runWithProjectStorage(projectUuid, async () => {
        await registerProductionGenerationStatusAdapters(handle.client, {
          accountConfigDatabase: userHandle.client,
        });
        await recoverGenerationTasks(handle.client, registeredGenerationTaskPoller);
      });
    }
  });
}

function assertDatabaseHandleCreationAllowed(): void {
  if (databaseRuntimeClosing) throw new Error("数据库正在安全关闭，禁止创建新句柄");
}

function createHandle(
  databasePath: string,
  options: { captureProfileSettings?: boolean } = {},
): DatabaseHandle {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  if (!fs.existsSync(databasePath)) fs.writeFileSync(databasePath, "");
  const client = knex({
    client: "better-sqlite3",
    connection: { filename: databasePath },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      afterCreate(connection: any, done: (error: Error | null, connection?: any) => void) {
        configureSQLiteConnection(connection, done);
      },
    },
  });
  if (options.captureProfileSettings) {
    client.on("query-response", (_response, obj) => {
      const sql = String((obj as { sql?: string })?.sql ?? "");
      void import("@/tianjiang/sync/profile-settings-adapter").then((adapter) => {
        if (adapter.shouldCaptureAccountSql(sql)) adapter.scheduleAccountSettingsCapture();
      }).catch(() => undefined);
    });
  }
  return { client, ready: Promise.resolve() };
}

async function initializeDatabase(
  client: Knex,
  databasePath: string,
  options: ApplicationMigrationOptions,
): Promise<void> {
  await migrateSQLite({
    database: client,
    databasePath,
    migrations: buildApplicationMigrations(options),
  });
  if (process.env.NODE_ENV === "dev") await initKnexType(client);
}

/**
 * HTTP、Socket 和任务恢复注册前的启动门。
 * 只有存在上次成功切换的活动账号时才迁移，不会为 fresh install 创建根 db2.sqlite。
 */
export async function migrateActiveDatabaseBeforeServe(): Promise<void> {
  const usersRoot = path.join(getPath(), "runtime-users");
  const markerPath = path.join(usersRoot, "active-user.json");
  if (!fs.existsSync(markerPath)) return;
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { segment?: unknown };
  if (typeof marker.segment !== "string" || !/^[0-9a-f]{32}$/.test(marker.segment)) {
    throw new Error("活动账号数据库指针损坏");
  }
  const databasePath = path.join(usersRoot, marker.segment, "db2.sqlite");
  if (!fs.existsSync(databasePath)) throw new Error("活动账号数据库不存在");
  await runWithSQLiteStartupRetry(async () => {
    // 每轮都创建并销毁独立句柄；失败的池绝不能带入下一轮启动迁移。
    const handle = createHandle(databasePath);
    try {
      await initializeDatabase(handle.client, databasePath, {
        role: "account",
        skipEmbeddingInit: true,
      });
    } finally {
      await handle.client.destroy();
    }
  });
}

function activeDatabase(): Knex {
  const context = currentUserStorage();
  // 根目录 db2.sqlite 仅是一次性迁移源；正常运行时缺少中央身份必须失败关闭。
  if (!context) throw new Error("缺少中央用户存储上下文");
  if (context.projectUuid) {
    const projectHandle = projectHandles.get(`${context.segment}:${context.projectUuid}`);
    if (!projectHandle) throw new Error("当前项目数据库尚未初始化");
    return projectHandle.client;
  }
  const handle = handles.get(context.segment);
  if (!handle) throw new Error("当前中央用户数据库尚未初始化");
  return handle.client;
}

/**
 * 显式账号配置库：始终指向当前认证账号的 db2.sqlite。
 * 即使 ALS 处于 projectUuid 项目上下文，也不得改读 project.sqlite，
 * 也禁止回退全局库 / 最后登录账号 / 默认账号。
 */
export function accountDatabase(): Knex {
  const context = currentUserStorage();
  if (!context) throw new Error("缺少中央用户存储上下文");
  const handle = handles.get(context.segment);
  if (!handle) throw new Error("当前中央用户数据库尚未初始化");
  return handle.client;
}

/**
 * 在账号库上执行回调，不切换项目 ALS（业务写仍走 activeDatabase/项目库）。
 */
export async function withAccountDatabase<T>(
  run: (database: Knex) => Promise<T> | T,
): Promise<T> {
  return run(accountDatabase());
}

const databaseCallable = (<TName extends TableName>(table: TName) =>
  activeDatabase()<RowType<TName>, RowType<TName>[]>(table)) as Knex;

// Knex 既是函数也是对象；Proxy 确保 transaction/schema/raw 等属性也解析到当前请求用户句柄。
const dbClient = new Proxy(databaseCallable, {
  apply(_target, _thisArg, argumentList) {
    return Reflect.apply(activeDatabase() as unknown as Function, activeDatabase(), argumentList);
  },
  get(_target, property) {
    const database = activeDatabase() as unknown as Record<PropertyKey, unknown>;
    const value = database[property];
    return typeof value === "function" ? value.bind(database) : value;
  },
  set(_target, property, value) {
    (activeDatabase() as unknown as Record<PropertyKey, unknown>)[property] = value;
    return true;
  },
});

/** 账号级配置查询入口：表访问语义同 u.db，但永远绑到账号 db2。 */
const accountDatabaseCallable = (<TName extends TableName>(table: TName) =>
  accountDatabase()<RowType<TName>, RowType<TName>[]>(table)) as Knex;

const accountDbClient = new Proxy(accountDatabaseCallable, {
  apply(_target, _thisArg, argumentList) {
    return Reflect.apply(accountDatabase() as unknown as Function, accountDatabase(), argumentList);
  },
  get(_target, property) {
    const database = accountDatabase() as unknown as Record<PropertyKey, unknown>;
    const value = database[property];
    return typeof value === "function" ? value.bind(database) : value;
  },
  set(_target, property, value) {
    (accountDatabase() as unknown as Record<PropertyKey, unknown>)[property] = value;
    return true;
  },
});

export default dbClient;
export { dbClient as db, accountDbClient as accountDb };

async function initKnexType(knexDb: Knex) {
  const { Client } = await import("@rmp135/sql-ts");
  const outFile = "src/types/database.d.ts";
  const generated = Client.fromConfig({
    interfaceNameFormat: "${table}",
    typeMap: {
      number: ["bigint"],
      string: ["text", "varchar", "char"],
    },
  }).fetchDatabase(knexDb);
  const declarations = await generated.toTypescript();
  const dbObject = await generated.toObject();
  const customHeader = `//该文件由脚本自动生成，请勿手动修改`;
  let declBody = declarations.replace(/^\/\*[\s\S]*?\*\/\s*/, "");
  declBody = declBody.replace(/(\n\s*)\/\*([^*][\s\S]*?)\*\//g, "$1/**$2*/");
  const tableInterfaces = dbObject.schemas.flatMap(
    (schema) => schema.tables.map((table) => table.interfaceName),
  );
  const aggregateTypes = `
export interface DB {
${tableInterfaces.map((name) => `  ${JSON.stringify(name)}: ${name};`).join("\n")}
}
`;
  const hashSource = JSON.stringify({ tableInterfaces, declBody });
  const hash = crypto.createHash("md5").update(hashSource).digest("hex");
  const content = `// @db-hash ${hash}\n${customHeader}\n\n${declBody}${aggregateTypes}`;
  let needWrite = true;
  try {
    const current = await readFile(outFile, "utf8");
    needWrite = current.match(/^\/\/\s*@db-hash\s*([a-zA-Z0-9]+)\n/)?.[1] !== hash;
  } catch {
    needWrite = true;
  }
  if (needWrite) await writeFile(outFile, content, "utf8");
}
