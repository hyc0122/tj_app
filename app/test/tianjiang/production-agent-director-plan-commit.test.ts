/**
 * 导演规划权威提交测试：只操作隔离目录中的 project.sqlite，禁止触碰真实 AppData。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { commitProductionDirectorPlan } from "../../src/agents/productionAgent/production-agent-plan-commit";
import {
  activateUserDatabase,
  db as activeDb,
  destroyAllDatabaseHandles,
  prepareProjectDatabase,
  resetDatabaseRuntimeForServe,
  stopGenerationTaskRecovery,
} from "../../src/utils/db";
import {
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";

const worktreeRoot = path.resolve(__dirname, "../..", "..");
const testDataRoot = path.join(worktreeRoot, ".tmp", "production-agent-director-plan-commit");
const PROJECT_UUID = "71ee1577-965c-42db-9a34-bc3f232e81f7";
const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 98071 };
const PROJECT_ID = 71001;
const OTHER_PROJECT_ID = 71002;
const EPISODE_ID = 71101;
const OTHER_EPISODE_ID = 71102;

async function withProjectDb(run: () => Promise<void>): Promise<void> {
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = testDataRoot;
  fs.rmSync(testDataRoot, { recursive: true, force: true });
  fs.mkdirSync(testDataRoot, { recursive: true });

  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  process.chdir(path.join(worktreeRoot, "app"));
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  try {
    await activateUserDatabase(IDENTITY);
    await runWithUserStorage(IDENTITY, async () => {
      await prepareProjectDatabase(PROJECT_UUID);
      await runWithProjectStorage(PROJECT_UUID, run);
    });
  } finally {
    await stopGenerationTaskRecovery();
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
}

test("导演规划只合并 scriptPlan，并与 mutation journal 在同一事务提交", async () => {
  await withProjectDb(async () => {
    await activeDb("o_script").insert([
      { id: EPISODE_ID, projectId: PROJECT_ID, name: "EP01", content: "原始剧本" },
      {
        id: OTHER_EPISODE_ID,
        projectId: OTHER_PROJECT_ID,
        name: "EP02",
        content: "其他项目剧本",
      },
    ]);

    const originalFlow = {
      script: "原始剧本",
      scriptPlan: "旧导演规划",
      assets: [{ id: 1, name: "角色甲", prompt: "保留角色提示词" }],
      storyboardTable: "保留分镜表",
      storyboard: [{ id: 2, content: "保留分镜内容" }],
      workbench: { videoList: [{ id: 3, name: "保留视频" }] },
      manualExtension: { operator: "人工编辑", revision: 9 },
    };
    await activeDb("o_agentWorkData").insert({
      id: 71201,
      projectId: PROJECT_ID,
      episodesId: EPISODE_ID,
      key: "productionAgent",
      data: JSON.stringify(originalFlow),
    });

    await commitProductionDirectorPlan({
      projectId: PROJECT_ID,
      episodesId: EPISODE_ID,
      content: "完整导演规划：第一场、第二场、第三场。",
    });

    const saved = await activeDb("o_agentWorkData")
      .where({ projectId: PROJECT_ID, episodesId: EPISODE_ID, key: "productionAgent" })
      .first();
    const savedFlow = JSON.parse(String(saved.data));
    assert.equal(savedFlow.scriptPlan, "完整导演规划：第一场、第二场、第三场。");
    assert.equal(savedFlow.script, originalFlow.script);
    assert.deepEqual(savedFlow.assets, originalFlow.assets);
    assert.equal(savedFlow.storyboardTable, originalFlow.storyboardTable);
    assert.deepEqual(savedFlow.storyboard, originalFlow.storyboard);
    assert.deepEqual(savedFlow.workbench, originalFlow.workbench);
    assert.deepEqual(savedFlow.manualExtension, originalFlow.manualExtension);

    const journal = await activeDb("o_legacyMutationJournal")
      .where({ source: "productionAgent", status: "pending" })
      .first();
    assert.ok(journal, "权威产物与 mutation journal 必须同事务落库");
    const journalCountBeforeFailure = await activeDb("o_legacyMutationJournal").count("* as count").first();

    await assert.rejects(
      commitProductionDirectorPlan({
        projectId: PROJECT_ID,
        episodesId: OTHER_EPISODE_ID,
        content: "不得跨项目提交",
      }),
      /当前项目|剧本集/,
    );
    const afterCrossProject = await activeDb("o_agentWorkData")
      .where({ projectId: PROJECT_ID, episodesId: EPISODE_ID, key: "productionAgent" })
      .first();
    assert.equal(JSON.parse(String(afterCrossProject.data)).scriptPlan, savedFlow.scriptPlan);

    await activeDb("o_agentWorkData")
      .where({ projectId: PROJECT_ID, episodesId: EPISODE_ID, key: "productionAgent" })
      .update({ data: "{" });
    await assert.rejects(
      commitProductionDirectorPlan({
        projectId: PROJECT_ID,
        episodesId: EPISODE_ID,
        content: "损坏数据上禁止覆盖",
      }),
      /工作区数据损坏/,
    );
    const malformed = await activeDb("o_agentWorkData")
      .where({ projectId: PROJECT_ID, episodesId: EPISODE_ID, key: "productionAgent" })
      .first();
    assert.equal(malformed.data, "{");
    const journalCountAfterFailure = await activeDb("o_legacyMutationJournal").count("* as count").first();
    assert.equal(
      Number(journalCountAfterFailure?.count),
      Number(journalCountBeforeFailure?.count),
      "失败事务不得新增 mutation journal",
    );
  });
});
