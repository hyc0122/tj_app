import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import knex from "knex";

import {
  CURRENT_VENDOR_ID,
  LEGACY_PROTOCOL_SCHEME,
  LEGACY_VENDOR_ID,
  legacyUserStorageSegment,
} from "../../src/tianjiang/identity/product-identity";
import {
  migrateLegacyVendorIdentity,
  migrateLegacyVendorSourceFile,
} from "../../src/tianjiang/data/product-identity-migration";
import { buildApplicationMigrations } from "../../src/tianjiang/data/application-migrations";
import {
  migrateLegacyUserStorageRoot,
  userStorageSegment,
} from "../../src/tianjiang/runtime/user-storage-context";

const controlledTempRoot = path.resolve(process.cwd(), "..", ".tmp");

function createControlledTempRoot(prefix: string): string {
  fs.mkdirSync(controlledTempRoot, { recursive: true });
  return fs.mkdtempSync(path.join(controlledTempRoot, prefix));
}

test("旧供应商主键、模型前缀和私密配置单向迁移到 tianjiang", async () => {
  const root = createControlledTempRoot("tj-product-vendor-");
  const database = knex({
    client: "better-sqlite3",
    connection: { filename: path.join(root, "db2.sqlite") },
    useNullAsDefault: true,
  });
  try {
    await database.schema.createTable("o_vendorConfig", (table) => {
      table.string("id").primary();
      table.text("inputValues");
      table.text("models");
      table.integer("enable");
    });
    await database.schema.createTable("o_agentDeploy", (table) => {
      table.integer("id").primary();
      table.string("vendorId");
      table.string("model");
      table.string("modelName");
    });
    await database("o_vendorConfig").insert({
      id: LEGACY_VENDOR_ID,
      inputValues: JSON.stringify({ apiKey: "legacy-secret" }),
      models: JSON.stringify([{ modelName: `${LEGACY_VENDOR_ID}:model-a` }]),
      enable: 1,
    });
    await database("o_agentDeploy").insert({
      id: 1,
      vendorId: LEGACY_VENDOR_ID,
      model: `${LEGACY_VENDOR_ID}:model-a`,
      modelName: `${LEGACY_VENDOR_ID}:model-a`,
    });

    await migrateLegacyVendorIdentity(database);

    assert.equal(await database("o_vendorConfig").where("id", LEGACY_VENDOR_ID).first(), undefined);
    const current = await database("o_vendorConfig").where("id", CURRENT_VENDOR_ID).first();
    assert.deepEqual(JSON.parse(current.inputValues), { apiKey: "legacy-secret" });
    assert.match(current.models, new RegExp(CURRENT_VENDOR_ID, "i"));
    const agent = await database("o_agentDeploy").where("id", 1).first();
    assert.equal(agent.vendorId, CURRENT_VENDOR_ID);
    assert.equal(agent.model, `${CURRENT_VENDOR_ID}:model-a`);
    assert.equal(agent.modelName, `${CURRENT_VENDOR_ID}:model-a`);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("新旧供应商行同时存在时保留新值并补齐旧私密配置", async () => {
  const root = createControlledTempRoot("tj-product-vendor-merge-");
  const database = knex({
    client: "better-sqlite3",
    connection: { filename: path.join(root, "db2.sqlite") },
    useNullAsDefault: true,
  });
  try {
    await database.schema.createTable("o_vendorConfig", (table) => {
      table.string("id").primary();
      table.text("inputValues");
      table.text("models");
      table.integer("enable");
    });
    await database("o_vendorConfig").insert([
      {
        id: LEGACY_VENDOR_ID,
        inputValues: JSON.stringify({ apiKey: "legacy-secret", endpoint: "legacy" }),
        models: JSON.stringify([
          { modelName: `${LEGACY_VENDOR_ID}:legacy-only`, label: "legacy-only" },
          { modelName: `${LEGACY_VENDOR_ID}:shared`, label: "legacy-shared" },
        ]),
        enable: 1,
      },
      {
        id: CURRENT_VENDOR_ID,
        inputValues: JSON.stringify({ endpoint: "current" }),
        models: JSON.stringify([
          { modelName: `${CURRENT_VENDOR_ID}:current-only`, label: "current-only" },
          { modelName: `${CURRENT_VENDOR_ID}:shared`, label: "current-shared" },
        ]),
        enable: 0,
      },
    ]);

    await migrateLegacyVendorIdentity(database);
    await migrateLegacyVendorIdentity(database);

    const rows = await database("o_vendorConfig").orderBy("id");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, CURRENT_VENDOR_ID);
    assert.deepEqual(JSON.parse(rows[0].inputValues), {
      apiKey: "legacy-secret",
      endpoint: "current",
    });
    assert.deepEqual(JSON.parse(rows[0].models), [
      { modelName: `${CURRENT_VENDOR_ID}:current-only`, label: "current-only" },
      { modelName: `${CURRENT_VENDOR_ID}:shared`, label: "current-shared" },
      { modelName: `${CURRENT_VENDOR_ID}:legacy-only`, label: "legacy-only" },
    ]);
    assert.equal(rows[0].enable, 1);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("新旧供应商双行遇到损坏 JSON 时失败关闭且不删除任何原始行", async () => {
  const root = createControlledTempRoot("tj-product-vendor-corrupt-");
  const database = knex({
    client: "better-sqlite3",
    connection: { filename: path.join(root, "db2.sqlite") },
    useNullAsDefault: true,
  });
  try {
    await database.schema.createTable("o_vendorConfig", (table) => {
      table.string("id").primary();
      table.text("inputValues");
      table.text("models");
      table.integer("enable");
    });
    await database("o_vendorConfig").insert([
      {
        id: LEGACY_VENDOR_ID,
        inputValues: JSON.stringify({ apiKey: "legacy-secret" }),
        models: "{broken-json",
        enable: 1,
      },
      {
        id: CURRENT_VENDOR_ID,
        inputValues: "{}",
        models: "[]",
        enable: 1,
      },
    ]);

    await assert.rejects(
      () => migrateLegacyVendorIdentity(database),
      /供应商模型 JSON 损坏/,
    );
    const rows = await database("o_vendorConfig").orderBy("id");
    assert.equal(rows.length, 2);
    assert.equal(rows.some((row) => row.id === LEGACY_VENDOR_ID), true);
    assert.equal(rows.some((row) => row.models === "{broken-json"), true);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("只有当前供应商行时仍清理遗留模型前缀并保持幂等", async () => {
  const root = createControlledTempRoot("tj-product-current-models-");
  const database = knex({
    client: "better-sqlite3",
    connection: { filename: path.join(root, "db2.sqlite") },
    useNullAsDefault: true,
  });
  try {
    await database.schema.createTable("o_vendorConfig", (table) => {
      table.string("id").primary();
      table.text("inputValues");
      table.text("models");
      table.integer("enable");
    });
    await database("o_vendorConfig").insert({
      id: CURRENT_VENDOR_ID,
      inputValues: "{}",
      models: JSON.stringify([{ modelName: `${LEGACY_VENDOR_ID}:model-a` }]),
      enable: 1,
    });

    await migrateLegacyVendorIdentity(database);
    await migrateLegacyVendorIdentity(database);

    const current = await database("o_vendorConfig").where("id", CURRENT_VENDOR_ID).first();
    assert.deepEqual(JSON.parse(current.models), [{
      modelName: `${CURRENT_VENDOR_ID}:model-a`,
    }]);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("旧用户目录和活动指针单向改名，新哈希成为唯一持久化位置", () => {
  const root = createControlledTempRoot("tj-product-user-storage-");
  const identity = { issuer: "https://central.example.test", userId: 7 };
  const oldSegment = legacyUserStorageSegment(identity);
  const newSegment = userStorageSegment(identity);
  assert.notEqual(oldSegment, newSegment);
  const usersRoot = path.join(root, "runtime-users");
  const oldRoot = path.join(usersRoot, oldSegment);
  fs.mkdirSync(oldRoot, { recursive: true });
  fs.writeFileSync(path.join(oldRoot, "db2.sqlite"), "legacy-user-data");
  fs.writeFileSync(
    path.join(usersRoot, "active-user.json"),
    JSON.stringify({ segment: oldSegment }),
  );

  migrateLegacyUserStorageRoot(root, identity);
  migrateLegacyUserStorageRoot(root, identity);

  assert.equal(fs.existsSync(oldRoot), false);
  assert.equal(
    fs.readFileSync(path.join(usersRoot, newSegment, "db2.sqlite"), "utf8"),
    "legacy-user-data",
  );
  const marker = JSON.parse(
    fs.readFileSync(path.join(usersRoot, "active-user.json"), "utf8"),
  );
  assert.equal(marker.segment, newSegment);
  fs.rmSync(root, { recursive: true, force: true });
});

test("新旧用户目录同时存在时失败关闭且两份数据均保留", () => {
  const root = createControlledTempRoot("tj-product-user-storage-conflict-");
  const identity = { issuer: "https://central.example.test", userId: 9 };
  const oldRoot = path.join(root, "runtime-users", legacyUserStorageSegment(identity));
  const newRoot = path.join(root, "runtime-users", userStorageSegment(identity));
  fs.mkdirSync(oldRoot, { recursive: true });
  fs.mkdirSync(newRoot, { recursive: true });
  fs.writeFileSync(path.join(oldRoot, "legacy.txt"), "legacy");
  fs.writeFileSync(path.join(newRoot, "current.txt"), "current");

  assert.throws(
    () => migrateLegacyUserStorageRoot(root, identity),
    /新旧账号目录同时存在/,
  );
  assert.equal(fs.readFileSync(path.join(oldRoot, "legacy.txt"), "utf8"), "legacy");
  assert.equal(fs.readFileSync(path.join(newRoot, "current.txt"), "utf8"), "current");
  fs.rmSync(root, { recursive: true, force: true });
});

test("旧动态供应商文件单向改名并改写内部机器标识", () => {
  const root = createControlledTempRoot("tj-product-vendor-file-");
  const legacyPath = path.join(root, `${LEGACY_VENDOR_ID}.ts`);
  fs.writeFileSync(
    legacyPath,
    `exports.vendor = { id: "${LEGACY_VENDOR_ID}", name: "legacy" };\n`,
  );

  migrateLegacyVendorSourceFile(root);

  assert.equal(fs.existsSync(legacyPath), false);
  const currentPath = path.join(root, `${CURRENT_VENDOR_ID}.ts`);
  assert.match(fs.readFileSync(currentPath, "utf8"), /id: "tianjiang"/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("当前动态供应商文件也会清理遗留内部机器标识并保持幂等", () => {
  const root = createControlledTempRoot("tj-product-current-vendor-file-");
  const currentPath = path.join(root, `${CURRENT_VENDOR_ID}.ts`);
  fs.writeFileSync(
    currentPath,
    `exports.vendor = { id: "${LEGACY_VENDOR_ID}", name: "legacy" };\n`,
  );

  migrateLegacyVendorSourceFile(root);
  migrateLegacyVendorSourceFile(root);

  const currentSource = fs.readFileSync(currentPath, "utf8");
  assert.equal(currentSource.includes(LEGACY_VENDOR_ID), false);
  assert.match(currentSource, /id: "tianjiang"/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("动态供应商文件冲突时保留当前文件并为旧内容创建恢复副本", () => {
  const root = createControlledTempRoot("tj-product-vendor-file-conflict-");
  const legacyPath = path.join(root, `${LEGACY_VENDOR_ID}.ts`);
  const currentPath = path.join(root, `${CURRENT_VENDOR_ID}.ts`);
  fs.writeFileSync(
    legacyPath,
    `exports.vendor = { id: "${LEGACY_VENDOR_ID}", value: "old" };\n`,
  );
  fs.writeFileSync(
    currentPath,
    `exports.vendor = { id: "${CURRENT_VENDOR_ID}", value: "new" };\n`,
  );

  migrateLegacyVendorSourceFile(root);
  migrateLegacyVendorSourceFile(root);

  assert.equal(fs.existsSync(legacyPath), false);
  assert.match(fs.readFileSync(currentPath, "utf8"), /value: "new"/);
  const recoveryRoot = path.join(root, "legacy-identity-recovery");
  const recoveryFiles = fs.readdirSync(recoveryRoot);
  assert.equal(recoveryFiles.length, 1);
  assert.match(
    fs.readFileSync(path.join(recoveryRoot, recoveryFiles[0]), "utf8"),
    /value: "old"/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("旧协议兼容值必须等于动态旧标识且不同于当前协议", () => {
  assert.equal(LEGACY_PROTOCOL_SCHEME, LEGACY_VENDOR_ID);
  assert.notEqual(LEGACY_PROTOCOL_SCHEME, CURRENT_VENDOR_ID);
});

test("产品机器标识迁移独立，最新迁移安全升级默认视频提示词", () => {
  const migrations = buildApplicationMigrations({ role: "account", skipEmbeddingInit: true });
  const product = migrations.find((m) => m.name === "product-machine-identity-v1");
  assert.ok(product);
  assert.equal(product!.version, 30);
  const latest = migrations.at(-1);
  assert.equal(latest?.version, 39);
  assert.equal(latest?.name, "dreamina-dispatch-enqueue-idempotency-v1");
  assert.ok(migrations.some((item) => item.name === "video-prompt-default-zh-v1"));
  assert.ok(migrations.some((item) => item.name === "database-role-account-v1"));
});
