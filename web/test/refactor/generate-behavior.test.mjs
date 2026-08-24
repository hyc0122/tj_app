import assert from "node:assert/strict";
import test from "node:test";

const logic = await import("../../src/views/production/components/workbench/generate/composables/generateLogic.ts").catch(() => null);

test("生产生成逻辑模块可独立执行", () => {
  assert.ok(logic, "缺少可独立测试的生产生成逻辑模块");
});

test("视频模式解析保留字符串模式并解析组合参考模式", () => {
  assert.equal(logic.parseVideoMode(""), null);
  assert.equal(logic.parseVideoMode("singleImage"), "singleImage");
  assert.deepEqual(logic.parseVideoMode('["imageReference:2","audioReference:1"]'), ["imageReference:2", "audioReference:1"]);
});

test("轨道时长被限制在模型支持的最小值和最大值之间", () => {
  assert.equal(logic.clampTrackDuration(2, [5, 8, 10]), 5);
  assert.equal(logic.clampTrackDuration(8, [5, 8, 10]), 8);
  assert.equal(logic.clampTrackDuration(20, [5, 8, 10]), 10);
  assert.equal(logic.clampTrackDuration(7, []), 7);
});

test("参考素材按资产图、分镜图、无图顺序稳定排列", () => {
  const items = [
    { id: 1, sources: "storyboard" },
    { id: 2, sources: "storyboard", src: "storyboard.png" },
    { id: 3, sources: "assets", src: "asset.png" },
    { id: 4, sources: "assets" },
  ];

  assert.deepEqual(
    logic.sortReferenceMedia(items).map((item) => item.id),
    [3, 2, 1, 4],
  );
});

test("提示词与视频请求保持不同的文本模式素材规则", () => {
  const items = [
    { id: 1, sources: "assets", src: "a.png" },
    { id: null, sources: "storyboard", src: "b.png" },
    { id: 3, sources: "storyboard" },
  ];

  assert.deepEqual(logic.selectPromptMedia(items, "text"), [
    { id: 1, sources: "assets" },
    { id: null, sources: "storyboard" },
    { id: 3, sources: "storyboard" },
  ]);
  assert.deepEqual(logic.selectVideoMedia(items, "text"), []);
  assert.deepEqual(logic.selectVideoMedia(items, "singleImage"), [{ id: 1, sources: "assets" }]);
});

test("参考预览根据去除 query 和 hash 后的扩展名识别媒体类型", () => {
  const previews = logic.buildReferencePreviews([
    { id: 1, sources: "assets", src: "a.MP4?sign=x" },
    { id: 2, sources: "assets", src: "b.wav#part" },
    { id: 3, sources: "storyboard", src: "c.png" },
    { id: 4, sources: "storyboard" },
  ]);

  assert.deepEqual(previews, [
    { type: "video", src: "a.MP4?sign=x" },
    { type: "audio", src: "b.wav#part" },
    { type: "image", src: "c.png" },
  ]);
});
