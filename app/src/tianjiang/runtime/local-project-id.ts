import crypto from "node:crypto";

/**
 * 旧工作区仍要求正整数主键；该 ID 只由本机从项目 UUID 推导，绝不进入中央公共契约。
 */
export function localLegacyProjectId(projectUuid: string): number {
  const normalized = projectUuid.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error("本地项目 ID 映射收到无效 UUID");
  }
  // 取 SHA-256 前 48 位，保持在 JavaScript/SQLite 安全整数范围内；零值映射到 1。
  const mapped = crypto
    .createHash("sha256")
    .update(`tianjiang-local-project:${normalized}`)
    .digest()
    .readUIntBE(0, 6);
  return mapped || 1;
}

export function buildLocalProjectIdMap(projectUuids: Iterable<string>): Map<string, number> {
  const result = new Map<string, number>();
  const reverse = new Map<number, string>();
  for (const projectUuid of projectUuids) {
    const normalized = projectUuid.toLowerCase();
    const mapped = localLegacyProjectId(normalized);
    const existing = reverse.get(mapped);
    if (existing && existing !== normalized) {
      // 极低概率哈希冲突也必须失败关闭，不能把两个项目误路由到同一旧工作区。
      throw new Error("本地项目 ID 映射冲突");
    }
    result.set(normalized, mapped);
    reverse.set(mapped, normalized);
  }
  return result;
}
