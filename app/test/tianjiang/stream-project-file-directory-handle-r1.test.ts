import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("目录 fsync 使用的句柄必须在成功与异常路径都关闭", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../src/tianjiang/media/stream-project-file.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /fs\.fsyncSync\(fs\.openSync\(parent,\s*"r"\)\)/);
  assert.match(source, /fs\.closeSync\(directoryHandle\)/);
});
