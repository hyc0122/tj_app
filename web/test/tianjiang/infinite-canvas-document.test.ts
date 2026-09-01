// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { installCanvasDomShims } from "./helpers/infinite-canvas-dom";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_DOCUMENT";
const restore = installCanvasDomShims();
afterEach(() => restore());

describe("规范画布文档", () => {
  it("编辑器入口必须接入文档序列化与分组深度合同", () => {
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/views/infiniteCanvas/editor.vue"),
      "utf8",
    );
    if (!src.includes("serializeCanvasDocument") || !src.includes("MAX_CANVAS_GROUP_DEPTH")) {
      console.error(SENTINEL);
      expect(src.includes("serializeCanvasDocument"), SENTINEL).toBe(true);
      expect(src.includes("MAX_CANVAS_GROUP_DEPTH"), SENTINEL).toBe(true);
    }
  });
});
