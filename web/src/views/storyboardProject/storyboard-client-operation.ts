const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 为一次明确的收费生成意图创建强随机 UUID。
 * 同一次网络重试必须由调用方复用该值；不可降级到 Math.random 等弱随机方案。
 */
export function createStoryboardClientOperationId(): string {
  const operationId = globalThis.crypto?.randomUUID?.() ?? "";
  if (!UUID_V4_PATTERN.test(operationId)) throw new Error("浏览器不支持安全的生成操作标识");
  return operationId;
}

export function isStoryboardClientOperationId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}
