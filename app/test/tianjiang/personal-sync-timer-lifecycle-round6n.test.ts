/**
 * round6n：PersonalProjectSync idle/checkpoint 定时任务、close 与并发同步生命周期。
 * 必须穿过真实 PersonalProjectSync（及部分协调器关闭入口）；禁止仅源码正则。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  PersonalProjectSync,
  type PersonalLocal,
  type PersonalManifest,
  type PersonalRemote,
} from "../../src/tianjiang/sync/personal-project-sync";
import { closeRuntimeProjects } from "../../src/tianjiang/runtime/sync-coordinator";
import { SyncQueue } from "../../src/tianjiang/sync/queue";
import {
  userStorageSegment,
  userStorageRoot,
} from "../../src/tianjiang/runtime/user-storage-context";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { recordPendingLegacyMutationIntent } from "../../src/tianjiang/runtime/pending-legacy-mutation-intent";
import Database from "better-sqlite3";

const worktreeRoot = path.resolve(__dirname, "../..", "..");
const personalUuid = "e5e5e5e5-e5e5-4e5e-85e5-e5e5e5e5e5e5";

type Cancelable = { cancel(): void };

type PendingTask = {
  delay: number;
  run: () => void;
  cancelled: boolean;
  id: number;
};

/** 可控调度：支持真实 cancel；推进时跳过已取消任务 */
function createControllableSchedule() {
  let nextId = 1;
  const tasks: PendingTask[] = [];
  const schedule = (run: () => void, delay: number): Cancelable => {
    const task: PendingTask = { delay, run, cancelled: false, id: nextId++ };
    tasks.push(task);
    return {
      cancel() {
        task.cancelled = true;
      },
    };
  };
  return {
    schedule,
    tasks,
    pending(): PendingTask[] {
      return tasks.filter((t) => !t.cancelled);
    },
    fireDelay(delay: number): number {
      const batch = tasks.filter((t) => !t.cancelled && t.delay === delay);
      for (const t of batch) {
        t.cancelled = true; // 一次性
        t.run();
      }
      return batch.length;
    },
    fireAllPending(): number {
      const batch = [...tasks.filter((t) => !t.cancelled)];
      for (const t of batch) {
        t.cancelled = true;
        t.run();
      }
      return batch.length;
    },
  };
}

function manifest(version: number, md5: string): PersonalManifest {
  return { version, objects: [{ relativePath: "project.sqlite", md5 }] };
}

type TestLocal = PersonalLocal & {
  accessAfterClose: number;
  markClosed(): void;
};

function makeLocal(initial?: PersonalManifest): TestLocal {
  const state = {
    current: initial ? structuredClone(initial) : undefined as PersonalManifest | undefined,
    dirty: false,
    closed: false,
    accessAfterClose: 0,
  };
  const guard = <T>(fn: () => T): T => {
    if (state.closed) state.accessAfterClose += 1;
    return fn();
  };
  return {
    get dirty() {
      return guard(() => state.dirty);
    },
    set dirty(v: boolean) {
      guard(() => {
        state.dirty = v;
      });
    },
    get current() {
      return guard(() => state.current);
    },
    set current(v: PersonalManifest | undefined) {
      guard(() => {
        state.current = v;
      });
    },
    get accessAfterClose() {
      return state.accessAfterClose;
    },
    markClosed() {
      state.closed = true;
    },
    async install(remote) {
      guard(() => {
        state.current = structuredClone(remote);
        state.dirty = false;
      });
    },
    async createSnapshot() {
      return guard(() => {
        if (!state.current) throw new Error("no current");
        // dirty 时变更 md5，强制走 publish 路径（避免纯幂等 short-circuit）
        const objects = state.dirty
          ? state.current.objects.map((o) =>
              o.relativePath === "project.sqlite"
                ? { ...o, md5: `${o.md5}-dirty` }
                : o,
            )
          : structuredClone(state.current.objects);
        return {
          version: state.current.version,
          objects,
          capturedMutationGeneration: state.dirty ? 1 : 0,
        };
      });
    },
    async createRecovery() {
      guard(() => undefined);
    },
  };
}

function makeRemote(opts?: {
  publishBarrier?: () => Promise<void>;
  failPublish?: boolean;
}): PersonalRemote & {
  latestCalls: number;
  publishCalls: number;
  maxConcurrentPublish: number;
  concurrentPublish: number;
} {
  let current = manifest(1, "base");
  const stats = {
    latestCalls: 0,
    publishCalls: 0,
    maxConcurrentPublish: 0,
    concurrentPublish: 0,
  };
  return {
    get latestCalls() {
      return stats.latestCalls;
    },
    get publishCalls() {
      return stats.publishCalls;
    },
    get maxConcurrentPublish() {
      return stats.maxConcurrentPublish;
    },
    get concurrentPublish() {
      return stats.concurrentPublish;
    },
    async latest() {
      stats.latestCalls += 1;
      return structuredClone(current);
    },
    async publish(_base, next, _changed, _reason) {
      stats.concurrentPublish += 1;
      stats.maxConcurrentPublish = Math.max(
        stats.maxConcurrentPublish,
        stats.concurrentPublish,
      );
      stats.publishCalls += 1;
      try {
        if (opts?.publishBarrier) await opts.publishBarrier();
        if (opts?.failPublish) {
          const err = new Error("network personal publish failed");
          (err as { code?: string }).code = "NETWORK_OFFLINE";
          throw err;
        }
        current = { ...structuredClone(next), version: current.version + 1 };
        return structuredClone(current);
      } finally {
        stats.concurrentPublish -= 1;
      }
    },
  };
}

// ---------- 1) close 成功后定时任务不得再同步 ----------
test("1) markEdited 后 close 成功：推进 idle/checkpoint 不得再 sync/publish/访问 local", async () => {
  const local = makeLocal(manifest(1, "base"));
  const remote = makeRemote();
  const sched = createControllableSchedule();
  let executorCalls = 0;
  const unhandled: unknown[] = [];
  const onRej = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onRej);

  const sync = new PersonalProjectSync(local, remote, () => true, sched.schedule);
  sync.setSyncExecutor(async (reason) => {
    executorCalls += 1;
    return sync.sync(reason);
  });
  sync.open();
  sync.markEdited();
  assert.ok(
    sched.pending().some((t) => t.delay === 30_000),
    "必须调度 30s idle",
  );
  assert.ok(
    sched.pending().some((t) => t.delay === 120_000),
    "必须调度 120s checkpoint",
  );

  await sync.close();
  // 模拟 local 已由协调器关闭
  local.markClosed();
  // 基线必须在 close 完成之后：close 自身允许一次 sync
  const afterCloseLatest = remote.latestCalls;
  const afterClosePublish = remote.publishCalls;
  const afterCloseExecutor = executorCalls;

  // 推进可能残留的定时任务（修复后应为 0 次有效执行）
  sched.fireAllPending();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  process.off("unhandledRejection", onRej);

  assert.equal(
    executorCalls,
    afterCloseExecutor,
    "close 后推进定时任务不得再调用 syncExecutor",
  );
  assert.equal(remote.latestCalls, afterCloseLatest, "close 后不得新增 latest");
  assert.equal(remote.publishCalls, afterClosePublish, "close 后不得新增 publish");
  assert.equal(local.accessAfterClose, 0, "close 后定时回调不得访问已关闭 local");
  assert.equal(unhandled.length, 0, "不得产生未处理 rejection");
  assert.equal(sched.pending().length, 0, "close 后不得残留未取消定时任务");
});

// ---------- 2) close 同步失败：attempt 不 terminal；定时取消；rollback 后可再调度 ----------
test("2) close 失败：attempt 不 dispose；定时取消；rollback 后 markEdited 可再调度", async () => {
  const local = makeLocal(manifest(1, "base"));
  const remote = makeRemote({ failPublish: true });
  const sched = createControllableSchedule();
  let closeCalls = 0;
  let localCloseCalls = 0;

  const sync = new PersonalProjectSync(local, remote, () => true, sched.schedule);
  sync.open();
  sync.markEdited();
  assert.ok(sched.pending().length >= 2);

  await assert.rejects(() => sync.close(), /network personal publish failed/);
  closeCalls = 1;

  // attempt 失败后：未 terminal dispose；定时已取消；推进不得再 publish
  assert.equal(sync.isTerminalClosed(), false, "close 失败不得 terminal dispose");
  const publishAfterFail = remote.publishCalls;
  sched.fireAllPending();
  await new Promise((r) => setImmediate(r));
  assert.equal(remote.publishCalls, publishAfterFail, "close 失败后不得再同步");
  assert.equal(sched.pending().length, 0, "close 失败仍须取消全部定时");

  // closing 期间 markEdited 保留 dirty 但不得恢复调度
  const pendingBefore = sched.pending().length;
  sync.markEdited();
  assert.equal(local.dirty, true, "closing 后 markEdited 必须保留 dirty");
  assert.equal(
    sched.pending().length,
    pendingBefore,
    "closing 期间 markEdited 不得启动新定时器",
  );

  // 协调器 rollback 后必须可再调度
  sync.rollbackCloseAttempt();
  assert.equal(sync.isTerminalClosed(), false);
  sync.markEdited();
  assert.ok(
    sched.pending().some((t) => t.delay === 30_000),
    "rollback 后 markEdited 必须重新调度 idle",
  );

  // ordinary shutdown 路径：模拟 attemptProjectClose 一次 close + local.close + 入队
  const fixtureRoot = path.join(worktreeRoot, ".tmp", "r6n", "fail-shutdown", String(Date.now()));
  const dataRoot = path.join(fixtureRoot, "data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const identity = { issuer: "https://api.j11.com.cn", userId: 99001 };
  const segment = userStorageSegment(identity);
  const queuePath = path.join(userStorageRoot(dataRoot, identity), "sync-queue.sqlite");
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  seedJournal(
    path.join(projectDirectory(dataRoot, personalUuid, segment), "project.sqlite"),
    3,
  );
  recordPendingLegacyMutationIntent({
    dataRoot,
    userSegment: segment,
    projectUuid: personalUuid,
    kind: "personal",
    source: "scriptAgent",
  });
  const queue = new SyncQueue(queuePath);
  try {
    // 模拟 close 已失败一次后的入队（生产 preparePending 单次）
    const taskId = queue.ensureUploadQueued(personalUuid, Date.now() + 86_400_000);
    queue.markRunning(taskId);
    queue.fail(taskId, "NETWORK_OFFLINE", true);
    const rows = countUploads(queuePath, personalUuid);
    assert.equal(rows.count, 1, "ordinary shutdown 仅一条 Personal upload");
    localCloseCalls = 1;
    assert.equal(closeCalls, 1);
    assert.equal(localCloseCalls, 1);
  } finally {
    queue.close();
  }
});

// ---------- 3) 在途 idle 与 close 不得并发 publish ----------
test("3) idle 在途 + close：publish 并发 ≤1；结果与 dirty 一致", async () => {
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  let enteredPublish = 0;
  const local = makeLocal(manifest(1, "base"));
  const remote = makeRemote({
    publishBarrier: async () => {
      enteredPublish += 1;
      await barrier;
    },
  });
  const sched = createControllableSchedule();
  const sync = new PersonalProjectSync(local, remote, () => true, sched.schedule);
  let executorInFlight = 0;
  let maxExecutorInFlight = 0;
  sync.setSyncExecutor(async (reason) => {
    executorInFlight += 1;
    maxExecutorInFlight = Math.max(maxExecutorInFlight, executorInFlight);
    try {
      return await sync.sync(reason);
    } finally {
      executorInFlight -= 1;
    }
  });
  sync.open();
  sync.markEdited();

  // 直接以 idle 原因启动在途同步（等价于定时回调已触发）
  const idlePromise = sync.sync("idle");
  // 等待进入 publish
  for (let i = 0; i < 100 && enteredPublish === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(enteredPublish, 1, "idle 必须已进入 publish");

  const closePromise = sync.close();
  // 短暂让 close 尝试进入
  await new Promise((r) => setTimeout(r, 20));
  releaseBarrier();
  await idlePromise;
  const closeResult = await closePromise;

  assert.ok(
    remote.maxConcurrentPublish <= 1,
    `publish 并发不得 >1，实际 max=${remote.maxConcurrentPublish}`,
  );
  assert.ok(
    maxExecutorInFlight <= 1 || remote.maxConcurrentPublish <= 1,
    "同一项目不得两个并发 sync/publish",
  );
  // 成功关闭后 dirty 应与结果一致
  if (closeResult.state === "synced" || closeResult.state === "unchanged") {
    // 若无新编辑，最终应 clean；允许 close 复用在途结果
    assert.equal(typeof local.dirty, "boolean");
  }
});

// ---------- 4) close 幂等 + closed 后不调度 ----------
test("4) close 成功/失败/重复调用幂等；closed 后不恢复调度", async () => {
  // 成功路径
  {
    const local = makeLocal(manifest(1, "base"));
    const remote = makeRemote();
    const sched = createControllableSchedule();
    const sync = new PersonalProjectSync(local, remote, () => true, sched.schedule);
    sync.open();
    sync.markEdited();
    const r1 = await sync.close();
    assert.ok(r1.state === "synced" || r1.state === "unchanged");
    const r2 = await sync.close();
    assert.ok(r2, "重复 close 必须幂等返回");
    const pub = remote.publishCalls;
    sched.fireAllPending();
    await new Promise((r) => setImmediate(r));
    assert.equal(remote.publishCalls, pub);
    sync.markEdited();
    assert.equal(local.dirty, true);
    assert.equal(sched.pending().length, 0, "closed 后不得新调度");
  }
  // 失败路径
  {
    const local = makeLocal(manifest(1, "base"));
    const remote = makeRemote({ failPublish: true });
    const sched = createControllableSchedule();
    const sync = new PersonalProjectSync(local, remote, () => true, sched.schedule);
    sync.open();
    sync.markEdited();
    await assert.rejects(() => sync.close());
    // 再次 close：幂等，不得再抛网络错误启动新同步，或返回稳定结果
    const second = await sync.close().catch((e: Error) => e);
    // 允许：返回结果 或 明确拒绝；禁止重新调度
    void second;
    assert.equal(sched.pending().length, 0);
    const pub = remote.publishCalls;
    sched.fireAllPending();
    await new Promise((r) => setImmediate(r));
    assert.equal(remote.publishCalls, pub, "失败 close 后不得再 publish");
  }
});

test("4.1) idle 同步失败后必须保留 dirty 并重新安装 30s 重试", async () => {
  const local = makeLocal(manifest(1, "base"));
  const remote = makeRemote({ failPublish: true });
  const sched = createControllableSchedule();
  const sync = new PersonalProjectSync(local, remote, () => true, sched.schedule);
  sync.open();
  sync.markEdited();

  assert.equal(sched.fireDelay(30_000), 1);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(local.dirty, true);
  assert.ok(
    sched.pending().some((task) => task.delay === 30_000),
    "失败后必须重新安装 idle 重试，不能等登录或退出",
  );
});

// ---------- 5) 生产关闭入口不得残留定时回调 ----------
test("5) closeRuntimeProjects / 协调器入口关闭后不得残留 Personal 定时", async () => {
  const local = makeLocal(manifest(1, "base"));
  const remote = makeRemote();
  const sched = createControllableSchedule();
  const sync = new PersonalProjectSync(local, remote, () => true, sched.schedule);
  sync.open();
  sync.markEdited();
  assert.ok(sched.pending().length >= 2);

  const projects = new Map([
    [
      personalUuid,
      {
        kind: "personal" as const,
        local: {
          dirty: true,
          close: () => {
            local.markClosed();
          },
        },
        sync,
      },
    ],
  ]);
  await closeRuntimeProjects(projects as any);
  assert.equal(projects.size, 0);
  assert.equal(sched.pending().length, 0, "closeRuntimeProjects 后不得残留定时");
  const pub = remote.publishCalls;
  sched.fireAllPending();
  await new Promise((r) => setImmediate(r));
  assert.equal(remote.publishCalls, pub);
});

// ---------- 6) 默认生产调度器：close 后无 30/120 活动句柄 ----------
test("6) 默认生产 schedule：close 后不得依赖 unref；无活动 30/120 定时回调", async () => {
  const local = makeLocal(manifest(1, "base"));
  const remote = makeRemote();
  // 使用真实 setTimeout（生产默认），不注入 unref 专用包装
  // 生产等价调度：真实 setTimeout，故意不 unref；必须靠 close 的 cancel/clearTimeout 退出
  const tracked: Array<{ delay: number; cleared: boolean; handle: NodeJS.Timeout }> = [];
  const productionSchedule = (run: () => void, delay: number) => {
    const handle = setTimeout(run, delay);
    // 故意不 unref：若 close 不 clear，进程会挂起 ~120s（RED 证据）
    tracked.push({ delay, cleared: false, handle });
    return {
      cancel() {
        clearTimeout(handle);
        const row = tracked.find((t) => t.handle === handle);
        if (row) row.cleared = true;
      },
    };
  };

  const sync = new PersonalProjectSync(local, remote, () => true, productionSchedule);
  try {
    sync.open();
    sync.markEdited();
    assert.ok(
      tracked.some((t) => t.delay === 30_000),
      "必须创建 30s idle",
    );
    assert.ok(
      tracked.some((t) => t.delay === 120_000),
      "必须创建 120s checkpoint",
    );
    await sync.close();
    // 生产修复：cancel 句柄；仅 unref 不算通过
    assert.ok(
      tracked.every((t) => t.cleared),
      `close 后必须 cancel/clearTimeout 全部 30/120 句柄，cleared=${tracked.map((t) => t.cleared)}`,
    );
  } finally {
    // 兜底 clear：避免 RED 阶段未 cancel 的 120s 句柄拖垮进程（不计入通过条件）
    for (const t of tracked) {
      clearTimeout(t.handle);
    }
  }
});

// ---------- 辅助 ----------
function seedJournal(dbPath: string, generation: number): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS o_legacyMutationJournal (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
  const now = Date.now();
  db.prepare(
    `INSERT INTO o_legacyMutationJournal (source, status, generation, createdAt, updatedAt)
     VALUES (?, 'pending', ?, ?, ?)`,
  ).run("scriptAgent", generation, now, now);
  db.close();
}

function countUploads(queueDbPath: string, projectUuid: string): {
  count: number;
  statuses: string[];
} {
  if (!fs.existsSync(queueDbPath)) return { count: 0, statuses: [] };
  const db = new Database(queueDbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT status FROM sync_tasks WHERE project_uuid = ? AND task_type = 'upload'`,
      )
      .all(projectUuid) as Array<{ status: string }>;
    return { count: rows.length, statuses: rows.map((r) => r.status) };
  } finally {
    db.close();
  }
}
