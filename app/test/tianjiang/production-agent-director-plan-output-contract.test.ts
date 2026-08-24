import assert from "node:assert/strict";
import test from "node:test";

import {
  ProductionAgentOutputError,
  validateProductionAgentOutput,
} from "../../src/agents/productionAgent/production-agent-output-contract";

const completePlan = [
  "# 分场汇总表",
  "| 场次 | 场景 | 人物 | 情绪基调 | 核心事件 |",
  "| 1-1 | 陆家厨房 | 沈云禾、小满 | 温暖转压抑 | 生日汤被倒 |",
  "## 逐场注意事项",
  "保持剧本事实，不新增人物。",
].join("\n");

test("真实回归：唯一完整 scriptPlan 后出现标签文字时提取完整产物", () => {
  const raw = [
    "## 第 3 步 · 一次性写出 `<scriptPlan>`",
    `<scriptPlan>${completePlan}</scriptPlan>`,
    "## 第 5 步 · 结束",
    "导演规划 `<scriptPlan>` 已完成，三场内容可交付下游。",
  ].join("\n\n");

  const result = validateProductionAgentOutput("directorPlan", raw, {
    finishReason: "stop",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.artifact.kind, "scriptPlan");
    assert.equal(result.artifact.content, completePlan);
    assert.match(result.memoryText, /分场汇总表/);
    assert.doesNotMatch(result.memoryText, /<scriptPlan>/);
  }
});

test("缺失、未闭合或仅完成摘要均不得成为导演规划", () => {
  for (const raw of [
    "导演规划已完成，可交付下游。",
    "<scriptPlan>尚未输出完",
    "导演规划 `<scriptPlan>` 已完成，可交付下游。",
  ]) {
    const result = validateProductionAgentOutput("directorPlan", raw, {
      finishReason: "stop",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "PRODUCTION_AGENT_OUTPUT_INCOMPLETE");
  }
});

test("空 scriptPlan 使用稳定 EMPTY_XML 错误码", () => {
  const result = validateProductionAgentOutput(
    "directorPlan",
    "<scriptPlan>   </scriptPlan>",
    { finishReason: "stop" },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "PRODUCTION_AGENT_OUTPUT_EMPTY_XML");
});

test("两个完整 scriptPlan 存在歧义，必须失败关闭", () => {
  const result = validateProductionAgentOutput(
    "directorPlan",
    "<scriptPlan>版本A</scriptPlan>\n<scriptPlan>版本B</scriptPlan>",
    { finishReason: "stop" },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "PRODUCTION_AGENT_OUTPUT_INCOMPLETE");
});

test("length/max-tokens 与 abort 不得提交已有闭合文本", () => {
  for (const finishReason of ["length", "max-tokens", "max_tokens"]) {
    const result = validateProductionAgentOutput(
      "directorPlan",
      `<scriptPlan>${completePlan}</scriptPlan>`,
      { finishReason },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "PRODUCTION_AGENT_OUTPUT_TRUNCATED");
  }

  const aborted = validateProductionAgentOutput(
    "directorPlan",
    `<scriptPlan>${completePlan}</scriptPlan>`,
    { finishReason: "stop", aborted: true },
  );
  assert.equal(aborted.ok, false);
  if (!aborted.ok) assert.equal(aborted.code, "PRODUCTION_AGENT_ABORTED");
});

test("ProductionAgentOutputError 只携带安全中文与稳定元数据", () => {
  const result = validateProductionAgentOutput("directorPlan", "x", {
    finishReason: "stop",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const error = new ProductionAgentOutputError(result);
    assert.equal(error.code, "PRODUCTION_AGENT_OUTPUT_INCOMPLETE");
    assert.equal(error.stage, "directorPlan");
    assert.match(error.message, /导演规划/);
    assert.doesNotMatch(error.message, /stack|Error|decryptString/i);
  }
});
