import { CENTRAL_API_URL } from "../auth/central-session";
import type { ClientConfigCache } from "./cache";
import {
  parsePublicClientConfig,
  type PublicClientConfig,
} from "./contracts";

const PATH = "/api/tianjiang/v1/public/client-config";

export type ClientConfigSource = "network" | "cache" | "packaged";

export interface ClientConfigResult {
  config: PublicClientConfig;
  source: ClientConfigSource;
  stale: boolean;
}

export class PublicClientConfigClient {
  constructor(
    private readonly cache: ClientConfigCache,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getLatest(): Promise<ClientConfigResult> {
    const cached = this.cache.read();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      let response: Response;
      try {
        response = await this.fetcher(`${CENTRAL_API_URL}${PATH}`, {
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

      if (response.status === 304 && cached) {
        return { config: cached.config, source: "cache", stale: false };
      }
      if (!response.ok) return this.degrade(cached);

      const body = await response.json() as { code?: unknown; data?: unknown };
      if (body.code !== 0 || body.data === undefined) return this.degrade(cached);
      const config = parsePublicClientConfig(body.data);
      const etag = response.headers.get("etag") ?? cached?.etag ?? "";
      try {
        this.cache.write(config, etag);
      } catch {
        // 写缓存失败仍返回网络结果
      }
      return { config, source: "network", stale: false };
    } catch {
      console.info("[client-config] network-or-parse-failed");
      return this.degrade(cached);
    }
  }

  private degrade(
    cached: ReturnType<ClientConfigCache["read"]>,
  ): ClientConfigResult {
    if (cached) return { config: cached.config, source: "cache", stale: true };
    return { config: this.cache.packaged(), source: "packaged", stale: true };
  }
}
