/**
 * 供应商模型删除：模板/自定义/最后一个/幂等/不补回/账号隔离/凭据不变。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import {
  deleteVendorModelFromState,
  mergeVendorModelList,
  parseVendorModelsState,
  serializeVendorModelsState,
  upsertCustomVendorModel,
  type VendorModelRecord,
} from "../../src/utils/vendor-models-store";

const SECRET = "must-not-appear-in-assert-messages";

const templateModels: VendorModelRecord[] = [
  { name: "模板A", modelName: "tpl-a", type: "text", think: false },
  { name: "模板B", modelName: "tpl-b", type: "text", think: false },
];

function tempRoot(name: string): string {
  const root = path.join(process.cwd(), "..", ".tmp", `vendor-del-${name}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

async function createDb(filename: string): Promise<Knex> {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const database = knex({
    client: "better-sqlite3",
    connection: { filename },
    useNullAsDefault: true,
  });
  await database.schema.createTable("o_vendorConfig", (table) => {
    table.text("id").primary();
    table.text("inputValues");
    table.text("models");
    table.integer("enable");
  });
  return database;
}

test("删除模板初始模型后列表不再含该名，序列化含 excluded 且刷新合并不补回", () => {
  const state = parseVendorModelsState("[]");
  const deleted = deleteVendorModelFromState(templateModels, state, "tpl-a");
  assert.equal(deleted.ok, true);
  if (!deleted.ok) return;
  assert.equal(deleted.list.some((m) => m.modelName === "tpl-a"), false);
  assert.equal(deleted.list.some((m) => m.modelName === "tpl-b"), true);
  assert.deepEqual(deleted.state.excluded, ["tpl-a"]);

  // 模拟模板刷新（同一模板再次 merge）不得补回
  const again = mergeVendorModelList(templateModels, deleted.state);
  assert.equal(again.some((m) => m.modelName === "tpl-a"), false);
  assert.equal(again.some((m) => m.modelName === "tpl-b"), true);

  const raw = serializeVendorModelsState(deleted.state);
  assert.equal(raw.includes("tpl-a"), true);
  const reparsed = parseVendorModelsState(raw);
  assert.deepEqual(reparsed.excluded, ["tpl-a"]);
  assert.equal(mergeVendorModelList(templateModels, reparsed).some((m) => m.modelName === "tpl-a"), false);
});

test("删除自定义模型后 custom 移除，模板刷新不会凭空恢复自定义", () => {
  let state = parseVendorModelsState("[]");
  state = upsertCustomVendorModel(state, {
    name: "自定义",
    modelName: "custom-1",
    type: "text",
    think: true,
  });
  const before = mergeVendorModelList(templateModels, state);
  assert.equal(before.some((m) => m.modelName === "custom-1"), true);

  const deleted = deleteVendorModelFromState(templateModels, state, "custom-1");
  assert.equal(deleted.ok, true);
  if (!deleted.ok) return;
  assert.equal(deleted.list.some((m) => m.modelName === "custom-1"), false);
  assert.equal(deleted.state.custom.some((m) => m.modelName === "custom-1"), false);
  // 纯自定义不在模板中，无需 excluded
  assert.equal(deleted.state.excluded.includes("custom-1"), false);
  assert.equal(
    mergeVendorModelList(templateModels, deleted.state).some((m) => m.modelName === "custom-1"),
    false,
  );
});

test("允许删除最后一个模型并保存空列表", () => {
  let state = parseVendorModelsState("[]");
  // 先排除全部模板
  for (const model of templateModels) {
    const step = deleteVendorModelFromState(templateModels, state, model.modelName);
    assert.equal(step.ok, true);
    if (step.ok) state = step.state;
  }
  assert.deepEqual(mergeVendorModelList(templateModels, state), []);

  state = upsertCustomVendorModel(state, {
    name: "唯一",
    modelName: "only-one",
    type: "text",
    think: false,
  });
  assert.equal(mergeVendorModelList(templateModels, state).length, 1);

  const deleted = deleteVendorModelFromState(templateModels, state, "only-one");
  assert.equal(deleted.ok, true);
  if (!deleted.ok) return;
  assert.deepEqual(deleted.list, []);
  const raw = serializeVendorModelsState(deleted.state);
  const reparsed = parseVendorModelsState(raw);
  assert.deepEqual(mergeVendorModelList(templateModels, reparsed), []);
});

test("模型不存在返回明确文案，禁止基本模型不允许删除", () => {
  const state = parseVendorModelsState("[]");
  const missing = deleteVendorModelFromState(templateModels, state, "no-such-model");
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.message, "模型不存在或已删除");
  assert.equal(missing.message.includes("基本模型"), false);

  // 已删除后再次删除同名模板模型 → 幂等明确错误
  const once = deleteVendorModelFromState(templateModels, state, "tpl-a");
  assert.equal(once.ok, true);
  if (!once.ok) return;
  const twice = deleteVendorModelFromState(templateModels, once.state, "tpl-a");
  assert.equal(twice.ok, false);
  if (twice.ok) return;
  assert.equal(twice.message, "模型不存在或已删除");
});

test("删除覆盖模板的自定义模型后，模板原模型也不会补回", () => {
  let state = parseVendorModelsState("[]");
  state = upsertCustomVendorModel(state, {
    name: "覆盖A",
    modelName: "tpl-a",
    type: "text",
    think: true,
  });
  const visible = mergeVendorModelList(templateModels, state);
  const overridden = visible.find((m) => m.modelName === "tpl-a");
  assert.equal(overridden?.name, "覆盖A");

  const deleted = deleteVendorModelFromState(templateModels, state, "tpl-a");
  assert.equal(deleted.ok, true);
  if (!deleted.ok) return;
  assert.equal(deleted.list.some((m) => m.modelName === "tpl-a"), false);
  assert.ok(deleted.state.excluded.includes("tpl-a"));
});

test("A/B 账号隔离：删除与凭据写入互不影响", async () => {
  const root = tempRoot("ab");
  try {
    const alice = await createDb(path.join(root, "alice", "db2.sqlite"));
    const bob = await createDb(path.join(root, "bob", "db2.sqlite"));
    try {
      await alice("o_vendorConfig").insert({
        id: "synthetic",
        inputValues: JSON.stringify({ apiKey: "alice-key", baseUrl: "https://a.example" }),
        models: serializeVendorModelsState({ custom: [], excluded: [] }),
        enable: 1,
      });
      await bob("o_vendorConfig").insert({
        id: "synthetic",
        inputValues: JSON.stringify({ apiKey: "bob-key", baseUrl: "https://b.example" }),
        models: serializeVendorModelsState({
          custom: [{ name: "BobCustom", modelName: "bob-m", type: "text", think: false }],
          excluded: [],
        }),
        enable: 1,
      });

      // Alice 删除模板 tpl-a
      const aliceRow = await alice("o_vendorConfig").where("id", "synthetic").first();
      const aliceState = parseVendorModelsState(aliceRow.models);
      const aliceDel = deleteVendorModelFromState(templateModels, aliceState, "tpl-a");
      assert.equal(aliceDel.ok, true);
      if (!aliceDel.ok) return;
      await alice("o_vendorConfig").where("id", "synthetic").update({
        models: serializeVendorModelsState(aliceDel.state),
      });

      const aliceAfter = await alice("o_vendorConfig").where("id", "synthetic").first();
      const bobAfter = await bob("o_vendorConfig").where("id", "synthetic").first();

      // Alice 模板 A 已排除
      assert.equal(
        mergeVendorModelList(templateModels, parseVendorModelsState(aliceAfter.models))
          .some((m) => m.modelName === "tpl-a"),
        false,
      );
      // Bob 仍有自定义，且未排除 tpl-a
      const bobList = mergeVendorModelList(
        templateModels,
        parseVendorModelsState(bobAfter.models),
      );
      assert.equal(bobList.some((m) => m.modelName === "bob-m"), true);
      assert.equal(bobList.some((m) => m.modelName === "tpl-a"), true);

      // 凭据未变（不断言密钥进错误消息）
      assert.equal(JSON.parse(aliceAfter.inputValues).apiKey, "alice-key");
      assert.equal(JSON.parse(bobAfter.inputValues).apiKey, "bob-key");
      assert.equal(JSON.parse(aliceAfter.inputValues).baseUrl, "https://a.example");
    } finally {
      await Promise.all([alice.destroy(), bob.destroy()]);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("删除模型不改写 inputValues（含密钥字段）", async () => {
  const root = tempRoot("creds");
  try {
    const database = await createDb(path.join(root, "db2.sqlite"));
    try {
      const inputValues = JSON.stringify({
        apiKey: SECRET,
        baseUrl: "https://provider.example/v1",
      });
      await database("o_vendorConfig").insert({
        id: "synthetic",
        inputValues,
        models: "[]",
        enable: 1,
      });
      const before = await database("o_vendorConfig").where("id", "synthetic").first();
      const state = parseVendorModelsState(before.models);
      const deleted = deleteVendorModelFromState(templateModels, state, "tpl-b");
      assert.equal(deleted.ok, true);
      if (!deleted.ok) return;
      await database("o_vendorConfig").where("id", "synthetic").update({
        models: serializeVendorModelsState(deleted.state),
        // 故意不写 inputValues
      });
      const after = await database("o_vendorConfig").where("id", "synthetic").first();
      assert.equal(after.inputValues, before.inputValues);
      assert.equal(JSON.parse(after.inputValues).apiKey, SECRET);
      // 测试输出侧：message 路径不含密钥字面（本用例无 message）
      assert.equal(deleted.list.some((m) => m.modelName === "tpl-b"), false);
    } finally {
      await database.destroy();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("兼容旧版 models 纯数组；重新添加已排除模型会取消排除", () => {
  const legacy = serializeVendorModelsState({
    custom: [{ name: "旧自定义", modelName: "legacy-c", type: "text", think: false }],
    excluded: [],
  });
  assert.equal(legacy.startsWith("["), true);
  const state = parseVendorModelsState(legacy);
  assert.equal(state.custom[0]?.modelName, "legacy-c");

  const afterExclude = deleteVendorModelFromState(templateModels, state, "tpl-a");
  assert.equal(afterExclude.ok, true);
  if (!afterExclude.ok) return;
  const restored = upsertCustomVendorModel(afterExclude.state, {
    name: "恢复A",
    modelName: "tpl-a",
    type: "text",
    think: false,
  });
  assert.equal(restored.excluded.includes("tpl-a"), false);
  assert.equal(
    mergeVendorModelList(templateModels, restored).find((m) => m.modelName === "tpl-a")?.name,
    "恢复A",
  );
});

test("损坏或类型错误的 models JSON 必须失败关闭，禁止静默清空后覆盖用户模型", () => {
  assert.throws(
    () => parseVendorModelsState("{broken-json"),
    /JSON 损坏.*保护原始数据/,
  );
  assert.throws(
    () => parseVendorModelsState(JSON.stringify({ unexpected: [] })),
    /JSON 类型无效.*保护原始数据/,
  );
});
