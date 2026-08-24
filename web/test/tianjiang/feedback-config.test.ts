import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workbenchPath = path.join(process.cwd(), "src/pages/workbench/index.vue");
const localeRoot = path.join(process.cwd(), "src/locales/language");
const locales = [
  "zh-CN.json",
  "zh-TW.json",
  "en.json",
  "ja_JP.json",
  "ru_RU.json",
  "th_TH.json",
  "vi-VN.json",
];

describe("反馈链接中央配置与主题", () => {
  const source = readFileSync(workbenchPath, "utf8");

  it("workbench 打开反馈不再内嵌硬编码 URL，改为配置解析", () => {
    // openFeedback 函数体不得再直接拼接 docs.qq；允许 PACKAGED_FEEDBACK_URL 常量作降级。
    const openFn = source.match(/async function openFeedback\(\)[\s\S]*?\n\}/);
    expect(openFn?.[0] ?? "").not.toMatch(/docs\.qq\.com/);
    expect(openFn?.[0] ?? "").toContain("resolveFeedbackUrl");
    expect(source).toContain("resolveFeedbackUrl");
    expect(source).toContain("/tianjiang/public/client-config");
    expect(source).toContain("PACKAGED_FEEDBACK_URL");
  });

  it("Electron 用系统浏览器协议，浏览器用 noopener/noreferrer", () => {
    expect(source).toContain("tianjiang://openurlwithbrowser?url=");
    expect(source).toContain('window.open(url, "_blank", "noopener,noreferrer")');
  });

  it("URL 无效时给出明确提示，不静默跳转", () => {
    expect(source).toContain("workbench.feedback.invalidUrl");
    expect(source).toContain("NotifyPlugin.warning");
  });

  it("左下角导航激活态使用品牌 token，禁止硬编码 #000/black", () => {
    // 禁止 footItem / 导航激活态重新硬编码纯黑
    expect(source).not.toMatch(/\.footItem[\s\S]*?\.active\s*\{[^}]*background(?:-color)?\s*:\s*#000\b/i);
    expect(source).not.toMatch(/\.footItem[\s\S]*?\.active\s*\{[^}]*background(?:-color)?\s*:\s*black\b/i);
    expect(source).toMatch(/\.footItem[\s\S]*?\.active\s*\{[^}]*--td-brand-color/);
    // 与设置按钮共用品牌激活态
    expect(source).toMatch(/\.active\s*\{[^}]*--td-brand-color/);
  });

  it("七种 locale 补齐反馈错误与说明文案", () => {
    for (const file of locales) {
      const data = JSON.parse(readFileSync(path.join(localeRoot, file), "utf8")) as {
        workbench?: { feedback?: Record<string, string> };
      };
      const fb = data.workbench?.feedback;
      expect(fb, file).toBeTruthy();
      expect(fb?.invalidUrl?.length ?? 0, file).toBeGreaterThan(0);
      expect(fb?.invalidUrlHint?.length ?? 0, file).toBeGreaterThan(0);
      expect(fb?.openFailed?.length ?? 0, file).toBeGreaterThan(0);
      expect(fb?.openFailedHint?.length ?? 0, file).toBeGreaterThan(0);
    }
  });
});
