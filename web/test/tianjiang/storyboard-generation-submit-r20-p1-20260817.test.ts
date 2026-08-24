// @vitest-environment jsdom
/**
 * R20 RED：Web 只展示普通供应商分阶白名单文案，未知错误仍兜底。
 */
import { describe, expect, it } from "vitest";
import { readSafeGenerationSubmitError } from "@/views/storyboardProject/storyboard-generation-preview";

describe("R20 普通供应商分阶提交错误白名单", () => {
  it("prepare/stage/execute 必须映射固定安全文案，未知错误不得回显秘密", () => {
    expect(readSafeGenerationSubmitError(
      { code: "VENDOR_PREPARE_FAILED", message: "当前视频模型配置或请求参数不可用" },
      "提交生成失败，请重试",
    )).toBe("当前视频模型配置或请求参数不可用");
    expect(readSafeGenerationSubmitError(
      { code: "VENDOR_MEDIA_STAGING_FAILED", message: "参考素材暂存失败，请检查网络或稍后重试" },
      "提交生成失败，请重试",
    )).toBe("参考素材暂存失败，请检查网络或稍后重试");
    expect(readSafeGenerationSubmitError(
      { code: "VENDOR_GENERATION_FAILED", message: "普通供应商生成失败，请检查模型配置或稍后重试" },
      "提交生成失败，请重试",
    )).toBe("普通供应商生成失败，请检查模型配置或稍后重试");
    expect(readSafeGenerationSubmitError(
      { code: "VENDOR_UNKNOWN_TRACE", message: "ENOENT C:\\Users\\alice\\secret.sqlite sk-secret" },
      "提交生成失败，请重试",
    )).toBe("提交生成失败，请重试");
  });
});
