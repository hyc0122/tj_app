import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const moduleUrl = pathToFileURL(
  path.resolve("src/views/assets/composables/assetsLogic.ts"),
).href;

test("素材页逻辑模块可独立执行", async () => {
  const logic = await import(moduleUrl);
  assert.equal(typeof logic.getMediaType, "function");
});

test("媒体类型忽略查询参数并识别常用图片、视频和音频", async () => {
  const { getMediaType } = await import(moduleUrl);
  assert.equal(getMediaType("https://cdn/a.webp?x=1"), "image");
  assert.equal(getMediaType("https://cdn/a.MP4#time=2"), "video");
  assert.equal(getMediaType("https://cdn/a.m4a"), "audio");
  assert.equal(getMediaType("https://cdn/a.bin"), "unknown");
});

test("父子素材被稳定展平并可按编号检索", async () => {
  const { flattenAssets, findAssetById } = await import(moduleUrl);
  const child = { id: 2 };
  const rows = [{ id: 1, sonAssets: [child] }, { id: 3 }];
  assert.deepEqual(flattenAssets(rows).map((item) => item.id), [1, 2, 3]);
  assert.equal(findAssetById(rows, 2), child);
  assert.equal(findAssetById(rows, 9), undefined);
});

test("单选模式只保留最后一次选择且过滤生成中的素材", async () => {
  const { normalizeSelection } = await import(moduleUrl);
  const isGenerating = (id) => id === 2;
  assert.deepEqual(normalizeSelection([1, 2, 3], false, isGenerating), [3]);
  assert.deepEqual(normalizeSelection([1, 2, 3], true, isGenerating), [1, 3]);
});
