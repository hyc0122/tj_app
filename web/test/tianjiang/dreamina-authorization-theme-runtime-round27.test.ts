// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { compile, compileString } from "sass";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import DreaminaAuthorizationDialog from "@/components/setting/components/vendorConfig/components/DreaminaAuthorizationDialog.vue";

const root = process.cwd();
const mainCss = compile(path.join(root, "src/assets/main.scss"), { style: "expanded" }).css;
const authorizationCss = compileString(
  readFileSync(path.join(root, "src/components/setting/components/vendorConfig/styles/_dreamina-provider-authorization.scss"), "utf8"),
  { style: "expanded" },
).css;

function injectStyle(id: string, css: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.dataset.testStyle = id;
  style.textContent = css;
  document.head.append(style);
  return style;
}

function cssRules(style: HTMLStyleElement): CSSStyleRule[] {
  return Array.from(style.sheet?.cssRules ?? []).filter((rule): rule is CSSStyleRule => "selectorText" in rule);
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
    productSurface: style.getPropertyValue("--product-surface").trim(),
    productBorder: style.getPropertyValue("--product-border").trim(),
    productText: style.getPropertyValue("--product-text").trim(),
    productFocus: style.getPropertyValue("--product-focus-ring").trim(),
    surfaceValue: style.getPropertyValue("--td-bg-color-container").trim(),
    borderValue: style.getPropertyValue("--td-border-level-1-color").trim(),
    textValue: style.getPropertyValue("--td-text-color-primary").trim(),
    focusValue: style.getPropertyValue("--td-brand-color-focus").trim(),
  };
}

beforeEach(() => {
  injectStyle("product-theme", mainCss);
  injectStyle("dreamina-authorization", authorizationCss);
  applyTheme("light");
});

afterEach(() => {
  document.querySelectorAll("style[data-test-style]").forEach((style) => style.remove());
  document.documentElement.className = "";
  document.documentElement.removeAttribute("theme-mode");
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = "";
});

describe("Round27 即梦授权弹窗运行时主题", () => {
  it("真实 TDialog Teleport 后命中产品主题规则和焦点规则", async () => {
    const wrapper = mount(DreaminaAuthorizationDialog, {
      attachTo: document.body,
      props: {
        visible: true,
        verificationUri: "https://jimeng.jianying.com/auth",
        userCode: "ABCD-1234",
        expiresAt: Date.now() + 60_000,
      },
    });
    await flushPromises();

    const dialog = document.querySelector<HTMLElement>(".dreaminaAuthDialog .t-dialog");
    const copyField = document.querySelector<HTMLElement>(".dreaminaAuthDialog .copyField");
    expect(dialog, document.body.innerHTML).not.toBeNull();
    expect(copyField, document.body.innerHTML).not.toBeNull();
    expect(dialog?.matches(".dreaminaAuthDialog .t-dialog")).toBe(true);

    const authStyle = document.querySelector<HTMLStyleElement>('style[data-test-style="dreamina-authorization"]');
    expect(authStyle).not.toBeNull();
    const rules = cssRules(authStyle!);
    const dialogRule = rules.find((rule) => rule.selectorText === ".dreaminaAuthDialog .t-dialog");
    const focusRule = rules.find((rule) => rule.selectorText.includes(".copyField:focus-within"));
    expect(dialogRule?.style.getPropertyValue("background")).toContain("--product-surface");
    expect(dialogRule?.style.getPropertyValue("border")).toContain("--product-border");
    expect(dialogRule?.style.getPropertyValue("color")).toContain("--product-text");
    expect(dialogRule?.style.getPropertyValue("box-shadow")).toContain("--product-shadow");
    expect(focusRule?.style.getPropertyValue("box-shadow")).toContain("--product-focus-ring");

    const copyButton = copyField?.querySelector<HTMLButtonElement>("button");
    copyButton?.focus();
    expect(document.activeElement).toBe(copyButton);
    expect(copyField?.contains(document.activeElement)).toBe(true);
    wrapper.unmount();
  });

  it("light、dark、cyberpunk 切换时实际根变量映射随主题更新", () => {
    const snapshots = (["light", "dark", "cyberpunk"] as const).map((theme) => {
      applyTheme(theme);
      return [theme, themeSnapshot()] as const;
    });

    for (const [, snapshot] of snapshots) {
      expect(snapshot.productSurface).toBe("var(--td-bg-color-container)");
      expect(snapshot.productBorder).toBe("var(--td-border-level-1-color)");
      expect(snapshot.productText).toBe("var(--td-text-color-primary)");
      expect(snapshot.productFocus).not.toBe("");
      expect(snapshot.surfaceValue).not.toBe("");
      expect(snapshot.borderValue).not.toBe("");
      expect(snapshot.textValue).not.toBe("");
      expect(snapshot.focusValue).not.toBe("");
    }

    const [, light] = snapshots[0];
    const [, dark] = snapshots[1];
    const [, cyberpunk] = snapshots[2];
    expect(dark.surfaceValue).not.toBe(light.surfaceValue);
    expect(dark.textValue).not.toBe(light.textValue);
    expect(cyberpunk.surfaceValue).not.toBe(dark.surfaceValue);
    expect(cyberpunk.borderValue).not.toBe(dark.borderValue);
    expect(cyberpunk.focusValue).not.toBe(dark.focusValue);
  });
});
