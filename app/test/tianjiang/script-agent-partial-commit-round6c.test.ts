/**
 * 第 6 轮最终 P0：部分提交语义 + 立即 markOnce
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ScriptAgentOutputError,
  scriptAgentOutputUserMessage,
  validateScriptAgentOutput,
  type ScriptAgentOutputErrorCode,
} from "../../src/agents/scriptAgent/script-agent-output-contract";
import {
  finalizeScriptExecutionOutput,
  toPartialCommitFail,
} from "../../src/agents/scriptAgent/script-agent-execution";
import { createIdempotentPlanCommitMarker } from "../../src/agents/scriptAgent/script-agent-decision-result";

class FakeMsg {
  status: "pending" | "complete" | "error" | "stop" = "pending";
  errorMsg?: string;
  errorCode?: string;
  errorStage?: string;
  id = "sub-msg";
  datetime = new Date().toISOString();
  events: Array<{ kind: string; code?: string; msg?: string }> = [];
  text() {
    return { append() {}, complete() {}, error() {} };
  }
  thinking() {
    return { append() {}, updateTitle() {}, complete() {} };
  }
  complete() {
    this.status = "complete";
    this.events.push({ kind: "complete" });
  }
  error(msg?: string, meta?: { errorCode?: string; stage?: string }) {
    this.status = "error";
    this.errorMsg = msg;
    this.errorCode = meta?.errorCode;
    this.errorStage = meta?.stage;
    this.events.push({ kind: "error", code: meta?.errorCode, msg });
  }
}

test("toPartialCommitFail：稳定 PARTIAL_COMMIT 且文案不含工作区未修改", () => {
  const fail = toPartialCommitFail("script", 10, "stop");
  assert.equal(fail.ok, false);
  assert.equal(fail.code, "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT");
  assert.match(fail.message, /已保存|仍保留/);
  assert.doesNotMatch(fail.message, /工作区未修改/);
  assert.match(scriptAgentOutputUserMessage("SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT", "script"), /仍保留|已保存/);
});

test("阶段1已提交后阶段2校验失败：子消息首条 error 即为 PARTIAL_COMMIT", async () => {
  const msg = new FakeMsg();
  await assert.rejects(
    () =>
      finalizeScriptExecutionOutput({
        stage: "adaptationStrategy",
        collected: {
          fullResponse: "过渡文本没有标签",
          toolCallCount: 0,
          stepCount: 1,
          streamFinishReason: "stop",
          aborted: false,
        },
        subMsg: msg as any,
        memory: { async add() {} } as any,
        memoryKey: "k",
        name: "编剧",
        deploymentKey: "scriptAgent:adaptationStrategyAgent",
        finishReason: "stop",
        projectId: 1,
        priorPlanCommitted: true,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ScriptAgentOutputError);
      assert.equal(err.code, "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT");
      assert.doesNotMatch(err.message, /工作区未修改/);
      return true;
    },
  );
  // 第一条可见错误即为 PARTIAL_COMMIT（禁止先 INCOMPLETE）
  assert.equal(msg.events[0]?.kind, "error");
  assert.equal(msg.events[0]?.code, "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT");
  assert.doesNotMatch(msg.events[0]?.msg ?? "", /工作区未修改/);
  assert.equal(msg.errorCode, "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT");
});

test("阶段1已提交后 generic 失败路径映射为 PARTIAL_COMMIT", () => {
  const fail = toPartialCommitFail("script", 0, null);
  const err = new ScriptAgentOutputError(fail);
  assert.equal(err.code, "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT");
  // 模拟 route：已有提交时 generic 也走同一文案
  assert.doesNotMatch(err.message, /工作区未修改/);
});

test("createIdempotentPlanCommitMarker：成功后立即 mark，同轮只一次，失败可补偿", () => {
  let calls = 0;
  const marker = createIdempotentPlanCommitMarker({
    recordIntent: () => {},
    markRuntime: () => {
      calls += 1;
      if (calls === 1) throw new Error("mark failed once");
    },
  });
  assert.equal(marker.marked, false);
  assert.equal(marker.pendingRetry, false);

  assert.throws(() => marker.markOnce());
  assert.equal(marker.marked, false);
  assert.equal(marker.pendingRetry, true);
  assert.equal(marker.intentRecorded, true);
  assert.equal(calls, 1);

  marker.markOnce();
  assert.equal(marker.marked, true);
  assert.equal(marker.pendingRetry, false);
  assert.equal(calls, 2);

  marker.markOnce();
  assert.equal(calls, 2);
});

test("createIdempotentPlanCommitMarker：未失败路径只标一次", () => {
  let calls = 0;
  const marker = createIdempotentPlanCommitMarker({
    recordIntent: () => {},
    markRuntime: () => {
      calls += 1;
    },
  });
  marker.markOnce();
  marker.markOnce();
  marker.markOnce();
  assert.equal(calls, 1);
  assert.equal(marker.marked, true);
});

test("priorPlanCommitted 时 validate 失败不得出现 INCOMPLETE 作为首个 code", async () => {
  const v = validateScriptAgentOutput("script", "残缺", { finishReason: "stop" });
  assert.equal(v.ok, false);
  if (v.ok) return;
  // 基线仍是 incomplete；toPartialCommit 覆盖
  const partial = toPartialCommitFail(v.stage, v.responseChars, v.finishReason ?? null);
  assert.notEqual(partial.code, "SCRIPT_AGENT_OUTPUT_INCOMPLETE" as ScriptAgentOutputErrorCode);
  assert.equal(partial.code, "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT");
});
