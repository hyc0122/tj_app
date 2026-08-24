import assert from "node:assert/strict";
import test from "node:test";

import {
  SCRIPT_AGENT_STAGE_TOOL_WHITELIST,
  ScriptAgentOutputError,
  stripXmlTags,
  validateScriptAgentOutput,
} from "../../src/agents/scriptAgent/script-agent-output-contract";

test("故事骨架：过渡英文且 finishReason=stop → INCOMPLETE", () => {
  const text = "Now let me also check the adaptation strategy and script data for any additional context:";
  const result = validateScriptAgentOutput("storySkeleton", text, { finishReason: "stop" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "SCRIPT_AGENT_OUTPUT_INCOMPLETE");
    assert.match(result.message, /故事骨架/);
    assert.doesNotMatch(result.message, /Now let me|Error|stack/i);
  }
});

test("故事骨架：未闭合 XML 且 finishReason=length → TRUNCATED", () => {
  const text = "<storySkeleton>部分骨架内容尚未写完";
  const result = validateScriptAgentOutput("storySkeleton", text, { finishReason: "length" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "SCRIPT_AGENT_OUTPUT_TRUNCATED");
    assert.match(result.message, /截断/);
  }
});

test("故事骨架：空 XML → EMPTY_XML", () => {
  const result = validateScriptAgentOutput("storySkeleton", "<storySkeleton>   </storySkeleton>", {
    finishReason: "stop",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "SCRIPT_AGENT_OUTPUT_EMPTY_XML");
});

test("故事骨架：完整非空 XML → 成功，memoryText 可去标签", () => {
  const body = "故事核：主角逆袭。\n三幕结构：...";
  const full = `阐述思路……\n<storySkeleton>${body}</storySkeleton>\n已完成。`;
  const result = validateScriptAgentOutput("storySkeleton", full, { finishReason: "stop" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.artifactPresent, true);
    assert.match(result.memoryText, /故事核/);
    assert.doesNotMatch(result.memoryText, /<storySkeleton>/);
  }
});

test("改编策略：必须完整 non-empty adaptationStrategy", () => {
  assert.equal(
    validateScriptAgentOutput("adaptationStrategy", "thinking only", { finishReason: "stop" }).ok,
    false,
  );
  const ok = validateScriptAgentOutput(
    "adaptationStrategy",
    "<adaptationStrategy>核心原则：快节奏</adaptationStrategy>",
    { finishReason: "stop" },
  );
  assert.equal(ok.ok, true);
});

test("剧本：至少一个完整 scriptItem；缺 name/空内容/未闭合/重复冲突失败", () => {
  assert.equal(
    validateScriptAgentOutput("script", "<scriptItem>无 name</scriptItem>", { finishReason: "stop" }).ok,
    false,
  );
  assert.equal(
    validateScriptAgentOutput("script", '<scriptItem name="EP01">  </scriptItem>', {
      finishReason: "stop",
    }).ok,
    false,
  );
  assert.equal(
    validateScriptAgentOutput("script", '<scriptItem name="EP01">未闭合', { finishReason: "stop" }).ok,
    false,
  );
  assert.equal(
    validateScriptAgentOutput(
      "script",
      '<scriptItem name="EP01">A</scriptItem><scriptItem name="EP01">B</scriptItem>',
      { finishReason: "stop" },
    ).ok,
    false,
  );
  const ok = validateScriptAgentOutput(
    "script",
    '<scriptItem name="作品 EP01：开篇">△内景 客厅\n主角：（起身）走。</scriptItem>',
    { finishReason: "stop" },
  );
  assert.equal(ok.ok, true);
});

test("abort 元数据 → SCRIPT_AGENT_ABORTED", () => {
  const result = validateScriptAgentOutput(
    "storySkeleton",
    "<storySkeleton>完整</storySkeleton>",
    { aborted: true, finishReason: "stop" },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "SCRIPT_AGENT_ABORTED");
});

test("阶段工具白名单：骨架不含 get_novel_text/get_script_content", () => {
  const list = SCRIPT_AGENT_STAGE_TOOL_WHITELIST.storySkeleton;
  assert.deepEqual([...list].sort(), ["get_novel_events", "get_planData"].sort());
  assert.ok(!list.includes("get_novel_text"));
  assert.ok(!list.includes("get_script_content"));
  const script = SCRIPT_AGENT_STAGE_TOOL_WHITELIST.script;
  assert.ok(script.includes("get_novel_text"));
  assert.ok(script.includes("get_script_content"));
});

test("stripXmlTags 不得用于验证前：验证在含标签原文上执行", () => {
  const raw = "Now let me also check...";
  const stripped = stripXmlTags(raw);
  // 过渡语去标签后仍非空，但契约仍失败
  assert.ok(stripped.length > 0);
  assert.equal(validateScriptAgentOutput("storySkeleton", raw, { finishReason: "stop" }).ok, false);
});

test("ScriptAgentOutputError 携带 code/stage，消息为安全中文", () => {
  const fail = validateScriptAgentOutput("storySkeleton", "x", { finishReason: "stop" });
  assert.equal(fail.ok, false);
  if (!fail.ok) {
    const err = new ScriptAgentOutputError(fail);
    assert.equal(err.code, "SCRIPT_AGENT_OUTPUT_INCOMPLETE");
    assert.equal(err.stage, "storySkeleton");
    assert.match(err.message, /故事骨架/);
  }
});
