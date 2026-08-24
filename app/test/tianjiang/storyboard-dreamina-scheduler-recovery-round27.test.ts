/**
 * Round27 P1 RED：即梦调度器必须恢复领取窗口，并把账号终态幂等镜像到项目库。
 * 全部场景仅调用 fake CLI，禁止访问真实即梦或产生收费。
 */
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import getPath from "../../src/utils/getPath";
import {
  accountDb,
  accountDatabase,
  activateUserDatabase,
  db as activeDb,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { getStableDeviceUUID } from "../../src/tianjiang/auth/device";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { enqueueAsyncMediaTasks } from "../../src/tianjiang/model-providers/async-generation-service";
import { recoverDreaminaSlots } from "../../src/tianjiang/model-providers/dreamina-cli/recovery";
import {
  reapExpiredDreaminaClaims,
  reconcilePendingProjectTaskMirrors,
  stopDreaminaSchedulerLoop,
  tickDreaminaScheduler,
} from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import {
  pauseGenerationRuntime,
  resumeGenerationRuntime,
} from "../../src/tianjiang/tasks/generation-runtime-participants";
import {
  closeActivatedWorkspaceRuntime,
} from "./helpers/worktree-runtime";
import { writeReadyDreaminaTestCapability } from "./helpers/dreamina-capability";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9730 };
const PROJECT_UUID = "31313131-3131-4131-a131-313131313131";
const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");

function readSubmitCount(logFile: string): number {
  if (!fs.existsSync(logFile)) return 0;
  return fs.readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args?: string[] })
    .filter((entry) => entry.args?.[0] === "text2image")
    .length;
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await waitWithTimeout(new Promise<http.Server>((resolve, reject) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
    created.once("error", reject);
  }), 2_000, "测试 HTTP 服务未在 2 秒内开始监听");
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function closeServer(server: http.Server): Promise<void> {
  try {
    await waitWithTimeout(new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }), 2_000, "测试 HTTP 服务未在 2 秒内关闭");
  } finally {
    // 中文注释：即使 keep-alive 回归，也强制释放本地测试连接，禁止测试进程永久挂死。
    server.closeAllConnections?.();
  }
}

function readCommandCount(logFile: string, command: string): number {
  if (!fs.existsSync(logFile)) return 0;
  return fs.readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args?: string[] })
    .filter((entry) => entry.args?.[0] === command)
    .length;
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return fs.existsSync(filePath);
}

async function waitForAccountState(
  taskUuid: string,
  expected: string,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const row = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
    const actual = `${row?.queueState}/${row?.providerState}/${row?.slotHeld}`;
    if (actual === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function projectCatalogRow() {
  return {
    projectUuid: PROJECT_UUID,
    name: "Round27 调度恢复",
    kind: "personal",
    ownerUserId: IDENTITY.userId,
    role: "owner",
    myRole: "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-15T00:00:00Z",
    lockStatus: "none",
    lockHolderName: "",
    openMode: "editable",
    businessType: "storyboard",
  };
}

test("即梦调度器必须恢复领取窗口并幂等收敛项目终态", async (t) => {
  // 中文注释：Windows 原生 SQLite 不接受过长数据库路径，仍限定在当前工作树 .tmp 内。
  const root = path.resolve(__dirname, "..", "..", "..", ".tmp", `r27-sr-${process.pid}`);
  const originalCwd = process.cwd();
  const originalListProjects = syncCoordinator.listProjects.bind(syncCoordinator);
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    DREAMINA_TEST_EXECUTABLE: process.env.DREAMINA_TEST_EXECUTABLE,
    DREAMINA_FAKE_SCENARIO: process.env.DREAMINA_FAKE_SCENARIO,
    DREAMINA_FAKE_QUERY_STATUS: process.env.DREAMINA_FAKE_QUERY_STATUS,
    DREAMINA_FAKE_DELAY_MS: process.env.DREAMINA_FAKE_DELAY_MS,
    DREAMINA_FAKE_LOG: process.env.DREAMINA_FAKE_LOG,
    PATH: process.env.PATH,
    DREAMINA_FAKE_QUERY_BARRIER: process.env.DREAMINA_FAKE_QUERY_BARRIER,
  };
  const logFile = path.join(root, "fake-cli.log");
  const deniedPathFallback = path.join(root, "deny-path-fallback");

  fs.mkdirSync(root, { recursive: true });
  // 中文注释：SQLite 使用短盘符，清理改走真实工作树路径，避免 Windows 对 SUBST 根目录返回 EPERM。
  const cleanupRoot = fs.realpathSync.native(root);
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = "storyboard-dreamina-scheduler-recovery-round27";
  // 中文注释：动态测试必须只走账号设置中的绝对 fake CLI；环境回退和 PATH 均指向不可执行哨兵。
  fs.mkdirSync(deniedPathFallback, { recursive: true });
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.PATH = deniedPathFallback;
  process.env.DREAMINA_FAKE_LOG = logFile;
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);

  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 2730,
        name: "Round27 调度恢复",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await writeDreaminaCliSettings({
        executablePath: FAKE_CLI,
        maxConcurrency: 1,
        pauseNewClaims: false,
      });
      writeReadyDreaminaTestCapability();
      syncCoordinator.listProjects = () => [projectCatalogRow()] as never;
      const shot = await new StoryboardService(PROJECT_UUID).insertShot({
        afterShotUuid: null,
        sourceText: "雨夜空镜",
      });
      // 中文注释：调度恢复场景必须先满足真实 CLI 的必需提示词与分辨率合同。
      await new StoryboardService(PROJECT_UUID).saveSettings({
        globalImagePrompt: "雨夜空镜",
        resolution: "2K",
      });
      const context = currentUserStorage();
      assert.ok(context, "测试必须处于账号上下文");
      const projectRoot = projectDirectory(getPath(), PROJECT_UUID, context.segment);
      const stagingRoot = path.join(
        getPath(),
        "runtime-users",
        context.segment,
        "staging",
      );

      const enqueue = async (): Promise<string> => {
        const [queued] = await enqueueAsyncMediaTasks({
          projectUuid: PROJECT_UUID,
          items: [{
            shotUuid: shot.shotUuid,
            mediaType: "image",
            providerModel: "dreamina-cli:text2image",
            mode: "text2image",
          }],
          paidBatchConfirmed: false,
        });
        assert.ok(queued?.taskUuid);
        return queued.taskUuid;
      };

      const clean = async () => {
        stopDreaminaSchedulerLoop();
        await accountDb("o_dreaminaCliDispatch").delete();
        await runWithProjectStorage(PROJECT_UUID, async () => {
          await activeDb.raw("DROP TRIGGER IF EXISTS r27_fail_submitting_mirror");
          await activeDb.raw("DROP TRIGGER IF EXISTS r27_fail_failed_mirror");
          await activeDb.raw("DROP TRIGGER IF EXISTS r27_fail_completed_mirror");
          await activeDb.raw("DROP TRIGGER IF EXISTS r27_fail_one_of_two_mirrors");
          await activeDb("o_storyboardCandidate").delete();
          await activeDb("o_storyboardGenerationTask").delete();
        });
        fs.rmSync(stagingRoot, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 200,
        });
        fs.writeFileSync(logFile, "");
      };

      await t.test("claim 后 staging 建目录失败必须释放槽且下一 tick 可重领", async () => {
        try {
          process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
          process.env.DREAMINA_FAKE_QUERY_STATUS = "running";
          const taskUuid = await enqueue();
          fs.mkdirSync(stagingRoot, { recursive: true });
          const blockedStaging = path.join(stagingRoot, taskUuid);
          fs.writeFileSync(blockedStaging, "block mkdir");

          let rejected = false;
          try {
            await tickDreaminaScheduler();
          } catch {
            rejected = true;
          }
          const failedClaim = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          fs.rmSync(blockedStaging, { force: true });
          await tickDreaminaScheduler();
          const reclaimed = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();

          assert.deepEqual({
            rejected,
            failedQueueState: failedClaim?.queueState,
            failedSlotHeld: Number(failedClaim?.slotHeld ?? -1),
            reclaimedQueueState: reclaimed?.queueState,
            submitCount: readSubmitCount(logFile),
          }, {
            rejected: false,
            failedQueueState: "queued",
            failedSlotHeld: 0,
            reclaimedQueueState: "provider_active",
            submitCount: 1,
          });
        } finally {
          await clean();
        }
      }).catch(() => undefined);

      await t.test("旧 lease 的 staging 失败不得释放 replacement lease", async () => {
        const replacementLease = "round27-mkdir-replacement-lease";
        let triggerCreated = false;
        let blockedStaging = "";
        try {
          const taskUuid = await enqueue();
          fs.mkdirSync(stagingRoot, { recursive: true });
          blockedStaging = path.join(stagingRoot, taskUuid);
          fs.writeFileSync(blockedStaging, "block mkdir");
          // 中文注释：领取刚完成即换入新 lease；旧 worker 的 mkdir 失败只能退出，不能覆盖新 owner。
          await accountDb.raw(`
            CREATE TRIGGER r27_replace_lease_before_mkdir
            AFTER UPDATE OF queueState ON o_dreaminaCliDispatch
            WHEN NEW.taskUuid = '${taskUuid}' AND NEW.queueState = 'claiming'
            BEGIN
              UPDATE o_dreaminaCliDispatch
              SET leaseOwner = '${replacementLease}', providerResultJson = '{"submitStarted":true}'
              WHERE taskUuid = '${taskUuid}';
            END
          `);
          triggerCreated = true;

          await tickDreaminaScheduler();
          const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          assert.deepEqual({
            queueState: dispatch?.queueState,
            providerState: dispatch?.providerState,
            slotHeld: Number(dispatch?.slotHeld ?? -1),
            leaseOwner: dispatch?.leaseOwner,
            submitStarted: JSON.parse(String(dispatch?.providerResultJson ?? "{}")).submitStarted,
          }, {
            queueState: "claiming",
            providerState: "not_sent",
            slotHeld: 1,
            leaseOwner: replacementLease,
            submitStarted: true,
          });
        } finally {
          if (triggerCreated) await accountDb.raw("DROP TRIGGER IF EXISTS r27_replace_lease_before_mkdir");
          if (blockedStaging) fs.rmSync(blockedStaging, { force: true });
          await clean();
        }
      });

      await t.test("claim 后项目 submitting 事务失败必须释放槽且可重领", async () => {
        try {
          process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
          process.env.DREAMINA_FAKE_QUERY_STATUS = "running";
          const taskUuid = await enqueue();
          await runWithProjectStorage(PROJECT_UUID, () => activeDb.raw(`
            CREATE TRIGGER r27_fail_submitting_mirror
            BEFORE UPDATE OF status ON o_storyboardGenerationTask
            WHEN NEW.status = 'submitting'
            BEGIN SELECT RAISE(ABORT, 'round27 injected submitting failure'); END
          `));
          let rejected = false;
          try {
            await tickDreaminaScheduler();
          } catch {
            rejected = true;
          }
          const failedClaim = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          const failedProject = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb.raw("DROP TRIGGER IF EXISTS r27_fail_submitting_mirror"));
          await tickDreaminaScheduler();
          const reclaimed = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();

          assert.deepEqual({
            rejected,
            failedQueueState: failedClaim?.queueState,
            failedSlotHeld: Number(failedClaim?.slotHeld ?? -1),
            failedProjectStatus: failedProject?.status,
            reclaimedQueueState: reclaimed?.queueState,
            submitCount: readSubmitCount(logFile),
          }, {
            rejected: false,
            failedQueueState: "queued",
            failedSlotHeld: 0,
            failedProjectStatus: "queued",
            reclaimedQueueState: "provider_active",
            submitCount: 1,
          });
        } finally {
          await clean();
        }
      }).catch(() => undefined);

      await t.test("过期 lease 必须回收，但不得回收本进程仍在 submit 的任务", async () => {
        try {
          process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
          process.env.DREAMINA_FAKE_QUERY_STATUS = "running";
          const staleTaskUuid = await enqueue();
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid: staleTaskUuid }).update({
            queueState: "claiming",
            providerState: "not_sent",
            slotHeld: 1,
            leaseOwner: "dead-process",
            leaseExpiresAt: Date.now() - 1,
          });
          await tickDreaminaScheduler();
          const recoveredStale = await accountDb("o_dreaminaCliDispatch")
            .where({ taskUuid: staleTaskUuid })
            .first();
          const staleSubmitCount = readSubmitCount(logFile);

          await clean();
          process.env.DREAMINA_FAKE_SCENARIO = "delay_submit";
          process.env.DREAMINA_FAKE_DELAY_MS = "900";
          process.env.DREAMINA_FAKE_QUERY_STATUS = "running";
          const inFlightTaskUuid = await enqueue();
          const firstTick = tickDreaminaScheduler();
          const waitStarted = Date.now();
          while (Date.now() - waitStarted < 700 && readSubmitCount(logFile) === 0) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid: inFlightTaskUuid }).update({
            leaseExpiresAt: Date.now() - 1,
          });
          // 中文注释：完整 tick 现在统一串行；这里直接验证 reaper 在 submit 期间不会越过 inFlight 事实。
          await reapExpiredDreaminaClaims();
          const duringSubmit = await accountDb("o_dreaminaCliDispatch")
            .where({ taskUuid: inFlightTaskUuid })
            .first();
          await firstTick;
          const afterSubmit = await accountDb("o_dreaminaCliDispatch")
            .where({ taskUuid: inFlightTaskUuid })
            .first();

          assert.deepEqual({
            staleQueueState: recoveredStale?.queueState,
            staleSubmitCount,
            duringQueueState: duringSubmit?.queueState,
            duringSlotHeld: Number(duringSubmit?.slotHeld ?? -1),
            afterQueueState: afterSubmit?.queueState,
            submitCount: readSubmitCount(logFile),
          }, {
            staleQueueState: "provider_active",
            staleSubmitCount: 1,
            duringQueueState: "claiming",
            duringSlotHeld: 1,
            afterQueueState: "provider_active",
            submitCount: 1,
          });
        } finally {
          await clean();
        }
      }).catch(() => undefined);

      await t.test("lease reaper 必须用旧状态条件更新，不能覆盖扫描后的并发状态变化", async () => {
        try {
          const firstTaskUuid = await enqueue();
          const secondTaskUuid = await enqueue();
          const expiredAt = Date.now() - 1;
          await accountDb("o_dreaminaCliDispatch")
            .whereIn("taskUuid", [firstTaskUuid, secondTaskUuid])
            .update({
              queueState: "claiming",
              providerState: "not_sent",
              slotHeld: 1,
              leaseOwner: "dead-process",
              leaseExpiresAt: expiredAt,
            });
          // 中文注释：第一条回收更新触发时模拟另一个执行器已把第二条推进到 provider_active。
          await accountDb.raw(`
            CREATE TRIGGER r27_reaper_claim_race
            AFTER UPDATE OF queueState ON o_dreaminaCliDispatch
            WHEN OLD.taskUuid = '${firstTaskUuid}' AND NEW.queueState = 'queued'
            BEGIN
              UPDATE o_dreaminaCliDispatch
              SET queueState = 'provider_active', providerState = 'running', slotHeld = 1,
                  leaseOwner = NULL, leaseExpiresAt = NULL
              WHERE taskUuid = '${secondTaskUuid}';
            END
          `);

          const recovered = await reapExpiredDreaminaClaims();
          const first = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: firstTaskUuid }).first();
          const second = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: secondTaskUuid }).first();

          assert.deepEqual({
            recovered,
            firstState: `${first?.queueState}/${first?.providerState}/${first?.slotHeld}`,
            secondState: `${second?.queueState}/${second?.providerState}/${second?.slotHeld}`,
          }, {
            recovered: 1,
            firstState: "queued/not_sent/0",
            secondState: "provider_active/running/1",
          });
        } finally {
          await accountDb.raw("DROP TRIGGER IF EXISTS r27_reaper_claim_race");
          await clean();
        }
      }).catch(() => undefined);

      await t.test("运行时 recover 不得重领本进程尚未落 submitStarted 的 inFlight task", async () => {
        try {
          process.env.DREAMINA_FAKE_SCENARIO = "delay_submit";
          process.env.DREAMINA_FAKE_DELAY_MS = "900";
          process.env.DREAMINA_FAKE_QUERY_STATUS = "running";
          const taskUuid = await enqueue();
          const originalTick = tickDreaminaScheduler();
          const waitStarted = Date.now();
          while (Date.now() - waitStarted < 700 && readSubmitCount(logFile) === 0) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.equal(readSubmitCount(logFile), 1, "fake CLI 必须已进入首个真实 submit Promise");
          // 中文注释：强制还原“inFlight 已登记、submitStarted 尚未落盘”的领取窗口，验证恢复入口自身的保护。
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
            providerResultJson: JSON.stringify({}),
          });
          const duringWindow = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          const duringResult = JSON.parse(String(duringWindow?.providerResultJson ?? "{}"));
          await recoverDreaminaSlots();
          await originalTick;

          assert.deepEqual({
            duringState: `${duringWindow?.queueState}/${duringWindow?.providerState}/${duringWindow?.slotHeld}`,
            submitStarted: Boolean(duringResult.submitStarted),
            submitCount: readSubmitCount(logFile),
          }, {
            duringState: "claiming/not_sent/1",
            submitStarted: false,
            submitCount: 1,
          });
        } finally {
          await clean();
        }
      }).catch(() => undefined);

      await t.test("pause drain 必须覆盖已越过暂停检查但尚未登记 inFlight 的 tick", { timeout: 10_000 }, async () => {
        const database = accountDatabase();
        const client = database.client as typeof database.client & {
          acquireConnection: () => Promise<unknown>;
        };
        const hadOwnAcquire = Object.prototype.hasOwnProperty.call(client, "acquireConnection");
        const originalAcquire = client.acquireConnection;
        let releaseAcquire!: () => void;
        let reachedClaimAcquire!: () => void;
        const claimAcquireReached = new Promise<void>((resolve) => {
          reachedClaimAcquire = resolve;
        });
        const acquireGate = new Promise<void>((resolve) => {
          releaseAcquire = resolve;
        });
        let interceptNextAcquire = false;
        let intercepted = false;
        const armClaimBoundary = (_response: unknown, query: { sql?: string; bindings?: unknown[] }) => {
          const bindings = Array.isArray(query.bindings) ? query.bindings.map(String) : [];
          if (String(query.sql ?? "").includes("o_dreaminaCliDispatch") && bindings.includes("unknown")) {
            // 中文注释：hasUnknownSlot 已返回后，下一个连接获取正处于 claim 前、inFlight 登记前的真实竞态窗口。
            interceptNextAcquire = true;
          }
        };
        try {
          process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
          process.env.DREAMINA_FAKE_QUERY_STATUS = "running";
          const taskUuid = await enqueue();
          database.on("query-response", armClaimBoundary);
          client.acquireConnection = async () => {
            if (interceptNextAcquire && !intercepted) {
              intercepted = true;
              interceptNextAcquire = false;
              reachedClaimAcquire();
              await acquireGate;
            }
            return originalAcquire.call(client);
          };

          const ticking = tickDreaminaScheduler();
          await waitWithTimeout(
            claimAcquireReached,
            2_000,
            "未命中 hasUnknownSlot 后、claim 连接获取前的竞态边界",
          );
          const pausing = pauseGenerationRuntime();
          // 中文注释：给旧 drain 足够机会在 inFlight 仍为空时错误返回，再放行真实领取。
          await Promise.race([
            pausing,
            new Promise<void>((resolve) => setTimeout(resolve, 120)),
          ]);
          releaseAcquire();
          await waitWithTimeout(
            Promise.all([ticking, pausing]),
            2_000,
            "pause drain 未在放行 claim 边界后 2 秒内完成",
          );
          const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();

          assert.deepEqual({
            intercepted,
            submitCount: readSubmitCount(logFile),
            state: `${dispatch?.queueState}/${dispatch?.providerState}/${dispatch?.slotHeld}`,
          }, {
            intercepted: true,
            submitCount: 0,
            state: "queued/not_sent/0",
          });
        } finally {
          releaseAcquire?.();
          if (hadOwnAcquire) client.acquireConnection = originalAcquire;
          else delete (client as { acquireConnection?: () => Promise<unknown> }).acquireConnection;
          database.off("query-response", armClaimBoundary);
          await resumeGenerationRuntime();
          await clean();
        }
      });

      await t.test("在途 lifecycle drain 期间 HTTP resume 必须拒绝重新开门", { timeout: 10_000 }, async () => {
        const database = accountDatabase();
        const client = database.client as typeof database.client & {
          acquireConnection: () => Promise<unknown>;
        };
        const hadOwnAcquire = Object.prototype.hasOwnProperty.call(client, "acquireConnection");
        const originalAcquire = client.acquireConnection;
        let releaseAcquire!: () => void;
        let reachedClaimAcquire!: () => void;
        const claimAcquireReached = new Promise<void>((resolve) => {
          reachedClaimAcquire = resolve;
        });
        const acquireGate = new Promise<void>((resolve) => {
          releaseAcquire = resolve;
        });
        let interceptNextAcquire = false;
        let intercepted = false;
        let server: http.Server | undefined;
        const armClaimBoundary = (_response: unknown, query: { sql?: string; bindings?: unknown[] }) => {
          const bindings = Array.isArray(query.bindings) ? query.bindings.map(String) : [];
          if (String(query.sql ?? "").includes("o_dreaminaCliDispatch") && bindings.includes("unknown")) {
            interceptNextAcquire = true;
          }
        };
        try {
          process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
          process.env.DREAMINA_FAKE_QUERY_STATUS = "running";
          const taskUuid = await enqueue();
          database.on("query-response", armClaimBoundary);
          client.acquireConnection = async () => {
            if (interceptNextAcquire && !intercepted) {
              intercepted = true;
              interceptNextAcquire = false;
              reachedClaimAcquire();
              await acquireGate;
            }
            return originalAcquire.call(client);
          };

          const app = express();
          app.use(express.json());
          app.use((_req, _res, next) => {
            enterUserStorage(IDENTITY);
            next();
          });
          const { default: resumeRouter } = await import("../../src/routes/task/dreaminaQueue/resume");
          app.use("/api/task/dreaminaQueue/resume", resumeRouter);
          const listening = await listen(app);
          server = listening.server;

          const ticking = tickDreaminaScheduler();
          await waitWithTimeout(
            claimAcquireReached,
            2_000,
            "未命中并发 resume 所需的 claim 边界",
          );
          const pausing = pauseGenerationRuntime();
          await new Promise<void>((resolve) => setTimeout(resolve, 120));
          const response = await waitWithTimeout(fetch(
            `http://127.0.0.1:${listening.port}/api/task/dreaminaQueue/resume`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
              signal: AbortSignal.timeout(2_000),
            },
          ), 2_500, "在途 drain 的 HTTP resume 未在 2.5 秒内返回");
          const responseBody = await response.text();
          releaseAcquire();
          await waitWithTimeout(
            Promise.all([ticking, pausing]),
            2_000,
            "并发 resume 场景未在放行 claim 边界后 2 秒内完成",
          );
          const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();

          assert.deepEqual({
            status: response.status,
            intercepted,
            submitCount: readSubmitCount(logFile),
            state: `${dispatch?.queueState}/${dispatch?.providerState}/${dispatch?.slotHeld}`,
            bodyHasBusyMessage: /暂停|退出|稍后/.test(responseBody),
          }, {
            status: 409,
            intercepted: true,
            submitCount: 0,
            state: "queued/not_sent/0",
            bodyHasBusyMessage: true,
          });
        } finally {
          releaseAcquire?.();
          if (hadOwnAcquire) client.acquireConnection = originalAcquire;
          else delete (client as { acquireConnection?: () => Promise<unknown> }).acquireConnection;
          database.off("query-response", armClaimBoundary);
          if (server) await closeServer(server);
          await resumeGenerationRuntime();
          await clean();
        }
      });

      await t.test("手工 resume 必须清除同账号 lifecycle 暂停门并恢复领取", { timeout: 10_000 }, async () => {
        let server: http.Server | undefined;
        try {
          process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
          process.env.DREAMINA_FAKE_QUERY_STATUS = "running";
          const taskUuid = await enqueue();
          await pauseGenerationRuntime();

          const app = express();
          app.use(express.json());
          app.use((_req, _res, next) => {
            enterUserStorage(IDENTITY);
            next();
          });
          const { default: resumeRouter } = await import("../../src/routes/task/dreaminaQueue/resume");
          app.use("/api/task/dreaminaQueue/resume", resumeRouter);
          const listening = await listen(app);
          server = listening.server;
          const response = await waitWithTimeout(fetch(`http://127.0.0.1:${listening.port}/api/task/dreaminaQueue/resume`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(2_000),
          }), 2_500, "手工 resume 请求未在 2.5 秒内返回");
          assert.equal(response.status, 200, await response.text());

          await waitWithTimeout(tickDreaminaScheduler(), 2_000, "手工 resume 后 tick 未在 2 秒内完成");
          const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          assert.deepEqual({
            submitCount: readSubmitCount(logFile),
            state: `${dispatch?.queueState}/${dispatch?.providerState}/${dispatch?.slotHeld}`,
          }, {
            submitCount: 1,
            state: "provider_active/running/1",
          });
        } finally {
          if (server) await closeServer(server);
          await resumeGenerationRuntime();
          await clean();
        }
      });

      await t.test("重启残留 marker 的旧读不得覆盖并发完成终态", async () => {
        const database = accountDatabase();
        let activeScanFinished = false;
        let concurrentTerminalWritten = false;
        let taskUuid = "";
        const terminalResult = {
          submitId: "sub-cleanup-new",
          files: ["new-result.png"],
          projectMirrorPending: null,
        };
        const injectTerminalAfterMarkerRead = (
          _response: unknown,
          query: { sql?: string; bindings?: unknown[] },
        ) => {
          const sql = String(query.sql ?? "");
          const bindings = Array.isArray(query.bindings) ? query.bindings.map(String) : [];
          if (!activeScanFinished
            && sql.includes("o_dreaminaCliDispatch")
            && bindings.includes("provider_active")
            && bindings.includes("1")) {
            activeScanFinished = true;
            return;
          }
          if (!activeScanFinished
            || concurrentTerminalWritten
            || !sql.trimStart().toLowerCase().startsWith("select")
            || !sql.includes("o_dreaminaCliDispatch")
            || !bindings.includes(taskUuid)) return;
          // 中文注释：旧 marker 已读出 active 快照后，由独立连接先耐久写入更高代际终态。
          const Database = require("better-sqlite3") as new (filename: string) => {
            prepare: (statement: string) => { run: (...params: unknown[]) => unknown };
            close: () => void;
          };
          const direct = new Database(path.join(
            getPath(),
            "runtime-users",
            context.segment,
            "db2.sqlite",
          ));
          try {
            direct.prepare(`
              UPDATE o_dreaminaCliDispatch
              SET queueState = ?, providerState = ?, slotHeld = 0,
                  providerResultJson = ?, updatedAt = ?
              WHERE taskUuid = ?
            `).run(
              "terminal",
              "completed",
              JSON.stringify(terminalResult),
              Date.now() + 10_000,
              taskUuid,
            );
            concurrentTerminalWritten = true;
          } finally {
            direct.close();
          }
        };
        try {
          taskUuid = await enqueue();
          const referencesRoot = path.join(stagingRoot, taskUuid, "references");
          fs.mkdirSync(path.join(referencesRoot, "crash-residue"), { recursive: true });
          fs.writeFileSync(path.join(referencesRoot, "crash-residue", "000.png"), "retain-me");
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
            queueState: "provider_active",
            providerState: "running",
            slotHeld: 1,
            leaseOwner: null,
            leaseExpiresAt: null,
            dispatchReady: 1,
            providerResultJson: JSON.stringify({ submitId: "sub-cleanup-old" }),
            updatedAt: Date.now(),
          });
          database.on("query-response", injectTerminalAfterMarkerRead);
          await tickDreaminaScheduler();
          const final = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          const parsed = JSON.parse(String(final?.providerResultJson ?? "{}"));
          assert.deepEqual({
            concurrentTerminalWritten,
            state: `${final?.queueState}/${final?.providerState}/${final?.slotHeld}`,
            submitId: parsed.submitId,
            files: parsed.files,
            projectMirrorPending: parsed.projectMirrorPending,
            cleanupPending: parsed.referenceSnapshotCleanupPending,
            residue: fs.readFileSync(
              path.join(referencesRoot, "crash-residue", "000.png"),
              "utf8",
            ),
          }, {
            concurrentTerminalWritten: true,
            state: "terminal/completed/0",
            submitId: terminalResult.submitId,
            files: terminalResult.files,
            projectMirrorPending: null,
            cleanupPending: undefined,
            residue: "retain-me",
          });
        } finally {
          database.off("query-response", injectTerminalAfterMarkerRead);
          await clean();
        }
      });

      await t.test("恢复 query 必须与自动 safeTick 串行且终态不可被旧 running 回退", async () => {
        const barrier = path.join(root, "recover-query-race");
        try {
          const taskUuid = await enqueue();
          // 中文注释：直接构造已提交投影，整个测试不得触发 submit，更不能命中 PATH 中的真实 CLI。
          process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
          process.env.DREAMINA_FAKE_QUERY_BARRIER = barrier;
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
            queueState: "provider_active",
            providerState: "running",
            slotHeld: 1,
            leaseOwner: null,
            leaseExpiresAt: null,
            providerResultJson: JSON.stringify({ submitId: "sub-query-race" }),
            updatedAt: Date.now(),
          });
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).update({
              status: "submitted",
              providerTaskId: "sub-query-race",
              updatedAt: Date.now(),
            }));

          const firstTick = tickDreaminaScheduler();
          assert.equal(
            await waitForFile(`${barrier}.first.ready`, 3_000),
            true,
            "自动 safeTick 的首个 fake query 必须进入确定性屏障",
          );
          const recovery = recoverDreaminaSlots();
          const secondBeforeRelease = await waitForFile(`${barrier}.second.finished`, 800);
          if (secondBeforeRelease) {
            assert.equal(
              await waitForAccountState(taskUuid, "terminal/completed/0", 3_000),
              true,
              "并发恢复 query 必须先真实落下较新 completed 终态",
            );
          }
          fs.writeFileSync(`${barrier}.release`, "release");
          await Promise.all([firstTick, recovery]);
          if (secondBeforeRelease) {
            assert.equal(
              await waitForAccountState(taskUuid, "provider_active/running/1", 3_000),
              true,
              "旧 running query 必须在 RED 中真实复现终态回退",
            );
          }

          const finalDispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          const finalProject = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
          const candidates = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardCandidate").where({ shotUuid: shot.shotUuid }).select());
          assert.deepEqual({
            secondBeforeRelease,
            accountState: `${finalDispatch?.queueState}/${finalDispatch?.providerState}/${finalDispatch?.slotHeld}`,
            projectStatus: finalProject?.status,
            candidateCount: candidates.length,
            queryCount: readCommandCount(logFile, "query_result"),
            submitCount: readSubmitCount(logFile),
          }, {
            secondBeforeRelease: false,
            accountState: "terminal/completed/0",
            projectStatus: "completed",
            candidateCount: 1,
            queryCount: 2,
            submitCount: 0,
          });
        } finally {
          fs.writeFileSync(`${barrier}.release`, "release");
          await clean();
          process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
          delete process.env.DREAMINA_FAKE_QUERY_BARRIER;
        }
      });

      await t.test("query 返回前代际变化时旧 running 结果不得覆盖 terminal", async () => {
        const barrier = path.join(root, "query-generation-cas");
        try {
          const taskUuid = await enqueue();
          process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
          process.env.DREAMINA_FAKE_QUERY_BARRIER = barrier;
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
            queueState: "provider_active",
            providerState: "running",
            slotHeld: 1,
            leaseOwner: null,
            leaseExpiresAt: null,
            providerResultJson: JSON.stringify({ submitId: "sub-query-generation" }),
            updatedAt: Date.now(),
          });
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).update({
              status: "submitted",
              providerTaskId: "sub-query-generation",
              updatedAt: Date.now(),
            }));

          const staleTick = tickDreaminaScheduler();
          assert.equal(
            await waitForFile(`${barrier}.first.ready`, 3_000),
            true,
            "旧 query 必须先进入 fake 屏障",
          );
          // 中文注释：模拟同一账号的另一恢复执行器先落下新终态，旧 query 只能观察、无权回退。
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
            queueState: "terminal",
            providerState: "completed",
            slotHeld: 0,
            providerTerminalAt: Date.now(),
            providerResultJson: JSON.stringify({
              submitId: "sub-query-generation",
              terminalGeneration: "newer",
            }),
            updatedAt: Date.now(),
          });
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).update({
              status: "completed",
              providerCompletedAt: Date.now(),
              updatedAt: Date.now(),
            }));
          fs.writeFileSync(`${barrier}.release`, "release");
          await staleTick;

          const finalDispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          const finalResult = JSON.parse(String(finalDispatch?.providerResultJson ?? "{}"));
          assert.deepEqual({
            accountState: `${finalDispatch?.queueState}/${finalDispatch?.providerState}/${finalDispatch?.slotHeld}`,
            terminalGeneration: finalResult.terminalGeneration,
            queryCount: readCommandCount(logFile, "query_result"),
            submitCount: readSubmitCount(logFile),
          }, {
            accountState: "terminal/completed/0",
            terminalGeneration: "newer",
            queryCount: 1,
            submitCount: 0,
          });
        } finally {
          fs.writeFileSync(`${barrier}.release`, "release");
          await clean();
          process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
          delete process.env.DREAMINA_FAKE_QUERY_BARRIER;
        }
      });

      await t.test("账号 failed 终态后的项目镜像失败必须在重启恢复时收敛", async () => {
        try {
          process.env.DREAMINA_FAKE_SCENARIO = "definite_failure";
          delete process.env.DREAMINA_FAKE_QUERY_STATUS;
          const taskUuid = await enqueue();
          await runWithProjectStorage(PROJECT_UUID, () => activeDb.raw(`
            CREATE TRIGGER r27_fail_failed_mirror
            BEFORE UPDATE OF status ON o_storyboardGenerationTask
            WHEN NEW.status = 'failed_fatal'
            BEGIN SELECT RAISE(ABORT, 'round27 injected failed mirror failure'); END
          `));
          await tickDreaminaScheduler();
          const durableTerminal = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          const beforeRecovery = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb.raw("DROP TRIGGER IF EXISTS r27_fail_failed_mirror"));
          await recoverDreaminaSlots();
          const afterRecovery = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
          const recoveredDispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          const recoveredResult = JSON.parse(String(recoveredDispatch?.providerResultJson ?? "{}"));

          assert.deepEqual({
            accountQueueState: durableTerminal?.queueState,
            accountProviderState: durableTerminal?.providerState,
            beforeProjectStatus: beforeRecovery?.status,
            afterProjectStatus: afterRecovery?.status,
            mirrorPending: recoveredResult.projectMirrorPending ?? null,
            errorCode: recoveredResult.code,
            errorMessage: recoveredResult.message,
            submitCount: readSubmitCount(logFile),
          }, {
            accountQueueState: "terminal",
            accountProviderState: "failed",
            beforeProjectStatus: "submitting",
            afterProjectStatus: "failed_fatal",
            mirrorPending: null,
            errorCode: "DREAMINA_CLI_DEFINITE_FAILURE",
            errorMessage: "参数不被当前 CLI 接受",
            submitCount: 1,
          });
        } finally {
          await clean();
        }
      }).catch(() => undefined);

      await t.test("单个项目镜像失败不得阻断同批其他 marker，后续重放必须收敛", async () => {
        try {
          const firstTaskUuid = await enqueue();
          const secondTaskUuid = await enqueue();
          for (const [taskUuid, providerTaskId] of [
            [firstTaskUuid, "sub-mirror-first"],
            [secondTaskUuid, "sub-mirror-second"],
          ]) {
            await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
              queueState: "terminal",
              providerState: "completed",
              slotHeld: 0,
              providerResultJson: JSON.stringify({
                submitId: providerTaskId,
                files: [`${providerTaskId}.png`],
                projectMirrorPending: {
                  status: "completed",
                  providerTaskId,
                  providerCompletedAt: 1786780800000,
                },
              }),
            });
          }
          await runWithProjectStorage(PROJECT_UUID, () => activeDb.raw(`
            CREATE TRIGGER r27_fail_one_of_two_mirrors
            BEFORE UPDATE OF status ON o_storyboardGenerationTask
            WHEN OLD.taskUuid = '${firstTaskUuid}' AND NEW.status = 'completed'
            BEGIN SELECT RAISE(ABORT, 'round27 injected one-of-two mirror failure'); END
          `));

          const firstPass = await reconcilePendingProjectTaskMirrors();
          const afterFirstPass = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask")
              .whereIn("taskUuid", [firstTaskUuid, secondTaskUuid])
              .select("taskUuid", "status"));
          const firstMarker = JSON.parse(String((await accountDb("o_dreaminaCliDispatch")
            .where({ taskUuid: firstTaskUuid }).first())?.providerResultJson ?? "{}"));
          const secondMarker = JSON.parse(String((await accountDb("o_dreaminaCliDispatch")
            .where({ taskUuid: secondTaskUuid }).first())?.providerResultJson ?? "{}"));
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb.raw("DROP TRIGGER IF EXISTS r27_fail_one_of_two_mirrors"));
          const secondPass = await reconcilePendingProjectTaskMirrors();
          const finalFirst = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid: firstTaskUuid }).first());
          const finalFirstResult = JSON.parse(String((await accountDb("o_dreaminaCliDispatch")
            .where({ taskUuid: firstTaskUuid }).first())?.providerResultJson ?? "{}"));

          assert.deepEqual({
            firstPass,
            firstStatus: afterFirstPass.find((row) => row.taskUuid === firstTaskUuid)?.status,
            secondStatus: afterFirstPass.find((row) => row.taskUuid === secondTaskUuid)?.status,
            firstPending: firstMarker.projectMirrorPending?.status,
            secondPending: secondMarker.projectMirrorPending ?? null,
            secondSubmitId: secondMarker.submitId,
            secondFiles: secondMarker.files,
            secondPass,
            finalFirstStatus: finalFirst?.status,
            finalFirstPending: finalFirstResult.projectMirrorPending ?? null,
            finalFirstSubmitId: finalFirstResult.submitId,
          }, {
            firstPass: 1,
            firstStatus: "queued",
            secondStatus: "completed",
            firstPending: "completed",
            secondPending: null,
            secondSubmitId: "sub-mirror-second",
            secondFiles: ["sub-mirror-second.png"],
            secondPass: 1,
            finalFirstStatus: "completed",
            finalFirstPending: null,
            finalFirstSubmitId: "sub-mirror-first",
          });
        } finally {
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb.raw("DROP TRIGGER IF EXISTS r27_fail_one_of_two_mirrors"));
          await clean();
        }
      }).catch(() => undefined);

      await t.test("项目任务暂时缺行时必须保留 terminal marker，恢复行后才可清除", async () => {
        try {
          const taskUuid = await enqueue();
          const originalTask = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
          assert.ok(originalTask, "夹具必须先有项目任务行");
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
            queueState: "terminal",
            providerState: "completed",
            slotHeld: 0,
            providerResultJson: JSON.stringify({
              submitId: "sub-missing-row",
              files: ["result.png"],
              projectMirrorPending: {
                status: "completed",
                providerTaskId: "sub-missing-row",
                providerCompletedAt: 1786780800000,
              },
            }),
          });
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).delete());

          const missingPass = await reconcilePendingProjectTaskMirrors();
          const afterMissing = JSON.parse(String((await accountDb("o_dreaminaCliDispatch")
            .where({ taskUuid }).first())?.providerResultJson ?? "{}"));
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").insert(originalTask));
          const restoredPass = await reconcilePendingProjectTaskMirrors();
          const restoredTask = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
          const afterRestored = JSON.parse(String((await accountDb("o_dreaminaCliDispatch")
            .where({ taskUuid }).first())?.providerResultJson ?? "{}"));

          assert.deepEqual({
            missingPass,
            pendingAfterMissing: afterMissing.projectMirrorPending?.status,
            submitIdAfterMissing: afterMissing.submitId,
            restoredPass,
            restoredStatus: restoredTask?.status,
            pendingAfterRestored: afterRestored.projectMirrorPending ?? null,
            submitIdAfterRestored: afterRestored.submitId,
          }, {
            missingPass: 0,
            pendingAfterMissing: "completed",
            submitIdAfterMissing: "sub-missing-row",
            restoredPass: 1,
            restoredStatus: "completed",
            pendingAfterRestored: null,
            submitIdAfterRestored: "sub-missing-row",
          });
        } finally {
          await clean();
        }
      }).catch(() => undefined);

      await t.test("单个 submitStarted 领取恢复成 unknown 只能计数一次", async () => {
        try {
          const taskUuid = await enqueue();
          await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
            queueState: "claiming",
            providerState: "not_sent",
            slotHeld: 1,
            leaseOwner: "dead-process",
            leaseExpiresAt: Date.now() - 1,
            providerResultJson: JSON.stringify({ submitStarted: true }),
          });

          const result = await recoverDreaminaSlots();
          const recovered = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          assert.deepEqual({
            recovered: result.recovered,
            state: `${recovered?.queueState}/${recovered?.providerState}/${recovered?.slotHeld}`,
          }, {
            recovered: 1,
            state: "provider_active/unknown/1",
          });
        } finally {
          await clean();
        }
      }).catch(() => undefined);

      await t.test("账号 completed 终态后的镜像失败必须恢复且候选按 taskUuid 恰一条", async () => {
        try {
          process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
          delete process.env.DREAMINA_FAKE_QUERY_STATUS;
          const taskUuid = await enqueue();
          await runWithProjectStorage(PROJECT_UUID, () => activeDb.raw(`
            CREATE TRIGGER r27_fail_completed_mirror
            BEFORE UPDATE OF status ON o_storyboardGenerationTask
            WHEN NEW.status = 'completed'
            BEGIN SELECT RAISE(ABORT, 'round27 injected completed mirror failure'); END
          `));
          await tickDreaminaScheduler();
          const durableTerminal = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          const beforeRecovery = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
          const candidateCountBefore = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardCandidate").count<{ total: number }>("candidateUuid as total").first());
          await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb.raw("DROP TRIGGER IF EXISTS r27_fail_completed_mirror"));
          await recoverDreaminaSlots();
          await tickDreaminaScheduler();
          const afterRecovery = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
          const candidates = await runWithProjectStorage(PROJECT_UUID, () =>
            activeDb("o_storyboardCandidate").where({ shotUuid: shot.shotUuid }).select());
          const recoveredDispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
          const recoveredResult = JSON.parse(String(recoveredDispatch?.providerResultJson ?? "{}"));
          assert.match(
            String(candidates[0]?.relativePath ?? ""),
            new RegExp(`^files/images/storyboard/${shot.shotUuid}/${taskUuid}\\.[0-9a-f-]{36}\\.png$`),
            "候选只能绑定本任务完整随机安装文件",
          );

          assert.deepEqual({
            accountQueueState: durableTerminal?.queueState,
            accountProviderState: durableTerminal?.providerState,
            beforeProjectStatus: beforeRecovery?.status,
            candidateCountBefore: Number(candidateCountBefore?.total ?? 0),
            afterProjectStatus: afterRecovery?.status,
            candidateCountAfter: candidates.length,
            candidateUuid: candidates[0]?.candidateUuid,
            submitId: recoveredResult.submitId,
            files: Array.isArray(recoveredResult.files)
              ? recoveredResult.files.map((item: unknown) => path.basename(String(item)))
              : [],
            mirrorPending: recoveredResult.projectMirrorPending ?? null,
            fileExists: candidates[0]
              ? fs.existsSync(path.join(projectRoot, ...String(candidates[0].relativePath).split("/")))
              : false,
            submitCount: readSubmitCount(logFile),
          }, {
            accountQueueState: "terminal",
            accountProviderState: "completed",
            beforeProjectStatus: "provider_completed",
            candidateCountBefore: 1,
            afterProjectStatus: "completed",
            candidateCountAfter: 1,
            candidateUuid: taskUuid,
            submitId: "sub-123",
            files: ["result.png"],
            mirrorPending: null,
            fileExists: true,
            submitCount: 1,
          });
        } finally {
          await clean();
        }
      }).catch(() => undefined);
    });
  } catch (error) {
    // 中文注释：RED 阶段保留完整错误栈，便于区分夹具失败与生产合同失败。
    console.error("[scheduler-recovery-r27]", error);
    throw error;
  } finally {
    syncCoordinator.listProjects = originalListProjects;
    stopDreaminaSchedulerLoop();
    await closeActivatedWorkspaceRuntime();
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // 中文注释：Windows 原生句柄关闭后可能短暂延迟释放，有限重试但不吞掉 teardown 失败。
    fs.rmSync(cleanupRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
