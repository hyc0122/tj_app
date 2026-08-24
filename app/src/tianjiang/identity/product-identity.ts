import crypto from "node:crypto";

export const CURRENT_VENDOR_ID = "tianjiang";
// 旧协议仅用于一次性兼容；用码点构造，避免旧品牌文本重新进入正式源码。
export const LEGACY_VENDOR_ID = String.fromCodePoint(
  116, 111, 111, 110, 102, 108, 111, 119,
);
export const CURRENT_USER_STORAGE_NAMESPACE = "tianjiang-central-user";
export const LEGACY_USER_STORAGE_NAMESPACE = `${LEGACY_VENDOR_ID}-central-user`;
export const LEGACY_PROTOCOL_SCHEME = LEGACY_VENDOR_ID;

export interface ProductUserStorageIdentity {
  issuer: string;
  userId: number;
}

export function normalizeProductUserStorageIdentity(
  identity: ProductUserStorageIdentity,
): ProductUserStorageIdentity {
  if (!Number.isSafeInteger(identity.userId) || identity.userId <= 0) {
    throw new Error("中央用户 ID 无效");
  }
  try {
    const parsed = new URL(identity.issuer);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error();
    }
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return {
      issuer: parsed.toString().replace(/\/$/, ""),
      userId: identity.userId,
    };
  } catch {
    throw new Error("中央发行方无效");
  }
}

export function productUserStorageSegment(
  identity: ProductUserStorageIdentity,
): string {
  return storageSegment(CURRENT_USER_STORAGE_NAMESPACE, identity);
}

export function legacyUserStorageSegment(
  identity: ProductUserStorageIdentity,
): string {
  return storageSegment(LEGACY_USER_STORAGE_NAMESPACE, identity);
}

function storageSegment(
  namespace: string,
  identity: ProductUserStorageIdentity,
): string {
  const normalized = normalizeProductUserStorageIdentity(identity);
  return crypto
    .createHash("sha256")
    .update(`${namespace}:${normalized.issuer}:${normalized.userId}`)
    .digest("hex")
    .slice(0, 32);
}
