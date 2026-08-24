/**
 * 第 6 轮：决策层 tool-error 传播与 markLegacyMutation 门禁
 * 不调用真实供应商。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ScriptAgentOutputError,
  SCRIPT_AGENT_DECISION_TOOL_NAMES,
  validateScriptAgentOutput,
} from "../../src/agents/scriptAgent/script-agent-output-contract";
import {
  consumeFullStreamForExecution,
  isScriptAgentToolStreamError,
} from "../../src/agents/scriptAgent/script-agent-execution";
import {
  shouldMarkLegacyMutationAfterDecision,
  type DecisionRunResult,
} from "../../src/agents/scriptAgent/script-agent-decision-result";

test("isScriptAgentToolStreamError 识别 ScriptAgentOutputError", () => {
  const fail = validateScriptAgentOutput("storySkeleton", "x", { finishReason: "stop" });
  assert.equal(fail.ok, false);
  if (fail.ok) return;
  const err = new ScriptAgentOutputError(fail);
  assert.equal(isScriptAgentToolStreamError(err), true);
  assert.equal(isScriptAgentToolStreamError(new Error("other")), false);
  assert.equal(
    isScriptAgentToolStreamError({
      name: "ScriptAgentOutputError",
      code: "SCRIPT_AGENT_OUTPUT_TRUNCATED",
      stage: "script",
      message: "截断",
    }),
    true,
  );
});

test("决策成功但未提交事务：不得 markLegacyMutation", () => {
  const result: DecisionRunResult = { planCommitted: false };
  assert.equal(shouldMarkLegacyMutationAfterDecision(result), false);
});

test("决策成功且事务已提交：才 markLegacyMutation", () => {
  const result: DecisionRunResult = { planCommitted: true };
  assert.equal(shouldMarkLegacyMutationAfterDecision(result), true);
});

test("决策层实际工具名集合冻结", () => {
  assert.deepEqual(
    [...SCRIPT_AGENT_DECISION_TOOL_NAMES].sort(),
    [
      "deepRetrieve",
      "run_sub_agent_adaptationStrategy",
      "run_sub_agent_script",
      "run_sub_agent_storySkeleton",
      "run_supervision_agent",
    ].sort(),
  );
});

test("consume 遇到 tool-error 后不得继续消费后续 text-delta（无第二次模型输出路径）", async () => {
  let deltasAfterError = 0;
  const err = new ScriptAgentOutputError(
    validateScriptAgentOutput("storySkeleton", "x", { finishReason: "stop" }) as any,
  );
  // 若 validation fail 结构正确：
  const fail = validateScriptAgentOutput("storySkeleton", "x", { finishReason: "stop" });
  if (fail.ok) throw new Error("expected fail");
  const outputErr = new ScriptAgentOutputError(fail);

  let sawError = false;
  const stream = (async function* () {
    yield { type: "text-delta", text: "step1" };
    yield {
      type: "tool-error",
      toolCallId: "t1",
      toolName: "run_sub_agent_storySkeleton",
      input: {},
      error: outputErr,
    };
    sawError = true;
    deltasAfterError += 1;
    yield { type: "text-delta", text: "model-second-call-output" };
  })();

  const msg = {
    status: "pending" as const,
    appended: "",
    datetime: new Date().toISOString(),
    text() {
      const self = this;
      return {
        append(t: string) {
          self.appended += t;
        },
        complete() {},
        error() {},
      };
    },
    thinking() {
      return { append() {}, updateTitle() {}, complete() {} };
    },
    complete() {
      this.status = "complete" as any;
    },
    error() {
      this.status = "error" as any;
    },
    stop() {
      this.status = "stop" as any;
    },
  };

  await assert.rejects(
    () => consumeFullStreamForExecution(stream as any, msg as any, { deferComplete: true }),
    (e: unknown) => e instanceof ScriptAgentOutputError,
  );
  assert.doesNotMatch(msg.appended, /model-second-call-output/);
  // generator 在 throw 后可能不再 pull；deltasAfterError 若已执行则证明我们在 yield tool-error 之后立刻 throw，
  // 不应把后续 text 写入消息
  void sawError;
  void deltasAfterError;
});
