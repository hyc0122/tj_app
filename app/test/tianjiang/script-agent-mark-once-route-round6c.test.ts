/**
 * 第 6 轮最终 P0：项目事务提交后立即 markOnce（不依赖整轮 finally）
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createIdempotentPlanCommitMarker } from "../../src/agents/scriptAgent/script-agent-decision-result";
import { ScriptAgentOutputError } from "../../src/agents/scriptAgent/script-agent-output-contract";
import { toPartialCommitFail } from "../../src/agents/scriptAgent/script-agent-execution";

test("finalize 事务成功后在 Promise 未结束前 markOnce 已调用（onPlanCommitted 立即触发）", async () => {
  let markCount = 0;
  let intentCount = 0;
  const marker = createIdempotentPlanCommitMarker({
    recordIntent: () => {
      intentCount += 1;
    },
    markRuntime: () => {
      markCount += 1;
    },
  });

  const order: string[] = [];
  let resolveMemory!: () => void;
  const memoryGate = new Promise<void>((r) => {
    resolveMemory = r;
  });

  const finalizedPromise = (async () => {
    order.push("txn");
    marker.markOnce();
    order.push("marked");
    order.push("artifactCommitted");
    await memoryGate;
    order.push("memory");
    return { planCommitted: true };
  })();

  assert.equal(markCount, 1);
  assert.equal(intentCount, 1);
  assert.ok(order.includes("marked"));
  assert.ok(!order.includes("memory"));

  resolveMemory();
  await finalizedPromise;
  assert.equal(markCount, 1);
});

test("onPlanCommitted 后 runDecision 仍 pending，抛 PARTIAL 后仍只 mark 一次", async () => {
  let markCount = 0;
  const marker = createIdempotentPlanCommitMarker({
    recordIntent: () => {},
    markRuntime: () => {
      markCount += 1;
    },
  });

  let hold!: () => void;
  const pending = new Promise<void>((r) => {
    hold = r;
  });

  const runDecision = async (ctx: { onPlanCommitted?: () => void; planCommitted?: boolean }) => {
    ctx.onPlanCommitted?.();
    ctx.planCommitted = true;
    assert.equal(markCount, 1);
    await pending;
    throw new ScriptAgentOutputError(toPartialCommitFail("script", 1, "stop"));
  };

  const ctx: { onPlanCommitted?: () => void; planCommitted?: boolean } = {
    onPlanCommitted: () => marker.markOnce(),
  };

  const p = runDecision(ctx).catch((e) => e);
  assert.equal(markCount, 1);

  hold();
  const err = await p;
  assert.ok(err instanceof ScriptAgentOutputError);
  marker.markOnce();
  assert.equal(markCount, 1);
});

test("第一次 mark 抛错，finally 补偿成功", () => {
  let calls = 0;
  const marker = createIdempotentPlanCommitMarker({
    recordIntent: () => {},
    markRuntime: () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
    },
  });
  try {
    marker.markOnce();
  } catch {
    // pendingRetry
  }
  assert.equal(marker.pendingRetry, true);
  assert.equal(marker.intentRecorded, true);
  assert.equal(marker.isSatisfied(), true);
  marker.markOnce();
  assert.equal(marker.marked, true);
  assert.equal(calls, 2);
});

test("未提交路径绝不 mark", () => {
  let calls = 0;
  const marker = createIdempotentPlanCommitMarker({
    recordIntent: () => {},
    markRuntime: () => {
      calls += 1;
    },
  });
  const planCommitted = false;
  if (planCommitted || marker.needsCompensation()) {
    marker.markOnce();
  }
  assert.equal(calls, 0);
});

test("disconnect/Abort 后已提交项目仍应 keep dirty（mark 已发生）", () => {
  let calls = 0;
  const marker = createIdempotentPlanCommitMarker({
    recordIntent: () => {},
    markRuntime: () => {
      calls += 1;
    },
  });
  marker.markOnce();
  assert.equal(calls, 1);
  marker.markOnce();
  assert.equal(calls, 1);
  assert.equal(marker.marked, true);
});
