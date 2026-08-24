/**
 * 执行层运行时行为：确定性 fake fullStream，不调用真实模型。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ScriptAgentOutputError,
  validateScriptAgentOutput,
} from "../../src/agents/scriptAgent/script-agent-output-contract";
import {
  consumeFullStreamForExecution,
  finalizeScriptExecutionOutput,
} from "../../src/agents/scriptAgent/script-agent-execution";

function textStream(chunks: string[], extras: Array<{ type: string; [k: string]: unknown }> = []) {
  return (async function* () {
    for (const t of chunks) {
      yield { type: "text-delta", text: t };
    }
    for (const e of extras) yield e;
    yield { type: "finish", finishReason: "stop" };
  })();
}

class FakeMsg {
  status: "pending" | "complete" | "error" | "stop" = "pending";
  errorMsg?: string;
  textStatus: "pending" | "complete" | "error" = "pending";
  appended = "";
  datetime = new Date().toISOString();
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
    return {
      append() {},
      updateTitle() {},
      complete() {},
    };
  }
  complete() {
    this.status = "complete";
  }
  error(msg?: string, _meta?: { errorCode?: string; stage?: string }) {
    this.status = "error";
    this.errorMsg = msg;
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

test("过渡文本 stop：finalize 失败，不得 memory.add，消息 error", async () => {
  const msg = new FakeMsg();
  const memory = new FakeMemory();
  const stream = textStream([
    "Now let me also check the adaptation strategy and script data for any additional context:",
  ]);
  const collected = await consumeFullStreamForExecution(stream, msg as any, { deferComplete: true });
  assert.equal(msg.status, "pending"); // 流结束未 complete
  assert.equal(collected.fullResponse.includes("Now let me"), true);

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
        finishReason: "stop",
      }),
    (err: unknown) => {
      assert.ok(err instanceof ScriptAgentOutputError);
      assert.equal(err.code, "SCRIPT_AGENT_OUTPUT_INCOMPLETE");
      return true;
    },
  );
  assert.equal(memory.adds.length, 0);
  assert.equal(msg.status, "error");
  assert.match(msg.errorMsg ?? "", /故事骨架/);
  assert.doesNotMatch(msg.errorMsg ?? "", /Now let me|decryptString/i);
});

test("未闭合 length：TRUNCATE，不得 memory", async () => {
  const msg = new FakeMsg();
  const memory = new FakeMemory();
  const stream = textStream(["<storySkeleton>部分内容"]);
  const collected = await consumeFullStreamForExecution(stream, msg as any, { deferComplete: true });
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
      }),
    (err: unknown) => err instanceof ScriptAgentOutputError && err.code === "SCRIPT_AGENT_OUTPUT_TRUNCATED",
  );
  assert.equal(memory.adds.length, 0);
  assert.equal(msg.status, "error");
});

test("完整 storySkeleton：成功一次 memory，消息 complete", async () => {
  const msg = new FakeMsg();
  const memory = new FakeMemory();
  const body = "故事核：逆袭。";
  const stream = textStream([`<storySkeleton>${body}</storySkeleton>`]);
  const collected = await consumeFullStreamForExecution(stream, msg as any, { deferComplete: true });
  const finalized = await finalizeScriptExecutionOutput({
    stage: "storySkeleton",
    collected,
    subMsg: msg as any,
    memory: memory as any,
    memoryKey: "assistant:execution:storySkeleton",
    name: "编剧",
    deploymentKey: "scriptAgent:storySkeletonAgent",
    finishReason: "stop",
  });
  assert.match(finalized.fullResponse, /storySkeleton|故事核/);
  assert.equal(memory.adds.length, 1);
  assert.equal(memory.adds[0].key, "assistant:execution:storySkeleton");
  assert.match(memory.adds[0].content, /故事核/);
  assert.doesNotMatch(memory.adds[0].content, /<storySkeleton>/);
  assert.equal(msg.status, "complete");
});

test("abort 流：stop 状态，不伪装产物失败", async () => {
  const msg = new FakeMsg();
  const memory = new FakeMemory();
  const stream = (async function* () {
    yield { type: "text-delta", text: "开始" };
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  })();
  await assert.rejects(
    () => consumeFullStreamForExecution(stream, msg as any, { deferComplete: true }),
    (err: unknown) => (err as Error).name === "AbortError",
  );
  // consume 在 abort 时标记 stop 而非 output incomplete
  assert.equal(msg.status, "stop");
  assert.equal(memory.adds.length, 0);
});

test("契约与 finalize 一致：空 XML 不进记忆", async () => {
  const v = validateScriptAgentOutput("storySkeleton", "<storySkeleton></storySkeleton>", {
    finishReason: "stop",
  });
  assert.equal(v.ok, false);
});
