// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { installCanvasDomShims } from "./helpers/infinite-canvas-dom";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_HISTORY_ASSETS";
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

describe("画布历史恢复与素材管理", () => {
  it("必须调用 Runtime 修订 CAS restore 与素材 API，节点只保存 assetUuid", () => {
    const haystack = [
      webSrc("features/tianjiang/canvas/api.ts"),
      webSrc("views/infiniteCanvas/components/CanvasHistoryDrawer.vue"),
      webSrc("views/infiniteCanvas/components/CanvasAssetManager.vue"),
      webSrc("views/infiniteCanvas/composables/useCanvasFlow.ts"),
    ].join("\n");
    const required = [
      "/canvas/revisions",
      "/restore",
      "/canvas/assets",
      "clientAssetMutationId",
      "assetUuid",
      "crypto.randomUUID",
      "currentRun",
      "latestRun",
      "confirmationUuid",
    ];
    const missing = required.filter((token) => !haystack.includes(token));
    if (missing.length !== 0) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
    }
  });

  it("媒体节点必须懒加载图片且视频禁止预载与自动播放", () => {
    const media = webSrc("views/infiniteCanvas/components/nodes/MediaCanvasNode.vue");
    if (!media.includes('preload="none"') || !media.includes("loading=\"lazy\"") || media.includes("autoplay")) {
      console.error(SENTINEL);
      expect(media.includes('preload="none"'), SENTINEL).toBe(true);
      expect(media.includes('loading="lazy"'), SENTINEL).toBe(true);
      expect(media.includes("autoplay"), SENTINEL).toBe(false);
    }
  });
});
