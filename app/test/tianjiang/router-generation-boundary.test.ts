import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import generateRouter from "../../src/core";

const appRoot = path.resolve(__dirname, "../..");

test("自动路由生成器不重复挂载显式装配的天将控制面", async () => {
  const previousCwd = process.cwd();
  try {
    process.chdir(appRoot);
    await generateRouter();
  } finally {
    process.chdir(previousCwd);
  }

  const generated = await readFile(path.join(appRoot, "src/router.ts"), "utf8");
  assert.doesNotMatch(generated, /routes\/tianjiang\/control-plane/);
  assert.doesNotMatch(generated, /routes\/tianjiang\/runtime/);
  assert.doesNotMatch(generated, /app\.use\("\/api\/tianjiang\/control-plane"/);
});
