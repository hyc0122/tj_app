import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import knex, { type Knex } from "knex";

import { getInitialTableSchemas } from "../../src/lib/initDB";
import { buildApplicationMigrations } from "../../src/tianjiang/data/application-migrations";
import {
  migrateJiasuProviderModelCatalogV44,
  migrateJiasuProviderV4,
} from "../../src/tianjiang/data/jiasu-provider-migration";
import { migrateProviderImageRecovery } from "../../src/tianjiang/data/provider-image-recovery-migration";

const controlledTempRoot = path.resolve(process.cwd(), "..", ".tmp");

async function createDatabase(name: string): Promise<{ database: Knex; root: string }> {
  fs.mkdirSync(controlledTempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(controlledTempRoot, name));
  const database = knex({
    client: "better-sqlite3",
    connection: { filename: path.join(root, "db2.sqlite") },
    useNullAsDefault: true,
  });
  await database.schema.createTable("o_vendorConfig", (table) => {
    table.string("id").primary();
    table.text("inputValues");
    table.text("models");
    table.integer("enable");
  });
  return { database, root };
}

test("新账号初始化时佳速 API 默认开启", async () => {
  fs.mkdirSync(controlledTempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(controlledTempRoot, "tj-jiasu-default-enabled-"));
  const database = knex({
    client: "better-sqlite3",
    connection: { filename: path.join(root, "db2.sqlite") },
    useNullAsDefault: true,
  });
  try {
    const schema = getInitialTableSchemas(true).find((item) => item.name === "o_vendorConfig");
    assert.ok(schema?.initData);
    await database.schema.createTable(schema.name, schema.builder);
    await schema.initData(database);
    const row = await database("o_vendorConfig").where({ id: "tianjiang" }).first();
    assert.equal(row.enable, 1);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("迁移到佳速 API 时保留密钥、用户字段、模型和启用状态", async () => {
  const { database, root } = await createDatabase("tj-jiasu-migration-");
  const written: string[] = [];
  try {
    const models = JSON.stringify([{ name: "用户模型", modelName: "custom-model", type: "image" }]);
    await database("o_vendorConfig").insert({
      id: "tianjiang",
      inputValues: JSON.stringify({
        apiKey: "existing-secret",
        baseUrl: "https://api.tianjiang.net/v1",
        userField: "保留值",
      }),
      models,
      enable: 1,
    });

    await migrateJiasuProviderV4(database, {
      builtinSource: "exports.vendor={version:'4.0'}",
      readInstalledVersion: () => "3.2",
      writeInstalledSource: (source) => written.push(source),
    });

    const row = await database("o_vendorConfig").where({ id: "tianjiang" }).first();
    assert.deepEqual(JSON.parse(row.inputValues), {
      apiKey: "existing-secret",
      baseUrl: "https://js.jiasuapi.com/v1",
      userField: "保留值",
    });
    assert.equal(row.models, models);
    assert.equal(row.enable, 1);
    assert.deepEqual(written, ["exports.vendor={version:'4.0'}"]);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("已安装 4.0 或更高版本时不覆盖用户源码", async () => {
  const { database, root } = await createDatabase("tj-jiasu-newer-");
  let writes = 0;
  try {
    await database("o_vendorConfig").insert({
      id: "tianjiang",
      inputValues: JSON.stringify({ apiKey: "secret", baseUrl: "https://custom.invalid/v1" }),
      models: "[]",
      enable: 0,
    });
    await migrateJiasuProviderV4(database, {
      builtinSource: "new-source",
      readInstalledVersion: () => "4.1",
      writeInstalledSource: () => { writes += 1; },
    });
    const row = await database("o_vendorConfig").where({ id: "tianjiang" }).first();
    assert.deepEqual(JSON.parse(row.inputValues), {
      apiKey: "secret",
      baseUrl: "https://js.jiasuapi.com/v1",
    });
    assert.equal(writes, 0);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("供应商行不存在时迁移不创建配置也不写源码", async () => {
  const { database, root } = await createDatabase("tj-jiasu-missing-");
  let writes = 0;
  try {
    await migrateJiasuProviderV4(database, {
      builtinSource: "new-source",
      readInstalledVersion: () => undefined,
      writeInstalledSource: () => { writes += 1; },
    });
    assert.equal(await database("o_vendorConfig").where({ id: "tianjiang" }).first(), undefined);
    assert.equal(writes, 0);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("损坏的 inputValues 必须阻断迁移，禁止覆盖密钥配置", async () => {
  const { database, root } = await createDatabase("tj-jiasu-invalid-");
  let writes = 0;
  try {
    await database("o_vendorConfig").insert({
      id: "tianjiang",
      inputValues: "{invalid-json",
      models: "[]",
      enable: 1,
    });
    await assert.rejects(
      migrateJiasuProviderV4(database, {
        builtinSource: "new-source",
        readInstalledVersion: () => "3.2",
        writeInstalledSource: () => { writes += 1; },
      }),
      /佳速 API 配置损坏/,
    );
    const row = await database("o_vendorConfig").where({ id: "tianjiang" }).first();
    assert.equal(row.inputValues, "{invalid-json");
    assert.equal(writes, 0);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("图片恢复迁移只替换错误预置并保留密钥、自定义模型和开关", async () => {
  const { database, root } = await createDatabase("tj-provider-image-recovery-");
  const writes: Array<[string, string]> = [];
  try {
    await database("o_vendorConfig").insert([
      {
        id: "tianjiang",
        inputValues: JSON.stringify({ apiKey: "existing-jiasu-secret", baseUrl: "https://js.jiasuapi.com/v1" }),
        models: JSON.stringify([
          { name: "旧图片预置", modelName: "doubao-seedream-5.0-Lite", type: "image", mode: ["text"] },
          { name: "旧视频预置", modelName: "Seedance 2.0", type: "video", mode: ["text"], audio: "optional" },
          { name: "用户自定义模型", modelName: "custom-image-alias", type: "image", mode: ["text"] },
        ]),
        enable: 0,
      },
      {
        id: "volcengine",
        inputValues: JSON.stringify({ apiKey: "existing-volc-secret", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3" }),
        models: JSON.stringify([{ name: "用户火山模型", modelName: "custom-volc-model", type: "text" }]),
        enable: 1,
      },
    ]);

    await migrateProviderImageRecovery(database, {
      builtinSources: { tianjiang: "jiasu-v4.1-source", volcengine: "volc-v2.5-source" },
      readInstalledVersion: (providerId) => providerId === "tianjiang" ? "4.0" : "2.4",
      writeInstalledSource: (providerId, source) => writes.push([providerId, source]),
    });

    const jiasu = await database("o_vendorConfig").where({ id: "tianjiang" }).first();
    assert.deepEqual(JSON.parse(jiasu.inputValues), {
      apiKey: "existing-jiasu-secret",
      baseUrl: "https://js.jiasuapi.com/v1",
    });
    assert.equal(jiasu.enable, 0);
    const jiasuModels = JSON.parse(jiasu.models);
    assert.deepEqual(jiasuModels.map((model: { modelName: string }) => model.modelName), [
      "doubao-seedream-4-0-250828",
      "doubao-seedance-1-0-pro-fast",
      "custom-image-alias",
    ]);

    const volcengine = await database("o_vendorConfig").where({ id: "volcengine" }).first();
    assert.deepEqual(JSON.parse(volcengine.inputValues), {
      apiKey: "existing-volc-secret",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    });
    assert.deepEqual(JSON.parse(volcengine.models), [
      { name: "用户火山模型", modelName: "custom-volc-model", type: "text" },
    ]);
    assert.equal(volcengine.enable, 1);
    assert.deepEqual(writes, [
      ["tianjiang", "jiasu-v4.1-source"],
      ["volcengine", "volc-v2.5-source"],
    ]);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("4.2 旧源码必须升级到含模型列表的 4.4，并保留账号配置和模型", async () => {
  const { database, root } = await createDatabase("tj-jiasu-model-catalog-");
  const writes: string[] = [];
  try {
    const inputValues = JSON.stringify({
      apiKey: "existing-secret",
      baseUrl: "https://js.jiasuapi.com/v1",
      userField: "保留值",
    });
    const models = JSON.stringify([
      { name: "用户视频模型", modelName: "custom-video", type: "video" },
    ]);
    await database("o_vendorConfig").insert({
      id: "tianjiang",
      inputValues,
      models,
      enable: 1,
    });

    await migrateJiasuProviderModelCatalogV44(database, {
      builtinSource: "exports.vendor={version:'4.4'};exports.listModels=async()=>[]",
      readInstalledVersion: () => "4.2",
      writeInstalledSource: (source) => writes.push(source),
    });

    const row = await database("o_vendorConfig").where({ id: "tianjiang" }).first();
    assert.equal(row.inputValues, inputValues);
    assert.equal(row.models, models);
    assert.equal(row.enable, 1);
    assert.deepEqual(writes, [
      "exports.vendor={version:'4.4'};exports.listModels=async()=>[]",
    ]);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("账号库注册佳速 4.4 源码升级迁移，项目库不得重复改写全局供应商源码", () => {
  const accountMigrations = buildApplicationMigrations({
    role: "account",
    skipEmbeddingInit: true,
  });
  const projectMigrations = buildApplicationMigrations({
    role: "project",
    skipEmbeddingInit: true,
  });
  assert.ok(accountMigrations.some((migration) => migration.name === "jiasu-provider-model-catalog-v4-4"));
  assert.equal(
    accountMigrations.at(-1)?.name,
    "canvas-import-staging-reservations-v1",
  );
  assert.equal(
    projectMigrations.some((migration) => migration.name === "jiasu-provider-model-catalog-v4-4"),
    false,
  );
});
