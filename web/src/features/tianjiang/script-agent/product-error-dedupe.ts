/**
 * 产物错误 toast 去重：按 messageId + errorCode，禁止全局时间窗压掉父/子正确消息。
 */

export function shouldShowProductError(
  seen: Map<string, number>,
  messageId: string,
  errorCode: string | undefined,
  now: number,
  windowMs = 1500,
): boolean {
  const key = `${messageId || "_"}|${errorCode ?? ""}`;
  const last = seen.get(key) ?? 0;
  if (now - last < windowMs) return false;
  seen.set(key, now);
  return true;
}
