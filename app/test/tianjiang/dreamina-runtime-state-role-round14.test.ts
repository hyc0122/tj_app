/**
 * Task 6 RED：运行态表只属于账号库；偏好进注册键；可执行路径进本机运行态；敏感字段失败关闭。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import express from "express";
import knex, { type Knex } from "knex";

import { buildApplicationMigrations } from "../../src/tianjiang/data/application-migrations";
import { migrateSQLite } from "../../src/tianjiang/data/sqlite-migrator";
import {
  activateUserDatabase,
  accountDb,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { createUniqueWorktreeRoot, closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");
const RUNTIME_TABLE = "o_dreaminaCliRuntimeState";

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function jsonRequest(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

function openDatabase(root: string, label: string): { database: Knex; databasePath: string } {
  const dir = path.join(root, label);
  fs.mkdirSync(dir, { recursive: true });
  const databasePath = path.join(dir, "db.sqlite");
  fs.writeFileSync(databasePath, "");
  return {
    databasePath,
    database: knex({
      client: "better-sqlite3",
      connection: { filename: databasePath },
      useNullAsDefault: true,
    }),
  };
}

async function columnNames(database: Knex, table: string): Promise<string[]> {
  const rows = await database.raw(`PRAGMA table_info(${table})`) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

test("账号链必须追加 dreamina-cli-runtime-state-v1，项目链不得出现运行态表", async () => {
  const account = buildApplicationMigrations({ role: "account", skipEmbeddingInit: true });
  const project = buildApplicationMigrations({ role: "project", skipEmbeddingInit: true });
  const frozen = account.find((item) => item.name === "dreamina-cli-account-v1");
  const runtime = account.find((item) => item.name === "dreamina-cli-runtime-state-v1");
  assert.ok(frozen, "已发布的 dreamina-cli-account-v1 不得消失");
  assert.equal(frozen!.checksumSource, "dreamina cli account settings session dispatch v1");
  assert.ok(runtime, "账号链必须追加全新版本 dreamina-cli-runtime-state-v1");
  assert.equal(runtime!.version, frozen!.version + 1);
  assert.ok(!project.some((item) => item.name === "dreamina-cli-runtime-state-v1"));

  const root = createUniqueWorktreeRoot("dreamina-runtime-migrate-r14");
  const accountDbHandle = openDatabase(root, "account");
  const projectDbHandle = openDatabase(root, "project");
  try {
    await migrateSQLite({
      database: accountDbHandle.database,
      databasePath: accountDbHandle.databasePath,
      migrations: account,
    });
    await migrateSQLite({
      database: projectDbHandle.database,
      databasePath: projectDbHandle.databasePath,
      migrations: project,
    });
    assert.equal(await accountDbHandle.database.schema.hasTable(RUNTIME_TABLE), true, "账号库必须有运行态表");
    assert.equal(await projectDbHandle.database.schema.hasTable(RUNTIME_TABLE), false, "项目库不得有运行态表");
    const names = await columnNames(accountDbHandle.database, RUNTIME_TABLE);
    assert.ok(!names.some((name) => /cookie|token|password|secret|deviceCode|userCode|device_code|user_code/i.test(name)));
  } finally {
    await accountDbHandle.database.destroy();
    await projectDbHandle.database.destroy();
  }
});

test("updateSettings 把偏好写入注册键、路径写入运行态，并拒绝登录材料", async () => {
  const root = createUniqueWorktreeRoot("dreamina-runtime-http-r14");
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const identity = { issuer: "https://api.j11.com.cn", userId: 9415 };

  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);

    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => {
      enterUserStorage(identity);
      next();
    });
    for (const name of ["getSettings", "updateSettings"] as const) {
      const loaded = await import(`../../src/routes/setting/dreaminaCli/${name}.ts`);
      app.use(`/api/setting/dreaminaCli/${name}`, loaded.default);
    }
    const { server, port } = await listen(app);
    const base = `http://127.0.0.1:${port}/api/setting/dreaminaCli`;
    try {
      const rejected = await jsonRequest(`${base}/updateSettings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          executablePath: FAKE_CLI,
          token: "must-not-store",
          cookie: "sid=abc",
          deviceCode: "device-code-secret",
        }),
      });
      assert.equal(rejected.status, 400, `提交 token/cookie/deviceCode 必须 400，实际 ${rejected.status} ${JSON.stringify(rejected.body)}`);

      const updated = await jsonRequest(`${base}/updateSettings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          executablePath: FAKE_CLI,
          preferredExecutionTarget: "wsl",
          maxConcurrency: 3,
        }),
      });
      assert.equal(updated.status, 200, `合法设置必须成功: ${JSON.stringify(updated.body)}`);

      await runWithUserStorage(identity, async () => {
        assert.equal(await accountDb.schema.hasTable(RUNTIME_TABLE), true, "生产账号库必须有运行态表");
        const runtime = await accountDb(RUNTIME_TABLE).where({ id: 1 }).first();
        assert.ok(runtime, "运行态表必须有默认行");
        assert.equal(runtime.executablePath, FAKE_CLI, "可执行路径必须写入设备本地运行态");
        assert.notEqual(
          runtime.effectiveExecutionTarget,
          "wsl",
          "effectiveExecutionTarget 不得因偏好是 WSL 而被写成已安装",
        );

        const dumped = JSON.stringify(runtime);
        assert.doesNotMatch(dumped, /must-not-store|sid=abc|device-code-secret/);

        const settings = await jsonRequest(`${base}/getSettings`);
        const payload = settings.body?.data ?? settings.body;
        assert.equal(payload.preferredExecutionTarget, "wsl");
        assert.equal(payload.maxConcurrency, 3);
        assert.equal(payload.executablePath, FAKE_CLI);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});
