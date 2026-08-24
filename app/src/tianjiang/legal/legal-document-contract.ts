/**
 * 公开协议契约：仅允许用户协议与隐私政策两种固定类型，
 * 响应只投影安全字段，禁止后台管理员、token 等私密信息进入客户端缓存。
 */

export type LegalDocumentType = "user_agreement" | "privacy_policy";

export const LEGAL_DOCUMENT_TYPES: readonly LegalDocumentType[] = [
  "user_agreement",
  "privacy_policy",
] as const;

export interface PublicLegalDocument {
  documentType: LegalDocumentType;
  title: string;
  content: string;
  version: string;
  updatedAt: string;
}

export const LEGAL_CONTENT_MAX_UTF8_BYTES = 65_536;
export const LEGAL_CACHE_VERSION = 1 as const;

const REQUIRED_TYPES = new Set<LegalDocumentType>(LEGAL_DOCUMENT_TYPES);

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`公开协议${label}无效`);
  }
  return value;
}

function parseDocumentType(value: unknown): LegalDocumentType {
  if (value === "user_agreement" || value === "privacy_policy") return value;
  throw new Error("公开协议类型无效");
}

/** 将上游文档投影为冻结公开字段并校验体积。 */
export function projectPublicLegalDocument(raw: unknown): PublicLegalDocument {
  const item = asRecord(raw);
  const documentType = parseDocumentType(item.documentType);
  const title = requiredNonEmptyString(item.title, "标题");
  const content = requiredNonEmptyString(item.content, "正文");
  const version = requiredNonEmptyString(item.version, "版本");
  const updatedAt = requiredNonEmptyString(item.updatedAt, "更新时间");
  if (utf8ByteLength(content) > LEGAL_CONTENT_MAX_UTF8_BYTES) {
    throw new Error("公开协议正文超过 64 KiB");
  }
  // 仅返回白名单字段，显式剥离 updatedBy/token/password 等额外键。
  return {
    documentType,
    title,
    content,
    version,
    updatedAt,
  };
}

/**
 * 解析并校验文档列表：必须恰好包含两种固定类型各一份。
 */
export function parseLegalDocuments(raw: unknown): PublicLegalDocument[] {
  if (!Array.isArray(raw)) {
    throw new Error("公开协议列表无效");
  }
  const documents = raw.map(projectPublicLegalDocument);
  if (documents.length !== LEGAL_DOCUMENT_TYPES.length) {
    throw new Error("公开协议必须恰好包含用户协议与隐私政策");
  }
  const seen = new Set<LegalDocumentType>();
  for (const doc of documents) {
    if (seen.has(doc.documentType)) {
      throw new Error("公开协议类型重复");
    }
    seen.add(doc.documentType);
  }
  for (const required of REQUIRED_TYPES) {
    if (!seen.has(required)) {
      throw new Error("公开协议缺少固定类型");
    }
  }
  // 稳定顺序：用户协议在前，隐私政策在后。
  return [
    documents.find((item) => item.documentType === "user_agreement")!,
    documents.find((item) => item.documentType === "privacy_policy")!,
  ];
}
