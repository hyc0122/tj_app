import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";

import { getInitialTableSchemas } from "../../src/lib/initDB";

// 测试脚本固定从 app 目录运行，避免 tsx 的 CJS 加载模式不提供 import.meta.dirname。
const appRoot = path.resolve(process.cwd());
const repoTempRoot = path.resolve(appRoot, "..", ".tmp");

function readAppFile(relativePath: string): string {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

function createTempDatabase(label: string): { database: Knex; root: string } {
  fs.mkdirSync(repoTempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(repoTempRoot, `${label}-`));
  return {
    root,
    database: knex({
      client: "better-sqlite3",
      connection: { filename: path.join(root, "db2.sqlite") },
      useNullAsDefault: true,
    }),
  };
}

async function loadChinesePromptModule() {
  try {
    return await import("../../src/tianjiang/prompts/video-prompt-generation");
  } catch (error) {
    assert.fail(`缺少集中管理的中文视频提示词模块：${String(error)}`);
  }
}

async function loadLanguageMigrationModule() {
  try {
    return await import("../../src/tianjiang/data/video-prompt-language-migration");
  } catch (error) {
    assert.fail(`缺少旧账号视频提示词中文迁移模块：${String(error)}`);
  }
}

test("内置视频提示词的四种模式必须只要求中文可读输出", async () => {
  const module = await loadChinesePromptModule();
  const prompt = module.DEFAULT_VIDEO_PROMPT_GENERATION_ZH;

  assert.equal(typeof prompt, "string");
  for (const marker of [
    "[参考图]",
    "[指令]",
    "[画面]",
    "[动作]",
    "[镜头]",
    "[声音]",
    "[叙事]",
    "@图N",
    "OS",
    "VO",
    "<duration-ms>",
    "Seedance 2.0",
    "Wan 2.6",
  ]) {
    assert.match(prompt, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  for (const forbidden of [
    "Instruction 必须用英文",
    "全部用英文",
    "叙事式英文提示词",
    "翻译为简洁英文",
    "[References]",
    "[Instruction]",
    "[Visual]",
    "[Motion]",
    "[Camera]",
    "[Audio]",
    "[Narrative]",
  ]) {
    assert.doesNotMatch(prompt, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("新账号初始化与旧修复链必须共用安全的中文默认来源", () => {
  const initSource = readAppFile("src/lib/initDB.ts");
  const repairSource = readAppFile("src/lib/fixDB.ts");
  assert.match(initSource, /DEFAULT_VIDEO_PROMPT_GENERATION_ZH/);
  assert.match(repairSource, /migrateDefaultVideoPromptToChinese/);
  assert.doesNotMatch(initSource, /Instruction 必须用英文|全部用英文|叙事式英文提示词/);
  assert.doesNotMatch(repairSource, /Instruction 必须用英文|全部用英文|叙事式英文提示词/);
});

test("新账号实际写入的默认视频提示词必须等于中文唯一事实源", async () => {
  const promptModule = await loadChinesePromptModule();
  const { database, root } = createTempDatabase("video-prompt-zh-initial");
  try {
    const schema = getInitialTableSchemas(true).find((item) => item.name === "o_prompt");
    assert.ok(schema?.initData, "新账号初始化必须包含 o_prompt 数据");
    await database.schema.createTable(schema.name, schema.builder);
    await schema.initData(database);

    const row = await database("o_prompt")
      .where({ type: "videoPromptGeneration" })
      .first();
    assert.equal(row?.data, promptModule.DEFAULT_VIDEO_PROMPT_GENERATION_ZH);
    assert.equal(String(row?.useData ?? "").trim(), "");
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("全部视觉风格视频手册必须与中文输出合同一致", () => {
  const skillsRoot = path.join(appRoot, "src/tianjiang/skills/builtin/art_skills");
  const manuals: string[] = [];
  for (const styleName of fs.readdirSync(skillsRoot)) {
    const manual = path.join(skillsRoot, styleName, "art_prompt", "art_storyboard_video.md");
    if (fs.existsSync(manual)) manuals.push(manual);
  }
  assert.ok(manuals.length >= 10, "应覆盖全部内置视觉风格视频手册");
  for (const manual of manuals) {
    const source = fs.readFileSync(manual, "utf8");
    assert.doesNotMatch(source, /通用多参模式（英文）|通用首尾帧模式（英文）|Wan 2\.6（英文）/);
    // Seedance 是模型名，除模型名外不允许残留英文自然语言风格词。
    const humanReadableSource = source.replaceAll("Seedance", "");
    assert.doesNotMatch(
      humanReadableSource,
      /[A-Za-z]{2,}/,
      `视频风格手册仍含英文自然语言：${manual}`,
    );
    assert.match(source, /通用多参模式（中文）/);
    assert.match(source, /通用首尾帧模式（中文）/);
  }
});

test("生产迁移白名单必须锁定两份已发布旧默认值且排除中文默认值", async () => {
  const promptModule = await loadChinesePromptModule();
  const migrationModule = await loadLanguageMigrationModule();
  assert.deepEqual([...migrationModule.LEGACY_DEFAULT_VIDEO_PROMPT_HASHES].sort(), [
    "626f4035545159802a7f28cc44e5f162d9183c03afd06138e63ba6c542455d6a",
    "df5c7c3cf1b7445c1bef3428a1f582a436be15d746e2baf07be5949472fda7e7",
  ]);
  assert.equal(
    migrationModule.LEGACY_DEFAULT_VIDEO_PROMPT_HASHES.has(
      migrationModule.hashVideoPrompt(promptModule.DEFAULT_VIDEO_PROMPT_GENERATION_ZH),
    ),
    false,
  );
});

test("旧账号迁移仅更新精确命中的原始默认值并保持幂等", async () => {
  const promptModule = await loadChinesePromptModule();
  const migrationModule = await loadLanguageMigrationModule();
  const legacyDefault = "测试用旧默认视频提示词";
  const legacyHash = migrationModule.hashVideoPrompt(legacyDefault);
  const { database, root } = createTempDatabase("video-prompt-zh-default");
  try {
    await database.schema.createTable("o_prompt", (table) => {
      table.integer("id").primary();
      table.string("type");
      table.text("data");
      table.text("useData");
    });
    await database("o_prompt").insert({
      id: 1,
      type: "videoPromptGeneration",
      data: legacyDefault,
      useData: "",
    });

    await migrationModule.migrateDefaultVideoPromptToChinese(database, {
      legacyHashes: new Set([legacyHash]),
    });
    let row = await database("o_prompt").where({ id: 1 }).first();
    assert.equal(row.data, promptModule.DEFAULT_VIDEO_PROMPT_GENERATION_ZH);

    await migrationModule.migrateDefaultVideoPromptToChinese(database, {
      legacyHashes: new Set([legacyHash]),
    });
    row = await database("o_prompt").where({ id: 1 }).first();
    assert.equal(row.data, promptModule.DEFAULT_VIDEO_PROMPT_GENERATION_ZH);
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("旧账号迁移不得覆盖 useData 或用户修改过的 data", async () => {
  const migrationModule = await loadLanguageMigrationModule();
  const legacyDefault = "测试用旧默认视频提示词";
  const legacyHash = migrationModule.hashVideoPrompt(legacyDefault);
  const { database, root } = createTempDatabase("video-prompt-zh-custom");
  try {
    await database.schema.createTable("o_prompt", (table) => {
      table.integer("id").primary();
      table.string("type");
      table.text("data");
      table.text("useData");
    });
    await database("o_prompt").insert([
      {
        id: 1,
        type: "videoPromptGeneration",
        data: legacyDefault,
        useData: "我的自定义视频提示词",
      },
      {
        id: 2,
        type: "videoPromptGeneration",
        data: "我修改过的默认提示词",
        useData: "",
      },
    ]);

    await migrationModule.migrateDefaultVideoPromptToChinese(database, {
      legacyHashes: new Set([legacyHash]),
    });
    const rows = await database("o_prompt").orderBy("id");
    assert.equal(rows[0].data, legacyDefault);
    assert.equal(rows[0].useData, "我的自定义视频提示词");
    assert.equal(rows[1].data, "我修改过的默认提示词");
  } finally {
    await database.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("单条与批量路由必须继续保留模型文件选择和 useData 优先级", () => {
  for (const route of [
    "src/routes/production/workbench/generateVideoPrompt.ts",
    "src/routes/production/workbench/batchGeneratePrompt.ts",
  ]) {
    const source = readAppFile(route);
    for (const fileName of [
      "wan2.6Single-imageFirstFrameMode.md",
      "seedance2Multi-parameterMode.md",
      "universalFirstAndLastFrameMode.md",
      "universalMulti-parameterMode.md",
    ]) {
      assert.match(source, new RegExp(fileName.replace(/[.]/g, "\\.")));
    }
    assert.match(source, /useData/);
    assert.match(source, /videoPromptGeneration/);
  }
});

test("应用迁移链的最新一步必须是中文默认视频提示词迁移", async () => {
  const { buildApplicationMigrations } = await import(
    "../../src/tianjiang/data/application-migrations"
  );
  const account = buildApplicationMigrations({ role: "account", skipEmbeddingInit: true });
  assert.ok(account.some((item) => item.name === "video-prompt-default-zh-v1"));
  assert.ok(account.some((item) => item.name === "database-role-account-v1"));
  assert.equal(account.at(-1)?.name, "dreamina-dispatch-enqueue-idempotency-v1");
});
