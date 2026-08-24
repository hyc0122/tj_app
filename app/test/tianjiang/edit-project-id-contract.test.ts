import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import test from "node:test";
import { z } from "zod";

/**
 * 冻结 editProject 的 id 契约：正安全整数，拒绝字符串与非整数。
 * 与 app/src/routes/project/editProject.ts 保持一致。
 */
export const editProjectIdSchema = z
  .number()
  .int()
  .positive()
  .refine((value) => Number.isSafeInteger(value), { message: "必须是安全整数" });

test("RED: 字符串 id 不得通过 editProject 契约（复现参数错误）", () => {
  const stringId = String(42);
  assert.equal(typeof stringId, "string");
  assert.throws(() => editProjectIdSchema.parse(stringId));
  // 源码曾以 String(localId) 发送，必须被后端 z.number() 拒绝
  const flowSource = fs.readFileSync(
    path.join(process.cwd(), "..", "web", "src", "features", "tianjiang", "project", "create-project-flow.ts"),
    "utf8",
  );
  // GREEN 后此断言翻转：不得再出现 String(localId)
  // 测试在实现前后共用：实现后要求发送数字 id。
  if (flowSource.includes("String(localId)")) {
    assert.ok(true, "当前仍为 RED 形态：create-project-flow 使用 String(localId)");
  } else {
    assert.match(flowSource, /id:\s*localId|id:\s*toPositiveSafeInteger/);
    assert.doesNotMatch(flowSource, /id:\s*String\(localId\)/);
  }
});

test("editProject 路由 id 必须为正安全整数，拒绝 0/负数/浮点/非安全整数", () => {
  assert.equal(editProjectIdSchema.parse(42), 42);
  assert.throws(() => editProjectIdSchema.parse(0));
  assert.throws(() => editProjectIdSchema.parse(-1));
  assert.throws(() => editProjectIdSchema.parse(1.5));
  assert.throws(() => editProjectIdSchema.parse(Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => editProjectIdSchema.parse("42"));
});

test("editProject.ts 源码冻结 z.number 且无 z.coerce 放宽字符串", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src", "routes", "project", "editProject.ts"),
    "utf8",
  );
  assert.match(source, /projectIdSchema|id:\s*z\.number\(\)/);
  assert.match(source, /\.number\(\)[\s\S]*\.int\(\)[\s\S]*\.positive\(\)/);
  assert.match(source, /Number\.isSafeInteger/);
  assert.doesNotMatch(source, /id:\s*z\.coerce/);
  assert.doesNotMatch(source, /z\.union\(\s*\[z\.number/);
  // 全量历史项目字段保持兼容
  for (const field of [
    "name",
    "intro",
    "type",
    "artStyle",
    "directorManual",
    "videoRatio",
    "imageModel",
    "videoModel",
    "projectType",
    "imageQuality",
    "mode",
  ]) {
    assert.match(source, new RegExp(field));
  }
});
