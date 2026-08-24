// @vitest-environment jsdom
import path from "node:path";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { compile } from "sass";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "vue-i18n";
import zhCN from "@/locales/language/zh-CN.json";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const axiosPatch = vi.fn();
const axiosPut = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    patch: (...args: unknown[]) => axiosPatch(...args),
    put: (...args: unknown[]) => axiosPut(...args),
  },
}));

import projectStore from "@/stores/project";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";

const root = process.cwd();
const mainCss = compile(path.join(root, "src/assets/main.scss"), { style: "expanded" }).css;
const storyboardCss = compile(path.join(root, "src/views/storyboardProject/styles/storyboard-workspace.scss"), {
  style: "expanded",
}).css;

const projectUuid = "77777777-7777-4777-a777-777777777777";
const shotUuid = "77777777-7777-4777-a777-777777777701";

const shot = {
  shotUuid,
  displayOrder: 1,
  sourceText: "雨夜，林夏走进旧剧院。",
  visualDescription: "霓虹倒映在积水中，镜头跟随人物前进。",
  imagePrompt: "电影感雨夜，统一人物造型",
  videoPrompt: "镜头缓慢跟随，动作自然",
  negativePrompt: "模糊，低清",
  shotSize: "全景",
  cameraMovement: "跟拍",
  composition: "中心构图",
  durationMs: 5000,
  aspectRatio: "9:16",
  bindings: [],
};

interface CssMediaRuleLike extends CSSRule {
  conditionText: string;
  cssRules: CSSRuleList;
}

function injectStyle(id: string, css: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.dataset.testStyle = id;
  style.textContent = css;
  document.head.append(style);
  return style;
}

function isStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return "selectorText" in rule && "style" in rule;
}

function isMediaRule(rule: CSSRule): rule is CssMediaRuleLike {
  return "conditionText" in rule && "cssRules" in rule;
}

function baselineStyleRules(style: HTMLStyleElement): CSSStyleRule[] {
  // 表面主题只检查无媒体条件下实际适用的基线规则，不能让其他视口规则替当前视口兜底。
  return Array.from(style.sheet?.cssRules ?? []).filter(isStyleRule);
}

function selectorMatchesElement(selector: string, element: Element): boolean {
  // 只匹配常态选择器；hover/focus 由独立 CSSOM 合同检查，避免伪造浏览器状态。
  if (selector.includes(":hover") || selector.includes(":focus") || selector.includes("::")) return false;
  try {
    return element.matches(selector.trim());
  } catch {
    return false;
  }
}

type VisualPropertyGroup = "background" | "border" | "color" | "shadow";

function visualDeclarationsForElement(element: Element, rules: CSSStyleRule[]): Record<VisualPropertyGroup, string> {
  const values: Record<VisualPropertyGroup, string[]> = {
    background: [],
    border: [],
    color: [],
    shadow: [],
  };
  for (const rule of rules) {
    if (!rule.selectorText.split(",").some((selector) => selectorMatchesElement(selector, element))) continue;
    for (const property of Array.from(rule.style)) {
      const value = rule.style.getPropertyValue(property).trim();
      if (!value) continue;
      if (property === "background" || property === "background-color") {
        values.background.push(`${property}: ${value}`);
      } else if (property.startsWith("border")) {
        values.border.push(`${property}: ${value}`);
      } else if (property === "color") {
        values.color.push(`${property}: ${value}`);
      } else if (property === "box-shadow") {
        values.shadow.push(`${property}: ${value}`);
      }
    }
  }
  return {
    background: values.background.join("\n"),
    border: values.border.join("\n"),
    color: values.color.join("\n"),
    shadow: values.shadow.join("\n"),
  };
}

function propertyDeclarationsForSelector(
  selector: string,
  property: string,
  style: HTMLStyleElement,
): string {
  return baselineStyleRules(style)
    .filter((rule) => rule.selectorText.split(",").some((candidate) => candidate.trim() === selector))
    .map((rule) => rule.style.getPropertyValue(property).trim())
    .filter(Boolean)
    .join("\n");
}

function focusVisibleDeclarations(element: Element, styles: HTMLStyleElement[]): string {
  const values: string[] = [];
  // 键盘焦点同样只接受当前无条件可用的规则，不能被其他视口或 reduced-motion 分支误兜底。
  for (const rule of styles.flatMap(baselineStyleRules)) {
    for (const selector of rule.selectorText.split(",")) {
      if (!selector.includes(":focus-visible")) continue;
      const restingSelector = selector.replaceAll(":focus-visible", "").trim();
      try {
        if (!element.matches(restingSelector)) continue;
      } catch {
        continue;
      }
      for (const property of ["outline", "box-shadow"] as const) {
        const value = rule.style.getPropertyValue(property).trim();
        if (value) values.push(`${property}: ${value}`);
      }
    }
  }
  return values.join("\n");
}

function cssLengthToPx(value: string): number | undefined {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(px|rem|em)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return match[2].toLowerCase() === "px" ? amount : amount * 16;
}

interface WidthBounds {
  min?: number;
  minInclusive?: boolean;
  max?: number;
  maxInclusive?: boolean;
}

function mediaWidthBounds(conditionText: string): WidthBounds {
  const bounds: WidthBounds = {};
  const length = "(-?\\d+(?:\\.\\d+)?(?:px|rem|em))";

  const maxColon = conditionText.match(new RegExp(`max-width\\s*:\\s*${length}`, "i"));
  const minColon = conditionText.match(new RegExp(`min-width\\s*:\\s*${length}`, "i"));
  if (maxColon) {
    bounds.max = cssLengthToPx(maxColon[1]);
    bounds.maxInclusive = true;
  }
  if (minColon) {
    bounds.min = cssLengthToPx(minColon[1]);
    bounds.minInclusive = true;
  }

  for (const match of conditionText.matchAll(new RegExp(`width\\s*(<=|<|>=|>)\\s*${length}`, "gi"))) {
    const value = cssLengthToPx(match[2]);
    if (value === undefined) continue;
    if (match[1] === "<" || match[1] === "<=") {
      bounds.max = value;
      bounds.maxInclusive = match[1] === "<=";
    } else {
      bounds.min = value;
      bounds.minInclusive = match[1] === ">=";
    }
  }

  for (const match of conditionText.matchAll(new RegExp(`${length}\\s*(<=|<|>=|>)\\s*width`, "gi"))) {
    const value = cssLengthToPx(match[1]);
    if (value === undefined) continue;
    if (match[2] === ">" || match[2] === ">=") {
      bounds.max = value;
      bounds.maxInclusive = match[2] === ">=";
    } else {
      bounds.min = value;
      bounds.minInclusive = match[2] === "<=";
    }
  }
  return bounds;
}

function mediaAppliesAtWidth(conditionText: string, width: number): boolean {
  const bounds = mediaWidthBounds(conditionText);
  if (bounds.min !== undefined) {
    if (bounds.minInclusive ? width < bounds.min : width <= bounds.min) return false;
  }
  if (bounds.max !== undefined) {
    if (bounds.maxInclusive ? width > bounds.max : width >= bounds.max) return false;
  }
  return true;
}

function selectorHas(rule: CSSStyleRule, selector: string): boolean {
  return rule.selectorText.split(",").some((candidate) => candidate.trim() === selector);
}

function effectivePropertyAtWidth(
  style: HTMLStyleElement,
  selector: string,
  property: string,
  width: number,
): string {
  let value = "";
  for (const rule of Array.from(style.sheet?.cssRules ?? [])) {
    if (isStyleRule(rule) && selectorHas(rule, selector)) {
      value = rule.style.getPropertyValue(property).trim() || value;
      continue;
    }
    if (!isMediaRule(rule) || !mediaAppliesAtWidth(rule.conditionText, width)) continue;
    for (const nested of Array.from(rule.cssRules).filter(isStyleRule)) {
      if (selectorHas(nested, selector)) value = nested.style.getPropertyValue(property).trim() || value;
    }
  }
  return value;
}

function splitGridTracks(value: string): string[] {
  const tracks: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    if (value[index] === ")") depth -= 1;
    if (/\s/.test(value[index]) && depth === 0) {
      const track = value.slice(start, index).trim();
      if (track) tracks.push(track);
      start = index + 1;
    }
  }
  const finalTrack = value.slice(start).trim();
  if (finalTrack) tracks.push(finalTrack);
  return tracks;
}

function trackMinimumPx(track: string): number | undefined {
  const minmax = track.match(/^minmax\(\s*(-?\d+(?:\.\d+)?(?:px|rem|em))\s*,/i);
  if (minmax) return cssLengthToPx(minmax[1]);
  return cssLengthToPx(track);
}

function applyTheme(theme: "light" | "dark" | "cyberpunk") {
  const html = document.documentElement;
  html.className = theme === "light" ? "" : theme;
  html.removeAttribute("theme-mode");
  html.removeAttribute("data-theme");
  if (theme === "light" || theme === "dark") html.setAttribute("theme-mode", theme);
  if (theme === "cyberpunk") html.setAttribute("data-theme", "cyberpunk");
}

function themeSnapshot() {
  const style = getComputedStyle(document.documentElement);
  return {
    productPage: style.getPropertyValue("--product-page").trim(),
    productSurface: style.getPropertyValue("--product-surface").trim(),
    productText: style.getPropertyValue("--product-text").trim(),
    productFocus: style.getPropertyValue("--product-focus-ring").trim(),
    pageValue: style.getPropertyValue("--td-bg-color-page").trim(),
    surfaceValue: style.getPropertyValue("--td-bg-color-container").trim(),
    textValue: style.getPropertyValue("--td-text-color-primary").trim(),
    focusValue: style.getPropertyValue("--td-brand-color-focus").trim(),
  };
}

function mountWorkspace(): VueWrapper {
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
  (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(i18n.global.t(key));
  const pinia = createPinia();
  setActivePinia(pinia);
  // 使用生产入口同时激活项目与访问权，避免旧夹具只写 project 导致 canWrite 仍停在只读。
  projectStore().activateProject(
    {
      id: "777",
      projectUuid,
      name: "雨夜剧场",
      describe: "分镜响应式主题验收夹具",
      projectType: "storyboard",
      myRole: "owner",
      openMode: "readwrite",
    } as never,
    {
      projectUuid,
      mode: "readwrite",
      reason: "",
      lockHolder: "",
    },
  );

  return mount(StoryboardWorkspace, {
    attachTo: document.body,
    global: {
      plugins: [pinia, i18n],
      stubs: {
        TButton: {
          inheritAttrs: true,
          props: ["loading", "disabled"],
          template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
        },
        TIcon: { template: "<i />" },
        TTag: { template: "<span><slot /></span>" },
        TCard: { inheritAttrs: true, template: "<section v-bind=\"$attrs\"><slot name=\"title\" /><slot /></section>" },
        TForm: { template: "<form><slot /></form>" },
        TFormItem: { template: "<div><slot /></div>" },
        TEmpty: { template: "<div>empty</div>" },
        TLoading: { template: "<div><slot /></div>" },
        TSelect: { template: "<select><slot /></select>" },
        TTextarea: { inheritAttrs: true, template: "<textarea v-bind=\"$attrs\" />" },
        TCheckbox: { template: "<input type=\"checkbox\" />" },
        TCheckboxGroup: { template: "<div><slot /></div>" },
        TImage: { template: "<img />" },
        TImageViewer: { template: "<div><slot name=\"trigger\" :open=\"() => {}\" /></div>" },
        TPopup: { template: "<div><slot /></div>" },
        modelSelect: { template: "<div />" },
        ImageTools: { template: "<div />" },
        "i-plus": { template: "<i />" },
      },
    },
  });
}

beforeEach(() => {
  axiosGet.mockReset();
  axiosPost.mockReset();
  axiosPatch.mockReset();
  axiosPut.mockReset();
  axiosGet.mockImplementation((url: string) => {
    if (url.endsWith("/shots")) return Promise.resolve({ data: { data: [shot] } });
    if (url.endsWith("/assets")) {
      return Promise.resolve({
        data: {
          assets: [{ assetUuid: "role-1", name: "林夏", assetType: "role", description: "主要角色" }],
        },
      });
    }
    if (url.endsWith("/settings")) {
      return Promise.resolve({
        data: { data: { aspectRatio: "9:16", defaultDurationMs: 5000, globalImagePrompt: "", globalVideoPrompt: "" } },
      });
    }
    return Promise.resolve({ data: { data: {} } });
  });
  axiosPost.mockImplementation((url: string) => {
    if (String(url).includes("/cornerScape/getAllAssets")) {
      return Promise.resolve({
        data: [{
          id: 1,
          imageId: 0,
          type: "role",
          name: "林夏",
          prompt: "portrait",
          filePath: null,
          state: "",
          model: "",
          resolution: "",
          describe: "女主",
          promptState: "",
          historyImages: [],
          errorReason: "",
          promptErrorReason: "",
          relepedAudio: [],
          audioBindState: "",
        }],
      });
    }
    return Promise.resolve({ data: { data: {} } });
  });
  axiosPatch.mockResolvedValue({ data: { data: shot } });
  axiosPut.mockResolvedValue({ data: { data: {} } });

  injectStyle("product-theme", mainCss);
  injectStyle("storyboard-workspace", storyboardCss);
  applyTheme("light");
});

afterEach(() => {
  document.querySelectorAll("style[data-test-style]").forEach((style) => style.remove());
  document.documentElement.className = "";
  document.documentElement.removeAttribute("theme-mode");
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = "";
});

describe("Round27 分镜工作台响应式产品主题", () => {
  it("真实页面、工具栏、列表、详情、资产与设置表面只消费全局 product 语义", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();

    const storyboardStyle = document.querySelector<HTMLStyleElement>('style[data-test-style="storyboard-workspace"]');
    expect(storyboardStyle).not.toBeNull();
    const rules = baselineStyleRules(storyboardStyle!);

    const surfaces: Array<[string, Element, Partial<Record<VisualPropertyGroup, string>>]> = [
      ["工作台根", wrapper.get(".storyboard-workspace").element, {
        background: "--product-page",
        color: "--product-text",
      }],
      ["生产工具栏", wrapper.get(".storyboardToolbar").element, {
        background: "--product-surface-soft",
        border: "--product-border",
      }],
      ["分镜列表", wrapper.get(".storyboardShotList").element, {
        background: "--product-surface-soft",
        border: "--product-border",
      }],
      ["分镜详情", wrapper.get(".storyboardDetail").element, {
        background: "--product-surface",
        border: "--product-border",
      }],
    ];

    await wrapper.get('[data-module="assets"]').trigger("click");
    await flushPromises();
    surfaces.push([
      "资产面板",
      wrapper.get('[data-panel="corner-scape-assets"]').element,
      { background: "--product-surface", border: "--product-border" },
    ]);

    await wrapper.get('[data-module="settings"]').trigger("click");
    await flushPromises();
    surfaces.push([
      "设置面板",
      wrapper.get('[data-panel="storyboard-settings"]').element,
      { background: "--product-surface", border: "--product-border" },
    ]);

    // 使用 Sass 编译后的 CSSOM 和真实 DOM 选择器匹配，不以源码字符串替代运行时合同。
    for (const [label, element, expectedTokens] of surfaces) {
      const declarations = visualDeclarationsForElement(element, rules);
      for (const [propertyGroup, token] of Object.entries(expectedTokens) as Array<[VisualPropertyGroup, string]>) {
        expect.soft(declarations[propertyGroup], `${label} 未命中基线 ${propertyGroup} 视觉属性`).not.toBe("");
        expect.soft(
          declarations[propertyGroup],
          `${label} 的 ${propertyGroup} 属性必须直接消费 ${token}，不得由其他属性错位代替`,
        ).toContain(`var(${token})`);
      }
    }

    expect.soft(storyboardCss, "分镜样式不得继续编译出页面私有 --sb-* 主题变量").not.toMatch(/--sb-[\w-]+/);
    wrapper.unmount();
  });

  it("真实可交互模块复用统一 hover 类，键盘焦点使用 product 焦点环", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();

    const storyboardStyle = document.querySelector<HTMLStyleElement>('style[data-test-style="storyboard-workspace"]');
    const productStyle = document.querySelector<HTMLStyleElement>('style[data-test-style="product-theme"]');
    expect(storyboardStyle).not.toBeNull();
    expect(productStyle).not.toBeNull();
    const focusStyles = [productStyle!, storyboardStyle!];

    const shotPanel = wrapper.get(".storyboardModulePanel");
    const moduleButtons = ["shots", "assets", "settings"].map((module) => wrapper.get(`[data-module="${module}"]`));
    const searchInput = wrapper.get<HTMLInputElement>(".storyboardSearch input");
    expect.soft(shotPanel.classes(), "包含表格和详情表单的页面容器不得整体缩放")
      .not.toContain("module-interactive--panel");
    for (const moduleButton of moduleButtons) {
      expect.soft(moduleButton.classes(), "分镜、资产与设置入口必须复用小模块 hover").toContain("module-interactive--sm");
      const button = moduleButton.element as HTMLButtonElement;
      expect.soft(button.tagName).toBe("BUTTON");
      expect.soft(button.disabled).toBe(false);
      expect.soft(button.tabIndex).toBeGreaterThanOrEqual(0);
      button.focus();
      expect.soft(document.activeElement).toBe(button);
      expect.soft(
        focusVisibleDeclarations(button, focusStyles),
        `${moduleButton.attributes("data-module")} 入口的实际 focus-visible 规则必须消费 product 焦点环`,
      ).toContain("--product-focus-ring");
    }

    searchInput.element.focus();
    expect(document.activeElement).toBe(searchInput.element);
    expect.soft(
      propertyDeclarationsForSelector(".storyboardSearch:focus-within", "box-shadow", storyboardStyle!),
      "真实搜索框 focus-within 的 box-shadow 必须直接消费 product 焦点环",
    ).toContain("--product-focus-ring");

    const shotActionButtons = ["refresh-shots", "insert-first", "insert-after", "save-shot"]
      .map((action) => wrapper.get<HTMLButtonElement>(`[data-action="${action}"]`));
    for (const actionButton of shotActionButtons) {
      actionButton.element.focus();
      expect.soft(document.activeElement).toBe(actionButton.element);
      expect.soft(
        focusVisibleDeclarations(actionButton.element, focusStyles),
        `${actionButton.attributes("data-action")} 必须直接消费 product 焦点环`,
      ).toContain("--product-focus-ring");
    }

    await wrapper.get('[data-module="assets"]').trigger("click");
    await flushPromises();
    const assetPanel = wrapper.get('[data-panel="corner-scape-assets"]');
    const assetCard = wrapper.get('[data-workspace="corner-scape"] .module-interactive');
    const assetButtons = [assetPanel.get<HTMLButtonElement>('[data-action="create-asset"]')];
    expect.soft(assetPanel.classes(), "资产页容器不得夺走资产卡自身 hover")
      .not.toContain("module-interactive--panel");
    expect.soft(assetCard.classes(), "塑角造景资产卡必须复用统一小卡 hover").toContain("module-interactive");
    for (const assetButton of assetButtons) {
      expect.soft(assetButton.element.disabled).toBe(false);
      expect.soft(assetButton.element.tabIndex).toBeGreaterThanOrEqual(0);
      assetButton.element.focus();
      expect.soft(document.activeElement).toBe(assetButton.element);
      expect.soft(
        focusVisibleDeclarations(assetButton.element, focusStyles),
        "资产操作按钮的实际 focus-visible 规则必须消费 product 焦点环",
      ).toContain("--product-focus-ring");
    }

    await wrapper.get('[data-module="settings"]').trigger("click");
    await flushPromises();
    const settingsPanel = wrapper.get('[data-panel="storyboard-settings"]');
    expect.soft(settingsPanel.classes(), "包含表单的设置容器不得整体缩放")
      .not.toContain("module-interactive--panel");
    const settingsSave = settingsPanel.get<HTMLButtonElement>('[data-action="save-storyboard-settings"]');
    expect.soft(settingsSave.element.disabled).toBe(false);
    expect.soft(settingsSave.element.tabIndex).toBeGreaterThanOrEqual(0);
    settingsSave.element.focus();
    expect.soft(document.activeElement).toBe(settingsSave.element);
    expect.soft(
      focusVisibleDeclarations(settingsSave.element, focusStyles),
      "设置保存按钮的实际 focus-visible 规则必须消费 product 焦点环",
    ).toContain("--product-focus-ring");
    wrapper.unmount();
  });

  it("错误重试与空态插入按钮也提供可见键盘焦点", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();

    const storyboardStyle = document.querySelector<HTMLStyleElement>('style[data-test-style="storyboard-workspace"]');
    const productStyle = document.querySelector<HTMLStyleElement>('style[data-test-style="product-theme"]');
    expect(storyboardStyle).not.toBeNull();
    expect(productStyle).not.toBeNull();
    const focusStyles = [productStyle!, storyboardStyle!];

    axiosGet.mockRejectedValueOnce(new Error("分镜刷新失败"));
    await wrapper.get('[data-action="refresh-shots"]').trigger("click");
    await flushPromises();
    const retryButton = wrapper.get<HTMLButtonElement>(".storyboardFeedback button");
    retryButton.element.focus();
    expect(document.activeElement).toBe(retryButton.element);
    expect(focusVisibleDeclarations(retryButton.element, focusStyles)).toContain("--product-focus-ring");

    axiosGet.mockResolvedValueOnce({ data: { data: [] } });
    await retryButton.trigger("click");
    await flushPromises();
    const emptyInsertButton = wrapper.get<HTMLButtonElement>(".shotListEmpty button");
    emptyInsertButton.element.focus();
    expect(document.activeElement).toBe(emptyInsertButton.element);
    expect(focusVisibleDeclarations(emptyInsertButton.element, focusStyles)).toContain("--product-focus-ring");
    wrapper.unmount();
  });

  it("light、dark、cyberpunk 的真实 product 映射在运行时保持可读差异", () => {
    const snapshots = (["light", "dark", "cyberpunk"] as const).map((theme) => {
      applyTheme(theme);
      return [theme, themeSnapshot()] as const;
    });

    for (const [, snapshot] of snapshots) {
      expect(snapshot.productPage).toBe("var(--td-bg-color-page)");
      expect(snapshot.productSurface).toBe("var(--td-bg-color-container)");
      expect(snapshot.productText).toBe("var(--td-text-color-primary)");
      expect(snapshot.productFocus).not.toBe("");
      expect(snapshot.pageValue).not.toBe("");
      expect(snapshot.surfaceValue).not.toBe("");
      expect(snapshot.textValue).not.toBe("");
      expect(snapshot.focusValue).not.toBe("");
    }

    const [, light] = snapshots[0];
    const [, dark] = snapshots[1];
    const [, cyberpunk] = snapshots[2];
    expect(dark.pageValue).not.toBe(light.pageValue);
    expect(dark.surfaceValue).not.toBe(light.surfaceValue);
    expect(dark.textValue).not.toBe(light.textValue);
    expect(cyberpunk.pageValue).not.toBe(dark.pageValue);
    expect(cyberpunk.surfaceValue).not.toBe(dark.surfaceValue);
    expect(cyberpunk.focusValue).not.toBe(dark.focusValue);
  });

  it("CSSOM 按真实工作台内容宽度提供 1920 双栏和 1366 单栏降级", () => {
    const storyboardStyle = document.querySelector<HTMLStyleElement>('style[data-test-style="storyboard-workspace"]');
    expect(storyboardStyle).not.toBeNull();
    const topLevelRules = Array.from(storyboardStyle!.sheet?.cssRules ?? []);

    const desktopColumns = effectivePropertyAtWidth(
      storyboardStyle!,
      ".storyboardSplit",
      "grid-template-columns",
      1920,
    );
    const desktopTracks = splitGridTracks(desktopColumns);
    const listMinimum = trackMinimumPx(desktopTracks[0] ?? "") ?? Number.NaN;
    const detailMinimum = trackMinimumPx(desktopTracks[1] ?? "") ?? Number.NaN;
    expect.soft(desktopTracks, "1920 视口的宽内容区必须保持列表与详情两个网格轨道").toHaveLength(2);
    expect.soft(listMinimum, "1920 视口下生产列表最小宽度应约为 760px")
      .toBeGreaterThanOrEqual(740);
    expect.soft(listMinimum, "1920 视口下生产列表最小宽度不得挤占详情空间")
      .toBeLessThanOrEqual(800);
    expect.soft(detailMinimum, "1920 视口下详情最小宽度应约为 360px")
      .toBeGreaterThanOrEqual(340);
    expect.soft(detailMinimum, "1920 视口下详情最小宽度不应超过紧凑布局上限")
      .toBeLessThanOrEqual(400);

    const narrowMedia = topLevelRules
      .filter(isMediaRule)
      .find((rule) => {
        const columns = Array.from(rule.cssRules)
          .filter(isStyleRule)
          .find((nested) => selectorHas(nested, ".storyboardSplit"))
          ?.style.getPropertyValue("grid-template-columns")
          .trim() ?? "";
        const upperBound = mediaWidthBounds(rule.conditionText).max;
        return splitGridTracks(columns).length === 1
          && upperBound !== undefined
          && upperBound >= 1449
          && upperBound <= 1450;
      });
    const narrowColumns = narrowMedia
      ? Array.from(narrowMedia.cssRules)
        .filter(isStyleRule)
        .find((rule) => selectorHas(rule, ".storyboardSplit"))
        ?.style.getPropertyValue("grid-template-columns")
        .trim() ?? ""
      : "";
    expect.soft(narrowMedia?.conditionText ?? "", "单栏断点必须覆盖 1366 外壳中的真实窄内容区").not.toBe("");
    expect.soft(splitGridTracks(narrowColumns), "低于实测安全阈值时分镜列表与详情必须收敛为一个轨道")
      .toHaveLength(1);
  });

  it("子页继承工作台可用高度且 1366/360 不产生横向裁剪", () => {
    const storyboardStyle = document.querySelector<HTMLStyleElement>('style[data-test-style="storyboard-workspace"]');
    expect(storyboardStyle).not.toBeNull();

    const shotWorkspaceSelector = ".storyboard-workspace:has(> .storyboardModulePanel--shots)";
    const wideWorkspaceHeight = effectivePropertyAtWidth(storyboardStyle!, shotWorkspaceSelector, "height", 1920);
    const wideWorkspaceMaxHeight = effectivePropertyAtWidth(storyboardStyle!, shotWorkspaceSelector, "max-height", 1920);
    const desktopWorkspaceHeight = effectivePropertyAtWidth(storyboardStyle!, shotWorkspaceSelector, "height", 1366);
    const desktopWorkspaceOverflow = effectivePropertyAtWidth(storyboardStyle!, shotWorkspaceSelector, "overflow-y", 1366);
    const desktopColumns = effectivePropertyAtWidth(storyboardStyle!, ".storyboardSplit", "grid-template-columns", 1366);
    const desktopSplitHeight = effectivePropertyAtWidth(storyboardStyle!, ".storyboardSplit", "height", 1366);

    expect.soft(wideWorkspaceHeight, "宽屏子页高度必须继承父工作台，不得再次使用视口高度").toBe("100%");
    expect.soft(wideWorkspaceMaxHeight, "宽屏子页不得越过父工作台可用高度").toBe("100%");
    expect.soft(desktopWorkspaceHeight, "1366 单栏子页同样必须继承父工作台高度").toBe("100%");
    expect.soft(desktopWorkspaceOverflow, "1366 单栏主操作应通过子页纵向滚动保持可达").toBe("auto");
    expect.soft(splitGridTracks(desktopColumns), "1366 外壳内容区不足 1120px 时不得保留双栏").toHaveLength(1);
    expect.soft(desktopSplitHeight, "单栏主区应按内容高度展开并由子页承载滚动").toBe("auto");

    const narrowColumns = effectivePropertyAtWidth(storyboardStyle!, ".storyboardSplit", "grid-template-columns", 360);
    const pageOverflow = effectivePropertyAtWidth(storyboardStyle!, ".storyboard-workspace", "overflow-x", 360);
    const legacyTableMinWidth = effectivePropertyAtWidth(storyboardStyle!, ".shotTableScroll table", "min-width", 360);
    expect.soft(splitGridTracks(narrowColumns), "360px 视口仍必须保持单栏").toHaveLength(1);
    expect.soft(pageOverflow, "窄屏工作台必须在页面边界截断横向溢出").toMatch(/^(?:clip|hidden)$/);
    expect.soft(cssLengthToPx(legacyTableMinWidth) ?? 0, "旧表格兜底不得强制 760px 撑宽页面")
      .toBeLessThanOrEqual(360);
  });
});
