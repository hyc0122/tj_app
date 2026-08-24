import { describe, expect, it } from "vitest";

import { evaluatePasswordPolicy } from "@/features/tianjiang/auth/password-policy";

describe("客户端密码规则与后台一致", () => {
  it("逐项校验长度、字母数字与 72 字节上限", () => {
    expect(evaluatePasswordPolicy("short1").valid).toBe(false);
    expect(evaluatePasswordPolicy("short1").minLength).toBe(false);

    const onlyLetters = evaluatePasswordPolicy("abcdefgh");
    expect(onlyLetters.valid).toBe(false);
    expect(onlyLetters.hasDigit).toBe(false);

    const onlyDigits = evaluatePasswordPolicy("12345678");
    expect(onlyDigits.valid).toBe(false);
    expect(onlyDigits.hasLetter).toBe(false);

    expect(evaluatePasswordPolicy("abcd1234").valid).toBe(true);

    const exactly72 = `${"a".repeat(70)}12`;
    expect(new TextEncoder().encode(exactly72).length).toBe(72);
    expect(evaluatePasswordPolicy(exactly72).valid).toBe(true);
    expect(evaluatePasswordPolicy(`${exactly72}x`).withinByteLimit).toBe(false);
  });
});
