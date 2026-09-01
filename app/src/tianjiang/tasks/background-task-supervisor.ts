/**
 * 后台任务监督器：已提交的生成任务归后端所有。
 * 只保留最小任务描述，按需短暂打开项目库，终态后立即关闭连接并删除运行态。
 * 项目切换、Socket 断开、窗口隐藏都不是取消。
 */
import knex, { type Knex } from "knex";

import {
  recoverGenerationTasks,
  type GenerationTaskIdentity,
  type RemoteGenerationResult,
} from "./generation-task-recovery";

export const MINIMAL_TASK_RUNTIME_KEYS = [
  "accountKey",
  "projectUuid",
  "localProjectId",
  "taskId",
  "remoteTaskId",
  "taskClass",
  "provider",
  "state",
  "nextPollAt",
  "retryCount",
] as const;

export type MinimalTaskRuntimeKey = (typeof MINIMAL_TASK_RUNTIME_KEYS)[number];

export interface MinimalTaskRuntime {
  accountKey: string;
  projectUuid: string;
  localProjectId?: number;
  taskId: number;
  remoteTaskId: string;
  taskClass?: string;
  provider: string;
  state: string;
  nextPollAt: number;
  retryCount: number;
}

export interface SupervisorProjectSource {
  projectUuid: string;
  localProjectId?: number;
  database?: Knex;
  databasePath?: string;
}

export interface BackgroundTaskSupervisorDeps {
  accountKey: string;
  now: () => number;
  poll: (task: GenerationTaskIdentity) => Promise<RemoteGenerationResult>;
  listSources: () => Promise<SupervisorProjectSource[]>;
  openDatabase?: (databasePath: string) => Promise<Knex>;
  closeDatabase?: (database: Knex) => Promise<void>;
  /** 生产环境用于绑定账号下的 projectUuid ALS，确保命中项目级供应商查询适配器。 */
  runInProjectContext?: <T>(projectUuid: string, run: () => Promise<T>) => Promise<T>;
  /** 项目已无未完成后台任务时释放非活动句柄。 */
  onProjectIdle?: (projectUuid: string) => Promise<void>;
  /** 生产路径：监督器持有项目库 lease，Promise settled 后释放。 */
  acquireProjectLease?: (projectUuid: string) => Promise<Knex>;
  releaseProjectLease?: (projectUuid: string) => Promise<void>;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  createRemoteTask?: unknown;
}

const FORBIDDEN_RUNTIME_KEY = /base64|blob|file|imageBitmap|messages|flowData|assets|rawResponse|data:/i;
const ACTIVE_GENERATION = new Set(["polling", "temporary_failure", "pending_finalize"]);

function runtimeKey(projectUuid: string, taskId: number): string {
  return `${projectUuid}:${taskId}`;
}

function asMinimal(row: MinimalTaskRuntime): MinimalTaskRuntime {
  return {
    accountKey: row.accountKey,
    projectUuid: row.projectUuid,
    ...(row.localProjectId != null ? { localProjectId: row.localProjectId } : {}),
    taskId: row.taskId,
    remoteTaskId: row.remoteTaskId,
    ...(row.taskClass ? { taskClass: row.taskClass } : {}),
    provider: row.provider,
    state: row.state,
    nextPollAt: row.nextPollAt,
    retryCount: row.retryCount,
  };
}

export interface BackgroundTaskSupervisor {
  restoreFromPersistence(): Promise<void>;
  tick(now?: number): Promise<void>;
  notifyProjectSwitch(fromProjectUuid: string | null, toProjectUuid: string | null): void;
  notifyWindowHiddenToTray(): void;
  notifyExplicitShutdown(): Promise<void>;
  pause(): void;
  resume(): void;
  listRuntimeTasks(): MinimalTaskRuntime[];
  runtimeCount(): number;
  fullProjectStoreCount(): number;
  openDatabaseCount(): number;
  pollCount(): number;
  submitCount(): number;
  cancelCount(): number;
  hasForbiddenPayload(): boolean;
}

export function createBackgroundTaskSupervisor(
  deps: BackgroundTaskSupervisorDeps,
): BackgroundTaskSupervisor {
  const runtime = new Map<string, MinimalTaskRuntime>();
  const retryDelayMs = deps.retryDelayMs ?? 5_000;
  let stopped = false;
  let paused = false;
  let hiddenToTray = false;
  let liveOpens = 0;
  let polls = 0;
  let activeTick: Promise<void> | undefined;
  const ownedConnections = new Set<Knex>();

  const poller = {
    async poll(task: GenerationTaskIdentity): Promise<RemoteGenerationResult> {
      polls += 1;
      return deps.poll(task);
    },
  };

  async function withSourceDatabase<T>(
    source: SupervisorProjectSource,
    run: (database: Knex) => Promise<T>,
  ): Promise<T> {
    const runWithContext = (database: Knex) => {
      const execute = () => run(database);
      return deps.runInProjectContext
        ? deps.runInProjectContext(source.projectUuid, execute)
        : execute();
    };
    if (source.database) {
      if (deps.acquireProjectLease && deps.releaseProjectLease) {
        await deps.acquireProjectLease(source.projectUuid);
        liveOpens += 1;
        try {
          return await runWithContext(source.database);
        } finally {
          liveOpens = Math.max(0, liveOpens - 1);
          await deps.releaseProjectLease(source.projectUuid);
        }
      }
      return runWithContext(source.database);
    }
    if (deps.acquireProjectLease && deps.releaseProjectLease) {
      let leased: Knex | undefined;
      try {
        leased = await deps.acquireProjectLease(source.projectUuid);
      } catch {
        leased = undefined;
      }
      if (leased) {
        liveOpens += 1;
        try {
          return await runWithContext(leased);
        } finally {
          liveOpens = Math.max(0, liveOpens - 1);
          await deps.releaseProjectLease(source.projectUuid);
        }
      }
    }
    const databasePath = String(source.databasePath ?? "").trim();
    if (!databasePath) throw new Error("缺少项目数据库");
    const database = deps.openDatabase
      ? await deps.openDatabase(databasePath)
      : knex({
          client: "better-sqlite3",
          connection: { filename: databasePath },
          useNullAsDefault: true,
        });
    liveOpens += 1;
    ownedConnections.add(database);
    try {
      return await runWithContext(database);
    } finally {
      ownedConnections.delete(database);
      liveOpens = Math.max(0, liveOpens - 1);
      if (deps.closeDatabase) await deps.closeDatabase(database);
      else await database.destroy();
    }
  }

  async function loadNonTerminal(source: SupervisorProjectSource, now: number): Promise<void> {
    await withSourceDatabase(source, async (database) => {
      const rows = await database("o_tasks")
        .where("state", "进行中")
        .whereIn("generationStatus", ["polling", "temporary_failure", "pending_finalize"])
        .whereNotNull("remoteTaskId")
        .whereNotNull("provider")
        .select("*");
      for (const row of rows) {
        const taskId = Number(row.id);
        const remoteTaskId = String(row.remoteTaskId ?? "").trim();
        if (!Number.isSafeInteger(taskId) || !remoteTaskId) continue;
        const key = runtimeKey(source.projectUuid, taskId);
        const previous = runtime.get(key);
        runtime.set(key, asMinimal({
          accountKey: deps.accountKey,
          projectUuid: source.projectUuid,
          localProjectId: source.localProjectId,
          taskId,
          remoteTaskId,
          taskClass: row.taskClass ? String(row.taskClass) : undefined,
          provider: String(row.provider),
          state: String(row.generationStatus ?? "polling"),
          nextPollAt: now,
          retryCount: previous?.retryCount ?? 0,
        }));
      }
    });
  }

  async function recoverSource(source: SupervisorProjectSource, now: number): Promise<void> {
    await withSourceDatabase(source, async (database) => {
      const previousByRemoteTask = new Map(
        [...runtime.values()]
          .filter((task) => task.projectUuid === source.projectUuid)
          .map((task) => [`${task.provider}:${task.remoteTaskId}`, task] as const),
      );
      await recoverGenerationTasks(database, poller, now, {
        shouldPoll(task) {
          const previous = previousByRemoteTask.get(`${task.provider}:${task.remoteTaskId}`);
          return !previous || previous.nextPollAt <= now;
        },
      });
      const rows = await database("o_tasks")
        .whereNotNull("remoteTaskId")
        .select("id", "generationStatus", "state", "remoteTaskId", "provider", "taskClass");
      const seen = new Set<string>();
      for (const row of rows) {
        const taskId = Number(row.id);
        const key = runtimeKey(source.projectUuid, taskId);
        const generationStatus = String(row.generationStatus ?? "");
        if (!ACTIVE_GENERATION.has(generationStatus) || row.state !== "进行中") {
          runtime.delete(key);
          continue;
        }
        seen.add(key);
        const previous = runtime.get(key);
        if (previous && previous.nextPollAt > now) {
          // 中文注释：任务仍在退避窗口内，保持原截止时间和重试次数。
          runtime.set(key, previous);
          continue;
        }
        const retryCount = generationStatus === "temporary_failure"
          ? (previous?.retryCount ?? 0) + 1
          : previous?.retryCount ?? 0;
        runtime.set(key, asMinimal({
          accountKey: deps.accountKey,
          projectUuid: source.projectUuid,
          localProjectId: source.localProjectId,
          taskId,
          remoteTaskId: String(row.remoteTaskId),
          taskClass: row.taskClass ? String(row.taskClass) : undefined,
          provider: String(row.provider ?? ""),
          state: generationStatus,
          nextPollAt: generationStatus === "temporary_failure" ? now + retryDelayMs : now,
          retryCount,
        }));
      }
      for (const key of [...runtime.keys()]) {
        if (key.startsWith(`${source.projectUuid}:`) && !seen.has(key)) {
          runtime.delete(key);
        }
      }
    });
    const stillRunning = [...runtime.values()].some((task) => task.projectUuid === source.projectUuid);
    if (!stillRunning && deps.onProjectIdle) {
      await deps.onProjectIdle(source.projectUuid);
    }
  }

  return {
    async restoreFromPersistence() {
      if (stopped) return;
      const now = deps.now();
      runtime.clear();
      for (const source of await deps.listSources()) {
        try {
          await loadNonTerminal(source, now);
        } catch {
          // 中文注释：单个损坏或被锁定的项目库不得阻断同账号其他项目恢复。
        }
      }
    },
    tick(now = deps.now()): Promise<void> {
      if (stopped || paused) return Promise.resolve();
      if (activeTick) return activeTick;
      const cycle = (async () => {
        void hiddenToTray;
        for (const source of await deps.listSources()) {
          try {
            await recoverSource(source, now);
          } catch {
            // 中文注释：每个项目源独立隔离；错误保留到下个周期重试。
          }
        }
      })();
      // 中文注释：setInterval 可能重入；整个恢复周期只允许一个在途 Promise。
      const settled = cycle.finally(() => {
        if (activeTick === settled) activeTick = undefined;
      });
      activeTick = settled;
      return settled;
    },
    notifyProjectSwitch(_fromProjectUuid, _toProjectUuid) {
      // 切换项目不是取消；不得向供应商发送 cancel，也不得重提。
    },
    notifyWindowHiddenToTray() {
      hiddenToTray = true;
    },
    async notifyExplicitShutdown() {
      stopped = true;
      paused = true;
      await activeTick?.catch(() => undefined);
      runtime.clear();
      for (const database of [...ownedConnections]) {
        try {
          if (deps.closeDatabase) await deps.closeDatabase(database);
          else await database.destroy();
        } catch {
          // ignore
        }
      }
      ownedConnections.clear();
      liveOpens = 0;
    },
    pause() {
      paused = true;
    },
    resume() {
      if (!stopped) paused = false;
    },
    listRuntimeTasks() {
      return [...runtime.values()].map(asMinimal);
    },
    runtimeCount() {
      return runtime.size;
    },
    fullProjectStoreCount() {
      return 0;
    },
    openDatabaseCount() {
      return liveOpens;
    },
    pollCount() {
      return polls;
    },
    submitCount() {
      return 0;
    },
    cancelCount() {
      return 0;
    },
    hasForbiddenPayload() {
      for (const task of runtime.values()) {
        const keys = Object.keys(task);
        if (keys.some((key) => FORBIDDEN_RUNTIME_KEY.test(key))) return true;
        if (keys.some((key) => !(MINIMAL_TASK_RUNTIME_KEYS as readonly string[]).includes(key))) {
          return true;
        }
        const serialized = JSON.stringify(task);
        if (FORBIDDEN_RUNTIME_KEY.test(serialized) || serialized.includes("data:")) return true;
      }
      return false;
    },
  };
}

let processSupervisor: BackgroundTaskSupervisor | undefined;

export function setProcessBackgroundTaskSupervisor(supervisor: BackgroundTaskSupervisor | undefined): void {
  processSupervisor = supervisor;
}

export function getProcessBackgroundTaskSupervisor(): BackgroundTaskSupervisor | undefined {
  return processSupervisor;
}

export async function stopProcessBackgroundTaskSupervisor(): Promise<void> {
  if (!processSupervisor) return;
  await processSupervisor.notifyExplicitShutdown();
  processSupervisor = undefined;
}
