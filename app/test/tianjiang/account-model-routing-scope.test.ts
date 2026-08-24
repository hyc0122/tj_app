/**
 * 账号级模型路由作用域：根因修复行为测试。
 * 项目 ALS 下配置必须来自 db2，业务写仍落 project.sqlite。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import {
  FROZEN_DEPLOYMENT_KEYS,
  RUNTIME_DEPLOYMENT_CONSUMERS,
  SIMPLE_DEPLOYMENT_KEYS,
  ADVANCED_DEPLOYMENT_KEYS,
  isFrozenDeploymentKey,
  parentDeploymentKey,
} from "../../src/tianjiang/model/deployment-keys";
import {
  getAccountSetting,
  resolveAccountDeployConfig,
  resolveAccountDeployModelName,
  resolveAccountPromptText,
  getAccountAgentDeployRow,
} from "../../src/utils/account-model-resolver";
import {
  activateUserDatabase,
  prepareProjectDatabase,
  resetDatabaseRuntimeForServe,
  db as activeDb,
  accountDb,
  accountDatabase,
} from "../../src/utils/db";
import {
  closeActivatedWorkspaceRuntime,
  createUniqueWorktreeRoot,
} from "./helpers/worktree-runtime";
import {
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";

const PROJECT_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function createAccountConfigDatabase(filename: string): Promise<Knex> {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const database = knex({
    client: "better-sqlite3",
    connection: { filename },
    useNullAsDefault: true,
  });
  await database.schema.createTable("o_setting", (table) => {
    table.text("key").primary();
    table.text("value");
  });
  await database.schema.createTable("o_agentDeploy", (table) => {
    table.integer("id");
    table.text("key");
    table.text("modelName");
    table.text("vendorId");
    table.text("name");
    table.integer("temperature");
    table.integer("maxOutputTokens");
  });
  await database.schema.createTable("o_prompt", (table) => {
    table.integer("id");
    table.text("type");
    table.text("data");
    table.text("useData");
  });
  await database.schema.createTable("o_vendorConfig", (table) => {
    table.text("id").primary();
    table.text("models");
    table.text("inputValues");
    table.integer("enable");
  });
  return database;
}

test("冻结部署键注册表覆盖简易/高级键且 parent 规则正确", () => {
  assert.ok(SIMPLE_DEPLOYMENT_KEYS.includes("universalAi"));
  assert.ok(ADVANCED_DEPLOYMENT_KEYS.includes("scriptAgent:decisionAgent"));
  assert.equal(FROZEN_DEPLOYMENT_KEYS.length, SIMPLE_DEPLOYMENT_KEYS.length + ADVANCED_DEPLOYMENT_KEYS.length);
  assert.equal(isFrozenDeploymentKey("universalAi"), true);
  assert.equal(isFrozenDeploymentKey("vendor-x:gpt"), false);
  assert.equal(parentDeploymentKey("scriptAgent:decisionAgent"), "scriptAgent");
  assert.equal(parentDeploymentKey("universalAi"), "universalAi");
  for (const entry of RUNTIME_DEPLOYMENT_CONSUMERS) {
    assert.equal(isFrozenDeploymentKey(entry.key), true, `消费者登记键未冻结: ${entry.key}`);
  }
});

test("种子 initDB 部署键 ⊆ 冻结注册表", () => {
  const initSource = fs.readFileSync(
    path.join(process.cwd(), "src/lib/initDB.ts"),
    "utf8",
  );
  const keyMatches = [...initSource.matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1]);
  // o_agentDeploy 种子键：出现在 o_agentDeploy.insert 块附近；用 name 字段邻近过滤
  const deployBlock = initSource.slice(
    initSource.indexOf('name: "o_agentDeploy"'),
    initSource.indexOf('name: "o_setting"'),
  );
  const deployKeys = [...deployBlock.matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(deployKeys.includes("universalAi"));
  for (const key of deployKeys) {
    assert.equal(
      isFrozenDeploymentKey(key),
      true,
      `种子部署键未进入冻结注册表: ${key}`,
    );
  }
  // 注册表中的每个键都应出现在种子（tts 与全部高级键）
  for (const key of FROZEN_DEPLOYMENT_KEYS) {
    assert.ok(deployKeys.includes(key), `冻结键缺少种子: ${key}`);
  }
  void keyMatches;
});

test("运行时 Ai.Text 部署键必须登记在冻结表", () => {
  const appSrc = path.join(process.cwd(), "src");
  const consumers: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "provider-templates") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const text = fs.readFileSync(full, "utf8");
      for (const match of text.matchAll(/Ai\.Text\(\s*["']([^"']+)["']/g)) {
        consumers.push(match[1]);
      }
      for (const match of text.matchAll(/key:\s*["']((?:script|production)Agent:[^"']+)["']/g)) {
        consumers.push(match[1]);
      }
    }
  }
  walk(appSrc);
  const unique = [...new Set(consumers)];
  for (const key of unique) {
    // 允许直连 vendorId:modelName（含冒号且非注册父键前缀时可跳过严格校验）
    if (isFrozenDeploymentKey(key)) continue;
    if (/^(scriptAgent|productionAgent|universalAi|ttsDubbing)(:|$)/.test(key)) {
      assert.fail(`运行时消费键未冻结登记: ${key}`);
    }
  }
  assert.ok(unique.includes("universalAi"));
});

test("简易模式：账号 universalAi 有模型，项目库同键为空时解析账号配置", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-acct-resolve-"));
  const account = await createAccountConfigDatabase(path.join(root, "account.sqlite"));
  const project = await createAccountConfigDatabase(path.join(root, "project.sqlite"));
  try {
    await account("o_setting").insert({ key: "agentUseMode", value: "0" });
    await account("o_agentDeploy").insert({
      id: 1,
      key: "universalAi",
      modelName: "acct-vendor:acct-model",
      vendorId: "acct-vendor",
      name: "通用AI",
    });
    // 项目库空白/恶意配置
    await project("o_setting").insert({ key: "agentUseMode", value: "0" });
    await project("o_agentDeploy").insert({
      id: 1,
      key: "universalAi",
      modelName: "",
      vendorId: null,
      name: "通用AI",
    });

    const resolved = await resolveAccountDeployModelName("universalAi", account);
    assert.equal(resolved, "acct-vendor:acct-model");

    // 若误用项目库应失败
    await assert.rejects(
      () => resolveAccountDeployModelName("universalAi", project),
      /简易配置模式下，未找到部署配置/,
    );
  } finally {
    await Promise.all([account.destroy(), project.destroy()]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("项目库恶意部署配置不得覆盖账号配置", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-acct-poison-"));
  const account = await createAccountConfigDatabase(path.join(root, "account.sqlite"));
  const project = await createAccountConfigDatabase(path.join(root, "project.sqlite"));
  try {
    await account("o_setting").insert({ key: "agentUseMode", value: "0" });
    await account("o_agentDeploy").insert({
      id: 1,
      key: "universalAi",
      modelName: "good-vendor:good-model",
      vendorId: "good-vendor",
      name: "通用AI",
    });
    await project("o_setting").insert({ key: "agentUseMode", value: "1" });
    await project("o_agentDeploy").insert({
      id: 1,
      key: "universalAi",
      modelName: "evil-vendor:evil-model",
      vendorId: "evil-vendor",
      name: "通用AI",
    });

    const name = await resolveAccountDeployModelName("universalAi", account);
    assert.equal(name, "good-vendor:good-model");
    assert.notEqual(name, "evil-vendor:evil-model");
  } finally {
    await Promise.all([account.destroy(), project.destroy()]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("高级模式解析子键；简易模式回退父键", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-acct-mode-"));
  const account = await createAccountConfigDatabase(path.join(root, "account.sqlite"));
  try {
    await account("o_agentDeploy").insert([
      {
        id: 1,
        key: "scriptAgent",
        modelName: "v:simple-parent",
        vendorId: "v",
        name: "剧本",
      },
      {
        id: 2,
        key: "scriptAgent:decisionAgent",
        modelName: "v:advanced-child",
        vendorId: "v",
        name: "决策",
      },
    ]);

    await account("o_setting").insert({ key: "agentUseMode", value: "0" });
    assert.equal(
      await resolveAccountDeployModelName("scriptAgent:decisionAgent", account),
      "v:simple-parent",
    );

    await account("o_setting").where("key", "agentUseMode").update({ value: "1" });
    assert.equal(
      await resolveAccountDeployModelName("scriptAgent:decisionAgent", account),
      "v:advanced-child",
    );

    const cfg = await resolveAccountDeployConfig("scriptAgent:decisionAgent", account);
    assert.equal(cfg?.modelName, "v:advanced-child");
  } finally {
    await account.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("自定义 Prompt 与设置读账号库", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-acct-prompt-"));
  const account = await createAccountConfigDatabase(path.join(root, "account.sqlite"));
  try {
    await account("o_prompt").insert({
      id: 1,
      type: "eventExtraction",
      data: "default-prompt",
      useData: "account-custom-prompt",
    });
    await account("o_setting").insert({ key: "switchAiDevTool", value: "1" });
    assert.equal(await resolveAccountPromptText("eventExtraction", account), "account-custom-prompt");
    assert.equal(await getAccountSetting("switchAiDevTool", account), "1");
  } finally {
    await account.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("真实 ALS：项目上下文下 accountDb 读 db2，activeDb 写项目库", async () => {
  const fixtureRoot = createUniqueWorktreeRoot("amrs-als");
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;

  try {
    process.chdir(fixtureRoot);
    process.env.NODE_ENV = "prod";
    resetDatabaseRuntimeForServe();

    const identity = { issuer: "https://api.j11.com.cn", userId: 77001 };
    await activateUserDatabase(identity);

    await runWithUserStorage(identity, async () => {
      // 写入账号 universalAi
      await accountDb("o_setting")
        .insert({ key: "agentUseMode", value: "0" })
        .onConflict("key")
        .merge({ value: "0" });
      await accountDb("o_agentDeploy").where("key", "universalAi").update({
        modelName: "als-vendor:als-model",
        vendorId: "als-vendor",
      });

      await prepareProjectDatabase(PROJECT_UUID);

      await runWithProjectStorage(PROJECT_UUID, async () => {
        // 项目库强制清空 universalAi（模拟空白种子）
        await activeDb("o_agentDeploy").where("key", "universalAi").update({
          modelName: "",
          vendorId: null,
        });

        // 账号库仍可解析
        const knexAccount = accountDatabase();
        const resolved = await resolveAccountDeployModelName("universalAi", knexAccount);
        assert.equal(resolved, "als-vendor:als-model");

        // 项目库同键为空
        const projectRow = await activeDb("o_agentDeploy").where("key", "universalAi").first();
        assert.equal(projectRow?.modelName || "", "");

        // 业务写项目库
        await activeDb("o_project")
          .insert({
            id: 1,
            name: "scope-test",
            projectType: "novel",
            intro: "",
            type: "",
            artStyle: null,
            videoRatio: null,
            createTime: Date.now(),
            imageModel: "",
            videoModel: "",
            imageQuality: "",
            mode: "",
            directorManual: "",
            userId: identity.userId,
          })
          .onConflict("id")
          .ignore();

        const projectBiz = await activeDb("o_project").where({ id: 1 }).first();
        assert.ok(projectBiz);

        // 错误信息不得含密钥样式绝对路径（用户可见解析错误）
        await activeDb("o_agentDeploy").where("key", "scriptAgent").update({ modelName: "" });
        // 清空账号 scriptAgent 验证错误文案
        await knexAccount("o_agentDeploy").where("key", "scriptAgent").update({ modelName: "" });
        await assert.rejects(
          () => resolveAccountDeployModelName("scriptAgent", knexAccount),
          (err: Error) => {
            assert.match(err.message, /未找到部署配置|简易配置模式/);
            assert.equal(/[A-Za-z]:\\/.test(err.message), false);
            assert.equal(/api[_-]?key|sk-|BEGIN /i.test(err.message), false);
            assert.equal(/SELECT |INSERT /i.test(err.message), false);
            assert.equal(/at\s+\S+\s+\(/.test(err.message), false);
            return true;
          },
        );
      });
    });
  } finally {
    await closeActivatedWorkspaceRuntime();
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    try {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  }
});

test("A/B 账号配置完全隔离", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-acct-ab-"));
  const alice = await createAccountConfigDatabase(path.join(root, "alice.sqlite"));
  const bob = await createAccountConfigDatabase(path.join(root, "bob.sqlite"));
  try {
    await alice("o_setting").insert({ key: "agentUseMode", value: "0" });
    await bob("o_setting").insert({ key: "agentUseMode", value: "0" });
    await alice("o_agentDeploy").insert({
      id: 1,
      key: "universalAi",
      modelName: "alice-v:alice-m",
      vendorId: "alice-v",
      name: "通用AI",
    });
    await bob("o_agentDeploy").insert({
      id: 1,
      key: "universalAi",
      modelName: "bob-v:bob-m",
      vendorId: "bob-v",
      name: "通用AI",
    });

    assert.equal(await resolveAccountDeployModelName("universalAi", alice), "alice-v:alice-m");
    assert.equal(await resolveAccountDeployModelName("universalAi", bob), "bob-v:bob-m");
    assert.notEqual(
      await getAccountAgentDeployRow("universalAi", alice),
      await getAccountAgentDeployRow("universalAi", bob),
    );
    const aliceRow = await getAccountAgentDeployRow("universalAi", alice);
    const bobRow = await getAccountAgentDeployRow("universalAi", bob);
    assert.equal(aliceRow?.modelName, "alice-v:alice-m");
    assert.equal(bobRow?.modelName, "bob-v:bob-m");
  } finally {
    await Promise.all([alice.destroy(), bob.destroy()]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ai.ts 不再直接 u.db 查询 o_agentDeploy/o_setting 配置", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/utils/ai.ts"), "utf8");
  assert.match(source, /resolveAccountDeployModelName/);
  assert.match(source, /resolveAccountVendorRuntime|loadAccountVendorPrivateInputs/);
  assert.equal(/u\.db\(\s*["']o_agentDeploy["']\s*\)/.test(source), false);
  assert.equal(/u\.db\(\s*["']o_setting["']\s*\)/.test(source), false);
  assert.equal(/u\.db\(\s*["']o_vendorConfig["']\s*\)/.test(source), false);
});
