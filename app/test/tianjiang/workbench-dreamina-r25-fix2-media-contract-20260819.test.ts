/**
 * R25-fix2 RED：前端已把 AVI 视为视频，后端项目文件分类必须保持一致。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyProjectFile,
  mediaTypeForExtension,
} from "../../src/tianjiang/media/project-file-store";

test("AVI 扩展名与项目文件路径必须一致分类为 video", () => {
  assert.equal(mediaTypeForExtension("AVI"), "video");
  assert.deepEqual(classifyProjectFile("files/videos/workbench/result.avi"), {
    category: "videos",
    mediaType: "video",
  });
  assert.deepEqual(classifyProjectFile("files/uploads/reference.avi"), {
    category: "videos",
    mediaType: "video",
  });
});
