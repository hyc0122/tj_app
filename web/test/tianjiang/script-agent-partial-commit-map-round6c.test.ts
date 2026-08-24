/**
 * 第 6 轮最终 P0：部分提交前端映射与去重
 */
import { describe, expect, it } from "vitest";
import {
  mapScriptAgentOutputError,
  resolveScriptAgentErrorI18nKey,
  SCRIPT_AGENT_ERROR_I18N_KEYS,
} from "@/features/tianjiang/script-agent/output-errors";
import { shouldShowProductError } from "@/features/tianjiang/script-agent/product-error-dedupe";
import zhCN from "@/locales/language/zh-CN.json";
import zhTW from "@/locales/language/zh-TW.json";
import en from "@/locales/language/en.json";
import ja from "@/locales/language/ja_JP.json";
import ru from "@/locales/language/ru_RU.json";
import th from "@/locales/language/th_TH.json";
import vi from "@/locales/language/vi-VN.json";

const LOCALES = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  "ja-JP": ja,
  "ru-RU": ru,
  "th-TH": th,
  "vi-VN": vi,
} as const;

function getByPath(obj: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === "string" ? cur : undefined;
}

describe("partial-commit 映射与去重", () => {
  it("INCOMPLETE + 已保存文案不得映射为工作区未修改（历史错误复现修复）", () => {
    const m = mapScriptAgentOutputError({
      code: "SCRIPT_AGENT_OUTPUT_INCOMPLETE",
      message: "后续阶段未完成，已保存的产物仍保留，请查看工作区后重试",
    });
    expect(m).toMatch(/已保存|仍保留|保留/);
    expect(m).not.toMatch(/工作区未修改/);
  });

  it("PARTIAL_COMMIT 七语均不含工作区未修改", () => {
    const key = SCRIPT_AGENT_ERROR_I18N_KEYS.SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT;
    expect(key).toBe("workbench.scriptAgent.outputError.partialCommit");
    for (const [locale, messages] of Object.entries(LOCALES)) {
      const text = getByPath(messages as Record<string, unknown>, key);
      expect(text, `${locale} missing partialCommit`).toBeTruthy();
      expect(String(text)).not.toMatch(/工作区未修改|workspace unchanged|未修改/i);
    }
    const mapped = mapScriptAgentOutputError({ code: "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT" });
    expect(mapped).not.toMatch(/工作区未修改/);
    expect(mapped.length).toBeGreaterThan(4);
  });

  it("resolveScriptAgentErrorI18nKey PARTIAL_COMMIT", () => {
    expect(resolveScriptAgentErrorI18nKey("SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT")).toBe(
      "workbench.scriptAgent.outputError.partialCommit",
    );
  });

  it("产品错误去重按 messageId+errorCode，不跨消息压制", () => {
    const seen = new Map<string, number>();
    const t0 = 1_000_000;
    expect(shouldShowProductError(seen, "msg-sub", "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT", t0)).toBe(
      true,
    );
    // 同一 messageId+code 1500ms 内去重
    expect(
      shouldShowProductError(seen, "msg-sub", "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT", t0 + 500),
    ).toBe(false);
    // 父消息不同 messageId：必须展示（修复全局 1500ms 压掉父消息）
    expect(
      shouldShowProductError(seen, "msg-parent", "SCRIPT_AGENT_OUTPUT_PARTIAL_COMMIT", t0 + 500),
    ).toBe(true);
    // 同 messageId 不同 code：可展示
    expect(
      shouldShowProductError(seen, "msg-sub", "SCRIPT_AGENT_OUTPUT_TRUNCATED", t0 + 500),
    ).toBe(true);
  });
});
