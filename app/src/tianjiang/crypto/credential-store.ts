import fs from "node:fs";
import path from "node:path";

/** 解密失败类别：仅内部诊断，禁止回显 Electron 英文原文。 */
export type CredentialDecryptionCategory =
  | "decrypt_failed"
  | "encryption_unavailable"
  | "corrupt_payload";

/**
 * 类型化凭据解密错误。
 * 只携带安全中文消息、类别与内部键名；禁止保留 safeStorage 原始英文异常。
 */
export class CredentialDecryptionError extends Error {
  readonly code = "CREDENTIAL_DECRYPTION_FAILED" as const;
  readonly category: CredentialDecryptionCategory;
  readonly keyName: string;

  constructor(category: CredentialDecryptionCategory, keyName: string) {
    super("本地凭据解密失败，需要重新登录后恢复");
    this.name = "CredentialDecryptionError";
    this.category = category;
    this.keyName = keyName;
  }
}

/** 不可读密文的稳定备份后缀（幂等：同键只备份一次）。 */
export const UNREADABLE_CIPHERTEXT_BACKUP_SUFFIX = "unreadable-backup";

export function unreadableBackupKey(name: string): string {
  return `${name}:${UNREADABLE_CIPHERTEXT_BACKUP_SUFFIX}`;
}

export interface CredentialStore {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
  /** 是否存在该键（不解密） */
  has(name: string): boolean;
  /** 读取磁盘/内存中的原始密文或存储值（不解密） */
  getCiphertext(name: string): string | undefined;
  /**
   * 将 name 的不可读密文备份到 name:unreadable-backup。
   * 已存在备份时不覆盖（幂等）；不删除原键、不删整个凭据文件。
   */
  backupUnreadableCiphertext(name: string): boolean;
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();
  private readonly undecryptable = new Set<string>();

  /** 测试：将某键标记为解密失败（模拟跨运行形态密文不兼容）。 */
  markUndecryptable(name: string): void {
    this.undecryptable.add(name);
  }

  clearUndecryptable(name: string): void {
    this.undecryptable.delete(name);
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  getCiphertext(name: string): string | undefined {
    return this.values.get(name);
  }

  get(name: string): string | undefined {
    if (!this.values.has(name)) return undefined;
    if (this.undecryptable.has(name)) {
      throw new CredentialDecryptionError("decrypt_failed", name);
    }
    return this.values.get(name);
  }

  set(name: string, value: string): void {
    this.values.set(name, value);
    this.undecryptable.delete(name);
  }

  delete(name: string): void {
    this.values.delete(name);
    this.undecryptable.delete(name);
  }

  backupUnreadableCiphertext(name: string): boolean {
    const ciphertext = this.values.get(name);
    if (ciphertext === undefined) return false;
    const backup = unreadableBackupKey(name);
    if (this.values.has(backup)) return true;
    this.values.set(backup, ciphertext);
    return true;
  }
}

export class ElectronCredentialStore implements CredentialStore {
  constructor(private readonly storagePath: string) {}

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.readAll(), name);
  }

  getCiphertext(name: string): string | undefined {
    const encrypted = this.readAll()[name];
    return typeof encrypted === "string" ? encrypted : undefined;
  }

  get(name: string): string | undefined {
    const encrypted = this.readAll()[name];
    if (encrypted === undefined) return undefined;
    try {
      const { safeStorage } = require("electron") as typeof import("electron");
      if (!safeStorage.isEncryptionAvailable()) {
        throw new CredentialDecryptionError("encryption_unavailable", name);
      }
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch (error) {
      if (error instanceof CredentialDecryptionError) throw error;
      // 禁止回显 Electron/safeStorage 英文异常原文
      throw new CredentialDecryptionError("decrypt_failed", name);
    }
  }

  set(name: string, value: string): void {
    let encrypted: string;
    try {
      const { safeStorage } = require("electron") as typeof import("electron");
      if (!safeStorage.isEncryptionAvailable()) {
        throw new CredentialDecryptionError("encryption_unavailable", name);
      }
      encrypted = safeStorage.encryptString(value).toString("base64");
    } catch (error) {
      if (error instanceof CredentialDecryptionError) throw error;
      throw new CredentialDecryptionError("encryption_unavailable", name);
    }
    const values = this.readAll();
    values[name] = encrypted;
    this.writeAll(values);
  }

  delete(name: string): void {
    const values = this.readAll();
    delete values[name];
    this.writeAll(values);
  }

  backupUnreadableCiphertext(name: string): boolean {
    const values = this.readAll();
    const ciphertext = values[name];
    if (typeof ciphertext !== "string") return false;
    const backup = unreadableBackupKey(name);
    if (typeof values[backup] === "string") return true;
    values[backup] = ciphertext;
    this.writeAll(values);
    return true;
  }

  private readAll(): Record<string, string> {
    if (!fs.existsSync(this.storagePath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new CredentialDecryptionError("corrupt_payload", this.storagePath);
      }
      return parsed as Record<string, string>;
    } catch (error) {
      if (error instanceof CredentialDecryptionError) throw error;
      throw new CredentialDecryptionError("corrupt_payload", this.storagePath);
    }
  }

  private writeAll(values: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporary = `${this.storagePath}.tmp`;
    // 文件只保存操作系统加密后的密文，并通过同目录原子替换避免写入半文件。
    fs.writeFileSync(temporary, JSON.stringify(values), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.storagePath);
    try {
      fs.chmodSync(this.storagePath, 0o600);
    } catch {
      // Windows ACL 由系统管理。
    }
  }
}

/**
 * 测试/迁移验收：以 scope 派生密钥模拟「开发态 Electron vs 打包 EXE」密文不兼容。
 * 同一文件路径、不同 scope 时 get 必须抛 CredentialDecryptionError。
 */
export class ScopedCredentialStore implements CredentialStore {
  constructor(
    private readonly storagePath: string,
    private readonly scopeId: string,
  ) {
    if (!scopeId.trim()) throw new Error("scopeId 无效");
  }

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.readAll(), name);
  }

  getCiphertext(name: string): string | undefined {
    const row = this.readAll()[name];
    return typeof row === "string" ? row : undefined;
  }

  get(name: string): string | undefined {
    const packed = this.readAll()[name];
    if (packed === undefined) return undefined;
    try {
      return decryptScoped(packed, this.scopeId);
    } catch {
      throw new CredentialDecryptionError("decrypt_failed", name);
    }
  }

  set(name: string, value: string): void {
    const values = this.readAll();
    values[name] = encryptScoped(value, this.scopeId);
    this.writeAll(values);
  }

  delete(name: string): void {
    const values = this.readAll();
    delete values[name];
    this.writeAll(values);
  }

  backupUnreadableCiphertext(name: string): boolean {
    const values = this.readAll();
    const ciphertext = values[name];
    if (typeof ciphertext !== "string") return false;
    const backup = unreadableBackupKey(name);
    if (typeof values[backup] === "string") return true;
    values[backup] = ciphertext;
    this.writeAll(values);
    return true;
  }

  private readAll(): Record<string, string> {
    if (!fs.existsSync(this.storagePath)) return {};
    return JSON.parse(fs.readFileSync(this.storagePath, "utf8")) as Record<string, string>;
  }

  private writeAll(values: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporary = `${this.storagePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(values), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.storagePath);
  }
}

function encryptScoped(plaintext: string, scopeId: string): string {
  // 使用 crypto 内建，避免测试依赖 electron.safeStorage
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const key = crypto.createHash("sha256").update(`tj-scoped-cred:v1:${scopeId}`).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptScoped(packed: string, scopeId: string): string {
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const buf = Buffer.from(packed, "base64");
  if (buf.length < 28) throw new Error("corrupt");
  const key = crypto.createHash("sha256").update(`tj-scoped-cred:v1:${scopeId}`).digest();
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
