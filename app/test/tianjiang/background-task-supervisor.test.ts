/**
 * RED→GREEN：后台任务监督器拥有已提交任务；项目切换不得取消、重提或保留完整项目缓存。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import {
  aggregateTaskCenterList,
  type TaskCenterProjectSource,
} from "../../src/tianjiang/tasks/task-center-aggregation";
import type {
  GenerationTaskIdentity,
  RemoteGenerationResult,
} from "../../src/tianjiang/tasks/generation-task-recovery";
import { stringifyGenerationCompletionContract, createGenerationCompletionContract } from "../../src/tianjiang/tasks/generation-completion-contract";
import { installManagedStaging } from "./helpers/managed-generation-staging";

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = 2_000_000_000_000;
const HOUR = 60 * 60 * 1000;
const FIXTURE_MP4 = path.resolve(__dirname, "fixtures", "minimal-adoptable.mp4");

function completedVideo(localPath = FIXTURE_MP4): RemoteGenerationResult {
  return {
    state: "completed",
    artifact: {
      mediaType: "video",
      sourceKind: "local_path",
      localPath,
    },
  };
}

const SUPERVISOR_SPEC = "../../src/tianjiang/tasks/background-task-supervisor";

interface SupervisorModule {
  createBackgroundTaskSupervisor: (deps: Record<string, unknown>) => Supervisor;
  MINIMAL_TASK_RUNTIME_KEYS?: string[];
}

interface Supervisor {
  restoreFromPersistence(): Promise<void>;
  tick(now?: number): Promise<void>;
  notifyProjectSwitch(fromProjectUuid: string | null, toProjectUuid: string | null): void;
  notifyWindowHiddenToTray(): void;
  notifyExplicitShutdown(): Promise<void>;
  listRuntimeTasks(): Array<Record<string, unknown>>;
  runtimeCount(): number;
  fullProjectStoreCount(): number;
  openDatabaseCount(): number;
  pollCount(): number;
  submitCount(): number;
  cancelCount(): number;
  hasForbiddenPayload(): boolean;
}

async function loadSupervisor(): Promise<SupervisorModule> {
  return import(SUPERVISOR_SPEC) as Promise<SupervisorModule>;
}

async function createProjectDatabase(root: string, name: string): Promise<Knex> {
  const filename = path.join(root, name);
  const database = knex({
    client: "better-sqlite3",
    connection: { filename },
    useNullAsDefault: true,
  });
  await database.schema.createTable("o_tasks", (table) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.string("state");
    table.text("reason");
    table.string("provider");
    table.string("remoteTaskId");
    table.string("projectUuid");
    table.string("requestDigest");
    table.string("taskClass");
    table.integer("createdAt");
    table.integer("lastPollAt");
    table.string("generationStatus");
    table.integer("manualRetryRequired");
    table.integer("recoveryAttemptedAt");
    table.integer("startTime");
    table.string("model");
    table.text("describe");
    table.text("relatedObjects");
    table.text("resultLocator");
  });
  await database.schema.createTable("o_video", (table) => {
    table.integer("id").primary();
    table.text("filePath");
    table.string("state");
    table.text("errorReason");
  });
  return database;
}

async function insertTask(
  database: Knex,
  input: {
    id: number;
    projectUuid: string;
    remoteTaskId: string;
    state?: string;
    generationStatus?: string;
    createdAt?: number;
  },
): Promise<void> {
  await database("o_tasks").insert({
    id: input.id,
    projectId: 1,
    state: input.state ?? "进行中",
    provider: "synthetic-provider",
    remoteTaskId: input.remoteTaskId,
    projectUuid: input.projectUuid,
    requestDigest: "a".repeat(64),
    taskClass: "视频生成",
    createdAt: input.createdAt ?? NOW - HOUR,
    startTime: input.createdAt ?? NOW - HOUR,
    generationStatus: input.generationStatus ?? "polling",
    manualRetryRequired: 0,
    model: "fake-model",
    describe: "fixture",
    relatedObjects: stringifyGenerationCompletionContract(createGenerationCompletionContract({
      kind: "video",
      mediaType: "video",
      videoId: input.id,
      relativePath: `files/videos/task-${input.id}.mp4`,
    })),
  });
  await database("o_video").insert({ id: input.id, filePath: "", state: "生成中" });
}

function fixtureRoot(label: string): string {
  const root = path.join(process.cwd(), "..", ".tmp", `bg-supervisor-${label}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function fakePoller() {
  const polls: GenerationTaskIdentity[] = [];
  const submits: string[] = [];
  const cancels: string[] = [];
  const outcomes = new Map<string, RemoteGenerationResult>();
  return {
    polls,
    submits,
    cancels,
    outcomes,
    poll: async (task: GenerationTaskIdentity): Promise<RemoteGenerationResult> => {
      polls.push(task);
      return outcomes.get(task.remoteTaskId) ?? { state: "pending" };
    },
    submit(remoteTaskId: string): void {
      submits.push(remoteTaskId);
    },
    cancel(remoteTaskId: string): void {
      cancels.push(remoteTaskId);
    },
  };
}

test("项目A两个运行任务切到B后仍由监督器持有，且不取消、不重提、不保留完整项目 Store", async () => {
  const root = fixtureRoot("switch");
  const dbA = await createProjectDatabase(root, "a.sqlite");
  const dbB = await createProjectDatabase(root, "b.sqlite");
  const poller = fakePoller();
  try {
    await insertTask(dbA, { id: 1, projectUuid: UUID_A, remoteTaskId: "remote-a-1" });
    await insertTask(dbA, { id: 2, projectUuid: UUID_A, remoteTaskId: "remote-a-2" });
    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    const liveOpens = { count: 0 };
    const supervisor = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:1",
      now: () => NOW,
      poll: poller.poll,
      listSources: async () => [
        { projectUuid: UUID_A, localProjectId: 501, database: dbA },
        { projectUuid: UUID_B, localProjectId: 502, database: dbB },
      ],
      openDatabase: async () => {
        liveOpens.count += 1;
        throw new Error("已注入数据库时不得再开新连接");
      },
      closeDatabase: async () => {
        liveOpens.count = Math.max(0, liveOpens.count - 1);
      },
    });
    await supervisor.restoreFromPersistence();
    assert.equal(supervisor.runtimeCount(), 2);
    supervisor.notifyProjectSwitch(UUID_A, UUID_B);
    assert.equal(supervisor.runtimeCount(), 2, "切换项目不得丢掉已提交后台任务");
    assert.equal(supervisor.fullProjectStoreCount(), 0, "后台不得为已关闭项目保留完整 Store");
    assert.equal(poller.cancels.length, 0);
    assert.equal(poller.submits.length, 0);
    assert.equal(supervisor.cancelCount(), 0);
    assert.equal(supervisor.submitCount(), 0);
    assert.equal(supervisor.hasForbiddenPayload(), false);
    const keys = new Set(Object.keys(supervisor.listRuntimeTasks()[0] ?? {}));
    for (const forbidden of ["base64", "blob", "file", "imageBitmap", "messages", "flowData", "assets", "rawResponse"]) {
      assert.equal(keys.has(forbidden), false, `运行态不得包含 ${forbidden}`);
    }
  } finally {
    await dbA.destroy();
    await dbB.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A任务完成后结果写入持久层，后台运行态归零，不再保留项目缓存", async () => {
  const root = fixtureRoot("complete");
  const staging = installManagedStaging(root);
  const dbA = await createProjectDatabase(root, "a.sqlite");
  const poller = fakePoller();
  poller.outcomes.set("remote-a-1", completedVideo(staging.stage(FIXTURE_MP4)));
  poller.outcomes.set("remote-a-2", completedVideo(staging.stage(FIXTURE_MP4)));
  try {
    await insertTask(dbA, { id: 1, projectUuid: UUID_A, remoteTaskId: "remote-a-1" });
    await insertTask(dbA, { id: 2, projectUuid: UUID_A, remoteTaskId: "remote-a-2" });
    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    const supervisor = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:1",
      now: () => NOW,
      poll: poller.poll,
      listSources: async () => [{ projectUuid: UUID_A, localProjectId: 501, database: dbA }],
    });
    await supervisor.restoreFromPersistence();
    supervisor.notifyProjectSwitch(UUID_A, UUID_B);
    await supervisor.tick(NOW);
    assert.equal(supervisor.runtimeCount(), 0);
    assert.equal(supervisor.fullProjectStoreCount(), 0);
    const rows = await dbA("o_tasks").orderBy("id");
    assert.equal(rows[0].state, "已完成");
    assert.equal(rows[0].generationStatus, "completed");
    assert.equal(rows[1].state, "已完成");
    assert.equal(poller.submits.length, 0);
    assert.equal(supervisor.openDatabaseCount(), 0, "终态后必须关闭短生命周期数据库连接");
  } finally {
    staging.dispose();
    await dbA.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("任务失败或取消后同样清理运行态并停止轮询", async () => {
  const root = fixtureRoot("fail");
  const dbA = await createProjectDatabase(root, "a.sqlite");
  const poller = fakePoller();
  poller.outcomes.set("remote-fail", { state: "failed", reason: "vendor failed" });
  poller.outcomes.set("remote-missing", { state: "not_found" });
  try {
    await insertTask(dbA, { id: 1, projectUuid: UUID_A, remoteTaskId: "remote-fail" });
    await insertTask(dbA, { id: 2, projectUuid: UUID_A, remoteTaskId: "remote-missing" });
    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    const supervisor = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:1",
      now: () => NOW,
      poll: poller.poll,
      listSources: async () => [{ projectUuid: UUID_A, localProjectId: 501, database: dbA }],
    });
    await supervisor.restoreFromPersistence();
    await supervisor.tick(NOW);
    assert.equal(supervisor.runtimeCount(), 0);
    const rows = await dbA("o_tasks").orderBy("id");
    assert.equal(rows[0].state, "生成失败");
    assert.equal(rows[1].state, "生成失败");
    const pollsBefore = poller.polls.length;
    await supervisor.tick(NOW + 30_000);
    assert.equal(poller.polls.length, pollsBefore, "终态后不得继续轮询");
  } finally {
    await dbA.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("temporary_failure 按现有合同重试，但不保留完整项目 Store", async () => {
  const root = fixtureRoot("tmpfail");
  const dbA = await createProjectDatabase(root, "a.sqlite");
  const poller = fakePoller();
  poller.outcomes.set("remote-tmp", { state: "temporary_error", reason: "ETIMEDOUT" });
  try {
    await insertTask(dbA, { id: 1, projectUuid: UUID_A, remoteTaskId: "remote-tmp" });
    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    const supervisor = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:1",
      now: () => NOW,
      poll: poller.poll,
      listSources: async () => [{ projectUuid: UUID_A, localProjectId: 501, database: dbA }],
      retryDelayMs: 5_000,
    });
    await supervisor.restoreFromPersistence();
    supervisor.notifyProjectSwitch(UUID_A, UUID_B);
    await supervisor.tick(NOW);
    assert.equal(supervisor.runtimeCount(), 1);
    assert.equal(supervisor.fullProjectStoreCount(), 0);
    const row = await dbA("o_tasks").where("id", 1).first();
    assert.equal(row.state, "进行中");
    assert.equal(row.generationStatus, "temporary_failure");
    const runtime = supervisor.listRuntimeTasks()[0];
    assert.equal(runtime.remoteTaskId, "remote-tmp");
    assert.ok(Number(runtime.nextPollAt) >= NOW);
    assert.equal(poller.submits.length, 0);
  } finally {
    await dbA.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("temporary_failure 到达 nextPollAt 前不得重复查询供应商", async () => {
  const root = fixtureRoot("retry-deadline");
  const dbA = await createProjectDatabase(root, "a.sqlite");
  const poller = fakePoller();
  poller.outcomes.set("remote-deadline", { state: "temporary_error", reason: "ETIMEDOUT" });
  try {
    await insertTask(dbA, { id: 1, projectUuid: UUID_A, remoteTaskId: "remote-deadline" });
    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    const supervisor = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:1",
      now: () => NOW,
      poll: poller.poll,
      listSources: async () => [{ projectUuid: UUID_A, localProjectId: 501, database: dbA }],
      retryDelayMs: 5_000,
    });
    await supervisor.restoreFromPersistence();
    await supervisor.tick(NOW);
    const pollsAfterFailure = poller.polls.length;

    await supervisor.tick(NOW + 4_999);
    assert.equal(poller.polls.length, pollsAfterFailure, "退避期限前不得重复轮询同一远端任务");

    await supervisor.tick(NOW + 5_000);
    assert.equal(poller.polls.length, pollsAfterFailure + 1, "达到退避期限后才允许再次轮询");
  } finally {
    await dbA.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("同一轮 tick 尚未结束时不得并发重复查询同一远端任务", async () => {
  const root = fixtureRoot("single-flight");
  const dbA = await createProjectDatabase(root, "a.sqlite");
  let releasePoll: (() => void) | undefined;
  const pollStarted = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  let pollCount = 0;
  try {
    await insertTask(dbA, { id: 1, projectUuid: UUID_A, remoteTaskId: "remote-single-flight" });
    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    const supervisor = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:1",
      now: () => NOW,
      poll: async () => {
        pollCount += 1;
        await pollStarted;
        return { state: "pending" };
      },
      listSources: async () => [{ projectUuid: UUID_A, localProjectId: 501, database: dbA }],
    });
    await supervisor.restoreFromPersistence();

    const first = supervisor.tick(NOW);
    const second = supervisor.tick(NOW);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pollCount, 1, "监督器必须把重叠 tick 合并成同一个单飞任务");
    releasePoll?.();
    await Promise.all([first, second]);
  } finally {
    await dbA.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("超过恢复窗口的临时错误必须转人工重试并释放后台运行态", async () => {
  const root = fixtureRoot("expired-temporary");
  const dbA = await createProjectDatabase(root, "a.sqlite");
  try {
    await insertTask(dbA, {
      id: 1,
      projectUuid: UUID_A,
      remoteTaskId: "remote-expired-temporary",
      createdAt: NOW - 25 * HOUR,
    });
    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    const supervisor = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:1",
      now: () => NOW,
      poll: async () => ({ state: "temporary_error", reason: "ETIMEDOUT" }),
      listSources: async () => [{ projectUuid: UUID_A, localProjectId: 501, database: dbA }],
    });
    await supervisor.restoreFromPersistence();
    await supervisor.tick(NOW);

    const row = await dbA("o_tasks").where("id", 1).first();
    assert.equal(row.state, "生成失败");
    assert.equal(row.generationStatus, "manual_retry");
    assert.equal(row.manualRetryRequired, 1);
    assert.equal(supervisor.runtimeCount(), 0, "过期任务不得永久占用后台运行态");
  } finally {
    await dbA.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("项目任务恢复必须进入对应 projectUuid 上下文", async () => {
  const root = fixtureRoot("project-context");
  const dbA = await createProjectDatabase(root, "a.sqlite");
  let currentProjectUuid: string | null = null;
  const observedContexts: Array<string | null> = [];
  try {
    await insertTask(dbA, { id: 1, projectUuid: UUID_A, remoteTaskId: "remote-context" });
    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    const supervisor = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:1",
      now: () => NOW,
      poll: async () => {
        observedContexts.push(currentProjectUuid);
        return { state: "pending" };
      },
      listSources: async () => [{ projectUuid: UUID_A, localProjectId: 501, database: dbA }],
      runInProjectContext: async (projectUuid: string, run: () => Promise<unknown>) => {
        const previous = currentProjectUuid;
        currentProjectUuid = projectUuid;
        try {
          return await run();
        } finally {
          currentProjectUuid = previous;
        }
      },
    });
    await supervisor.restoreFromPersistence();
    await supervisor.tick(NOW);
    assert.deepEqual(observedContexts, [UUID_A]);
  } finally {
    await dbA.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("按需短暂打开项目库，tick 结束后连接数归零", async () => {
  const root = fixtureRoot("brief-open");
  const staging = installManagedStaging(root);
  const filename = path.join(root, "a.sqlite");
  const bootstrap = await createProjectDatabase(root, "a.sqlite");
  await insertTask(bootstrap, { id: 1, projectUuid: UUID_A, remoteTaskId: "remote-brief" });
  await bootstrap.destroy();
  const poller = fakePoller();
  poller.outcomes.set("remote-brief", completedVideo(staging.stage(FIXTURE_MP4)));
  const opened: Knex[] = [];
  try {
    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    const supervisor = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:1",
      now: () => NOW,
      poll: poller.poll,
      listSources: async () => [{ projectUuid: UUID_A, localProjectId: 501, databasePath: filename }],
      openDatabase: async (databasePath: string) => {
        const db = knex({
          client: "better-sqlite3",
          connection: { filename: databasePath },
          useNullAsDefault: true,
        });
        opened.push(db);
        return db;
      },
      closeDatabase: async (database: Knex) => {
        await database.destroy();
        const index = opened.indexOf(database);
        if (index >= 0) opened.splice(index, 1);
      },
    });
    await supervisor.restoreFromPersistence();
    await supervisor.tick(NOW);
    assert.equal(opened.length, 0);
    assert.equal(supervisor.openDatabaseCount(), 0);
    assert.equal(supervisor.runtimeCount(), 0);
  } finally {
    staging.dispose();
    await Promise.all(opened.map((db) => db.destroy().catch(() => undefined)));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("隐藏到托盘后后台任务继续；显式退出才停止监督器", async () => {
  const root = fixtureRoot("tray");
  const dbA = await createProjectDatabase(root, "a.sqlite");
  const poller = fakePoller();
  try {
    await insertTask(dbA, { id: 1, projectUuid: UUID_A, remoteTaskId: "remote-tray" });
    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    const supervisor = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:1",
      now: () => NOW,
      poll: poller.poll,
      listSources: async () => [{ projectUuid: UUID_A, localProjectId: 501, database: dbA }],
    });
    await supervisor.restoreFromPersistence();
    supervisor.notifyWindowHiddenToTray();
    await supervisor.tick(NOW);
    assert.equal(supervisor.runtimeCount(), 1);
    assert.ok(poller.polls.length >= 1, "隐藏到托盘后必须继续轮询");
    await supervisor.notifyExplicitShutdown();
    const pollsAfterStop = poller.polls.length;
    await supervisor.tick(NOW + 30_000);
    assert.equal(poller.polls.length, pollsAfterStop, "显式退出后不得继续轮询");
    assert.equal(supervisor.runtimeCount(), 0);
  } finally {
    await dbA.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("任务中心可以读取非当前项目任务", async () => {
  const root = fixtureRoot("task-center");
  const dbA = await createProjectDatabase(root, "a.sqlite");
  const dbB = await createProjectDatabase(root, "b.sqlite");
  const poller = fakePoller();
  try {
    await insertTask(dbA, { id: 11, projectUuid: UUID_A, remoteTaskId: "remote-center-a" });
    await insertTask(dbB, { id: 21, projectUuid: UUID_B, remoteTaskId: "remote-center-b", state: "已完成", generationStatus: "completed" });
    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    const supervisor = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:1",
      now: () => NOW,
      poll: poller.poll,
      listSources: async () => [
        { projectUuid: UUID_A, localProjectId: 501, database: dbA },
        { projectUuid: UUID_B, localProjectId: 502, database: dbB },
      ],
    });
    await supervisor.restoreFromPersistence();
    supervisor.notifyProjectSwitch(UUID_A, UUID_B);
    const sources: TaskCenterProjectSource[] = [
      {
        projectUuid: UUID_A,
        projectName: "A",
        legacyProjectId: 501,
        databasePath: path.join(root, "a.sqlite"),
      },
      {
        projectUuid: UUID_B,
        projectName: "B",
        legacyProjectId: 502,
        databasePath: path.join(root, "b.sqlite"),
      },
    ];
    const listed = aggregateTaskCenterList(sources, { page: 1, limit: 20 });
    assert.ok(listed.data.some((row) => row.projectUuid === UUID_A));
    assert.ok(listed.data.some((row) => row.projectUuid === UUID_B));
    assert.equal(supervisor.runtimeCount(), 1);
  } finally {
    await dbA.destroy();
    await dbB.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("连续切换 20 个项目时后台未完成任务可大于 0，完整项目 Store 必须为 0，打开连接不增长", async () => {
  const root = fixtureRoot("twenty");
  const databases: Knex[] = [];
  const poller = fakePoller();
  try {
    const sources: Array<{ projectUuid: string; localProjectId: number; database: Knex }> = [];
    for (let i = 0; i < 20; i += 1) {
      const projectUuid = `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, "0")}`;
      const database = await createProjectDatabase(root, `p${i}.sqlite`);
      databases.push(database);
      await insertTask(database, {
        id: 1,
        projectUuid,
        remoteTaskId: `remote-${i}`,
      });
      sources.push({ projectUuid, localProjectId: 7000 + i, database });
    }
    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    let openCount = 0;
    const supervisor = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:1",
      now: () => NOW,
      poll: poller.poll,
      listSources: async () => sources,
      openDatabase: async () => {
        openCount += 1;
        throw new Error("测试已注入数据库");
      },
      closeDatabase: async () => {
        openCount = Math.max(0, openCount - 1);
      },
    });
    await supervisor.restoreFromPersistence();
    const counts: number[] = [];
    for (const source of sources) {
      supervisor.notifyProjectSwitch(null, source.projectUuid);
      counts.push(supervisor.fullProjectStoreCount());
    }
    assert.ok(counts.every((value) => value === 0));
    assert.equal(supervisor.runtimeCount(), 20);
    assert.equal(supervisor.fullProjectStoreCount(), 0);
    assert.equal(openCount, 0);
    assert.equal(poller.submits.length, 0);
    assert.equal(poller.cancels.length, 0);
    assert.equal(supervisor.hasForbiddenPayload(), false);
  } finally {
    await Promise.all(databases.map((db) => db.destroy()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Socket 断开、路由卸载不得成为取消已提交任务的信号", async () => {
  const root = fixtureRoot("socket");
  const dbA = await createProjectDatabase(root, "a.sqlite");
  const poller = fakePoller();
  try {
    await insertTask(dbA, { id: 1, projectUuid: UUID_A, remoteTaskId: "remote-socket" });
    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    const supervisor = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:1",
      now: () => NOW,
      poll: poller.poll,
      listSources: async () => [{ projectUuid: UUID_A, localProjectId: 501, database: dbA }],
    });
    await supervisor.restoreFromPersistence();
    supervisor.notifyProjectSwitch(UUID_A, UUID_B);
    await supervisor.tick(NOW);
    assert.equal(supervisor.runtimeCount(), 1);
    assert.equal(poller.cancels.length, 0);
    assert.equal(supervisor.cancelCount(), 0);
  } finally {
    await dbA.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("单个损坏项目库不得阻断后续正常项目的恢复与轮询", async () => {
  const root = fixtureRoot("source-isolation");
  const badDb = knex({
    client: "better-sqlite3",
    connection: { filename: path.join(root, "bad.sqlite") },
    useNullAsDefault: true,
  });
  const goodDb = await createProjectDatabase(root, "good.sqlite");
  const polled: string[] = [];
  try {
    await insertTask(goodDb, { id: 1, projectUuid: UUID_B, remoteTaskId: "remote-good" });
    const { createBackgroundTaskSupervisor } = await loadSupervisor();
    const supervisor = createBackgroundTaskSupervisor({
      accountKey: "https://api.j11.com.cn:1",
      now: () => NOW,
      poll: async (task: GenerationTaskIdentity) => {
        polled.push(task.remoteTaskId);
        return { state: "pending" };
      },
      listSources: async () => [
        { projectUuid: UUID_A, localProjectId: 501, database: badDb },
        { projectUuid: UUID_B, localProjectId: 502, database: goodDb },
      ],
    });

    await supervisor.restoreFromPersistence();
    assert.equal(supervisor.runtimeCount(), 1);
    await supervisor.tick(NOW);
    assert.deepEqual(polled, ["remote-good"]);
  } finally {
    await badDb.destroy();
    await goodDb.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
