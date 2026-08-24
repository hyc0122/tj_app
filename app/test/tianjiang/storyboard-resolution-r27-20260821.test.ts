import assert from "node:assert/strict";
import test from "node:test";

import * as generationService from "../../src/tianjiang/storyboard/storyboard-generation-service";

test("R27 视频分辨率：旧项目默认 720p，明确选择原样保留，未知值 fail-closed", () => {
  const helper = (generationService as unknown as {
    generationResolutionForMedia?: (mediaType: "image" | "video", resolution: unknown) => string;
  }).generationResolutionForMedia;

  assert.equal(typeof helper, "function", "分辨率规范化必须由预览与正式生成共用并可测试");
  assert.equal(helper!("video", ""), "720p");
  assert.equal(helper!("video", "480p"), "480p");
  assert.equal(helper!("video", "720p"), "720p");
  assert.equal(helper!("video", "1080p"), "1080p");
  assert.throws(
    () => helper!("video", "4K"),
    (error: unknown) => (
      Boolean(error)
      && typeof error === "object"
      && (error as { code?: string }).code === "STORYBOARD_VIDEO_RESOLUTION_UNSUPPORTED"
    ),
  );
});
