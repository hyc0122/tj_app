/**
 * 第 6 轮：七语错误码运行时映射 + 安全回退
 */
import { describe, expect, it } from "vitest";
import {
  mapScriptAgentOutputError,
  resolveScriptAgentErrorI18nKey,
  SCRIPT_AGENT_ERROR_I18N_KEYS,
} from "@/features/tianjiang/script-agent/output-errors";
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

describe("七语 scriptAgent 输出错误 i18n", () => {
  const codes = Object.keys(SCRIPT_AGENT_ERROR_I18N_KEYS) as Array<
    keyof typeof SCRIPT_AGENT_ERROR_I18N_KEYS
  >;

  it("每个错误码在 7 语种均有非空文案", () => {
    for (const code of codes) {
      const key = SCRIPT_AGENT_ERROR_I18N_KEYS[code];
      for (const [locale, messages] of Object.entries(LOCALES)) {
        const text = getByPath(messages as Record<string, unknown>, key);
        expect(text, `${locale} missing ${key}`).toBeTruthy();
        expect(String(text).length).toBeGreaterThan(2);
        // 禁止英文堆栈/供应商痕迹
        expect(String(text)).not.toMatch(/Error while|stack|api[_-]?key|Bearer /i);
      }
    }
  });

  it("resolveScriptAgentErrorI18nKey 返回稳定 key", () => {
    expect(resolveScriptAgentErrorI18nKey("SCRIPT_AGENT_OUTPUT_TRUNCATED")).toBe(
      "workbench.scriptAgent.outputError.truncated",
    );
    expect(resolveScriptAgentErrorI18nKey("SCRIPT_AGENT_OUTPUT_INVALID_SCRIPT")).toBe(
      "workbench.scriptAgent.outputError.invalidScript",
    );
  });

  it("mapScriptAgentOutputError 优先 code，拒绝英文堆栈", () => {
    const m = mapScriptAgentOutputError({
      code: "SCRIPT_AGENT_OUTPUT_TRUNCATED",
      message: "Error while generating: at Object.stream (provider.js:1)",
    });
    expect(m).toMatch(/截断|token|上限|truncated|ตัด|ตัดทอน|обрез| cắt|截斷/i);
    expect(m).not.toMatch(/Error while|provider\.js/i);
  });

  it("未知 code + 英文消息回退安全默认", () => {
    const m = mapScriptAgentOutputError({
      code: "SOME_VENDOR_ERROR",
      message: "API key invalid at /home/user/secrets",
    });
    expect(m).not.toMatch(/API key|\/home\/|secrets/i);
    expect(m.length).toBeGreaterThan(4);
  });
});
