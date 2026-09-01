// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import axe from "axe-core";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_AI_A11Y";

function webSrc(relative: string): string {
  try {
    return readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src", relative),
      "utf8",
    );
  } catch {
    console.error(SENTINEL);
    expect.fail(SENTINEL);
    return "";
  }
}

describe("AI 面板无障碍合同", () => {
  it("必须覆盖 focus trap、Tab 回绕、背景 inert、Escape 只关最上层和焦点恢复", () => {
    const haystack = [
      webSrc("views/infiniteCanvas/components/ai/CanvasAiPanel.vue"),
      webSrc("views/infiniteCanvas/components/execution/CanvasExecutionPreviewDialog.vue"),
      webSrc("views/infiniteCanvas/components/execution/CanvasFailureDialog.vue"),
      webSrc("views/infiniteCanvas/components/execution/CanvasExecutionDesk.vue"),
    ].join("\n");
    const required = [
      "aria-live",
      "focus-trap",
      "inert",
      "Escape",
      "restoreFocus",
      "tabindex",
      "role=\"dialog\"",
    ];
    const missing = required.filter((token) => !haystack.includes(token));
    if (missing.length !== 0) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
    }
  });

  it("AI 对话与执行台样例 DOM 不得有 critical axe 违规", async () => {
    document.documentElement.innerHTML = `<html><body>
      <aside aria-label="画布 AI" aria-live="polite">
        <button type="button">新对话</button>
        <textarea aria-label="输入提示词"></textarea>
      </aside>
      <div role="dialog" aria-modal="true" aria-label="执行预览">
        <button type="button">确认</button>
        <button type="button">取消</button>
      </div>
    </body></html>`;
    const results = await axe.run(document, { resultTypes: ["violations"] });
    const critical = results.violations.filter((item) => item.impact === "critical");
    if (critical.length !== 0) {
      console.error(SENTINEL);
      expect(critical, SENTINEL).toEqual([]);
    }
  });
});
