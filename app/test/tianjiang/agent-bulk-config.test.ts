/**
 * 一键配置全部 Agent：RED→GREEN
 * 覆盖简易/高级目标键、排除项、模型校验、事务回滚、账号隔离。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import {
  BulkAgentConfigError,
  buildBulkUpdatePatches,
  executeBulkAgentConfig,
  resolveBulkTargetKeys,
  resolveTextModelForBulk,
  safeBulkAgentErrorMessage,
  SIMPLE_AGENT_KEYS,
  type AgentDeployRow,
  type VendorModelCandidate,
} from "../../src/tianjiang/agent/bulk-agent-config";

function seedRows(extra: AgentDeployRow[] = []): AgentDeployRow[] {
  const base: AgentDeployRow[] = [
    { id: 1, key: "scriptAgent", disabled: false, temperature: 7, maxOutputTokens: 100 },
    { id: 2, key: "productionAgent", disabled: false, temperature: 5, maxOutputTokens: 200 },
    { id: 3, key: "universalAi", disabled: false, temperature: 1, maxOutputTokens: 0 },
    { id: 4, key: "ttsDubbing", disabled: true, temperature: 1, maxOutputTokens: 0 },
    { id: 5, key: "scriptAgent:decisionAgent", disabled: false, temperature: 11, maxOutputTokens: 111 },
    { id: 6, key: "scriptAgent:supervisionAgent", disabled: false, temperature: 12, maxOutputTokens: 112 },
    { id: 7, key: "productionAgent:decisionAgent", disabled: false, temperature: 9, maxOutputTokens: 333 },
    { id: 8, key: "productionAgent:deriveAssetsAgent", disabled: true, temperature: 2, maxOutputTokens: 9 },
    { id: 9, key: "scriptAgent:scriptAgent", disabled: false, temperature: 3, maxOutputTokens: 50 },
  ];
  return [...base, ...extra];
}

const textModels: VendorModelCandidate[] = [
  {
    vendorId: "deepseek",
    vendorName: "DeepSeek",
    model: "DeepSeek-V3",
    modelName: "deepseek-chat",
    type: "text",
    enable: 1,
  },
  {
    vendorId: "deepseek",
    vendorName: "DeepSeek",
    model: "Image-X",
    modelName: "deepseek-image",
    type: "image",
    enable: 1,
  },
  {
    vendorId: "off-vendor",
    vendorName: "Off",
    model: "Off-Text",
    modelName: "off-text",
    type: "text",
    enable: 0,
  },
];

test("简易模式目标键仅三个父级，不含 tts 与子项", () => {
  const keys = resolveBulkTargetKeys("simple", seedRows());
  assert.deepEqual(keys, ["scriptAgent", "productionAgent", "universalAi"]);
  assert.equal(keys.includes("ttsDubbing" as string), false);
  assert.equal(keys.some((k) => k.includes(":")), false);
  assert.deepEqual([...SIMPLE_AGENT_KEYS], ["scriptAgent", "productionAgent", "universalAi"]);
});

test("高级模式含 universalAi 与全部启用子项，排除禁用子项与 tts", () => {
  const keys = resolveBulkTargetKeys("advanced", seedRows());
  assert.ok(keys.includes("universalAi"));
  assert.ok(keys.includes("scriptAgent:decisionAgent"));
  assert.ok(keys.includes("productionAgent:decisionAgent"));
  assert.equal(keys.includes("productionAgent:deriveAssetsAgent"), false);
  assert.equal(keys.includes("ttsDubbing"), false);
  assert.equal(keys.includes("scriptAgent"), false);
  assert.equal(keys.includes("productionAgent"), false);
});

test("禁用父级不进入简易目标", () => {
  const rows = seedRows().map((r) =>
    r.key === "productionAgent" ? { ...r, disabled: true } : r,
  );
  const keys = resolveBulkTargetKeys("simple", rows);
  assert.deepEqual(keys, ["scriptAgent", "universalAi"]);
});

test("无效/已删除/非文本/未启用供应商拒绝", () => {
  assert.throws(
    () => resolveTextModelForBulk(textModels, "missing", "x"),
    (e: unknown) => e instanceof BulkAgentConfigError && e.code === "VENDOR_DISABLED",
  );
  assert.throws(
    () => resolveTextModelForBulk(textModels, "off-vendor", "off-text"),
    (e: unknown) => e instanceof BulkAgentConfigError && e.code === "VENDOR_DISABLED",
  );
  assert.throws(
    () => resolveTextModelForBulk(textModels, "deepseek", "deleted-model"),
    (e: unknown) => e instanceof BulkAgentConfigError && e.code === "MODEL_NOT_FOUND",
  );
  assert.throws(
    () => resolveTextModelForBulk(textModels, "deepseek", "deepseek-image"),
    (e: unknown) => e instanceof BulkAgentConfigError && e.code === "MODEL_NOT_TEXT",
  );
  // 禁止采用客户端任意 modelLabel：只看候选 hit.model
  const ok = resolveTextModelForBulk(textModels, "deepseek", "deepseek-chat");
  assert.equal(ok.storedModelName, "deepseek:deepseek-chat");
  assert.equal(ok.model, "DeepSeek-V3");
});

test("补丁只含 vendorId/model/modelName，且数量与目标键一致", () => {
  const rows = seedRows();
  const keys = resolveBulkTargetKeys("simple", rows);
  const patches = buildBulkUpdatePatches(rows, keys, {
    vendorId: "deepseek",
    model: "DeepSeek-V3",
    storedModelName: "deepseek:deepseek-chat",
  });
  assert.equal(patches.length, 3);
  for (const p of patches) {
    assert.equal(p.vendorId, "deepseek");
    assert.equal(p.model, "DeepSeek-V3");
    assert.equal(p.modelName, "deepseek:deepseek-chat");
  }
});

async function openAccountDb(dir: string): Promise<Knex> {
  fs.mkdirSync(dir, { recursive: true });
  const databasePath = path.join(dir, "db2.sqlite");
  if (!fs.existsSync(databasePath)) fs.writeFileSync(databasePath, "");
  const db = knex({
    client: "better-sqlite3",
    connection: { filename: databasePath },
    useNullAsDefault: true,
  });
  await db.schema.createTable("o_agentDeploy", (table) => {
    table.integer("id").primary();
    table.string("key");
    table.string("name");
    table.string("model");
    table.string("modelName");
    table.text("vendorId");
    table.string("desc");
    table.integer("temperature");
    table.integer("maxOutputTokens");
    table.boolean("disabled");
  });
  await db.schema.createTable("o_vendorConfig", (table) => {
    table.text("id").primary();
    table.integer("enable");
    table.text("models");
    table.text("inputValues");
  });
  for (const row of seedRows()) {
    await db("o_agentDeploy").insert({
      id: row.id,
      key: row.key,
      name: row.key,
      model: "OLD",
      modelName: "old:model",
      vendorId: "old",
      desc: "d",
      temperature: row.temperature,
      maxOutputTokens: row.maxOutputTokens,
      disabled: Boolean(row.disabled),
    });
  }
  await db("o_vendorConfig").insert({
    id: "deepseek",
    enable: 1,
    models: JSON.stringify([
      { name: "DeepSeek-V3", modelName: "deepseek-chat", type: "text" },
      { name: "Image-X", modelName: "deepseek-image", type: "image" },
    ]),
    inputValues: JSON.stringify({ apiKey: "redacted-test-credential" }),
  });
  return db;
}

test("简易模式事务准确更新三个父级，保留 temperature/maxOutputTokens", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `agent-bulk-simple-${Date.now()}`);
  const db = await openAccountDb(root);
  try {
    const result = await executeBulkAgentConfig(
      db as any,
      {
        mode: "simple",
        vendorId: "deepseek",
        modelName: "deepseek-chat",
      },
      {
        listVendorModels: async () => textModels,
      },
    );
    assert.equal(result.updatedCount, 3);
    assert.deepEqual(result.keys.sort(), ["productionAgent", "scriptAgent", "universalAi"]);

    const parents = await db("o_agentDeploy")
      .whereIn("key", ["scriptAgent", "productionAgent", "universalAi"])
      .select("*");
    for (const row of parents) {
      assert.equal(row.vendorId, "deepseek");
      assert.equal(row.model, "DeepSeek-V3");
      assert.equal(row.modelName, "deepseek:deepseek-chat");
    }
    // 独立参数保留
    const script = parents.find((r: any) => r.key === "scriptAgent");
    assert.equal(script.temperature, 7);
    assert.equal(script.maxOutputTokens, 100);

    // tts 与子项未改
    const tts = await db("o_agentDeploy").where({ key: "ttsDubbing" }).first();
    assert.equal(tts.model, "OLD");
    const child = await db("o_agentDeploy").where({ key: "scriptAgent:decisionAgent" }).first();
    assert.equal(child.model, "OLD");
  } finally {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("高级模式更新 universalAi 与全部启用子项，禁用子项不动", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `agent-bulk-adv-${Date.now()}`);
  const db = await openAccountDb(root);
  try {
    const result = await executeBulkAgentConfig(
      db as any,
      {
        mode: "advanced",
        vendorId: "deepseek",
        modelName: "deepseek-chat",
      },
      {
        listVendorModels: async () => textModels,
      },
    );
    assert.ok(result.updatedCount >= 4);
    assert.ok(result.keys.includes("universalAi"));
    assert.ok(result.keys.includes("scriptAgent:decisionAgent"));
    assert.equal(result.keys.includes("productionAgent:deriveAssetsAgent"), false);

    const disabledChild = await db("o_agentDeploy")
      .where({ key: "productionAgent:deriveAssetsAgent" })
      .first();
    assert.equal(disabledChild.model, "OLD");

    const decision = await db("o_agentDeploy")
      .where({ key: "scriptAgent:decisionAgent" })
      .first();
    assert.equal(decision.modelName, "deepseek:deepseek-chat");
    assert.equal(decision.temperature, 11);
    assert.equal(decision.maxOutputTokens, 111);

    // 简易父级 scriptAgent 不应被高级模式改写
    const parent = await db("o_agentDeploy").where({ key: "scriptAgent" }).first();
    assert.equal(parent.model, "OLD");
  } finally {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("中途失败全部回滚，库内保持旧值", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `agent-bulk-rb-${Date.now()}`);
  const db = await openAccountDb(root);
  try {
    // 源码契约：executeBulkAgentConfig 必须走单事务
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/tianjiang/agent/bulk-agent-config.ts"),
      "utf8",
    );
    assert.match(source, /db\.transaction\s*\(/);

    // 真实事务行为：更新一半后抛错，整批回滚
    const rows = seedRows();
    const keys = resolveBulkTargetKeys("simple", rows);
    const patches = buildBulkUpdatePatches(rows, keys, {
      vendorId: "deepseek",
      model: "DeepSeek-V3",
      storedModelName: "deepseek:deepseek-chat",
    });
    assert.ok(patches.length >= 2);

    await assert.rejects(
      () =>
        db.transaction(async (trx) => {
          for (let i = 0; i < patches.length; i += 1) {
            if (i >= 1) throw new Error("SIMULATED_FAIL");
            await trx("o_agentDeploy").where({ id: patches[i].id }).update({
              vendorId: patches[i].vendorId,
              model: patches[i].model,
              modelName: patches[i].modelName,
            });
          }
        }),
      /SIMULATED_FAIL/,
    );

    const after = await db("o_agentDeploy")
      .whereIn("key", ["scriptAgent", "productionAgent", "universalAi"])
      .select("model", "modelName", "vendorId");
    for (const row of after) {
      assert.equal(row.model, "OLD");
      assert.equal(row.vendorId, "old");
      assert.equal(row.modelName, "old:model");
    }
  } finally {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A/B 账号隔离：各写自己的 db2，互不影响", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `agent-bulk-ab-${Date.now()}`);
  const aDb = await openAccountDb(path.join(root, "a"));
  const bDb = await openAccountDb(path.join(root, "b"));
  try {
    await executeBulkAgentConfig(
      aDb as any,
      {
        mode: "simple",
        vendorId: "deepseek",
        modelName: "deepseek-chat",
      },
      { listVendorModels: async () => textModels },
    );
    const a = await aDb("o_agentDeploy").where({ key: "scriptAgent" }).first();
    const b = await bDb("o_agentDeploy").where({ key: "scriptAgent" }).first();
    assert.equal(a.modelName, "deepseek:deepseek-chat");
    assert.equal(b.modelName, "old:model");
  } finally {
    await aDb.destroy();
    await bDb.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("错误信息脱敏不含密钥/路径/SQL", () => {
  assert.equal(
    safeBulkAgentErrorMessage(new Error("E:\\\\secret\\\\db.sqlite SELECT * FROM x bearer-token-sample")),
    "批量配置 Agent 失败，请稍后重试",
  );
  assert.equal(
    safeBulkAgentErrorMessage(new BulkAgentConfigError("MODEL_NOT_TEXT", "只能选择文本类型模型")),
    "只能选择文本类型模型",
  );
});

test("路由源码强制 accountDatabase 且请求契约无 model 字段", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "src/routes/setting/agentDeploy/bulkConfigureAgents.ts"),
    "utf8",
  );
  assert.match(route, /accountDatabase\s*\(/);
  assert.match(route, /mode:\s*z\.enum/);
  assert.match(route, /vendorId:\s*z\.string/);
  assert.match(route, /modelName:\s*z\.string/);
  assert.doesNotMatch(route, /model:\s*z\.string/);
  assert.doesNotMatch(route, /u\.db\s+as\s+any/);
});

test("事务内二次校验：候选在同一快照解析，禁止客户端 model 字段", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/tianjiang/agent/bulk-agent-config.ts"),
    "utf8",
  );
  assert.match(source, /listVendorModels:\s*\(trx/);
  assert.match(source, /resolveTextModelForBulk\(/);
  // 输入接口仅 mode/vendorId/modelName
  assert.match(source, /export interface BulkAgentConfigInput \{[^}]*mode:[^}]*vendorId:[^}]*modelName:\s*string/s);
  assert.doesNotMatch(
    source,
    /export interface BulkAgentConfigInput \{[^}]*\bmodel:\s*string/s,
  );
  // 函数签名无 modelLabel 参数
  assert.doesNotMatch(source, /resolveTextModelForBulk\([^)]*modelLabel/);
});

test("并发删除/禁用模型时整事务失败回滚，库内保持旧值", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `agent-bulk-race-${Date.now()}`);
  const db = await openAccountDb(root);
  try {
    await assert.rejects(
      () =>
        executeBulkAgentConfig(
          db as any,
          {
            mode: "simple",
            vendorId: "deepseek",
            modelName: "deepseek-chat",
          },
          {
            // 事务内列举时模型已消失，模拟并发删除
            listVendorModels: async () => [],
          },
        ),
      (err: unknown) =>
        err instanceof BulkAgentConfigError
        && (err.code === "MODEL_NOT_FOUND" || err.code === "VENDOR_DISABLED" || err.code === "MODEL_REQUIRED"),
    );
    const after = await db("o_agentDeploy")
      .whereIn("key", ["scriptAgent", "productionAgent", "universalAi"])
      .select("model", "modelName", "vendorId");
    for (const row of after) {
      assert.equal(row.model, "OLD");
      assert.equal(row.vendorId, "old");
      assert.equal(row.modelName, "old:model");
    }

    await assert.rejects(
      () =>
        executeBulkAgentConfig(
          db as any,
          {
            mode: "simple",
            vendorId: "deepseek",
            modelName: "deepseek-chat",
          },
          {
            // 供应商被并发禁用
            listVendorModels: async () =>
              textModels.map((m) =>
                m.vendorId === "deepseek" ? { ...m, enable: 0 } : m,
              ),
          },
        ),
      (err: unknown) => err instanceof BulkAgentConfigError && err.code === "VENDOR_DISABLED",
    );
    const afterDisable = await db("o_agentDeploy").where({ key: "scriptAgent" }).first();
    assert.equal(afterDisable.modelName, "old:model");
  } finally {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("项目库句柄与账号库分离：只更新传入的账号 db2，不写项目库", async () => {
  const root = path.join(process.cwd(), "..", ".tmp", `agent-bulk-als-${Date.now()}`);
  const accountDb = await openAccountDb(path.join(root, "account"));
  const projectDb = await openAccountDb(path.join(root, "project"));
  try {
    // 项目库预先写入可观察的“污染”标记
    await projectDb("o_agentDeploy").where({ key: "scriptAgent" }).update({
      model: "PROJECT_MARKER",
      modelName: "project:marker",
      vendorId: "project-vendor",
    });

    // 模拟项目 ALS 下仍显式使用 accountDatabase：execute 只收到账号库
    await executeBulkAgentConfig(
      accountDb as any,
      {
        mode: "simple",
        vendorId: "deepseek",
        modelName: "deepseek-chat",
      },
      { listVendorModels: async () => textModels },
    );

    const accountRow = await accountDb("o_agentDeploy").where({ key: "scriptAgent" }).first();
    const projectRow = await projectDb("o_agentDeploy").where({ key: "scriptAgent" }).first();
    assert.equal(accountRow.modelName, "deepseek:deepseek-chat");
    assert.equal(accountRow.vendorId, "deepseek");
    // 项目库完全未动
    assert.equal(projectRow.model, "PROJECT_MARKER");
    assert.equal(projectRow.modelName, "project:marker");
    assert.equal(projectRow.vendorId, "project-vendor");

    // 路由层不得用 u.db（项目 ALS 活跃库）
    const route = fs.readFileSync(
      path.join(process.cwd(), "src/routes/setting/agentDeploy/bulkConfigureAgents.ts"),
      "utf8",
    );
    assert.match(route, /const accountDb = accountDatabase\(\)/);
    assert.doesNotMatch(route, /executeBulkAgentConfig\(\s*u\.db/);
  } finally {
    await accountDb.destroy();
    await projectDb.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
