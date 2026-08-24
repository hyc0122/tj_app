/**
 * 与中央后台一致的业务密码规则（渲染进程侧镜像，禁止放宽）。
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

function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  // 测试/旧环境回退：与 Node Buffer.byteLength 语义一致。
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function evaluatePasswordPolicy(password: string): PasswordPolicyResult {
  const minLength = [...password].length >= MIN_CHARS;
  const hasLetter = /[A-Za-z]/.test(password);
  const hasDigit = /\d/.test(password);
  const withinByteLimit = utf8ByteLength(password) <= MAX_UTF8_BYTES;
  const valid = minLength && hasLetter && hasDigit && withinByteLimit;

  let message: string | null = null;
  if (!valid) {
    if (!minLength) message = "密码至少需要 8 个字符";
    else if (!hasLetter || !hasDigit) message = "密码必须同时包含字母和数字";
    else if (!withinByteLimit) message = "密码 UTF-8 长度不得超过 72 字节";
    else message = "密码不符合安全规则";
  }

  return {
    valid,
    minLength,
    hasLetter,
    hasDigit,
    withinByteLimit,
    message,
  };
}
