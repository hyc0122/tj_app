// @vitest-environment jsdom
/**
 * R22-fix2 RED：即梦四态必须分码；路径已解析但 CLI 失败不得显示未安装。
 */
import { describe, expect, it } from "vitest";
import { readSafeGenerationSubmitError } from "@/views/storyboardProject/storyboard-generation-preview";

describe("R22-fix2 即梦四态分码", () => {
  it("未安装、未登录、不可用、模式不支持必须是四条稳定文案", () => {
    expect(readSafeGenerationSubmitError(
      { code: "DREAMINA_CLI_NOT_INSTALLED", message: "未安装即梦 CLI 或无法执行" },
      "提交生成失败，请重试",
    )).toBe("未安装即梦 CLI 或无法执行");
    expect(readSafeGenerationSubmitError(
      { code: "DREAMINA_CLI_NOT_LOGGED_IN", message: "未登录即梦账号" },
      "提交生成失败，请重试",
    )).toBe("未登录即梦账号");
    expect(readSafeGenerationSubmitError(
      { code: "STORYBOARD_DREAMINA_CLI_UNAVAILABLE", message: "即梦 CLI 不可用" },
      "提交生成失败，请重试",
    )).toBe("即梦 CLI 不可用");
    expect(readSafeGenerationSubmitError(
      { code: "STORYBOARD_DREAMINA_MODE_UNSUPPORTED", message: "当前即梦 CLI 不支持 multimodal2video" },
      "提交生成失败，请重试",
    )).toBe("当前即梦 CLI 不支持 multimodal2video");
  });

  it("CLI 不可用不得回退成未安装，也不得回显路径或 SQL", () => {
    expect(readSafeGenerationSubmitError(
      { code: "STORYBOARD_DREAMINA_CLI_UNAVAILABLE", message: "未安装即梦 CLI 或无法执行" },
      "提交生成失败，请重试",
    )).toBe("即梦 CLI 不可用");
    expect(readSafeGenerationSubmitError(
      { code: "RAW", message: "E:\\\\app\\\\dreamina.exe SELECT cookie" },
      "提交生成失败，请重试",
    )).toBe("提交生成失败，请重试");
  });
});
