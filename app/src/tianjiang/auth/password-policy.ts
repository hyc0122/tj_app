/**
 * 与中央后台一致的业务密码规则：
 * - 至少 8 个字符
 * - 必须同时包含字母和数字
 * - UTF-8 总长度不得超过 72 字节
 */
export interface PasswordPolicyResult {
  readonly valid: boolean;
  readonly minLength: boolean;
  readonly hasLetter: boolean;
  readonly hasDigit: boolean;
  readonly withinByteLimit: boolean;
  readonly message: string | null;
}

const MIN_CHARS = 8;
const MAX_UTF8_BYTES = 72;

export function evaluatePasswordPolicy(password: string): PasswordPolicyResult {
  const minLength = [...password].length >= MIN_CHARS;
  const hasLetter = /[A-Za-z\u00C0-\u024F\u4E00-\u9FFF]/.test(password)
    || /[A-Za-z]/.test(password);
  // 业务规则要求“字母”，此处按 ASCII 字母验收，避免把纯中文当字母通过。
  const hasAsciiLetter = /[A-Za-z]/.test(password);
  const hasDigit = /\d/.test(password);
  const withinByteLimit = Buffer.byteLength(password, "utf8") <= MAX_UTF8_BYTES;
  const letterOk = hasAsciiLetter;
  const valid = minLength && letterOk && hasDigit && withinByteLimit;

  let message: string | null = null;
  if (!valid) {
    if (!minLength) message = "密码至少需要 8 个字符";
    else if (!letterOk || !hasDigit) message = "密码必须同时包含字母和数字";
    else if (!withinByteLimit) message = "密码 UTF-8 长度不得超过 72 字节";
    else message = "密码不符合安全规则";
  }

  return {
    valid,
    minLength,
    hasLetter: letterOk,
    hasDigit,
    withinByteLimit,
    message,
  };
}

export function assertPasswordPolicy(password: string): void {
  const result = evaluatePasswordPolicy(password);
  if (!result.valid) {
    throw new Error(result.message ?? "密码不符合安全规则");
  }
}
