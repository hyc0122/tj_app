import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("赛博朋克主题与侧栏视觉", () => {
  it("theme.ts 支持 cyberpunk 并在切回 light/dark 时清除残留", () => {
    const source = read("src/utils/theme.ts");
    expect(source).toContain('mode === "cyberpunk"');
    expect(source).toContain("clearCyberpunkDom");
    expect(source).toContain("resolveThemeBase");
    expect(source).toContain("resolveMdEditorTheme");
    expect(source).toContain("resolveMonacoTheme");
    expect(source).toContain("clearDynamicBrandVars");
    // 第三方仅 light/dark：cyberpunk 映射为 dark
    expect(source).toMatch(/cyberpunk[\s\S]*return "dark"/);
    expect(source).toContain('root.classList.add("cyberpunk")');
    expect(source).toContain('root.setAttribute("data-theme", "cyberpunk")');
    expect(source).toContain('root.classList.remove("cyberpunk")');
    expect(source).toContain('root.removeAttribute("data-theme")');
  });

  it("setting store 持久化支持 cyberpunk 模式", () => {
    const source = read("src/stores/setting.ts");
    expect(source).toContain('"cyberpunk"');
    expect(source).toContain('persist: { pick: ["otherSetting", "themeSetting", "language"] }');
  });

  it("界面设置提供四档主题含赛博朋克，并使用 i18n", () => {
    const source = read("src/components/setting/components/uiConfig.vue");
    expect(source).toContain('value="cyberpunk"');
    expect(source).toContain("settings.ui.modeCyberpunk");
    expect(source).toContain("settings.ui.colorMode");
    expect(source).toContain("clearDynamicBrandVars");
    expect(source).not.toMatch(/颜色模式/);
  });

  it("全局 SCSS 定义 cyberpunk token 与模块悬浮动效", () => {
    const source = read("src/assets/main.scss");
    expect(source).toContain(":root.cyberpunk");
    expect(source).toContain("--cyber-cyan");
    expect(source).toContain("--cyber-pink");
    expect(source).toContain("--cyber-purple");
    expect(source).toContain(".module-interactive");
    expect(source).toContain(".module-interactive--panel");
    expect(source).toContain("prefers-reduced-motion");
    expect(source).toContain("translateY(-2px) scale(1.02)");
    // 排除危险按钮与窗口控制；禁止裸 .t-popup 进入 transform:none 块
    expect(source).toContain(".t-button--theme-danger");
    expect(source).toContain(".titleBar-btn");
    expect(source).toContain("transform: none !important");
    expect(source).toMatch(/绝对不要把 \.t-popup|严禁对裸 \.t-popup/);
  });

  it("侧栏为图标+文字，窄屏折叠并保留 aria-label / tooltip", () => {
    const source = read("src/pages/workbench/index.vue");
    expect(source).toContain("menuCollapsed");
    expect(source).toContain("class=\"label\"");
    expect(source).toContain("aria-label");
    expect(source).toContain(":disabled=\"!menuCollapsed\"");
    expect(source).toContain("workbench.menu.team");
    expect(source).toContain("workbench.menu.navAria");
    expect(source).toContain("module-interactive");
    expect(source).toContain("focus-visible");
    expect(source).toMatch(/--menu-width:\s*168px/);
    expect(source).toMatch(/--menu-width:\s*64px/);
    // 激活态使用品牌 token，禁止硬编码黑底
    expect(source).toMatch(/\.active[\s\S]*--td-brand-color/);
    expect(source).not.toMatch(/\.footItem[\s\S]*?\.active\s*\{[^}]*#000\b/i);
  });

  it("Markdown/Monaco 主题映射不传入 cyberpunk 原值", () => {
    const samples = [
      "src/components/editMdPreivew.vue",
      "src/components/setting/components/promptManage.vue",
      "src/components/setting/components/modelMap.vue",
      "src/components/setting/components/devConfig.vue",
      "src/components/setting/components/vendorConfig/components/VendorImportDialogs.vue",
    ];
    for (const rel of samples) {
      const source = read(rel);
      expect(source).not.toMatch(/:theme="themeSetting\.mode"/);
      expect(source).not.toMatch(/theme="cyberpunk"/);
      expect(
        source.includes("resolveMdEditorTheme") ||
          source.includes("resolveMdEditorThemeStrict") ||
          source.includes("resolveMonacoTheme") ||
          source.includes("monacoTheme"),
      ).toBe(true);
    }
  });

  it("七语 i18n 含菜单 team 与 settings.ui 赛博键", () => {
    const locales = ["zh-CN", "en", "zh-TW", "ja_JP", "ru_RU", "th_TH", "vi-VN"];
    for (const loc of locales) {
      const data = JSON.parse(read(`src/locales/language/${loc}.json`));
      expect(data.workbench.menu.team).toBeTruthy();
      expect(data.workbench.menu.navAria).toBeTruthy();
      expect(data.settings.ui.modeCyberpunk).toBeTruthy();
      expect(data.settings.ui.colorMode).toBeTruthy();
      expect(data.settings.ui.modeAuto).toBeTruthy();
      expect(data.settings.ui.modeLight).toBeTruthy();
      expect(data.settings.ui.modeDark).toBeTruthy();
    }
  });
});
