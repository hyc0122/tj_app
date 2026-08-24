import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const forbiddenCopy = [
  "中央 API 已由应用安全固定",
  "请使用天将业务账号登录",
  "创建独立天将业务账号",
];

describe("登录视觉与文案契约", () => {
  it("背景仅为本地 CSS，支持 reduced-motion，登录高度使用标题栏变量", () => {
    const login = readFileSync(
      path.join(process.cwd(), "src/pages/login/index.vue"),
      "utf8",
    );
    const backdrop = readFileSync(
      path.join(process.cwd(), "src/components/auth/AuthAnimatedBackdrop.vue"),
      "utf8",
    );
    expect(login).toContain("AuthAnimatedBackdrop");
    expect(login).toContain("var(--app-titlebar-height)");
    expect(login).not.toMatch(/calc\(100vh\s*-\s*32px\)/);
    expect(login).toContain("navigateToProjectAfterAuth");
    expect(login).toMatch(/nav\.ok/);

    expect(backdrop).toMatch(/radial-gradient|linear-gradient/);
    expect(backdrop).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(backdrop).not.toMatch(/https?:\/\//i);
    expect(backdrop).not.toMatch(/<video|WebGL|canvas|fetch\(/i);
  });

  it("源码与全部 locale 删除三条指定提示与旧键", () => {
    const login = readFileSync(
      path.join(process.cwd(), "src/pages/login/index.vue"),
      "utf8",
    );
    for (const text of forbiddenCopy) {
      expect(login).not.toContain(text);
    }
    expect(login).not.toMatch(/login\.slogan|login\.tips|login\.registerSlogan/);

    const localeDir = path.join(process.cwd(), "src/locales/language");
    for (const file of readdirSync(localeDir).filter((name) => name.endsWith(".json"))) {
      const content = readFileSync(path.join(localeDir, file), "utf8");
      for (const text of forbiddenCopy) {
        expect(content, file).not.toContain(text);
      }
      // login 对象内不得保留旧键
      expect(content).not.toMatch(/"login"\s*:\s*\{[^}]*"slogan"\s*:/);
      expect(content).not.toMatch(/"registerSlogan"\s*:/);
      expect(content).not.toMatch(/"tips"\s*:\s*"中央|"tips"\s*:\s*"The central|"tips"\s*:\s*"アプリ|"tips"\s*:\s*"Адрес|"tips"\s*:\s*"แอป|"tips"\s*:\s*"API trung/);
    }
  });
});
