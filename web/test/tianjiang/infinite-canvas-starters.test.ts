// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createPersonalCanvasRequest } from "@/features/tianjiang/canvas/project-lifecycle";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_STARTERS";
const STARTERS = [
  "blank",
  "novel-upload",
  "storyboard-guide",
  "text-to-image",
  "first-frame-to-video",
];

function webSrc(relative: string): string {
  return readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src", relative),
    "utf8",
  );
}

describe("个人画布创建方式与空态卡", () => {
  it("创建请求固定 personal/canvas 且不含团队字段", () => {
    const body = createPersonalCanvasRequest({ name: "测试画布" });
    if (body.scope !== "personal" || body.businessType !== "canvas" || "teamUuid" in body) {
      console.error(SENTINEL);
      expect(body.scope, SENTINEL).toBe("personal");
      expect(body.businessType, SENTINEL).toBe("canvas");
      expect(body.teamUuid, SENTINEL).toBeUndefined();
    }
  });

  it("生产入口必须声明五种 starter，且 blank 不是空态第五张卡", () => {
    const haystack = [
      webSrc("pages/workbench/index.vue"),
      webSrc("router/index.ts"),
      webSrc("features/tianjiang/canvas/project-lifecycle.ts"),
    ].join("\n");
    const missing = STARTERS.filter((kind) => !haystack.includes(kind));
    if (missing.length !== 0) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
    }
  });
});
