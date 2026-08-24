import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const moduleUrl = pathToFileURL(
  path.resolve("src/views/cornerScape/composables/cornerScapeLogic.ts"),
).href;

test("角色情景逻辑模块可独立执行", async () => {
  const logic = await import(moduleUrl);
  assert.equal(typeof logic.selectIdsByState, "function");
});

test("按状态和空提示词筛选时只返回符合条件的编号", async () => {
  const { selectIdsByState, selectPromptEmptyIds } = await import(moduleUrl);
  const rows = [
    { id: 1, state: "生成中", prompt: "a" },
    { id: 2, state: "未生成", prompt: "" },
    { id: 3, state: "未生成", prompt: "b" },
  ];
  assert.deepEqual(selectIdsByState(rows, "未生成"), [2, 3]);
  assert.deepEqual(selectPromptEmptyIds(rows), [2]);
});

test("预览图去重且忽略空地址", async () => {
  const { collectPreviewImages } = await import(moduleUrl);
  assert.deepEqual(
    collectPreviewImages([
      { src: "a.png", history: [{ filePath: "b.png" }, { filePath: "a.png" }] },
      { src: "", history: [{ filePath: "" }] },
    ]),
    ["a.png", "b.png"],
  );
});
