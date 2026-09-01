// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { installCanvasDomShims } from "./helpers/infinite-canvas-dom";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_HISTORY";
const restore = installCanvasDomShims();
afterEach(() => restore());

describe("画布历史", () => {
  it("编辑器必须接入 undo/redo 事务且历史上限 100", () => {
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/views/infiniteCanvas/editor.vue"),
      "utf8",
    );
    if (!src.includes("undo") || !src.includes("redo") || !src.includes("100")) {
      console.error(SENTINEL);
      expect(src.includes("undo"), SENTINEL).toBe(true);
      expect(src.includes("redo"), SENTINEL).toBe(true);
      expect(src.includes("100"), SENTINEL).toBe(true);
    }
  });
});
