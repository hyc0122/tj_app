import fs from "node:fs";
import path from "node:path";

import {
  PACKAGED_PUBLIC_CLIENT_CONFIG,
  parsePublicClientConfig,
  type PublicClientConfig,
} from "./contracts";

export interface ClientConfigCacheRecord {
  cacheVersion: 1;
  etag: string;
  cachedAt: string;
  config: PublicClientConfig;
}

export function clientConfigCachePath(dataRoot: string): string {
  return path.join(dataRoot, "public-cache", "client-config.json");
}

export class ClientConfigCache {
  constructor(private readonly dataRoot: string) {}

  get path(): string {
    return clientConfigCachePath(this.dataRoot);
  }

  read(): ClientConfigCacheRecord | null {
    try {
      if (!fs.existsSync(this.path)) return null;
      const raw = JSON.parse(fs.readFileSync(this.path, "utf8")) as Record<string, unknown>;
      if (raw.cacheVersion !== 1 || typeof raw.etag !== "string") return null;
      return {
        cacheVersion: 1,
        etag: raw.etag,
        cachedAt: String(raw.cachedAt ?? ""),
        config: parsePublicClientConfig(raw.config),
      };
    } catch {
      return null;
    }
  }

  write(config: PublicClientConfig, etag: string): ClientConfigCacheRecord {
    const record: ClientConfigCacheRecord = {
      cacheVersion: 1,
      etag,
      cachedAt: new Date().toISOString(),
      config: parsePublicClientConfig(config),
    };
    const target = this.path;
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    const temporary = path.join(dir, `client-config.${process.pid}.${Date.now()}.tmp`);
    // 同目录原子替换，禁止写系统 temp。
    fs.writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, target);
    return record;
  }

  packaged(): PublicClientConfig {
    return { ...PACKAGED_PUBLIC_CLIENT_CONFIG };
  }
}
