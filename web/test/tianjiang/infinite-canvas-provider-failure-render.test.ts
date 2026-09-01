// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_PROVIDER_FAILURE_RENDER";

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

describe("供应商失败渲染合同", () => {
  it("失败弹窗必须文本插值、截断 1MiB、替换凭据且禁止 v-html", () => {
    const haystack = [
      webSrc("views/infiniteCanvas/components/execution/CanvasFailureDialog.vue"),
      webSrc("features/tianjiang/canvas/useCanvasExecution.ts"),
    ].join("\n");
    const required = [
      "[REDACTED_SECRET]",
      "1048576",
      "sanitizeFailureText",
      "textContent",
      "Authorization",
      "AccessKey",
      "safeProcessedText",
    ];
    const missing = required.filter((token) => !haystack.includes(token));
    if (missing.length !== 0 || haystack.includes("v-html")) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
      expect(haystack.includes("v-html"), SENTINEL).toBe(false);
    }
  });
});
