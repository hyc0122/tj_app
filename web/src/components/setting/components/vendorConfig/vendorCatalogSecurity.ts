/**
 * 供应商 UI 错误脱敏：日志与 message 不得回显密钥形态。
 */

/** 将疑似密钥的长 token 替换为占位，保留可读错误语义。 */
export function redactVendorErrorMessage(raw: string, minTokenLength = 16): string {
  const pattern = new RegExp(`[A-Za-z0-9_\\-]{${minTokenLength},}`, "g");
  return raw.replace(pattern, "[redacted]");
}
