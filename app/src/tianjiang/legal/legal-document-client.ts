import { CENTRAL_API_URL } from "../auth/central-session";
import type { LegalDocumentCache } from "./legal-document-cache";
import {
  parseLegalDocuments,
  type PublicLegalDocument,
} from "./legal-document-contract";

const LEGAL_DOCUMENTS_PATH = "/api/tianjiang/v1/public/legal-documents";
const REQUEST_TIMEOUT_MS = 12_000;

export type LegalDocumentSource = "network" | "cache" | "packaged";

export interface LegalDocumentsResult {
  documents: PublicLegalDocument[];
  source: LegalDocumentSource;
  stale: boolean;
}

/**
 * 固定中央主机拉取公开协议；renderer 与调用方均不能覆盖 serverUrl。
 */
export class LegalDocumentClient {
  constructor(
    private readonly cache: LegalDocumentCache,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getLatest(): Promise<LegalDocumentsResult> {
    const cached = this.cache.read();
    const url = `${CENTRAL_API_URL}${LEGAL_DOCUMENTS_PATH}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
          },
          redirect: "error",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 304) {
        if (!cached) {
          return {
            documents: this.cache.packagedFallback(),
            source: "packaged",
            stale: true,
          };
        }
        return {
          documents: cached.documents,
          source: "cache",
          stale: false,
        };
      }

      if (!response.ok) {
        return this.degrade(cached, `http-${response.status}`);
      }

      const body = await response.json() as {
        code?: unknown;
        data?: { documents?: unknown };
      };
      if (body.code !== 0 || !body.data) {
        return this.degrade(cached, "business-code");
      }
      const documents = parseLegalDocuments(body.data.documents);
      const etag = response.headers.get("etag") ?? cached?.etag ?? "";
      try {
        this.cache.write(documents, etag);
      } catch {
        // 写缓存失败不影响本次网络结果返回。
      }
      return {
        documents,
        source: "network",
        stale: false,
      };
    } catch {
      // 日志只记分类，不写正文/请求头/ETag。
      console.info("[legal-documents] network-or-parse-failed");
      return this.degrade(cached, "network");
    }
  }

  private degrade(
    cached: ReturnType<LegalDocumentCache["read"]>,
    _reason: string,
  ): LegalDocumentsResult {
    if (cached) {
      return {
        documents: cached.documents,
        source: "cache",
        stale: true,
      };
    }
    return {
      documents: this.cache.packagedFallback(),
      source: "packaged",
      stale: true,
    };
  }
}
