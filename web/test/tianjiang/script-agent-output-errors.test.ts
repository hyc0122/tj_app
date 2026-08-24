import { describe, expect, it } from "vitest";
import { mapScriptAgentOutputError } from "@/features/tianjiang/script-agent/output-errors";

describe("剧本 Agent 输出错误映射", () => {
  it("截断码映射中文", () => {
    expect(mapScriptAgentOutputError({ code: "SCRIPT_AGENT_OUTPUT_TRUNCATED" })).toMatch(/截断/);
  });
  it("不完整码映射中文且无英文堆栈", () => {
    const m = mapScriptAgentOutputError({ code: "SCRIPT_AGENT_OUTPUT_INCOMPLETE" });
    expect(m).toMatch(/工作区未修改/);
    expect(m).not.toMatch(/Error|stack|Now let me/i);
  });
  it("英文异常回退安全中文", () => {
    expect(
      mapScriptAgentOutputError({
        message: "Error while generating: at Object.stream",
      }),
    ).toMatch(/输出不完整|请重试/);
  });
  it("已有安全中文原样可用", () => {
    expect(
      mapScriptAgentOutputError({
        message: "执行层未生成完整改编策略，工作区未修改，请重试",
      }),
    ).toMatch(/改编策略/);
  });
});
