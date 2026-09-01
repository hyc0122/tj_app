// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_EDITOR_RENDER";

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

function tapSrc(relative: string): string {
  try {
    return readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../tapcanvas", relative),
      "utf8",
    );
  } catch {
    console.error(SENTINEL);
    expect.fail(SENTINEL);
    return "";
  }
}

describe("TapCanvas 个人画布编辑器宿主", () => {
  it("编辑器必须打开本地 TapCanvas React 子应用", () => {
    const haystack = [
      webSrc("views/infiniteCanvas/editor.vue"),
      webSrc("views/infiniteCanvas/TapCanvasHost.vue"),
      tapSrc("package.json"),
      tapSrc("src/App.tsx"),
      tapSrc("src/canvas/Canvas.tsx"),
    ].join("\n");
    const required = ["TapCanvasHost", "/tapcanvas/", "@xyflow/react", "Mantine"];
    const missing = required.filter((token) => !haystack.includes(token));
    if (missing.length !== 0) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
    }
  });
});
