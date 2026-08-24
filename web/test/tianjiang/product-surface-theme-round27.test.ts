import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = readFileSync(path.join(root, "src/assets/main.scss"), "utf8");

const productTokens = [
  "--product-page",
  "--product-surface",
  "--product-surface-soft",
  "--product-overlay",
  "--product-border",
  "--product-border-strong",
  "--product-text",
  "--product-text-secondary",
  "--product-text-muted",
  "--product-shadow",
  "--product-radius-card",
  "--product-focus-ring",
] as const;

/**
 * 提取同一主题选择器的所有顶层声明块。
 * main.scss 允许把组件覆写拆成后续同选择器块，因此测试合并检查，避免绑定文件位置。
 */
function collectThemeBlocks(selectorPattern: RegExp): string {
  const blocks: string[] = [];
  const selector = new RegExp(selectorPattern.source, selectorPattern.flags.includes("g") ? selectorPattern.flags : `${selectorPattern.flags}g`);
  let match: RegExpExecArray | null;

  while ((match = selector.exec(source)) !== null) {
    const openingBrace = source.indexOf("{", match.index);
    if (openingBrace < 0) break;

    let depth = 0;
    for (let index = openingBrace; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      if (depth === 0) {
        blocks.push(source.slice(openingBrace + 1, index));
        selector.lastIndex = index + 1;
        break;
      }
    }
  }

  return blocks.join("\n");
}

describe("Round27 全局产品表面主题契约", () => {
  it.each([
    ["light", /:root\s*,\s*:root\[theme-mode=["']light["']\]\s*/],
    ["dark", /:root\.dark\s*,\s*:root\[theme-mode=["']dark["']\]\s*/],
    ["cyberpunk", /:root\.cyberpunk\s*,\s*:root\[data-theme=["']cyberpunk["']\]\s*/],
  ])("%s 主题显式提供完整 product 语义 token", (_theme, selectorPattern) => {
    const themeSource = collectThemeBlocks(selectorPattern);
    expect(themeSource.length).toBeGreaterThan(0);
    for (const token of productTokens) {
      expect(themeSource).toMatch(new RegExp(`${token}\\s*:`));
    }
  });

  it("保留模块悬浮、键盘焦点与 reduced-motion 降级合同", () => {
    expect(source).toContain(".module-interactive,");
    expect(source).toContain(".module-interactive--sm");
    expect(source).toContain(".module-interactive--panel");
    expect(source).toContain("&:focus-visible:not(:disabled)");
    expect(source).toContain("translateY(-2px) scale(1.02)");
    expect(source).toContain("translateY(-1px) scale(1.01)");

    const reducedMotion = source.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(reducedMotion).toContain(".module-interactive");
    expect(reducedMotion).toContain(".module-interactive--sm");
    expect(reducedMotion).toContain(".module-interactive--panel");
    expect(reducedMotion).toContain("transform: none !important");
  });
});
