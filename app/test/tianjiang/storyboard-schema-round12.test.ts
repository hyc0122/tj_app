/**
 * Task 2 RED：账号/项目角色迁移必须 fail-closed，并给项目库稳定资产 UUID 与分镜表。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import { buildApplicationMigrations } from "../../src/tianjiang/data/application-migrations";
import {
  migrateStoryboardGenerationEnqueueIdempotency,
  migrateStoryboardProjectSchema,
} from "../../src/tianjiang/data/storyboard-project-migration";
import { migrateSQLite } from "../../src/tianjiang/data/sqlite-migrator";

const tmpRoot = path.join(process.cwd(), "..", ".tmp", "sb-schema-t2");

const STORYBOARD_TABLES = [
  "o_storyboardShot",
  "o_storyboardShotAsset",
  "o_storyboardWorkspaceSettings",
  "o_storyboardCandidate",
  "o_storyboardGenerationTask",
] as const;

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

test("项目角色迁移链必须在 video-prompt 后追加角色标记和分镜表，且旧编号不移动", () => {
  const baseline = buildApplicationMigrations({
    role: "project",
    skipEmbeddingInit: true,
  });
  const videoPrompt = baseline.find((item) => item.name === "video-prompt-default-zh-v1");
  assert.ok(videoPrompt, "既有 video-prompt-default-zh-v1 不得消失");
  const roleMarker = baseline.find((item) => item.name === "database-role-project-v1");
  assert.ok(roleMarker, "项目库必须写入 database-role-project-v1");
  assert.ok(roleMarker!.version === videoPrompt!.version + 1);
  const storyboard = baseline.find((item) => item.name === "storyboard-project-schema-v1");
  assert.ok(storyboard, "项目库必须追加分镜表迁移");
  assert.ok(storyboard!.version === roleMarker!.version + 1);
  assert.ok(!baseline.some((item) => item.name === "database-role-account-v1"));
  assert.ok(!baseline.some((item) => item.name.includes("dreamina")));
});

test("账号角色迁移链只写账号角色标记，不得创建分镜表", () => {
  const account = buildApplicationMigrations({
    role: "account",
    skipEmbeddingInit: true,
  });
  const videoPrompt = account.find((item) => item.name === "video-prompt-default-zh-v1");
  const roleMarker = account.find((item) => item.name === "database-role-account-v1");
  assert.ok(videoPrompt);
  assert.ok(roleMarker);
  assert.equal(roleMarker!.version, videoPrompt!.version + 1);
  assert.equal(account.at(-1)?.name, "jiasu-provider-model-catalog-v4-4");
  assert.ok(!account.some((item) => item.name === "storyboard-project-schema-v1"));
});

test("项目入队迁移在只落部分列后重跑必须补齐 ready/限额列和唯一索引", async () => {
  const partial = openDatabase("project-partial-enqueue");
  try {
    await migrateStoryboardProjectSchema(partial.database);
    await partial.database.schema.alterTable("o_storyboardGenerationTask", (table) => {
      table.string("clientOperationId", 36);
      table.integer("operationItemIndex");
    });
    await migrateStoryboardGenerationEnqueueIdempotency(partial.database);
    for (const column of [
      "clientOperationId",
      "operationItemIndex",
      "enqueueReady",
      "projectConcurrencyLimit",
      "modelConcurrencyLimit",
    ]) {
      assert.equal(await partial.database.schema.hasColumn("o_storyboardGenerationTask", column), true, `缺少 ${column}`);
    }
    const indexes = await partial.database.raw("PRAGMA index_list(o_storyboardGenerationTask)") as Array<{ name: string }>;
    assert.ok(indexes.some((row) => row.name === "idx_storyboard_generation_operation_item"));
    assert.equal(
      await partial.database.schema.hasColumn("o_storyboardGenerationOperation", "requestIntentDigest"),
      true,
    );
  } finally {
    await partial.database.destroy();
  }
});

test("空库、最新库和历史库项目迁移后都有五张分镜表、默认设置和稳定资产 UUID", async () => {
  const empty = openDatabase("empty");
  const latest = openDatabase("latest");
  const historical = openDatabase("historical");
  try {
    await migrate("project", empty.database, empty.databasePath);

    const baselineOnly = buildApplicationMigrations({
      role: "project",
      skipEmbeddingInit: true,
    }).filter((item) => item.name === "video-prompt-default-zh-v1"
      || item.version < (buildApplicationMigrations({
        role: "project",
        skipEmbeddingInit: true,
      }).find((row) => row.name === "video-prompt-default-zh-v1")?.version ?? 0));
    await migrateSQLite({
      database: historical.database,
      databasePath: historical.databasePath,
      migrations: baselineOnly.length > 0
        ? baselineOnly
        : buildApplicationMigrations({ role: "project", skipEmbeddingInit: true }).slice(0, -2),
    });
    await historical.database("o_assets").insert({
      id: 91,
      name: "角色甲",
      type: "role",
      projectId: 1,
    });
    await migrate("project", historical.database, historical.databasePath);

    await migrate("project", latest.database, latest.databasePath);
    await migrate("project", latest.database, latest.databasePath);

    for (const item of [empty, historical, latest]) {
      for (const table of STORYBOARD_TABLES) {
        assert.equal(await item.database.schema.hasTable(table), true, `缺少表 ${table}`);
      }
      assert.equal(await item.database.schema.hasColumn("o_assets", "assetUuid"), true);
      const settings = await item.database("o_storyboardWorkspaceSettings").first();
      assert.ok(settings, "必须写入默认分镜设置");
    }

    const first = await historical.database("o_assets").where({ id: 91 }).first();
    await migrate("project", historical.database, historical.databasePath);
    const second = await historical.database("o_assets").where({ id: 91 }).first();
    assert.match(String(first.assetUuid), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(first.assetUuid, second.assetUuid);

    await empty.database("o_storyboardShot").insert({
      shotUuid: "11111111-1111-4111-a111-111111111111",
      displayOrder: 1,
      createdAt: "2026-08-13T00:00:00Z",
      updatedAt: "2026-08-13T00:00:00Z",
    });
    await assert.rejects(
      () => empty.database("o_storyboardShot").insert({
        shotUuid: "22222222-2222-4222-a222-222222222222",
        displayOrder: 1,
        createdAt: "2026-08-13T00:00:00Z",
        updatedAt: "2026-08-13T00:00:00Z",
      }),
      /unique|UNIQUE/i,
    );
    await assert.rejects(
      () => empty.database("o_storyboardShot").insert({
        shotUuid: "33333333-3333-4333-a333-333333333333",
        displayOrder: 0,
        createdAt: "2026-08-13T00:00:00Z",
        updatedAt: "2026-08-13T00:00:00Z",
      }),
      /check|CHECK|constraint/i,
    );
  } finally {
    await empty.database.destroy();
    await latest.database.destroy();
    await historical.database.destroy();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("账号角色不得创建分镜表，错误角色再次打开必须校验和漂移", async () => {
  const projectDb = openDatabase("role-project");
  const accountDb = openDatabase("role-account");
  try {
    await migrate("project", projectDb.database, projectDb.databasePath);
    await migrate("account", accountDb.database, accountDb.databasePath);

    for (const table of STORYBOARD_TABLES) {
      assert.equal(await accountDb.database.schema.hasTable(table), false, `账号库不得有 ${table}`);
    }
    assert.equal(await accountDb.database.schema.hasTable("o_dreaminaCliSettings"), true);
    assert.equal(await projectDb.database.schema.hasTable("o_dreaminaCliSettings"), false);

    await assert.rejects(
      () => migrate("account", projectDb.database, projectDb.databasePath),
      /SQLite 迁移校验和漂移/,
    );
    await assert.rejects(
      () => migrate("project", accountDb.database, accountDb.databasePath),
      /SQLite 迁移校验和漂移/,
    );
  } finally {
    await projectDb.database.destroy();
    await accountDb.database.destroy();
  }
});
