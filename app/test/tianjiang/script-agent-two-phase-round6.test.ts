/**
 * 第 6 轮：校验后提交两阶段 + tool-error + 决策白名单 + 事务快照
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ScriptAgentOutputError,
  SCRIPT_AGENT_DECISION_TOOL_NAMES,
  validateScriptAgentOutput,
} from "../../src/agents/scriptAgent/script-agent-output-contract";
import {
  consumeFullStreamForExecution,
  finalizeScriptExecutionOutput,
} from "../../src/agents/scriptAgent/script-agent-execution";
import { commitScriptAgentPlanData } from "../../src/agents/scriptAgent/script-agent-plan-commit";
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
const testDataRoot = path.join(worktreeRoot, ".tmp", "script-agent-two-phase-round6");
const PROJECT_UUID = "cccccccc-3333-4333-8333-cccccccccccc";
const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 88042 };
const LOCAL_PROJECT_ID = 101;

function ensureTestEnv(): void {
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = testDataRoot;
  fs.mkdirSync(testDataRoot, { recursive: true });
}

class FakeMsg {
  status: "pending" | "complete" | "error" | "stop" = "pending";
  errorMsg?: string;
  errorCode?: string;
  errorStage?: string;
  textStatus: "pending" | "complete" | "error" = "pending";
  appended = "";
  datetime = new Date().toISOString();
  id = "msg-fake-1";
  text() {
    const self = this;
    return {
      append(t: string) {
        self.appended += t;
      },
      complete() {
        self.textStatus = "complete";
      },
      error() {
        self.textStatus = "error";
      },
    };
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

class FakeMemory {
  adds: Array<{ key: string; content: string }> = [];
  async add(key: string, content: string) {
    this.adds.push({ key, content });
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

async function snapshotPlan(projectId: number) {
  const work = await activeDb("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
  const scripts = await activeDb("o_script").where({ projectId }).select("id", "name", "content");
  return {
    work: work ? String(work.data) : null,
    scripts: scripts.map((s: { id: number; name: string; content: string }) => ({
      id: s.id,
      name: s.name,
      content: s.content,
    })),
  };
}

test("决策层工具白名单：不含四个工作区读取工具", () => {
  const names = SCRIPT_AGENT_DECISION_TOOL_NAMES;
  assert.ok(names.includes("deepRetrieve"));
  assert.ok(names.includes("run_sub_agent_storySkeleton"));
  assert.ok(names.includes("run_sub_agent_adaptationStrategy"));
  assert.ok(names.includes("run_sub_agent_script"));
  assert.ok(names.includes("run_supervision_agent"));
  for (const forbidden of [
    "get_planData",
    "get_novel_events",
    "get_novel_text",
    "get_script_content",
  ]) {
    assert.ok(!names.includes(forbidden), `决策层不得含 ${forbidden}`);
  }
});

test("完整 XML + finishReason=length：finalize 不写库、不写记忆", async () => {
  await withProjectDb(async () => {
    const before = await snapshotPlan(LOCAL_PROJECT_ID);
    const msg = new FakeMsg();
    const memory = new FakeMemory();
    const socket = new FakeSocket();
    const full = "<storySkeleton>完整骨架</storySkeleton>";
    const collected = {
      fullResponse: full,
      toolCallCount: 0,
      stepCount: 1,
      streamFinishReason: "length" as string | null,
      aborted: false,
    };
    await assert.rejects(
      () =>
        finalizeScriptExecutionOutput({
          stage: "storySkeleton",
          collected,
          subMsg: msg as any,
          memory: memory as any,
          memoryKey: "assistant:execution:storySkeleton",
          name: "编剧",
          deploymentKey: "scriptAgent:storySkeletonAgent",
          finishReason: "length",
          projectId: LOCAL_PROJECT_ID,
          socket: socket as any,
        }),
      (err: unknown) =>
        err instanceof ScriptAgentOutputError && err.code === "SCRIPT_AGENT_OUTPUT_TRUNCATED",
    );
    assert.equal(memory.adds.length, 0);
    assert.equal(msg.status, "error");
    assert.equal(msg.errorCode, "SCRIPT_AGENT_OUTPUT_TRUNCATED");
    assert.equal(
      socket.events.filter((e) => e.event === "artifactCommitted").length,
      0,
    );
    const after = await snapshotPlan(LOCAL_PROJECT_ID);
    assert.deepEqual(after, before);
  });
});

test("正式事务：失败前后数据库快照一致；成功只提交一次", async () => {
  await withProjectDb(async () => {
    // 种子
    await commitScriptAgentPlanData({
      projectId: LOCAL_PROJECT_ID,
      agentType: "scriptAgent",
      data: {
        storySkeleton: "旧骨架",
        adaptationStrategy: "旧策略",
        script: [],
      },
    });
    const baseline = await snapshotPlan(LOCAL_PROJECT_ID);

    const msg = new FakeMsg();
    const memory = new FakeMemory();
    const socket = new FakeSocket();

    // 失败路径：过渡文本
    await assert.rejects(() =>
      finalizeScriptExecutionOutput({
        stage: "storySkeleton",
        collected: {
          fullResponse: "Now let me also check...",
          toolCallCount: 1,
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
      }),
    );
    assert.deepEqual(await snapshotPlan(LOCAL_PROJECT_ID), baseline);
    assert.equal(memory.adds.length, 0);

    // 成功路径：只提交一次
    const msg2 = new FakeMsg();
    const memory2 = new FakeMemory();
    const socket2 = new FakeSocket();
    const body = "新骨架内容-第6轮";
    const result = await finalizeScriptExecutionOutput({
      stage: "storySkeleton",
      collected: {
        fullResponse: `<storySkeleton>${body}</storySkeleton>`,
        toolCallCount: 0,
        stepCount: 1,
        streamFinishReason: "stop",
        aborted: false,
      },
      subMsg: msg2 as any,
      memory: memory2 as any,
      memoryKey: "assistant:execution:storySkeleton",
      name: "编剧",
      deploymentKey: "scriptAgent:storySkeletonAgent",
      finishReason: "stop",
      projectId: LOCAL_PROJECT_ID,
      socket: socket2 as any,
    });
    assert.equal(result.planCommitted, true);
    assert.equal(memory2.adds.length, 1);
    assert.equal(msg2.status, "complete");
    assert.equal(
      socket2.events.filter((e) => e.event === "artifactCommitted").length,
      1,
    );

    const after = await snapshotPlan(LOCAL_PROJECT_ID);
    assert.ok(after.work?.includes(body));
    assert.ok(after.work?.includes("旧策略")); // 合并保留
    // 再次成功提交另一阶段，确认骨架不丢
    await finalizeScriptExecutionOutput({
      stage: "adaptationStrategy",
      collected: {
        fullResponse: "<adaptationStrategy>新策略</adaptationStrategy>",
        toolCallCount: 0,
        stepCount: 1,
        streamFinishReason: "stop",
        aborted: false,
      },
      subMsg: new FakeMsg() as any,
      memory: new FakeMemory() as any,
      memoryKey: "assistant:execution:adaptationStrategy",
      name: "编剧",
      deploymentKey: "scriptAgent:adaptationStrategyAgent",
      finishReason: "stop",
      projectId: LOCAL_PROJECT_ID,
      socket: new FakeSocket() as any,
    });
    const finalSnap = await snapshotPlan(LOCAL_PROJECT_ID);
    assert.ok(finalSnap.work?.includes(body));
    assert.ok(finalSnap.work?.includes("新策略"));
  });
});

test("fullStream tool-error 携带 ScriptAgentOutputError：立即终止并传播 code/stage", async () => {
  const msg = new FakeMsg();
  const fail = validateScriptAgentOutput("storySkeleton", "x", { finishReason: "stop" });
  assert.equal(fail.ok, false);
  if (fail.ok) return;
  const outputErr = new ScriptAgentOutputError(fail);

  const stream = (async function* () {
    yield { type: "text-delta", text: "调度中" };
    yield {
      type: "tool-error",
      toolCallId: "call-1",
      toolName: "run_sub_agent_storySkeleton",
      input: { prompt: "写骨架" },
      error: outputErr,
    };
    // 若未终止，后续不应被消费
    yield { type: "text-delta", text: "不该出现的第二次输出" };
    yield { type: "finish", finishReason: "stop" };
  })();

  await assert.rejects(
    () => consumeFullStreamForExecution(stream, msg as any, { deferComplete: true }),
    (err: unknown) => {
      assert.ok(err instanceof ScriptAgentOutputError);
      assert.equal(err.code, "SCRIPT_AGENT_OUTPUT_INCOMPLETE");
      assert.equal(err.stage, "storySkeleton");
      return true;
    },
  );
  assert.doesNotMatch(msg.appended, /不该出现的第二次输出/);
});

test("tool-error 失败路径：不得 memory.add，消息 error 带 errorCode", async () => {
  const msg = new FakeMsg();
  const memory = new FakeMemory();
  const fail = validateScriptAgentOutput("script", "残缺", { finishReason: "stop" });
  assert.equal(fail.ok, false);
  if (fail.ok) return;

  await assert.rejects(
    () =>
      finalizeScriptExecutionOutput({
        stage: "script",
        collected: {
          fullResponse: "残缺",
          toolCallCount: 0,
          stepCount: 1,
          streamFinishReason: "stop",
          aborted: false,
        },
        subMsg: msg as any,
        memory: memory as any,
        memoryKey: "assistant:execution:script",
        name: "编剧",
        deploymentKey: "scriptAgent:scriptAgent",
        finishReason: "stop",
        projectId: LOCAL_PROJECT_ID,
      }),
    (err: unknown) => err instanceof ScriptAgentOutputError,
  );
  assert.equal(memory.adds.length, 0);
  assert.equal(msg.status, "error");
  assert.ok(msg.errorCode);
  assert.equal(msg.errorStage, "script");
});
