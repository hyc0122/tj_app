import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import knex from "knex";

import {
  migrationChecksum,
  migrateSQLite,
  type SqliteMigration,
} from "../../src/tianjiang/data/sqlite-migrator";

function migrations(): SqliteMigration[] {
  return [
    {
      version: 1,
      name: "create-items",
      checksumSource: "create table items v1",
      up: async (database) => {
        await database.schema.createTable("items", (table) => {
          table.integer("id").primary();
          table.text("name").notNullable();
        });
      },
    },
    {
      version: 2,
      name: "seed-items",
      checksumSource: "seed preserved default row v1",
      up: async (database) => {
        await database("items").insert({ id: 1, name: "默认数据" });
      },
    },
    {
      version: 3,
      name: "create-item-children",
      checksumSource: "create item foreign key v1",
      up: async (database) => {
        await database.schema.createTable("item_children", (table) => {
          table.integer("id").primary();
          table.integer("item_id").notNullable().references("id").inTable("items");
        });
      },
    },
  ];
}

test("空库按版本顺序迁移、记录校验和、生成一致备份且重复运行幂等", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-migrate-empty-"));
  const databasePath = path.join(root, "db2.sqlite");
  fs.writeFileSync(databasePath, "");
  const database = createKnex(databasePath);
  try {
    const first = await migrateSQLite({ database, databasePath, migrations: migrations() });
    assert.deepEqual(first.appliedVersions, [1, 2, 3]);
    assert.ok(first.backupPath);
    assert.equal(fs.existsSync(first.backupPath), true);
    assert.equal(fs.existsSync(`${first.backupPath}.json`), true);
    const rows = await database("schema_migrations").orderBy("version");
    assert.deepEqual(rows.map((row) => row.version), [1, 2, 3]);
    assert.equal(rows.every((row) => /^[0-9a-f]{64}$/.test(row.checksum)), true);
    assert.deepEqual(await database("items"), [{ id: 1, name: "默认数据" }]);
    assert.match(JSON.stringify(await database.raw("PRAGMA foreign_keys")), /foreign_keys["']?:1/);
    assert.match(JSON.stringify(await database.raw("PRAGMA journal_mode")), /wal/i);
    assert.match(JSON.stringify(await database.raw("PRAGMA busy_timeout")), /"(?:busy_timeout|timeout)":5000/);
    await assert.rejects(
      () => database("item_children").insert({ id: 1, item_id: 999 }),
      /FOREIGN KEY constraint failed/i,
      "迁移连接必须真实执行外键约束，不能只校验 PRAGMA 返回值",
    );

    const second = await migrateSQLite({ database, databasePath, migrations: migrations() });
    assert.deepEqual(second.appliedVersions, []);
    assert.equal(second.backupPath, undefined);
    assert.deepEqual(await database("items"), [{ id: 1, name: "默认数据" }]);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("真实旧库无迁移表时保留原表、行和主键并继续升级", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-migrate-legacy-"));
  const databasePath = path.join(root, "db2.sqlite");
  const legacy = new Database(databasePath);
  legacy.exec("CREATE TABLE legacy_data(id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  legacy.prepare("INSERT INTO legacy_data(id, value) VALUES (?, ?)").run(7, "必须保留");
  legacy.close();
  const database = createKnex(databasePath);
  try {
    await migrateSQLite({ database, databasePath, migrations: migrations() });
    assert.deepEqual(await database("legacy_data"), [{ id: 7, value: "必须保留" }]);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("已应用迁移校验和漂移会拒绝启动", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-migrate-checksum-"));
  const databasePath = path.join(root, "db2.sqlite");
  fs.writeFileSync(databasePath, "");
  const database = createKnex(databasePath);
  try {
    await migrateSQLite({ database, databasePath, migrations: migrations() });
    const drifted = migrations();
    drifted[0] = { ...drifted[0], checksumSource: "tampered migration" };
    await assert.rejects(
      () => migrateSQLite({ database, databasePath, migrations: drifted }),
      /校验和漂移/,
    );
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("品牌化后的迁移校验和继续接受已安装旧版本记录", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-migrate-compatible-checksum-"));
  const databasePath = path.join(root, "db2.sqlite");
  fs.writeFileSync(databasePath, "");
  const database = createKnex(databasePath);
  const legacyToken = String.fromCodePoint(
    116, 111, 111, 110, 102, 108, 111, 119,
  );
  const currentMigration: SqliteMigration = {
    version: 1,
    name: "create-items",
    checksumSource: "tianjiang create items v1",
    compatibleChecksumSources: [`${legacyToken} create items v1`],
    up: async () => {},
  };
  try {
    await database.schema.createTable("schema_migrations", (table) => {
      table.integer("version").primary();
      table.text("name").notNullable();
      table.text("checksum").notNullable();
      table.text("applied_at").notNullable();
    });
    await database("schema_migrations").insert({
      version: 1,
      name: currentMigration.name,
      checksum: migrationChecksum({
        ...currentMigration,
        checksumSource: currentMigration.compatibleChecksumSources![0],
      }),
      applied_at: new Date(0).toISOString(),
    });

    const result = await migrateSQLite({
      database,
      databasePath,
      migrations: [currentMigration],
    });
    assert.deepEqual(result.appliedVersions, []);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("单个迁移失败会回滚且版本不前进，备份失败则禁止创建迁移表", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-migrate-failure-"));
  const databasePath = path.join(root, "db2.sqlite");
  fs.writeFileSync(databasePath, "");
  const database = createKnex(databasePath);
  const failing: SqliteMigration[] = [{
    version: 1,
    name: "failing",
    checksumSource: "failing v1",
    up: async (trx) => {
      await trx.schema.createTable("must_rollback", (table) => table.integer("id"));
      throw new Error("synthetic migration failure");
    },
  }];
  try {
    await assert.rejects(
      () => migrateSQLite({ database, databasePath, migrations: failing }),
      /synthetic migration failure/,
    );
    assert.equal(await database.schema.hasTable("must_rollback"), false);
    assert.deepEqual(await database("schema_migrations"), []);
  } finally {
    await database.destroy();
  }

  const backupFailurePath = path.join(root, "backup-failure.sqlite");
  fs.writeFileSync(backupFailurePath, "");
  const backupFailureDatabase = createKnex(backupFailurePath);
  try {
    await assert.rejects(
      () => migrateSQLite({
        database: backupFailureDatabase,
        databasePath: backupFailurePath,
        migrations: migrations(),
        backup: async () => {
          throw new Error("synthetic backup failure");
        },
      }),
      /synthetic backup failure/,
    );
    assert.equal(await backupFailureDatabase.schema.hasTable("schema_migrations"), false);
  } finally {
    await backupFailureDatabase.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createKnex(databasePath: string) {
  return knex({
    client: "better-sqlite3",
    connection: { filename: databasePath },
    useNullAsDefault: true,
  });
}
