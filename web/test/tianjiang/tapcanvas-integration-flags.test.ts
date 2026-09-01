// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SENTINEL = "RED_EXPECTED:TAPCANVAS_FLAGS";

function readRel(relative: string): string {
  try {
    return readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", relative),
      "utf8",
    );
  } catch {
    console.error(SENTINEL);
    expect.fail(SENTINEL);
    return "";
  }
}

describe("TapCanvas 接入必须隐藏团队/社区并走天将适配层", () => {
  it("子应用必须隐藏团队与社区入口，API 指向天将适配层", () => {
    const haystack = [
      readRel("tapcanvas/src/tianjiang/integrationFlags.ts"),
      readRel("tapcanvas/src/RouteEntrypoint.tsx"),
      readRel("tapcanvas/src/api/server.ts"),
      readRel("tapcanvas/src/portal/CanvasHubPage.tsx"),
    ].join("\n");
    const required = [
      "TAPCANVAS_HIDE_TEAM",
      "TAPCANVAS_HIDE_COMMUNITY",
      "TAPCANVAS_TIANJIANG_ADAPTER",
      "/api/tianjiang/tapcanvas",
      "canvas-hub",
      "一句话把想法变成画布",
    ];
    const missing = required.filter((token) => !haystack.includes(token));
    if (missing.length !== 0) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
    }
  });
});
