// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { installCanvasDomShims } from "./helpers/infinite-canvas-dom";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_PERFORMANCE";
const restore = installCanvasDomShims();
afterEach(() => restore());

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
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../tapcanvas/src", relative),
      "utf8",
    );
  } catch {
    console.error(SENTINEL);
    expect.fail(SENTINEL);
    return "";
  }
}

describe("画布可视渲染与卸载销毁", () => {
  it("必须启用 React Flow 可视元素渲染，并在拖拽/视口结束后再提交状态", () => {
    const haystack = [
      tapSrc("canvas/Canvas.tsx"),
      tapSrc("canvas/CanvasVirtualizationContext.ts"),
    ].join("\n");
    const required = [
      "onlyRenderVisibleElements",
      "onNodeDragStop",
      "onMoveEnd",
      "onCanvasMoveEnd",
      "ReactFlowProvider",
    ];
    const missing = required.filter((token) => !haystack.includes(token));
    if (missing.length !== 0) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
    }
  });

  it("2GiB 上限测试不得创建真实整文件夹具或线性占用内存", () => {
    const worker = webSrc("features/tianjiang/canvas/streaming-sha256-worker.ts");
    const dialog = webSrc("views/infiniteCanvas/components/CanvasImportExportDialog.vue");
    const haystack = `${worker}\n${dialog}`;
    if (
      haystack.includes("arrayBuffer(")
      || haystack.includes("new ArrayBuffer(2147483648)")
      || !haystack.includes("MAX_CANVAS_MULTIPART_FILE_BYTES")
    ) {
      console.error(SENTINEL);
      expect(haystack.includes("arrayBuffer("), SENTINEL).toBe(false);
      expect(haystack.includes("MAX_CANVAS_MULTIPART_FILE_BYTES"), SENTINEL).toBe(true);
    }
  });
});
