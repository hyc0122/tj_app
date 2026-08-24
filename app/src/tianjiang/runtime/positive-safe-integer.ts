/**
 * 正安全整数边界（叶子纯函数）。
 * Socket auth 要求原始 typeof number；HTTP body 经 JSON 解析后亦为 number。
 * 禁止服务端 Number("101") 隐式接收字符串。
 */

export class PositiveSafeIntegerError extends Error {
  readonly code = "POSITIVE_SAFE_INTEGER_INVALID";
  constructor(message = "项目标识无效") {
    super(message);
    this.name = "PositiveSafeIntegerError";
  }
}

/** 宽松：number 或纯数字字符串 → number | undefined（描述资源用） */
export function parsePositiveSafeInteger(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
  }
  if (typeof raw === "string" && /^[1-9]\d*$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

/**
 * 严格：仅接受 typeof number 的正安全整数（Socket handshake.auth.projectId）。
 * 字符串即使是 "101" 也拒绝。
 */
export function requireStrictPositiveSafeInteger(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new PositiveSafeIntegerError();
  }
  return raw;
}
