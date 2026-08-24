import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import getPath from "../../src/utils/getPath";

const worktreeRoot = path.resolve(
  __dirname,
  "../../..",
);
const expectedTempRoot = path.join(worktreeRoot, ".tmp", "r");
const expectedRuntimeDataRoot = path.join(expectedTempRoot, "runtime-data");

test("默认天将专项测试必须使用当前工作树内的短 TEMP 和 TMP", () => {
  assert.equal(path.resolve(os.tmpdir()), expectedTempRoot);
  assert.equal(path.resolve(process.env.TEMP ?? ""), expectedTempRoot);
  assert.equal(path.resolve(process.env.TMP ?? ""), expectedTempRoot);
  assert.equal(
    path.resolve(process.env.TIANJIANG_TEST_DATA_ROOT ?? ""),
    expectedRuntimeDataRoot,
  );
  assert.equal(
    path.resolve(process.env.TIANJIANG_TEST_WORKTREE_ROOT ?? ""),
    worktreeRoot,
  );
  assert.equal(path.resolve(getPath()), expectedRuntimeDataRoot);

  const originalDirectory = process.cwd();
  const fixtureDirectory = path.join(expectedTempRoot, "cwd-data-fixture");
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  try {
    process.chdir(fixtureDirectory);
    assert.equal(path.resolve(getPath()), path.join(fixtureDirectory, "data"));
  } finally {
    process.chdir(originalDirectory);
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }

  const originalDataRoot = process.env.TIANJIANG_TEST_DATA_ROOT;
  try {
    process.env.TIANJIANG_TEST_DATA_ROOT = path.join(worktreeRoot, "outside-data");
    assert.throws(() => getPath(), /必须位于当前工作树 \.tmp/);
  } finally {
    if (originalDataRoot === undefined) {
      delete process.env.TIANJIANG_TEST_DATA_ROOT;
    } else {
      process.env.TIANJIANG_TEST_DATA_ROOT = originalDataRoot;
    }
  }
});
