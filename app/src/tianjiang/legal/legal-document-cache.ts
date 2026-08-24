import fs from "node:fs";
import path from "node:path";

import { PACKAGED_LEGAL_DOCUMENTS } from "./default-legal-documents";
import {
  LEGAL_CACHE_VERSION,
  parseLegalDocuments,
  type PublicLegalDocument,
} from "./legal-document-contract";

export interface LegalDocumentCacheRecord {
  cacheVersion: typeof LEGAL_CACHE_VERSION;
  etag: string;
  cachedAt: string;
  documents: PublicLegalDocument[];
}

/** 公开缓存位于通用应用数据目录，不进入账号私有数据库。 */
export function legalDocumentCachePath(dataRoot: string): string {
  return path.join(dataRoot, "public-cache", "legal-documents.json");
}

export class LegalDocumentCache {
  constructor(private readonly dataRoot: string) {}

  get path(): string {
    return legalDocumentCachePath(this.dataRoot);
  }

  read(): LegalDocumentCacheRecord | null {
    try {
      if (!fs.existsSync(this.path)) return null;
      const raw = JSON.parse(fs.readFileSync(this.path, "utf8")) as unknown;
      return parseCacheRecord(raw);
    } catch {
      // 读取失败只降级，不删除可能仍可读的旧文件。
      return null;
    }
  }

  write(documents: PublicLegalDocument[], etag: string): LegalDocumentCacheRecord {
    const record: LegalDocumentCacheRecord = {
      cacheVersion: LEGAL_CACHE_VERSION,
      etag,
      cachedAt: new Date().toISOString(),
      documents: parseLegalDocuments(documents),
    };
    const target = this.path;
    const directory = path.dirname(target);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(
      directory,
      `legal-documents.${process.pid}.${Date.now()}.tmp`,
    );
    // 同目录原子替换，避免半文件；mode 限制本机读取范围。
    fs.writeFileSync(temporary, JSON.stringify(record), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, target);
    return record;
  }

  packagedFallback(): PublicLegalDocument[] {
    return [...PACKAGED_LEGAL_DOCUMENTS];
  }
}

function parseCacheRecord(raw: unknown): LegalDocumentCacheRecord {
  const item = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  if (item.cacheVersion !== LEGAL_CACHE_VERSION) {
    throw new Error("协议缓存版本无效");
  }
  if (typeof item.etag !== "string") {
    throw new Error("协议缓存 ETag 无效");
  }
  if (typeof item.cachedAt !== "string" || !item.cachedAt) {
    throw new Error("协议缓存时间无效");
  }
  return {
    cacheVersion: LEGAL_CACHE_VERSION,
    etag: item.etag,
    cachedAt: item.cachedAt,
    documents: parseLegalDocuments(item.documents),
  };
}
