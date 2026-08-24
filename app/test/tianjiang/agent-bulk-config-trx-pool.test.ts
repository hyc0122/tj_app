/**
 * 一键配置：pool max=1 事务内不得再申请 accountDb 连接。
 * 覆盖模板模型 / custom / excluded / 生产 Router + 账号·项目 ALS。
 * RED→GREEN：旧实现在事务内调用 getModelList→accountDb 会 acquire timeout。
 */
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import {
  BulkAgentConfigError,
  executeBulkAgentConfig,
  type AgentDeployRow,
} from "../../src/tianjiang/agent/bulk-agent-config";
import { listEnabledVendorModelsForBulk } from "../../src/tianjiang/agent/bulk-vendor-models";
import bulkConfigureAgentsRouter, {
  executeBulkConfigureAgentsRequest,
} from "../../src/routes/setting/agentDeploy/bulkConfigureAgents";
import {
  beginDatabaseShutdown,
  destroyAllDatabaseHandles,
  prepareProjectDatabase,
  prepareUserDatabase,
  resetDatabaseRuntimeForServe,
  stopGenerationTaskRecovery,
  accountDb,
  db as activeDb,
} from "../../src/utils/db";
import {
  runWithProjectStorage,
  runWithUserStorage,
  userStorageRoot,
  userStorageSegment,
} from "../../src/tianjiang/runtime/user-storage-context";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { buildMergedVendorModelList } from "../../src/utils/vendor";

const WORKTREE = path.resolve(process.cwd(), "..");
const ACQUIRE_MS = 2_000;
/** 事务内若二次申请连接，better-sqlite3 pool max=1 会卡满 acquire；上限必须远小于该超时 */
const FAST_BUDGET_MS = 1_500;

const TEMPLATE_VENDOR = "bulkTplVendor";
const TEMPLATE_CODE = `
exports.vendor = {
  id: "${TEMPLATE_VENDOR}",
  name: "Bulk Template Vendor",
  models: [
    { name: "Template Text A", modelName: "tpl-text-a", type: "text" },
    { name: "Template Image B", modelName: "tpl-image-b", type: "image" },
    { name: "Template Text C", modelName: "tpl-text-c", type: "text" },
  ],
};
`;

function seedDeployRows(): AgentDeployRow[] {
  return [
    { id: 1, key: "scriptAgent", disabled: false, temperature: 7, maxOutputTokens: 100 },
    { id: 2, key: "productionAgent", disabled: false, temperature: 5, maxOutputTokens: 200 },
    { id: 3, key: "universalAi", disabled: false, temperature: 1, maxOutputTokens: 0 },
    { id: 4, key: "ttsDubbing", disabled: true, temperature: 1, maxOutputTokens: 0 },
    { id: 5, key: "scriptAgent:decisionAgent", disabled: false, temperature: 11, maxOutputTokens: 111 },
  ];
}

async function openPoolOneDb(dir: string): Promise<Knex> {
  fs.mkdirSync(dir, { recursive: true });
  const databasePath = path.join(dir, "db2.sqlite");
  if (!fs.existsSync(databasePath)) fs.writeFileSync(databasePath, "");
  const db = knex({
    client: "better-sqlite3",
    connection: { filename: databasePath },
    useNullAsDefault: true,
    // 与生产 createHandle 一致：事务占用唯一连接时禁止再借
    pool: { min: 1, max: 1 },
    acquireConnectionTimeout: ACQUIRE_MS,
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
  for (const row of seedDeployRows()) {
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
  return db;
}

function installVendorTemplate(dataRoot: string, vendorId: string, code: string): void {
  const vendorDir = path.join(dataRoot, "vendor");
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, `${vendorId}.ts`), code, "utf8");
}

function withTestDataRoot<T>(dataRoot: string, run: () => Promise<T>): Promise<T> {
  const prevData = process.env.TIANJIANG_TEST_DATA_ROOT;
  const prevTree = process.env.TIANJIANG_TEST_WORKTREE_ROOT;
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = WORKTREE;
  process.env.TIANJIANG_TEST_DATA_ROOT = dataRoot;
  return run().finally(() => {
    if (prevData === undefined) delete process.env.TIANJIANG_TEST_DATA_ROOT;
    else process.env.TIANJIANG_TEST_DATA_ROOT = prevData;
    if (prevTree === undefined) delete process.env.TIANJIANG_TEST_WORKTREE_ROOT;
    else process.env.TIANJIANG_TEST_WORKTREE_ROOT = prevTree;
  });
}

test("buildMergedVendorModelList：模板−excluded+custom 与同名覆盖", async () => {
  const root = path.join(WORKTREE, ".tmp", `bulk-merge-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  try {
    await withTestDataRoot(root, async () => {
      installVendorTemplate(root, TEMPLATE_VENDOR, TEMPLATE_CODE);
      // 仅模板
      const onlyTpl = buildMergedVendorModelList(TEMPLATE_VENDOR, "[]");
      assert.ok(onlyTpl.some((m) => m.modelName === "tpl-text-a"));
      assert.ok(onlyTpl.some((m) => m.modelName === "tpl-image-b"));

      // excluded 模板模型不得出现
      const excluded = buildMergedVendorModelList(
        TEMPLATE_VENDOR,
        JSON.stringify({ custom: [], excluded: ["tpl-text-a"] }),
      );
      assert.equal(excluded.some((m) => m.modelName === "tpl-text-a"), false);
      assert.ok(excluded.some((m) => m.modelName === "tpl-text-c"));

      // custom 合并 + 同名覆盖展示名
      const custom = buildMergedVendorModelList(
        TEMPLATE_VENDOR,
        JSON.stringify({
          custom: [
            { name: "Custom Text", modelName: "custom-text-1", type: "text" },
            { name: "Overridden A", modelName: "tpl-text-a", type: "text" },
          ],
          excluded: [],
        }),
      );
      assert.ok(custom.some((m) => m.modelName === "custom-text-1"));
      const overridden = custom.find((m) => m.modelName === "tpl-text-a");
      assert.equal(overridden?.name, "Overridden A");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pool max=1：事务内二次 accountDb 查询会超时（回归对照）", async () => {
  const root = path.join(WORKTREE, ".tmp", `bulk-deadlock-${Date.now()}`);
  const db = await openPoolOneDb(root);
  try {
    await db("o_vendorConfig").insert({
      id: TEMPLATE_VENDOR,
      enable: 1,
      models: "[]",
      inputValues: "{}",
    });
    const started = Date.now();
    await assert.rejects(
      () =>
        db.transaction(async (trx) => {
          // 占住唯一连接
          await trx("o_vendorConfig").select("id");
          // 模拟旧 getModelList：再经 pool 申请连接 → acquire timeout
          await db("o_vendorConfig").where("id", TEMPLATE_VENDOR).first();
        }),
      /Timeout acquiring a connection|Knex: Timeout|acquire/i,
    );
    const elapsed = Date.now() - started;
    // 应在 acquire 超时量级失败，证明 max=1 下二次申请会卡死事务路径
    assert.ok(elapsed >= ACQUIRE_MS - 200, `expected ~${ACQUIRE_MS}ms timeout, got ${elapsed}`);
  } finally {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pool max=1 + 仅模板模型：listEnabledVendorModelsForBulk 在事务内快速成功", async () => {
  const root = path.join(WORKTREE, ".tmp", `bulk-tpl-fast-${Date.now()}`);
  const db = await openPoolOneDb(root);
  try {
    await withTestDataRoot(root, async () => {
      installVendorTemplate(root, TEMPLATE_VENDOR, TEMPLATE_CODE);
      // models 无自定义，模型只存在于模板源码
      await db("o_vendorConfig").insert({
        id: TEMPLATE_VENDOR,
        enable: 1,
        models: "[]",
        inputValues: "{}",
      });

      const started = Date.now();
      const result = await executeBulkAgentConfig(
        db as any,
        {
          mode: "simple",
          vendorId: TEMPLATE_VENDOR,
          modelName: "tpl-text-a",
        },
        {
          listVendorModels: (trx) => listEnabledVendorModelsForBulk(trx),
        },
      );
      const elapsed = Date.now() - started;
      assert.ok(
        elapsed < FAST_BUDGET_MS,
        `template bulk must finish under ${FAST_BUDGET_MS}ms (no pool wait), got ${elapsed}ms`,
      );
      assert.equal(result.modelName, "tpl-text-a");
      assert.equal(result.model, "Template Text A");
      assert.equal(result.updatedCount, 3);
      const row = await db("o_agentDeploy").where({ key: "scriptAgent" }).first();
      assert.equal(row.modelName, `${TEMPLATE_VENDOR}:tpl-text-a`);
    });
  } finally {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("自定义模型成功；excluded 模板拒绝；禁用供应商/非文本拒绝", async () => {
  const root = path.join(WORKTREE, ".tmp", `bulk-cases-${Date.now()}`);
  const db = await openPoolOneDb(root);
  try {
    await withTestDataRoot(root, async () => {
      installVendorTemplate(root, TEMPLATE_VENDOR, TEMPLATE_CODE);
      await db("o_vendorConfig").insert({
        id: TEMPLATE_VENDOR,
        enable: 1,
        models: JSON.stringify({
          custom: [{ name: "My Custom", modelName: "my-custom-text", type: "text" }],
          excluded: ["tpl-text-c"],
        }),
        inputValues: "{}",
      });
      await db("o_vendorConfig").insert({
        id: "disabledVendor",
        enable: 0,
        models: JSON.stringify([
          { name: "Off", modelName: "off-text", type: "text" },
        ]),
        inputValues: "{}",
      });

      // custom OK
      const customOk = await executeBulkConfigureAgentsRequest(
        { mode: "simple", vendorId: TEMPLATE_VENDOR, modelName: "my-custom-text" },
        db as any,
      );
      assert.equal(customOk.model, "My Custom");

      // excluded template model
      await assert.rejects(
        () =>
          executeBulkConfigureAgentsRequest(
            { mode: "simple", vendorId: TEMPLATE_VENDOR, modelName: "tpl-text-c" },
            db as any,
          ),
        (e: unknown) => e instanceof BulkAgentConfigError && e.code === "MODEL_NOT_FOUND",
      );

      // non-text template
      await assert.rejects(
        () =>
          executeBulkConfigureAgentsRequest(
            { mode: "simple", vendorId: TEMPLATE_VENDOR, modelName: "tpl-image-b" },
            db as any,
          ),
        (e: unknown) => e instanceof BulkAgentConfigError && e.code === "MODEL_NOT_TEXT",
      );

      // disabled vendor
      await assert.rejects(
        () =>
          executeBulkConfigureAgentsRequest(
            { mode: "simple", vendorId: "disabledVendor", modelName: "off-text" },
            db as any,
          ),
        (e: unknown) => e instanceof BulkAgentConfigError && e.code === "VENDOR_DISABLED",
      );
    });
  } finally {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("并发删除模型：事务内 list 为空则整体失败回滚", async () => {
  const root = path.join(WORKTREE, ".tmp", `bulk-race-${Date.now()}`);
  const db = await openPoolOneDb(root);
  try {
    await db("o_vendorConfig").insert({
      id: TEMPLATE_VENDOR,
      enable: 1,
      models: "[]",
      inputValues: "{}",
    });
    await assert.rejects(
      () =>
        executeBulkAgentConfig(
          db as any,
          { mode: "simple", vendorId: TEMPLATE_VENDOR, modelName: "tpl-text-a" },
          {
            listVendorModels: async () => [],
          },
        ),
      (e: unknown) => e instanceof BulkAgentConfigError,
    );
    const row = await db("o_agentDeploy").where({ key: "scriptAgent" }).first();
    assert.equal(row.modelName, "old:model");
  } finally {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A/B 账号库隔离 + 项目库句柄不被写入", async () => {
  const root = path.join(WORKTREE, ".tmp", `bulk-ab-${Date.now()}`);
  const aDb = await openPoolOneDb(path.join(root, "a"));
  const bDb = await openPoolOneDb(path.join(root, "b"));
  const projectDb = await openPoolOneDb(path.join(root, "project"));
  try {
    await withTestDataRoot(root, async () => {
      installVendorTemplate(root, TEMPLATE_VENDOR, TEMPLATE_CODE);
      for (const db of [aDb, bDb, projectDb]) {
        await db("o_vendorConfig").insert({
          id: TEMPLATE_VENDOR,
          enable: 1,
          models: "[]",
          inputValues: "{}",
        });
      }
      await projectDb("o_agentDeploy").where({ key: "scriptAgent" }).update({
        model: "PROJECT",
        modelName: "project:mark",
        vendorId: "project",
      });

      await executeBulkConfigureAgentsRequest(
        { mode: "simple", vendorId: TEMPLATE_VENDOR, modelName: "tpl-text-a" },
        aDb as any,
      );
      const a = await aDb("o_agentDeploy").where({ key: "scriptAgent" }).first();
      const b = await bDb("o_agentDeploy").where({ key: "scriptAgent" }).first();
      const p = await projectDb("o_agentDeploy").where({ key: "scriptAgent" }).first();
      assert.equal(a.modelName, `${TEMPLATE_VENDOR}:tpl-text-a`);
      assert.equal(b.modelName, "old:model");
      assert.equal(p.modelName, "project:mark");
    });
  } finally {
    await aDb.destroy();
    await bDb.destroy();
    await projectDb.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP 包装调用共用服务函数（非生产 Router；对照 executeBulkConfigureAgentsRequest）", async () => {
  const root = path.join(WORKTREE, ".tmp", `bulk-svc-http-${Date.now()}`);
  const db = await openPoolOneDb(root);
  try {
    await withTestDataRoot(root, async () => {
      installVendorTemplate(root, TEMPLATE_VENDOR, TEMPLATE_CODE);
      await db("o_vendorConfig").insert({
        id: TEMPLATE_VENDOR,
        enable: 1,
        models: "[]",
        inputValues: "{}",
      });
      // 仅验证服务函数语义，不挂载生产 Router
      const result = await executeBulkConfigureAgentsRequest(
        { mode: "simple", vendorId: TEMPLATE_VENDOR, modelName: "tpl-text-a" },
        db as any,
      );
      assert.equal(result.model, "Template Text A");
      assert.equal(result.modelName, "tpl-text-a");
    });
  } finally {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const PROD_PROJECT_UUID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const IDENTITY_A = { issuer: "https://api.j11.com.cn", userId: 91001 };
const IDENTITY_B = { issuer: "https://api.j11.com.cn", userId: 91002 };

async function readDeployRow(dbPath: string, key: string): Promise<{
  model: string;
  modelName: string;
  vendorId: string;
} | undefined> {
  const db = knex({
    client: "better-sqlite3",
    connection: { filename: dbPath },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
  try {
    return await db("o_agentDeploy").where({ key }).first();
  } finally {
    await db.destroy();
  }
}

/**
 * 生产 Router + 真实账号/项目 ALS 验收。
 * 挂载 app/src/routes/setting/agentDeploy/bulkConfigureAgents 默认导出，
 * 中间件进入 runWithUserStorage(A)+runWithProjectStorage，禁止手写 app.post 业务逻辑。
 */
test("生产 Router：挂载 bulkConfigureAgents + 账号/项目 ALS + pool max=1", async () => {
  const fixtureRoot = path.join(WORKTREE, ".tmp", `bulk-prod-router-${Date.now()}`);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
  let server: http.Server | undefined;
  const originalNodeEnv = process.env.NODE_ENV;

  try {
    await withTestDataRoot(fixtureRoot, async () => {
      process.env.NODE_ENV = "prod";
      resetDatabaseRuntimeForServe();
      installVendorTemplate(fixtureRoot, TEMPLATE_VENDOR, TEMPLATE_CODE);

      // 生产 createHandle 为 max=1；prepareUserDatabase 走同一路径
      await prepareUserDatabase(IDENTITY_A);
      await prepareUserDatabase(IDENTITY_B);

      await runWithUserStorage(IDENTITY_A, async () => {
        // 账号 A：启用模板供应商，部署行保留可更新旧值
        const existing = await accountDb("o_vendorConfig").where({ id: TEMPLATE_VENDOR }).first();
        if (existing) {
          await accountDb("o_vendorConfig").where({ id: TEMPLATE_VENDOR }).update({
            enable: 1,
            models: "[]",
            inputValues: "{}",
          });
        } else {
          await accountDb("o_vendorConfig").insert({
            id: TEMPLATE_VENDOR,
            enable: 1,
            models: "[]",
            inputValues: "{}",
          });
        }
        for (const key of ["scriptAgent", "productionAgent", "universalAi"]) {
          await accountDb("o_agentDeploy").where({ key }).update({
            model: "A_OLD",
            modelName: "a:old",
            vendorId: "old",
            disabled: false,
          });
        }

        await prepareProjectDatabase(PROD_PROJECT_UUID);
        await runWithProjectStorage(PROD_PROJECT_UUID, async () => {
          // 项目库写入可观察标记：正式 bulk 不得改项目库
          await activeDb("o_agentDeploy").where({ key: "scriptAgent" }).update({
            model: "PROJECT_MARK",
            modelName: "project:mark",
            vendorId: "project-vendor",
          });
        });
      });

      await runWithUserStorage(IDENTITY_B, async () => {
        await accountDb("o_agentDeploy").where({ key: "scriptAgent" }).update({
          model: "B_MARK",
          modelName: "b:mark",
          vendorId: "bob-vendor",
        });
      });

      const segmentA = userStorageSegment(IDENTITY_A);
      const segmentB = userStorageSegment(IDENTITY_B);
      const aDbPath = path.join(userStorageRoot(fixtureRoot, IDENTITY_A), "db2.sqlite");
      const bDbPath = path.join(userStorageRoot(fixtureRoot, IDENTITY_B), "db2.sqlite");
      const projectDbPath = path.join(
        projectDirectory(fixtureRoot, PROD_PROJECT_UUID, segmentA),
        "project.sqlite",
      );
      assert.equal(fs.existsSync(aDbPath), true);
      assert.equal(fs.existsSync(bDbPath), true);
      assert.equal(fs.existsSync(projectDbPath), true);

      const app = express();
      app.use(express.json());
      // 请求进入当前账号 A + 当前项目 ALS；生产 Router 内 accountDatabase() 仍只读 A 的 db2
      app.use((req, res, next) => {
        runWithUserStorage(IDENTITY_A, () => {
          runWithProjectStorage(PROD_PROJECT_UUID, () => {
            next();
          });
        });
      });
      // 直接挂载生产默认 Router，不重写校验/包装/错误转换
      app.use(
        "/api/setting/agentDeploy/bulkConfigureAgents",
        bulkConfigureAgentsRouter,
      );

      server = await new Promise<http.Server>((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      const base = `http://127.0.0.1:${addr.port}`;
      const url = `${base}/api/setting/agentDeploy/bulkConfigureAgents`;

      // —— 成功路径：模板文本模型，1500ms 内 ——
      const started = Date.now();
      const okRes = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "simple",
          vendorId: TEMPLATE_VENDOR,
          modelName: "tpl-text-a",
        }),
      });
      const okElapsed = Date.now() - started;
      const okBody = (await okRes.json()) as {
        code: number;
        message?: string;
        data?: {
          updatedCount?: number;
          keys?: string[];
          vendorId?: string;
          model?: string;
          modelName?: string;
        };
      };
      assert.equal(okRes.status, 200, JSON.stringify(okBody));
      // 生产 success() 包装 code=200（非 0）
      assert.equal(okBody.code, 200);
      assert.equal(okBody.data?.vendorId, TEMPLATE_VENDOR);
      assert.equal(okBody.data?.modelName, "tpl-text-a");
      assert.equal(okBody.data?.model, "Template Text A");
      assert.ok((okBody.data?.updatedCount ?? 0) >= 3);
      assert.ok(Array.isArray(okBody.data?.keys));
      assert.ok(
        okElapsed < FAST_BUDGET_MS,
        `生产 Router bulk 必须在 ${FAST_BUDGET_MS}ms 内完成（pool max=1 无二次借连接），实际 ${okElapsed}ms`,
      );

      // 账号 A 已更新
      const aRow = await readDeployRow(aDbPath, "scriptAgent");
      assert.equal(aRow?.modelName, `${TEMPLATE_VENDOR}:tpl-text-a`);
      assert.equal(aRow?.model, "Template Text A");
      assert.equal(aRow?.vendorId, TEMPLATE_VENDOR);

      // 账号 B 完全不变
      const bRow = await readDeployRow(bDbPath, "scriptAgent");
      assert.equal(bRow?.modelName, "b:mark");
      assert.equal(bRow?.model, "B_MARK");
      assert.equal(bRow?.vendorId, "bob-vendor");

      // 当前项目库标记完全不变
      const pRow = await readDeployRow(projectDbPath, "scriptAgent");
      assert.equal(pRow?.modelName, "project:mark");
      assert.equal(pRow?.model, "PROJECT_MARK");
      assert.equal(pRow?.vendorId, "project-vendor");

      // —— validateFields：缺字段 / 非法 mode → 400 参数错误，不写库 ——
      const aBeforeInvalid = await readDeployRow(aDbPath, "scriptAgent");
      for (const bad of [
        { vendorId: TEMPLATE_VENDOR, modelName: "tpl-text-a" },
        { mode: "simple", modelName: "tpl-text-a" },
        { mode: "simple", vendorId: TEMPLATE_VENDOR },
        { mode: "invalid-mode", vendorId: TEMPLATE_VENDOR, modelName: "tpl-text-a" },
      ]) {
        const badRes = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bad),
        });
        const badBody = (await badRes.json()) as {
          code?: number;
          data?: { errors?: unknown };
          message?: string;
        };
        assert.equal(badRes.status, 400, JSON.stringify({ bad, badBody }));
        // 校验失败也必须使用正式 code/data/message envelope。
        assert.equal(badBody.code, 400);
        assert.equal(badBody.message, "参数错误");
        assert.equal(Array.isArray(badBody.data?.errors), true);
      }
      const aAfterInvalid = await readDeployRow(aDbPath, "scriptAgent");
      assert.deepEqual(aAfterInvalid, aBeforeInvalid);

      // —— 业务 400：excluded / 非 text；错误脱敏 ——
      await runWithUserStorage(IDENTITY_A, async () => {
        await accountDb("o_vendorConfig").where({ id: TEMPLATE_VENDOR }).update({
          models: JSON.stringify({ custom: [], excluded: ["tpl-text-c"] }),
        });
      });
      const excludedRes = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "simple",
          vendorId: TEMPLATE_VENDOR,
          modelName: "tpl-text-c",
        }),
      });
      const excludedBody = (await excludedRes.json()) as { code?: number; message?: string };
      assert.equal(excludedRes.status, 400);
      assert.equal(excludedBody.code, 400);
      assert.ok(excludedBody.message);
      assert.doesNotMatch(String(excludedBody.message), /[A-Za-z]:\\/);
      assert.doesNotMatch(String(excludedBody.message), /SELECT |INSERT |sqlite/i);
      assert.doesNotMatch(String(excludedBody.message), /at\s+\S+\s+\(/);
      assert.doesNotMatch(String(excludedBody.message), /api[_-]?key|secret|bearer/i);
      assert.doesNotMatch(String(excludedBody.message), /\[object Object\]/);

      const nonTextRes = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "simple",
          vendorId: TEMPLATE_VENDOR,
          modelName: "tpl-image-b",
        }),
      });
      const nonTextBody = (await nonTextRes.json()) as { code?: number; message?: string };
      assert.equal(nonTextRes.status, 400);
      assert.match(String(nonTextBody.message ?? ""), /文本/);

      // 失败路径不得把 A 写坏成 image 模型
      const aFinal = await readDeployRow(aDbPath, "scriptAgent");
      assert.equal(aFinal?.modelName, `${TEMPLATE_VENDOR}:tpl-text-a`);
      // B / 项目仍不变
      assert.equal((await readDeployRow(bDbPath, "scriptAgent"))?.modelName, "b:mark");
      assert.equal((await readDeployRow(projectDbPath, "scriptAgent"))?.modelName, "project:mark");
      // segment 诊断（证明 A/B 目录不同）
      assert.notEqual(segmentA, segmentB);

      // —— 系统异常：SQLite 错误必须返回 HTTP/body 500，不得因带 code 被误判为 400 ——
      await runWithUserStorage(IDENTITY_A, async () => {
        await accountDb.schema.dropTable("o_vendorConfig");
      });
      const systemRes = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "simple",
          vendorId: TEMPLATE_VENDOR,
          modelName: "tpl-text-a",
        }),
      });
      const systemBody = (await systemRes.json()) as {
        code?: number;
        data?: unknown;
        message?: string;
      };
      assert.equal(systemRes.status, 500, JSON.stringify(systemBody));
      assert.equal(systemBody.code, 500);
      assert.equal(systemBody.data, null);
      assert.equal(systemBody.message, "批量配置 Agent 失败，请稍后重试");
      assert.doesNotMatch(JSON.stringify(systemBody), /[A-Za-z]:\\|SELECT |sqlite|stack|secret/i);
    });
  } finally {
    // 中文注释：逐项释放测试资源，任何清理失败都必须显式暴露，不能静默吞掉。
    let cleanupError: unknown;
    try {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      await stopGenerationTaskRecovery();
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await destroyAllDatabaseHandles();
    } catch (error) {
      cleanupError ??= error;
    }
    beginDatabaseShutdown();
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    try {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }
});

test("路由源码禁止事务内 getModelList/accountDb 二次查询", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "src/routes/setting/agentDeploy/bulkConfigureAgents.ts"),
    "utf8",
  );
  const listSrc = fs.readFileSync(
    path.join(process.cwd(), "src/tianjiang/agent/bulk-vendor-models.ts"),
    "utf8",
  );
  // 去掉注释后再断言可执行代码
  const stripComments = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  const listCode = stripComments(listSrc);
  const routeCode = stripComments(route);
  assert.match(routeCode, /listEnabledVendorModelsForBulk/);
  assert.match(routeCode, /executeBulkConfigureAgentsRequest/);
  assert.match(routeCode, /accountDatabase\s*\(/);
  assert.doesNotMatch(routeCode, /getModelList\s*\(/);
  assert.doesNotMatch(listCode, /getModelList\s*\(/);
  assert.doesNotMatch(listCode, /\baccountDb\b|\baccountDatabase\b/);
  assert.match(listCode, /buildMergedVendorModelList/);
});
