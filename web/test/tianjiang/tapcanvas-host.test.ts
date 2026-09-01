// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SENTINEL = "RED_EXPECTED:TAPCANVAS_HOST";

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

describe("无限画布必须接入 TapCanvas React 子应用", () => {
  it("工作台菜单与路由必须打开本地 TapCanvas 宿主而不是 Vue Flow 编辑器", () => {
    const haystack = [
      webSrc("pages/workbench/index.vue"),
      webSrc("router/index.ts"),
      webSrc("views/infiniteCanvas/index.vue"),
      webSrc("views/infiniteCanvas/TapCanvasHost.vue"),
      tapSrc("package.json"),
      tapSrc("src/App.tsx"),
      tapSrc("src/canvas/Canvas.tsx"),
    ].join("\n");
    const required = [
      "/infinite-canvas",
      "TapCanvasHost",
      "/tapcanvas/index.html",
      "@xyflow/react",
      "Mantine",
    ];
    const missing = required.filter((token) => !haystack.includes(token));
    const externalIframe = /iframe[^>]+src=["']https?:\/\//i.test(haystack);
    if (missing.length !== 0 || externalIframe) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
      expect(externalIframe, SENTINEL).toBe(false);
    }
  });
});
