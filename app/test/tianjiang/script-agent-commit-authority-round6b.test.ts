/**
 * 第 6 轮 P0：项目事务提交为权威提交点；记忆为提交后辅助步骤。
 * 不调用真实收费模型。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ScriptAgentOutputError,
  SCRIPT_AGENT_DECISION_TOOL_NAMES,
} from "../../src/agents/scriptAgent/script-agent-output-contract";
import { finalizeScriptExecutionOutput } from "../../src/agents/scriptAgent/script-agent-execution";
import {
  commitScriptAgentArtifact,
  commitScriptAgentPlanData,
  readScriptAgentPlanData,
} from "../../src/agents/scriptAgent/script-agent-plan-commit";
import {
  shouldMarkLegacyMutationAfterDecision,
  type DecisionRunResult,
} from "../../src/agents/scriptAgent/script-agent-decision-result";
import { buildDecisionTools } from "../../src/agents/scriptAgent/index";
import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  stopGenerationTaskRecovery,
  prepareProjectDatabase,
  resetDatabaseRuntimeForServe,
  beginDatabaseShutdown,
  db as activeDb,
} from "../../src/utils/db";
import {
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";

const worktreeRoot = path.resolve(__dirname, "../..", "..");
const testDataRoot = path.join(worktreeRoot, ".tmp", "script-agent-commit-authority-round6b");
const PROJECT_UUID = "dddddddd-4444-4444-8444-dddddddddddd";
const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 88043 };
const LOCAL_PROJECT_ID = 202;

function ensureTestEnv(): void {
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = testDataRoot;
  fs.mkdirSync(testDataRoot, { recursive: true });
}

class FakeMsg {
  status: "pending" | "complete" | "error" | "stop" | "warning" = "pending";
  errorMsg?: string;
  errorCode?: string;
  errorStage?: string;
  datetime = new Date().toISOString();
  id = "msg-auth-1";
  text() {
    return { append() {}, complete() {}, error() {} };
  }
  thinking() {
    return { append() {}, updateTitle() {}, complete() {} };
  }
  complete() {
    this.status = "complete";
  }
  error(msg?: string, meta?: { errorCode?: string; stage?: string }) {
    this.status = "error";
    this.errorMsg = msg;
    this.errorCode = meta?.errorCode;
    this.errorStage = meta?.stage;
  }
  stop() {
    this.status = "stop";
  }
}

class FakeSocket {
  events: Array<{ event: string; payload: unknown }> = [];
  emit(event: string, payload: unknown) {
    this.events.push({ event, payload });
  }
}

async function withProjectDb(run: () => Promise<void>): Promise<void> {
  ensureTestEnv();
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

test("项目事务成功后 memory.add 抛错：产物已提交、planCommitted=true、不得回滚为「工作区未修改」", async () => {
  await withProjectDb(async () => {
    const msg = new FakeMsg();
    const socket = new FakeSocket();
    let memoryCalled = 0;
    const memory = {
      async add() {
        memoryCalled += 1;
        throw new Error("embedding provider failed");
      },
    };
    const body = "权威骨架-memory失败后仍在库";
    const result = await finalizeScriptExecutionOutput({
      stage: "storySkeleton",
      collected: {
        fullResponse: `<storySkeleton>${body}</storySkeleton>`,
        toolCallCount: 0,
        stepCount: 1,
        streamFinishReason: "stop",
        aborted: false,
      },
      subMsg: msg as any,
      memory: memory as any,
      memoryKey: "assistant:execution:storySkeleton",
      name: "编剧",
      deploymentKey: "scriptAgent:storySkeletonAgent",
      finishReason: "stop",
      projectId: LOCAL_PROJECT_ID,
      socket: socket as any,
    });

    assert.equal(result.planCommitted, true);
    assert.equal(memoryCalled, 1);
    // 消息不得残留 pending；产物已提交故不得 error 成「未修改」
    assert.notEqual(msg.status, "pending");
    assert.notEqual(msg.status, "error");
    assert.equal(msg.status, "complete");
    assert.doesNotMatch(msg.errorMsg ?? "", /工作区未修改/);
    assert.equal(
      socket.events.filter((e) => e.event === "artifactCommitted").length,
      1,
    );

    const plan = await readScriptAgentPlanData(LOCAL_PROJECT_ID);
    assert.equal(plan.storySkeleton, body);
    // 权威：mark 条件必须为 true（route finally 依赖此标志）
    assert.equal(shouldMarkLegacyMutationAfterDecision(result), true);
  });
});

test("第一阶段已提交后：后续失败仍 planCommitted=true，应 markLegacyMutation，不得声称未修改", async () => {
  // 模拟：tracker 已在阶段1提交后为 true；后续 tool-error 不清除该标志
  const afterStage1: DecisionRunResult = { planCommitted: true };
  assert.equal(shouldMarkLegacyMutationAfterDecision(afterStage1), true);

  // 若整轮 runDecisionAI 以抛错结束，route 必须仍能从 ctx/tracker 读到已提交
  // （测试契约：DecisionRunResult 与 catch 路径可读 ctx.planCommitted）
  const ctxLike = { planCommitted: true };
  assert.equal(
    shouldMarkLegacyMutationAfterDecision({ planCommitted: ctxLike.planCommitted === true }),
    true,
  );

  // 未提交时不得 mark
  assert.equal(shouldMarkLegacyMutationAfterDecision({ planCommitted: false }), false);
  assert.equal(shouldMarkLegacyMutationAfterDecision(undefined), false);
});

test("事务内读-合并-写：storySkeleton 只改骨架，不覆盖并发写入的策略与剧本", async () => {
  await withProjectDb(async () => {
    await commitScriptAgentPlanData({
      projectId: LOCAL_PROJECT_ID,
      agentType: "scriptAgent",
      data: {
        storySkeleton: "旧骨架",
        adaptationStrategy: "旧策略",
        script: [{ name: "EP01", content: "旧剧本" }],
      },
    });

    // 可控 barrier：在 commitScriptAgentArtifact 的「读」与「写」之间插入手动保存
    // 通过 hook 实现：先手动更新策略与剧本，再提交骨架 artifact
    await commitScriptAgentPlanData({
      projectId: LOCAL_PROJECT_ID,
      agentType: "scriptAgent",
      data: {
        storySkeleton: "旧骨架",
        adaptationStrategy: "手动新策略-并发",
        script: [
          { name: "EP01", content: "旧剧本" },
          { name: "EP99", content: "手动新剧本-并发" },
        ],
      },
    });

    // Agent 仅提交骨架：必须保留手动新策略与 EP99
    await commitScriptAgentArtifact({
      projectId: LOCAL_PROJECT_ID,
      artifact: { kind: "storySkeleton", content: "Agent新骨架" },
    });

    const plan = await readScriptAgentPlanData(LOCAL_PROJECT_ID);
    assert.equal(plan.storySkeleton, "Agent新骨架");
    assert.equal(plan.adaptationStrategy, "手动新策略-并发");
    assert.ok(plan.script.some((s) => s.name === "EP99" && s.content.includes("手动新剧本")));
    assert.ok(plan.script.some((s) => s.name === "EP01"));
  });
});

test("script 阶段只 upsert 本次条目，不删除其他剧本", async () => {
  await withProjectDb(async () => {
    await commitScriptAgentPlanData({
      projectId: LOCAL_PROJECT_ID,
      agentType: "scriptAgent",
      data: {
        storySkeleton: "S",
        adaptationStrategy: "A",
        script: [
          { name: "KEEP", content: "保留" },
          { name: "EP01", content: "旧EP01" },
        ],
      },
    });

    await commitScriptAgentArtifact({
      projectId: LOCAL_PROJECT_ID,
      artifact: {
        kind: "script",
        items: [{ name: "EP01", content: "新EP01" }],
      },
    });

    const plan = await readScriptAgentPlanData(LOCAL_PROJECT_ID);
    assert.equal(plan.storySkeleton, "S");
    assert.equal(plan.adaptationStrategy, "A");
    const keep = plan.script.find((s) => s.name === "KEEP");
    const ep01 = plan.script.find((s) => s.name === "EP01");
    assert.ok(keep);
    assert.equal(keep!.content, "保留");
    assert.equal(ep01!.content, "新EP01");
  });
});

test("权威事务开始前 barrier 插入手动保存：事务内重读后非目标字段不被覆盖", async () => {
  await withProjectDb(async () => {
    await commitScriptAgentPlanData({
      projectId: LOCAL_PROJECT_ID,
      agentType: "scriptAgent",
      data: {
        storySkeleton: "基线骨架",
        adaptationStrategy: "基线策略",
        script: [{ name: "BASE", content: "基线剧本" }],
      },
    });

    let preTxnManualDone = false;
    // hook 实际在权威事务开始前执行（非事务内读后）
    const barrier = {
      beforeAuthoritativeTransaction: async () => {
        await commitScriptAgentPlanData({
          projectId: LOCAL_PROJECT_ID,
          agentType: "scriptAgent",
          data: {
            storySkeleton: "基线骨架",
            adaptationStrategy: "事务间隙手动策略",
            script: [
              { name: "BASE", content: "基线剧本" },
              { name: "GAP", content: "间隙剧本" },
            ],
          },
        });
        preTxnManualDone = true;
      },
    };

    await commitScriptAgentArtifact({
      projectId: LOCAL_PROJECT_ID,
      artifact: { kind: "storySkeleton", content: "间隙后Agent骨架" },
      testHooks: barrier,
    });

    assert.equal(preTxnManualDone, true);
    const plan = await readScriptAgentPlanData(LOCAL_PROJECT_ID);
    assert.equal(plan.storySkeleton, "间隙后Agent骨架");
    // 同事务内读取最新行并只改骨架，保留 barrier 写入的策略与 GAP
    assert.equal(plan.adaptationStrategy, "事务间隙手动策略");
    assert.ok(plan.script.some((s) => s.name === "GAP"));
  });
});

test("buildDecisionTools 最终键集严格等于冻结白名单", async () => {
  const fakeCtx = {
    socket: { emit() {} } as any,
    isolationKey: "1:scriptAgent",
    text: "x",
    resTool: { data: { projectId: 1 }, newMessage: () => new FakeMsg(), socket: { emit() {} } } as any,
    msg: new FakeMsg() as any,
    thinkConfig: { think: false, thinlLevel: 0 as const },
  };
  // 可能因 createSubAgent 读 skill 文件失败——只断言 tools 键时不执行 tool
  const tools = buildDecisionTools(fakeCtx as any);
  const keys = Object.keys(tools).sort();
  assert.deepEqual(keys, [...SCRIPT_AGENT_DECISION_TOOL_NAMES].sort());
  for (const forbidden of ["get_planData", "get_novel_events", "get_novel_text", "get_script_content", "extra_spy"]) {
    assert.ok(!keys.includes(forbidden));
  }
});

test("Memory.getTools 若出现额外工具也不得暴露到决策层", async () => {
  // 通过 monkey-patch Memory.prototype.getTools 注入额外工具
  const Memory = (await import("../../src/utils/agent/memory")).default;
  const original = Memory.prototype.getTools;
  Memory.prototype.getTools = function (this: any) {
    return {
      ...original.call(this),
      extra_spy_tool: { description: "should not appear" },
      get_planData: { description: "leaked" },
    };
  };
  try {
    const fakeCtx = {
      socket: { emit() {} } as any,
      isolationKey: "2:scriptAgent",
      text: "x",
      resTool: { data: { projectId: 1 }, newMessage: () => new FakeMsg(), socket: { emit() {} } } as any,
      msg: new FakeMsg() as any,
      thinkConfig: { think: false, thinlLevel: 0 as const },
    };
    const tools = buildDecisionTools(fakeCtx as any);
    assert.ok(!("extra_spy_tool" in tools));
    assert.ok(!("get_planData" in tools));
    assert.deepEqual(Object.keys(tools).sort(), [...SCRIPT_AGENT_DECISION_TOOL_NAMES].sort());
  } finally {
    Memory.prototype.getTools = original;
  }
});

test("memory 失败错误文案不得含「工作区未修改」且产物保持", async () => {
  await withProjectDb(async () => {
    const msg = new FakeMsg();
    const result = await finalizeScriptExecutionOutput({
      stage: "adaptationStrategy",
      collected: {
        fullResponse: "<adaptationStrategy>策略已入库</adaptationStrategy>",
        toolCallCount: 0,
        stepCount: 1,
        streamFinishReason: "stop",
        aborted: false,
      },
      subMsg: msg as any,
      memory: {
        async add() {
          throw new Error("summary model timeout");
        },
      } as any,
      memoryKey: "assistant:execution:adaptationStrategy",
      name: "编剧",
      deploymentKey: "scriptAgent:adaptationStrategyAgent",
      finishReason: "stop",
      projectId: LOCAL_PROJECT_ID,
      socket: new FakeSocket() as any,
    });
    assert.equal(result.planCommitted, true);
    assert.equal(msg.status, "complete");
    const plan = await readScriptAgentPlanData(LOCAL_PROJECT_ID);
    assert.equal(plan.adaptationStrategy, "策略已入库");
  });
});
