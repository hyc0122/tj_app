// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { installCanvasDomShims } from "./helpers/infinite-canvas-dom";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_LAYOUT";
const restore = installCanvasDomShims();
afterEach(() => restore());

describe("画布布局", () => {
  it("编辑器必须接入可取消 layout worker", () => {
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/views/infiniteCanvas/editor.vue"),
      "utf8",
    );
    if (!src.includes("canvas-layout.worker") || !src.includes("requestId")) {
      console.error(SENTINEL);
      expect(src.includes("canvas-layout.worker"), SENTINEL).toBe(true);
      expect(src.includes("requestId"), SENTINEL).toBe(true);
    }
  });
});
