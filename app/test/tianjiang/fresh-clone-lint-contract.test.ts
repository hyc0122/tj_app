import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("全新克隆的标准 lint 入口先生成受控 router.ts 再执行 tsc", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  const generator = fs.readFileSync(path.resolve("scripts/generate-router.ts"), "utf8");

  assert.equal(packageJson.scripts?.lint, "tsx scripts/generate-router.ts && tsc --noEmit");
  assert.match(generator, /import generateRouter from "\.\.\/src\/core"/);
  assert.match(generator, /generateRouter\(\)/);
});
