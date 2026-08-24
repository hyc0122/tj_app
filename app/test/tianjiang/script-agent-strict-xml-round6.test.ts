/**
 * 第 6 轮：严格 XML 语法校验（RED→GREEN）
 * - 完整标签 + finishReason=length 始终失败
 * - 完整第一项 + 第二项未闭合失败
 * - 完整骨架 + 第二个未闭合骨架失败
 * - 成功时返回结构化 artifact，禁止松散二次解析
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  validateScriptAgentOutput,
} from "../../src/agents/scriptAgent/script-agent-output-contract";

test("完整 storySkeleton 已到达，但 finishReason=length：始终 TRUNCATED", () => {
  const full = "<storySkeleton>故事核：完整内容已写完</storySkeleton>";
  const result = validateScriptAgentOutput("storySkeleton", full, { finishReason: "length" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "SCRIPT_AGENT_OUTPUT_TRUNCATED");
  }
});

test("完整 storySkeleton + finishReason=max-tokens：始终 TRUNCATED", () => {
  const full = "<storySkeleton>完整</storySkeleton>";
  const result = validateScriptAgentOutput("storySkeleton", full, { finishReason: "max-tokens" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "SCRIPT_AGENT_OUTPUT_TRUNCATED");
});

test("完整第一项 scriptItem + 第二项未闭合：整体失败", () => {
  const text =
    '<scriptItem name="EP01">△内景 客厅\n对白。</scriptItem><scriptItem name="EP02">未闭合内容';
  const result = validateScriptAgentOutput("script", text, { finishReason: "stop" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.code === "SCRIPT_AGENT_OUTPUT_INCOMPLETE" ||
        result.code === "SCRIPT_AGENT_OUTPUT_INVALID_SCRIPT",
    );
  }
});

test("完整骨架 + 第二个未闭合骨架：失败", () => {
  const text =
    "<storySkeleton>第一份完整骨架</storySkeleton>\n<storySkeleton>第二份未闭合";
  const result = validateScriptAgentOutput("storySkeleton", text, { finishReason: "stop" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "SCRIPT_AGENT_OUTPUT_INCOMPLETE");
  }
});

test("重复完整目标标签：失败", () => {
  const text =
    "<storySkeleton>A</storySkeleton><storySkeleton>B</storySkeleton>";
  const result = validateScriptAgentOutput("storySkeleton", text, { finishReason: "stop" });
  assert.equal(result.ok, false);
});

test("孤立关闭标签：失败", () => {
  const text = "</storySkeleton><storySkeleton>ok</storySkeleton>";
  const result = validateScriptAgentOutput("storySkeleton", text, { finishReason: "stop" });
  assert.equal(result.ok, false);
});

test("adaptationStrategy 恰好一个完整非空标签成功，并返回结构化 artifact", () => {
  const body = "核心原则：快节奏剪辑";
  const result = validateScriptAgentOutput(
    "adaptationStrategy",
    `<adaptationStrategy>${body}</adaptationStrategy>`,
    { finishReason: "stop" },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.artifact);
    assert.equal(result.artifact.kind, "adaptationStrategy");
    if (result.artifact.kind === "adaptationStrategy") {
      assert.equal(result.artifact.content, body);
    }
  }
});

test("script 多项完整闭合 + 结构化 items，开闭数量一致", () => {
  const text =
    '<scriptItem name="EP01">内容一</scriptItem>\n<scriptItem name="EP02">内容二</scriptItem>';
  const result = validateScriptAgentOutput("script", text, { finishReason: "stop" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.artifact.kind, "script");
    if (result.artifact.kind === "script") {
      assert.equal(result.artifact.items.length, 2);
      assert.equal(result.artifact.items[0].name, "EP01");
      assert.equal(result.artifact.items[1].name, "EP02");
    }
  }
});

test("script 开标签多于闭标签：失败", () => {
  const text =
    '<scriptItem name="EP01">A</scriptItem><scriptItem name="EP02">B<scriptItem name="EP03">C</scriptItem>';
  // EP02 未闭合但 EP03 完整 — 开 3 闭 2
  const result = validateScriptAgentOutput("script", text, { finishReason: "stop" });
  assert.equal(result.ok, false);
});
