/**
 * Round27 P1：人工终结 unknown 与付费重试都必须以账号耐久状态为准。
 * 测试只绑定仓库内 fake CLI，并主动清空 PATH，禁止默认命令回退到真实即梦 CLI。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import {
  accountDb,
  accountDatabase,
  activateUserDatabase,
  db as activeDb,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { enqueueAsyncMediaTasks } from "../../src/tianjiang/model-providers/async-generation-service";
import { resolveUnknownTask } from "../../src/tianjiang/model-providers/dreamina-cli/recovery";
import {
  reconcilePendingProjectTaskMirrors,
  stopDreaminaSchedulerLoop,
  tickDreaminaScheduler,
} from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";
import { writeReadyDreaminaTestCapability } from "./helpers/dreamina-capability";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9786 };
const PROJECT_UUID = "86868686-8686-4686-a686-868686868686";
const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");

test("resolveUnknown 只终结 unknown 占槽任务，并用耐久 marker 收敛项目失败态", async () => {
  const root = path.resolve(__dirname, "..", "..", "..", ".tmp", `r27-ur-${process.pid}`);
  const previousCwd = process.cwd();
  const previousListProjects = syncCoordinator.listProjects.bind(syncCoordinator);
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    DREAMINA_TEST_EXECUTABLE: process.env.DREAMINA_TEST_EXECUTABLE,
    DREAMINA_FAKE_LOG: process.env.DREAMINA_FAKE_LOG,
    DREAMINA_FAKE_SCENARIO: process.env.DREAMINA_FAKE_SCENARIO,
    DREAMINA_FAKE_QUERY_STATUS: process.env.DREAMINA_FAKE_QUERY_STATUS,
    DREAMINA_FAKE_DELAY_MS: process.env.DREAMINA_FAKE_DELAY_MS,
    PATH: process.env.PATH,
  };
  const fakeLog = path.join(root, "fake-cli.log");

  fs.mkdirSync(root, { recursive: true });
  // 中文注释：Windows 长路径删除使用真实路径，避免测试结束时只因路径规范化失败误报。
  const cleanupRoot = fs.realpathSync.native(root);
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = "storyboard-dreamina-unknown-retry-state-round27";
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  process.env.DREAMINA_FAKE_LOG = fakeLog;
  // 中文注释：即使生产代码误走默认命令名，也不能从本机 PATH 找到真实 CLI。
  process.env.PATH = path.join(root, "deny-path-fallback");
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);

  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 2786,
        name: "Round27 unknown CAS",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      await writeDreaminaCliSettings({
        executablePath: FAKE_CLI,
        maxConcurrency: 1,
        pauseNewClaims: true,
      });
      writeReadyDreaminaTestCapability();
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT_UUID,
        name: "Round27 unknown CAS",
        kind: "personal",
        ownerUserId: IDENTITY.userId,
        myRole: "owner",
        openMode: "editable",
        businessType: "storyboard",
      }] as never;

      const service = new StoryboardService(PROJECT_UUID);
      await service.saveSettings({
        globalImagePrompt: "雨夜列车驶过城市",
        resolution: "2K",
      });
      const shot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "雨夜列车驶过城市",
      });
      const enqueue = async (): Promise<string> => {
        const [task] = await enqueueAsyncMediaTasks({
          projectUuid: PROJECT_UUID,
          clientOperationId: crypto.randomUUID(),
          paidBatchConfirmed: false,
          items: [{
            shotUuid: shot.shotUuid,
            mediaType: "image",
            providerModel: "dreamina-cli:text2image",
            mode: "text2image",
          }],
        });
        assert.ok(task?.taskUuid);
        return task.taskUuid;
      };

      const taskUuid = await enqueue();
      await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
        queueState: "provider_active",
        providerState: "unknown",
        slotHeld: 1,
        leaseOwner: "unknown-owner",
        leaseExpiresAt: Date.now() + 60_000,
        providerResultJson: JSON.stringify({
          submitId: "fake-unknown-submit-id",
          message: "提交结果未知",
        }),
      });
      await runWithProjectStorage(PROJECT_UUID, async () => {
        await activeDb("o_storyboardGenerationTask").where({ taskUuid }).update({
          status: "submitted",
          providerTaskId: "fake-unknown-submit-id",
        });
        // 中文注释：强制项目镜像首次失败，证明账号终态与 marker 先于跨库写入耐久化。
        await activeDb.raw(`
          CREATE TRIGGER r27_fail_unknown_resolution
          BEFORE UPDATE ON o_storyboardGenerationTask
          WHEN NEW.status = 'failed_fatal'
          BEGIN
            SELECT RAISE(ABORT, 'r27 unknown mirror blocked');
          END
        `);
      });

      await resolveUnknownTask({ taskUuid, confirm: true });
      const terminal = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
      const terminalResult = JSON.parse(String(terminal?.providerResultJson ?? "{}"));
      const beforeReplay = await runWithProjectStorage(PROJECT_UUID, () =>
        activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
      assert.deepEqual({
        queueState: terminal?.queueState,
        providerState: terminal?.providerState,
        slotHeld: Number(terminal?.slotHeld ?? -1),
        leaseOwner: terminal?.leaseOwner ?? null,
        leaseExpiresAt: terminal?.leaseExpiresAt ?? null,
        hasTerminalAt: Number(terminal?.providerTerminalAt ?? 0) > 0,
        submitId: terminalResult.submitId,
        markerStatus: terminalResult.projectMirrorPending?.status,
        markerCode: terminalResult.projectMirrorPending?.errorCode,
        projectStatus: beforeReplay?.status,
      }, {
        queueState: "terminal",
        providerState: "failed",
        slotHeld: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        hasTerminalAt: true,
        submitId: "fake-unknown-submit-id",
        markerStatus: "failed_fatal",
        markerCode: "DREAMINA_UNKNOWN_MANUALLY_RESOLVED",
        projectStatus: "submitted",
      });

      await runWithProjectStorage(PROJECT_UUID, () =>
        activeDb.raw("DROP TRIGGER r27_fail_unknown_resolution"));
      assert.equal(await reconcilePendingProjectTaskMirrors(), 1);
      const replayedDispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
      const replayedResult = JSON.parse(String(replayedDispatch?.providerResultJson ?? "{}"));
      const replayedProject = await runWithProjectStorage(PROJECT_UUID, () =>
        activeDb("o_storyboardGenerationTask").where({ taskUuid }).first());
      assert.equal(replayedProject?.status, "failed_fatal");
      assert.equal(replayedProject?.errorCode, "DREAMINA_UNKNOWN_MANUALLY_RESOLVED");
      assert.equal(replayedResult.projectMirrorPending, null);

      const protectedStates = [
        { queueState: "queued", providerState: "not_sent", slotHeld: 0 },
        { queueState: "provider_active", providerState: "running", slotHeld: 1 },
        { queueState: "terminal", providerState: "completed", slotHeld: 0 },
      ] as const;
      for (const state of protectedStates) {
        const protectedTaskUuid = await enqueue();
        await accountDb("o_dreaminaCliDispatch").where({ taskUuid: protectedTaskUuid }).update(state);
        const before = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: protectedTaskUuid }).first();
        await assert.rejects(
          resolveUnknownTask({ taskUuid: protectedTaskUuid, confirm: true }),
          (error: any) => error?.code === "DREAMINA_UNKNOWN_STATE_CONFLICT",
        );
        const after = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: protectedTaskUuid }).first();
        assert.deepEqual({
          queueState: after?.queueState,
          providerState: after?.providerState,
          slotHeld: Number(after?.slotHeld ?? -1),
          providerTerminalAt: after?.providerTerminalAt ?? null,
        }, {
          queueState: before?.queueState,
          providerState: before?.providerState,
          slotHeld: Number(before?.slotHeld ?? -1),
          providerTerminalAt: before?.providerTerminalAt ?? null,
        });
      }

      const versionDriftTaskUuid = await enqueue();
      await accountDb("o_dreaminaCliDispatch").where({ taskUuid: versionDriftTaskUuid }).update({
        queueState: "provider_active",
        providerState: "unknown",
        slotHeld: 1,
        leaseOwner: "version-owner",
        leaseExpiresAt: 123_456,
        providerResultJson: JSON.stringify({ submitId: "fake-version-drift-submit" }),
      });
      const directAccountDb = accountDatabase();
      const transactionDescriptor = Object.getOwnPropertyDescriptor(directAccountDb, "transaction");
      const originalTransaction = directAccountDb.transaction.bind(directAccountDb);
      let injectedVersionDrift = false;
      const wrappedTransaction = (handler: (trx: any) => Promise<unknown>) =>
        originalTransaction.call(directAccountDb, async (trx: any) => {
          const wrappedTrx = ((tableName: string) => {
            const builder = trx(tableName);
            if (tableName !== "o_dreaminaCliDispatch" || injectedVersionDrift) return builder;
            const originalWhere = builder.where.bind(builder);
            builder.where = (...whereArgs: unknown[]) => {
              const scoped = originalWhere(...whereArgs);
              const originalFirst = scoped.first.bind(scoped);
              scoped.first = async (...firstArgs: unknown[]) => {
                const row = await originalFirst(...firstArgs);
                if (row && !injectedVersionDrift) {
                  injectedVersionDrift = true;
                  // 中文注释：在同一事务的读取与 CAS 之间只推进版本，状态、lease、result 均保持不变。
                  const previousVersion = Number(row.updatedAt);
                  await trx("o_dreaminaCliDispatch").where({ taskUuid: versionDriftTaskUuid }).update({
                    updatedAt: previousVersion + 1,
                  });
                  const drifted = await trx("o_dreaminaCliDispatch")
                    .where({ taskUuid: versionDriftTaskUuid })
                    .first();
                  assert.equal(Number(drifted?.updatedAt), previousVersion + 1);
                }
                return row;
              };
              return scoped;
            };
            return builder;
          }) as any;
          return handler(wrappedTrx);
        });
      Object.defineProperty(directAccountDb, "transaction", {
        configurable: true,
        writable: true,
        value: wrappedTransaction,
      });
      assert.equal(directAccountDb.transaction, wrappedTransaction);
      try {
        const resolution = await resolveUnknownTask({ taskUuid: versionDriftTaskUuid, confirm: true })
          .then(() => ({ code: "RESOLVED" }))
          .catch((error: any) => ({ code: String(error?.code ?? "") }));
        assert.equal(injectedVersionDrift, true, "必须真实注入仅读取版本漂移");
        assert.equal(resolution.code, "DREAMINA_UNKNOWN_STATE_CONFLICT");
      } finally {
        if (transactionDescriptor) {
          Object.defineProperty(directAccountDb, "transaction", transactionDescriptor);
        } else {
          delete (directAccountDb as any).transaction;
        }
      }
      const afterVersionDrift = await accountDb("o_dreaminaCliDispatch")
        .where({ taskUuid: versionDriftTaskUuid })
        .first();
      assert.deepEqual({
        queueState: afterVersionDrift?.queueState,
        providerState: afterVersionDrift?.providerState,
        slotHeld: Number(afterVersionDrift?.slotHeld ?? -1),
      }, {
        queueState: "provider_active",
        providerState: "unknown",
        slotHeld: 1,
      });

      assert.equal(fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, "utf8").trim() : "", "");

      const routeConflictTaskUuid = await enqueue();
      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        enterUserStorage(IDENTITY);
        next();
      });
      const { default: resolveUnknownRouter } = await import(
        "../../src/routes/task/dreaminaQueue/resolveUnknown"
      );
      app.use("/api/task/dreaminaQueue/resolveUnknown", resolveUnknownRouter);
      const routeServer = await new Promise<http.Server>((resolve) => {
        const created = app.listen(0, "127.0.0.1", () => resolve(created));
      });
      try {
        const address = routeServer.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const response = await fetch(`http://127.0.0.1:${port}/api/task/dreaminaQueue/resolveUnknown`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taskUuid: routeConflictTaskUuid, confirm: true }),
        });
        const body = await response.json() as { code?: unknown };
        assert.equal(response.status, 409);
        assert.equal(body.code, "DREAMINA_UNKNOWN_STATE_CONFLICT");
      } finally {
        await new Promise<void>((resolve) => routeServer.close(() => resolve()));
      }

      const raceTaskUuid = await enqueue();
      await accountDb("o_dreaminaCliDispatch").where({ taskUuid: raceTaskUuid }).update({
        queueState: "provider_active",
        providerState: "unknown",
        slotHeld: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        providerResultJson: JSON.stringify({ submitId: "fake-delayed-query-submit" }),
      });
      await runWithProjectStorage(PROJECT_UUID, () =>
        activeDb("o_storyboardGenerationTask").where({ taskUuid: raceTaskUuid }).update({
          status: "submitted",
          providerTaskId: "fake-delayed-query-submit",
        }));
      process.env.DREAMINA_FAKE_SCENARIO = "delay_query";
      process.env.DREAMINA_FAKE_QUERY_STATUS = "running";
      process.env.DREAMINA_FAKE_DELAY_MS = "900";
      fs.writeFileSync(fakeLog, "");

      const querying = tickDreaminaScheduler();
      const waitStartedAt = Date.now();
      while (Date.now() - waitStartedAt < 700) {
        const log = fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, "utf8") : "";
        if (log.includes("query_result")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.match(fs.readFileSync(fakeLog, "utf8"), /query_result/, "必须先进入 fake CLI 的延迟查询窗口");
      await resolveUnknownTask({ taskUuid: raceTaskUuid, confirm: true });
      await querying;

      const afterRace = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: raceTaskUuid }).first();
      const afterRaceProject = await runWithProjectStorage(PROJECT_UUID, () =>
        activeDb("o_storyboardGenerationTask").where({ taskUuid: raceTaskUuid }).first());
      assert.deepEqual({
        queueState: afterRace?.queueState,
        providerState: afterRace?.providerState,
        slotHeld: Number(afterRace?.slotHeld ?? -1),
        projectStatus: afterRaceProject?.status,
      }, {
        queueState: "terminal",
        providerState: "failed",
        slotHeld: 0,
        projectStatus: "failed_fatal",
      });
    });
  } finally {
    stopDreaminaSchedulerLoop();
    syncCoordinator.listProjects = previousListProjects;
    await closeActivatedWorkspaceRuntime();
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fs.rmSync(cleanupRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch {
      // 中文注释：Windows 偶发延迟释放目录句柄时，仅保留在本工作树 .tmp，绝不跨目录清理。
    }
  }
});
