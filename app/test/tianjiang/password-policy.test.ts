import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePasswordPolicy } from "../../src/tianjiang/auth/password-policy";

test("密码规则：至少 8 字符、字母+数字、UTF-8 ≤72 字节", () => {
  assert.equal(evaluatePasswordPolicy("Ab1").valid, false);
  assert.equal(evaluatePasswordPolicy("abcdefgh").valid, false);
  assert.equal(evaluatePasswordPolicy("12345678").valid, false);
  assert.equal(evaluatePasswordPolicy("SecurePass123!").valid, true);
  assert.equal(evaluatePasswordPolicy("abcd1234").valid, true);

  // 72 字节边界：72 个 ASCII 字符通过，73 失败。
  const exactly72 = `${"a".repeat(70)}12`;
  assert.equal(Buffer.byteLength(exactly72, "utf8"), 72);
  assert.equal(evaluatePasswordPolicy(exactly72).valid, true);
  assert.equal(evaluatePasswordPolicy(`${exactly72}x`).valid, false);
  assert.equal(evaluatePasswordPolicy(`${exactly72}x`).withinByteLimit, false);

  // 多字节字符占用更多字节。
  const multi = `${"密".repeat(24)}a1`; // 24*3 + 2 = 74 字节
  assert.equal(Buffer.byteLength(multi, "utf8") > 72, true);
  assert.equal(evaluatePasswordPolicy(multi).withinByteLimit, false);
});
