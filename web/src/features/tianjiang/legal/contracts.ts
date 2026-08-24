export type LegalDocumentType = "user_agreement" | "privacy_policy";

export interface PublicLegalDocument {
  documentType: LegalDocumentType;
  title: string;
  content: string;
  version: string;
  updatedAt: string;
}

export type LegalDocumentSource = "network" | "cache" | "packaged";

export interface LegalDocumentsResult {
  documents: PublicLegalDocument[];
  source: LegalDocumentSource;
  stale: boolean;
}

const ALLOWED = new Set<LegalDocumentType>(["user_agreement", "privacy_policy"]);

export function parseRendererLegalDocuments(payload: unknown): LegalDocumentsResult {
  const root = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const data = root.data && typeof root.data === "object"
    ? root.data as Record<string, unknown>
    : root;
  const list = Array.isArray(data.documents) ? data.documents : [];
  const documents: PublicLegalDocument[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const documentType = row.documentType;
    if (documentType !== "user_agreement" && documentType !== "privacy_policy") continue;
    if (!ALLOWED.has(documentType)) continue;
    if (
      typeof row.title !== "string"
      || typeof row.content !== "string"
      || typeof row.version !== "string"
      || typeof row.updatedAt !== "string"
    ) {
      continue;
    }
    documents.push({
      documentType,
      title: row.title,
      content: row.content,
      version: row.version,
      updatedAt: row.updatedAt,
    });
  }
  const source = data.source === "network" || data.source === "cache" || data.source === "packaged"
    ? data.source
    : "packaged";
  return {
    documents,
    source,
    stale: data.stale === true,
  };
}
