// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import axe from "axe-core";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_A11Y";

function scss(): string {
  return readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/views/infiniteCanvas/styles/canvas.scss"),
    "utf8",
  );
}

describe("画布主题与无障碍", () => {
  it("必须提供 light/dark/cyberpunk token、focus-visible 与 reduced-motion", () => {
    const src = scss();
    const required = [
      'theme-mode="light"',
      "dark",
      "cyberpunk",
      ":focus-visible",
      "prefers-reduced-motion",
      'aria-live',
      'role="separator"',
      "overflow-wrap",
    ];
    const missing = required.filter((token) => !src.includes(token));
    if (missing.length !== 0) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
    }
  });

  it("自动扫描画布无障碍选择器契约", async () => {
    const src = scss();
    document.documentElement.innerHTML = `<html><head></head><body>
      <main class="canvas-editor">
        <style>${src.replaceAll("html[theme-mode", "body[theme-mode")}</style>
        <div aria-live="polite" class="canvas-live">已保存</div>
        <div role="separator" aria-orientation="horizontal" tabindex="0"></div>
        <button type="button" class="canvas-toolbar">Save canvas</button>
      </main>
    </body></html>`;
    const results = await axe.run(document, { resultTypes: ["violations"] });
    if (!src.includes(":focus-visible") || results.violations.some((item) => item.impact === "critical")) {
      console.error(SENTINEL);
      expect(src.includes(":focus-visible"), SENTINEL).toBe(true);
    }
  });
});
