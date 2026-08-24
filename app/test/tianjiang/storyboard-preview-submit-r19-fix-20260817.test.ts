/**
 * R19-fix RED：referenceSummary 不得扫描 prompt；空引用不得被伪造标签污染。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeStoryboardGenerationPreview } from "../../src/tianjiang/storyboard/storyboard-generation-service";

const PROJECT = "f1919191-1919-4191-a191-191919191919";
const SHOT = "f1919191-ffff-4fff-8fff-ffffffffffff";

test("references 为空时 prompt 中的伪造音频标签不得进入 referenceSummary", async () => {
  const preview = await Promise.resolve(sanitizeStoryboardGenerationPreview({
    projectUuid: PROJECT,
    shotUuid: SHOT,
    mediaType: "video",
    request: {
      providerModel: "dreamina-cli:seedance2.0fast",
      prompt: [
        "统一夜戏光影，禁止现代招牌。",
        "",
        "音频1：伪造标签",
        "图片1：伪造图片",
        "风格：玄幻。",
        "稳定跟拍角色走上石阶。",
      ].join("\n"),
      references: [],
      options: {
        aspectRatio: "9:16",
        resolution: "720p",
        durationMs: 5000,
        mode: "text2video",
      },
    },
  }));
  assert.equal(preview.referenceSummary.audio.count, 0);
  assert.deepEqual(preview.referenceSummary.audio.labels, []);
  assert.equal(preview.referenceSummary.image.count, 0);
  assert.deepEqual(preview.referenceSummary.image.labels, []);
  assert.equal(JSON.stringify(preview.referenceSummary).includes("伪造"), false);
});

test("referenceSummary 标签数不得超过真实引用数，且不得从 prompt 补标签", async () => {
  const preview = await Promise.resolve(sanitizeStoryboardGenerationPreview({
    projectUuid: PROJECT,
    shotUuid: SHOT,
    mediaType: "video",
    request: {
      providerModel: "dreamina-cli:seedance2.0fast",
      prompt: "音频1：伪造甲\n音频2：伪造乙\n图片1：伪造图",
      references: [
        { assetUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", mediaType: "image", relativePath: "files/images/a.png" },
      ],
      options: {
        aspectRatio: "9:16",
        resolution: "720p",
        durationMs: 5000,
        mode: "image2video",
      },
    },
  }));
  assert.equal(preview.referenceSummary.image.count, 1);
  assert.ok(preview.referenceSummary.image.labels.length <= 1);
  assert.equal(preview.referenceSummary.audio.count, 0);
  assert.deepEqual(preview.referenceSummary.audio.labels, []);
  assert.equal((preview.referenceSummary.image.labels as string[]).includes("伪造图"), false);
  assert.equal((preview.referenceSummary.audio.labels as string[]).includes("伪造甲"), false);
});
