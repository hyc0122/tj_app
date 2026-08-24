/**
 * R26 RED：队列暂停必须区分停用、手动暂停和生命周期排空；启动只恢复生命周期暂停。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import {
  migrateDreaminaCliAccountSchema,
  migrateDreaminaCliEnabled,
  migrateDreaminaCliPauseReason,
} from "../../src/tianjiang/data/dreamina-cli-account-migration";
import { recoverDreaminaSlots } from "../../src/tianjiang/model-providers/dreamina-cli/recovery";
import {
  getDreaminaQueueState,
  pauseDreaminaClaimsForEnablement,
  stopDreaminaSchedulerLoop,
} from "../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import {
  readDreaminaCliSettings,
  resolveDreaminaPauseReason,
  setDreaminaCliSettingsWriteHookForTests,
  writeDreaminaCliSettings,
} from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 3260 };
const LEAK = "E:\\data\\db2.sqlite SELECT * FROM queue at pause.ts:18 cookie=abc sk-secret";

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function jsonRequest(url: string, body?: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

async function withQueueControlRoutes(run: (base: string) => Promise<void>): Promise<void> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `dreamina-r26-routes-${crypto.randomUUID()}`);
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  setDreaminaCliSettingsWriteHookForTests(null);
  let server: http.Server | undefined;
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      await writeDreaminaCliSettings({ enabled: true, pauseReason: "manual_pause", maxConcurrency: 3 });
      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        // 中文注释：路由测试固定注入当前账号上下文，避免跨账号读写造成假阳性。
        runWithUserStorage(IDENTITY, () => Promise.resolve(next()));
      });
      app.use("/update", (await import("../../src/routes/setting/dreaminaCli/updateSettings")).default);
      app.use("/pause", (await import("../../src/routes/task/dreaminaQueue/pause")).default);
      app.use("/resume", (await import("../../src/routes/task/dreaminaQueue/resume")).default);
      const listening = await listen(app);
      server = listening.server;
      await run(`http://127.0.0.1:${listening.port}`);
    });
  } finally {
    setDreaminaCliSettingsWriteHookForTests(null);
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    stopDreaminaSchedulerLoop();
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function openDatabase(label: string): { database: Knex; root: string } {
  const parent = path.resolve(process.cwd(), "..", ".tmp", "dreamina-r26-migration");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, `${label}-`));
  const databasePath = path.join(root, "db.sqlite");
  fs.writeFileSync(databasePath, "");
  return {
    root,
    database: knex({
      client: "better-sqlite3",
      connection: { filename: databasePath },
      useNullAsDefault: true,
    }),
  };
}

test("pauseReason 迁移把旧 pauseNewClaims=true 明确归类为 manual_pause", async () => {
  const fixture = openDatabase("legacy");
  try {
    await migrateDreaminaCliAccountSchema(fixture.database);
    await migrateDreaminaCliEnabled(fixture.database);
    await fixture.database("o_dreaminaCliSettings").where({ id: 1 }).update({ pauseNewClaims: 1 });
    await migrateDreaminaCliPauseReason(fixture.database);
    const row = await fixture.database("o_dreaminaCliSettings").where({ id: 1 }).first();
    assert.equal(row?.pauseReason, "manual_pause");
  } finally {
    await fixture.database.destroy();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("运行时对账保留 lifecycle_drain，只有账号激活显式恢复；手动暂停始终保留", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `dreamina-r26-recovery-${crypto.randomUUID()}`);
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      await writeDreaminaCliSettings({ enabled: true, pauseReason: "manual_pause" });
      await recoverDreaminaSlots();
      let settings = await readDreaminaCliSettings();
      assert.equal(settings.pauseReason, "manual_pause");
      assert.equal(resolveDreaminaPauseReason(settings), "manual_pause");
      assert.equal((await getDreaminaQueueState()).paused, true);

      await writeDreaminaCliSettings({ pauseReason: "lifecycle_drain" });
      const before = await getDreaminaQueueState();
      await recoverDreaminaSlots();
      settings = await readDreaminaCliSettings();
      let after = await getDreaminaQueueState();
      assert.equal(settings.pauseReason, "lifecycle_drain");
      assert.equal(after.pauseReason, "lifecycle_drain");
      assert.equal(after.paused, true);
      // 中文注释：恢复领取门不得删除或替换任何任务身份。
      assert.equal(after.queued, before.queued);
      assert.equal(after.activeSlots, before.activeSlots);

      await (recoverDreaminaSlots as unknown as (
        options: { recoverLifecycleDrain: boolean },
      ) => Promise<{ recovered: number }>)({ recoverLifecycleDrain: true });
      settings = await readDreaminaCliSettings();
      after = await getDreaminaQueueState();
      assert.equal(settings.pauseReason, "none");
      assert.equal(after.pauseReason, "none");
      assert.equal(after.paused, false);

      await writeDreaminaCliSettings({ enabled: false, pauseReason: "lifecycle_drain" });
      await recoverDreaminaSlots();
      settings = await readDreaminaCliSettings();
      assert.equal(settings.enabled, false);
      // 中文注释：普通运行时对账不拥有生命周期恢复权限，即便停用也不能改写底层原因。
      assert.equal(settings.pauseReason, "lifecycle_drain");
      assert.equal(resolveDreaminaPauseReason(settings), "disabled");
      assert.equal((await getDreaminaQueueState()).pauseReason, "disabled");

      await (recoverDreaminaSlots as unknown as (
        options: { recoverLifecycleDrain: boolean },
      ) => Promise<{ recovered: number }>)({ recoverLifecycleDrain: true });
      await writeDreaminaCliSettings({ enabled: true });
      assert.equal((await getDreaminaQueueState()).pauseReason, "none");
      assert.equal((await getDreaminaQueueState()).paused, false);
    });
  } finally {
    stopDreaminaSchedulerLoop();
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    // 中文注释：Windows sqlite/定时器句柄释放有短暂延迟，限定在本用例目录内重试清理。
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("旧 updateSettings 不能绕过专用队列恢复门", async () => {
  await withQueueControlRoutes(async (base) => {
      const before = await readDreaminaCliSettings();
      const bypass = await jsonRequest(`${base}/update`, { pauseNewClaims: false });
      assert.notEqual(bypass.status, 200, JSON.stringify(bypass.body));
      const afterBypass = await readDreaminaCliSettings();
      assert.equal(afterBypass.pauseReason, "manual_pause");
      assert.equal(afterBypass.updatedAt, before.updatedAt);
  });
});

test("队列控制未知错误使用固定中文安全码，显式 lifecycle 冲突仍返回 409", async () => {
  await withQueueControlRoutes(async (base) => {
      setDreaminaCliSettingsWriteHookForTests(() => { throw new Error(LEAK); });
      const pauseFailed = await jsonRequest(`${base}/pause`);
      assert.equal(pauseFailed.body?.code, "DREAMINA_QUEUE_PAUSE_FAILED");
      assert.equal(pauseFailed.body?.message, "即梦队列暂停失败，请稍后重试");
      assert.equal(pauseFailed.text.includes("db2.sqlite"), false);
      assert.equal(pauseFailed.text.includes("sk-secret"), false);
      const resumeFailed = await jsonRequest(`${base}/resume`);
      assert.equal(resumeFailed.body?.code, "DREAMINA_QUEUE_RESUME_FAILED");
      assert.equal(resumeFailed.body?.message, "即梦队列恢复失败，请稍后重试");
      assert.equal(resumeFailed.text.includes("SELECT *"), false);
      setDreaminaCliSettingsWriteHookForTests(null);

      const leaveDrain = pauseDreaminaClaimsForEnablement();
      try {
        const conflict = await jsonRequest(`${base}/resume`);
        assert.equal(conflict.status, 409);
        assert.match(String(conflict.body?.message ?? conflict.text), /生命周期排空|排空提交临界区/);
      } finally {
        leaveDrain();
      }
  });
});

test("暂停和恢复成功响应必须带严格递增 updatedAt", async () => {
  await withQueueControlRoutes(async (base) => {
      const resumed = await jsonRequest(`${base}/resume`);
      assert.equal(resumed.status, 200);
      assert.ok(Number(resumed.body?.data?.updatedAt) > 0);
      const paused = await jsonRequest(`${base}/pause`);
      assert.equal(paused.status, 200);
      assert.ok(Number(paused.body?.data?.updatedAt) > Number(resumed.body?.data?.updatedAt));
  });
});

test("并发上限只接受 1..8，边界值能持久化", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `dreamina-r26-concurrency-${crypto.randomUUID()}`);
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      assert.equal((await writeDreaminaCliSettings({ maxConcurrency: 1 })).maxConcurrency, 1);
      assert.equal((await writeDreaminaCliSettings({ maxConcurrency: 8 })).maxConcurrency, 8);
      await assert.rejects(
        () => writeDreaminaCliSettings({ maxConcurrency: 0 }),
        (error: any) => error?.code === "DREAMINA_CLI_INVALID_CONCURRENCY",
      );
      await assert.rejects(
        () => writeDreaminaCliSettings({ maxConcurrency: 9 }),
        (error: any) => error?.code === "DREAMINA_CLI_INVALID_CONCURRENCY",
      );
    });
  } finally {
    await runWithUserStorage(IDENTITY, () => closeActivatedWorkspaceRuntime()).catch(() => undefined);
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
