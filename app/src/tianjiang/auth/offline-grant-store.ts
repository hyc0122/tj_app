import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RuntimeProjectCatalogItem } from "../runtime/central-runtime-adapter";
import type { CachedOfflineGrant } from "./offline-grant";

export interface OfflineRuntimeCache {
  issuer: string;
  userId: number;
  grant: CachedOfflineGrant;
  catalog: RuntimeProjectCatalogItem[];
}

/**
 * 离线授权和目录缓存使用 AES-256-GCM 加密落盘。
 * 密钥文件仅允许当前用户读取；Electron 凭据存储收口不影响缓存格式。
 */
export class OfflineGrantStore {
  private readonly cachePath: string;
  private readonly keyPath: string;

  constructor(private readonly dataRoot: string) {
    this.cachePath = path.join(dataRoot, "auth", "offline-runtime.cache");
    this.keyPath = path.join(dataRoot, "runtime-credentials", "offline-cache.key");
  }

  save(cache: OfflineRuntimeCache): void {
    const key = this.loadOrCreateKey();
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from("tianjiang-offline-runtime:v1", "utf8"));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(cache), "utf8"),
      cipher.final(),
    ]);
    const payload = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    const temporary = `${this.cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `tj-offline:v1:${payload}`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.cachePath);
  }

  load(): OfflineRuntimeCache | undefined {
    if (!fs.existsSync(this.cachePath) || !fs.existsSync(this.keyPath)) return undefined;
    try {
      const encoded = fs.readFileSync(this.cachePath, "utf8");
      if (!encoded.startsWith("tj-offline:v1:")) return undefined;
      const payload = Buffer.from(encoded.slice("tj-offline:v1:".length), "base64url");
      if (payload.length < 29) return undefined;
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.readKey(),
        payload.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from("tianjiang-offline-runtime:v1", "utf8"));
      decipher.setAuthTag(payload.subarray(12, 28));
      const plain = Buffer.concat([
        decipher.update(payload.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plain) as OfflineRuntimeCache;
    } catch {
      return undefined;
    }
  }

  clear(): void {
    fs.rmSync(this.cachePath, { force: true });
  }

  private loadOrCreateKey(): Buffer {
    if (fs.existsSync(this.keyPath)) return this.readKey();
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyPath, key.toString("base64url"), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return key;
  }

  private readKey(): Buffer {
    const key = Buffer.from(fs.readFileSync(this.keyPath, "utf8"), "base64url");
    if (key.length !== 32) throw new Error("离线授权缓存密钥损坏");
    return key;
  }
}
