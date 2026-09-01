/**
 * 完成合同必须由生产构造器生成；生产路由禁止手工伪造 relatedObjects。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  GENERATION_COMPLETION_CONTRACT_VERSION,
  createGenerationCompletionContract,
  parseGenerationCompletionContract,
  stringifyGenerationCompletionContract,
} from "../../src/tianjiang/tasks/generation-completion-contract";

const SRC = path.resolve(__dirname, "../../src");

const PRODUCTION_ROUTES = [
  "routes/production/workbench/generateVideo.ts",
  "routes/production/workbench/batchGenerateVideo.ts",
  "routes/production/editImage/generateFlowImage.ts",
  "routes/production/assets/batchGenerateAssetsImage.ts",
  "routes/production/storyboard/batchGenerateImage.ts",
  "routes/assetsGenerate/generateAssets.ts",
  "routes/assetsGenerate/batchGenerateImageAssets.ts",
];

test("生产构造器生成带版本号、业务主键、相对路径和媒体类型的唯一合同", () => {
  const contract = createGenerationCompletionContract({
    kind: "video",
    mediaType: "video",
    relativePath: "files/videos/a.mp4",
    videoId: 9,
    projectId: 1,
    scriptId: 2,
  });
  assert.equal(contract.version, GENERATION_COMPLETION_CONTRACT_VERSION);
  const raw = stringifyGenerationCompletionContract(contract);
  const parsed = parseGenerationCompletionContract(raw);
  assert.deepEqual(parsed, contract);
  assert.throws(() => parseGenerationCompletionContract(JSON.stringify({
    kind: "video",
    videoId: 9,
    relativePath: "files/videos/a.mp4",
  })), /版本/);
  assert.throws(() => createGenerationCompletionContract({
    kind: "video",
    mediaType: "video",
    relativePath: "../escape.mp4",
    videoId: 1,
  } as never), /路径/);
});

test("全部视频/图片/资产/分镜生产路由在供应商调用前复用生产构造器", () => {
  for (const relative of PRODUCTION_ROUTES) {
    const source = fs.readFileSync(path.join(SRC, relative), "utf8");
    assert.match(source, /createGenerationCompletionContract/, `${relative} 必须调用生产构造器`);
    assert.match(source, /stringifyGenerationCompletionContract/, `${relative} 必须持久化合同`);
    assert.doesNotMatch(
      source,
      /relatedObjects:\s*JSON\.stringify\((req\.body|repeloadObj|relatedObjects)\)/,
      `${relative} 禁止手工伪造 relatedObjects`,
    );
  }
});
