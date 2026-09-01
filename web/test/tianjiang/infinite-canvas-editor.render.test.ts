// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { installCanvasDomShims } from "./helpers/infinite-canvas-dom";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_EDITOR_RENDER";
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

describe("Vue Flow 个人画布编辑器渲染合同", () => {
  it("编辑器必须手动接管 Vue Flow 变更并只渲染可视节点", () => {
    const haystack = [
      webSrc("views/infiniteCanvas/editor.vue"),
      webSrc("views/infiniteCanvas/composables/useCanvasFlow.ts"),
      webSrc("views/infiniteCanvas/components/CanvasViewport.vue"),
    ].join("\n");
    const required = [
      "VueFlow",
      "apply-default",
      "only-render-visible-elements",
      "@vue-flow/core",
      "@vue-flow/background",
      "@vue-flow/controls",
      "@vue-flow/minimap",
      "@vue-flow/core/dist/style.css",
      "@vue-flow/core/dist/theme-default.css",
      "@vue-flow/controls/dist/style.css",
      "@vue-flow/minimap/dist/style.css",
      "styles/canvas.scss",
      "getSelectedNodes",
      "Background",
      "Controls",
      "MiniMap",
    ];
    const missing = required.filter((token) => !haystack.includes(token));
    if (missing.length !== 0) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
    }
  });

  it("工具栏、右键菜单和节点组件必须从编辑器入口接入", () => {
    const editor = webSrc("views/infiniteCanvas/editor.vue");
    const required = [
      "CanvasTopToolbar",
      "CanvasBottomToolbar",
      "CanvasContextMenu",
      "CanvasHistoryDrawer",
      "CanvasAssetManager",
      "CanvasImportExportDialog",
      "TextCanvasNode",
      "MediaCanvasNode",
      "FileCanvasNode",
      "GenerationCanvasNode",
      "StoryboardCanvasNode",
      "GroupCanvasNode",
    ];
    const missing = required.filter((token) => !editor.includes(token));
    if (missing.length !== 0) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
    }
  });
});
