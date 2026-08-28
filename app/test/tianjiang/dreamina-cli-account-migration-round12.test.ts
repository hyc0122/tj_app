/**
 * Task 9 RED：即梦本机会话表必须由账号角色迁移链创建，项目链 fail-closed。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import { buildApplicationMigrations } from "../../src/tianjiang/data/application-migrations";
import {
  migrateDreaminaCliAccountSchema,
  migrateDreaminaDispatchEnqueueIdempotency,
} from "../../src/tianjiang/data/dreamina-cli-account-migration";
import { migrateSQLite } from "../../src/tianjiang/data/sqlite-migrator";
import {
  activateUserDatabase,
  accountDb,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";

const ACCOUNT_TABLES = [
  "o_dreaminaCliSettings",
  "o_dreaminaCliSession",
  "o_dreaminaCliDispatch",
] as const;

const tmpRoot = path.join(process.cwd(), "..", ".tmp", "dreamina-account-t9");

function openDatabase(label: string): { database: Knex; databasePath: string; root: string } {
  fs.mkdirSync(tmpRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tmpRoot, `${label}-`));
  const databasePath = path.join(root, "db.sqlite");
  fs.writeFileSync(databasePath, "");
  return {
    root,
    databasePath,
    database: knex({
      client: "better-sqlite3",
      connection: { filename: databasePath },
      useNullAsDefault: true,
    }),
  };
}

async function migrate(role: "account" | "project", database: Knex, databasePath: string) {
  return migrateSQLite({
    database,
    databasePath,
    migrations: buildApplicationMigrations({
      role,
      skipEmbeddingInit: true,
    }),
  });
}

async function columnNames(database: Knex, table: string): Promise<string[]> {
  const rows = await database.raw(`PRAGMA table_info(${table})`) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

test("账号迁移链必须在角色标记后追加即梦与佳速升级迁移，项目链不得出现", () => {
  const account = buildApplicationMigrations({ role: "account", skipEmbeddingInit: true });
  const project = buildApplicationMigrations({ role: "project", skipEmbeddingInit: true });
  const roleMarker = account.find((item) => item.name === "database-role-account-v1");
  const dreamina = account.find((item) => item.name === "dreamina-cli-account-v1");
  assert.ok(roleMarker, "账号角色标记不得消失");
  assert.ok(dreamina, "账号链必须追加 dreamina-cli-account-v1");
  assert.equal(dreamina!.version, roleMarker!.version + 1);
  assert.deepEqual(account.slice(-7).map((item) => item.name), [
    "dreamina-cli-account-v1",
    "dreamina-cli-runtime-state-v1",
    "dreamina-dispatch-enqueue-idempotency-v1",
    "dreamina-cli-enabled-v1",
    "dreamina-cli-pause-reason-v1",
    "dreamina-cli-poll-seconds-v1",
    "jiasu-provider-model-catalog-v4-4",
  ]);
  assert.ok(!project.some((item) => item.name.includes("dreamina")));
  assert.ok(!account.some((item) => item.name === "storyboard-project-schema-v1"));
});

test("账号入队迁移在只落第一列后重跑必须补齐其余列和项目边界唯一索引", async () => {
  const partial = openDatabase("account-partial-enqueue");
  try {
    await migrateDreaminaCliAccountSchema(partial.database);
    await partial.database.schema.alterTable("o_dreaminaCliDispatch", (table) => {
      table.string("clientOperationId", 36);
    });
    await migrateDreaminaDispatchEnqueueIdempotency(partial.database);
    for (const column of [
      "clientOperationId",
      "operationItemIndex",
      "dispatchReady",
      "dispatchIdentityDigest",
    ]) {
      assert.equal(await partial.database.schema.hasColumn("o_dreaminaCliDispatch", column), true, `缺少 ${column}`);
    }
    const indexes = await partial.database.raw("PRAGMA index_list(o_dreaminaCliDispatch)") as Array<{ name: string }>;
    assert.ok(indexes.some((row) => row.name === "idx_dreamina_dispatch_operation_item"));
  } finally {
    await partial.database.destroy();
  }
});

test("账号库迁移后默认并发为 1，0/9 被约束拒绝，且不含凭据列", async () => {
  const account = openDatabase("account");
  const project = openDatabase("project");
  try {
    await migrate("account", account.database, account.databasePath);
    await migrate("project", project.database, project.databasePath);

    for (const table of ACCOUNT_TABLES) {
      assert.equal(await account.database.schema.hasTable(table), true, `账号库缺少 ${table}`);
      assert.equal(await project.database.schema.hasTable(table), false, `项目库不得有 ${table}`);
    }

    const settings = await account.database("o_dreaminaCliSettings").where({ id: 1 }).first();
    assert.ok(settings);
    assert.equal(settings.maxConcurrency, 1);
    assert.equal(settings.pauseNewClaims, 0);
    assert.equal(settings.executablePath, null);

    await assert.rejects(
      () => account.database("o_dreaminaCliSettings").where({ id: 1 }).update({ maxConcurrency: 0 }),
      /check|CHECK|constraint/i,
    );
    await assert.rejects(
      () => account.database("o_dreaminaCliSettings").where({ id: 1 }).update({ maxConcurrency: 9 }),
      /check|CHECK|constraint/i,
    );

    for (const table of ACCOUNT_TABLES) {
      const names = await columnNames(account.database, table);
      assert.ok(!names.some((name) => /cookie|token|password|secret|deviceCode|userCode|stdout|stderr/i.test(name)));
    }

    await assert.rejects(
      () => migrate("project", account.database, account.databasePath),
      /SQLite 迁移校验和漂移/,
    );
    await assert.rejects(
      () => migrate("account", project.database, project.databasePath),
      /SQLite 迁移校验和漂移/,
    );
  } finally {
    await account.database.destroy();
    await project.database.destroy();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Windows 可能短暂锁住 WAL；不影响合同断言。
    }
  }
});

test("activateUserDatabase 生产入口必须在账号库创建即梦三表", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", "dreamina-activate-t9");
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const identity = { issuer: "https://api.j11.com.cn", userId: 9004 };

  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      for (const table of ACCOUNT_TABLES) {
        assert.equal(await accountDb.schema.hasTable(table), true, `生产账号库缺少 ${table}`);
      }
      const settings = await accountDb("o_dreaminaCliSettings").where({ id: 1 }).first();
      assert.equal(settings?.maxConcurrency, 1);
    });
  } finally {
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 可能短暂锁住 WAL；不影响合同断言。
    }
  }
});
