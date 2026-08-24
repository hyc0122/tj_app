import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { ProfileCrypto } from "../crypto/profile-crypto";
import {
  assertRegistrySensitivity,
  isDeviceLocalProfileSyncKey,
  isRegisteredProfileSyncKey,
} from "../sync/profile-sync-registry";

interface ProfileRow {
  setting_value: string;
  sensitive: number;
}

export interface StoredProfileEntry {
  value: string;
  sensitive: boolean;
}

export type ProfilePendingOp = "set" | "delete";

export interface ProfilePendingMutation {
  key: string;
  op: ProfilePendingOp;
  entry?: StoredProfileEntry;
}

export class ProfileStore {
  readonly databasePath: string;
  private readonly database: Database.Database;

  constructor(
    dataRoot: string,
    readonly userUUID: string,
    private readonly crypto: ProfileCrypto,
  ) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userUUID)) {
      throw new Error("用户 UUID 无效");
    }
    const userDirectory = path.resolve(dataRoot, "users", userUUID);
    const expectedRoot = path.resolve(dataRoot, "users") + path.sep;
    if (!userDirectory.startsWith(expectedRoot)) throw new Error("个人配置路径越界");
    fs.mkdirSync(userDirectory, { recursive: true });
    this.databasePath = path.join(userDirectory, "profile.sqlite");
    const database = new Database(this.databasePath);
    try {
      database.pragma("journal_mode = WAL");
      database.exec(`
        CREATE TABLE IF NOT EXISTS profile_settings (
          setting_key TEXT PRIMARY KEY,
          setting_value TEXT NOT NULL,
          sensitive INTEGER NOT NULL CHECK (sensitive IN (0, 1)),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS profile_meta (
          meta_key TEXT PRIMARY KEY,
          meta_value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS profile_pending_mutations (
          setting_key TEXT PRIMARY KEY,
          op TEXT NOT NULL CHECK (op IN ('set', 'delete')),
          setting_value TEXT,
          sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
          updated_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO profile_meta(meta_key, meta_value) VALUES ('remote_version', '0');
        PRAGMA user_version = 3;
      `);
      this.database = database;
    } catch (error) {
      // 构造器尚未返回时只能由局部句柄负责释放，避免 Windows 永久锁住 profile.sqlite。
      database.close();
      throw error;
    }
  }

  set(key: string, value: string, sensitive: boolean): void {
    validateProfileKey(key);
    const stored = sensitive ? this.crypto.encrypt(value) : `plain:${value}`;
    this.database.prepare(`
      INSERT INTO profile_settings(setting_key, setting_value, sensitive, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        sensitive = excluded.sensitive,
        updated_at = excluded.updated_at
    `).run(key, stored, sensitive ? 1 : 0, new Date().toISOString());
  }

  get(key: string): string | undefined {
    validateProfileKey(key);
    const row = this.database.prepare(
      "SELECT setting_value, sensitive FROM profile_settings WHERE setting_key = ?",
    ).get(key) as ProfileRow | undefined;
    if (!row) return undefined;
    return row.sensitive ? this.crypto.decrypt(row.setting_value) : row.setting_value.replace(/^plain:/, "");
  }

  remove(key: string): void {
    validateProfileKey(key);
    this.database.prepare("DELETE FROM profile_settings WHERE setting_key = ?").run(key);
  }

  listKeys(): string[] {
    return (this.database.prepare("SELECT setting_key FROM profile_settings ORDER BY setting_key").all() as Array<{
      setting_key: string;
    }>).map((row) => row.setting_key);
  }

  exportStoredSnapshot(): Record<string, StoredProfileEntry> {
    return this.readStoredRows((key) => isRegisteredProfileSyncKey(key));
  }

  exportLocalSnapshot(): Record<string, StoredProfileEntry> {
    return this.readStoredRows(() => true);
  }

  /** 解密远端快照但不抬升本地版本，供先回写真实设置再提交 profile.sqlite。 */
  decodeStoredEntries(entries: Record<string, StoredProfileEntry>): Record<string, string> {
    const live: Record<string, string> = {};
    for (const [key, entry] of Object.entries(entries)) {
      validateStoredEntry(key, entry);
      if (!isRegisteredProfileSyncKey(key) || isDeviceLocalProfileSyncKey(key)) continue;
      assertRegistrySensitivity(key, entry.sensitive);
      live[key] = entry.sensitive
        ? this.crypto.decrypt(entry.value)
        : entry.value.replace(/^plain:/, "");
    }
    return live;
  }

  applyStoredSnapshot(entries: Record<string, StoredProfileEntry>, version: number): void {
    if (!Number.isSafeInteger(version) || version < 0) throw new Error("个人配置版本无效");
    const incoming: Record<string, StoredProfileEntry> = {};
    for (const [key, entry] of Object.entries(entries)) {
      validateStoredEntry(key, entry);
      // 中文注释：远端快照只允许覆盖已登记键；未登记本机脏数据保留且不上云。
      if (!isRegisteredProfileSyncKey(key) || isDeviceLocalProfileSyncKey(key)) continue;
      assertRegistrySensitivity(key, entry.sensitive);
      incoming[key] = entry;
    }
    const apply = this.database.transaction(() => {
      const retained = this.readStoredRows((key) =>
        !isRegisteredProfileSyncKey(key) && !isDeviceLocalProfileSyncKey(key));
      this.database.prepare("DELETE FROM profile_settings").run();
      const insert = this.database.prepare(`
        INSERT INTO profile_settings(setting_key, setting_value, sensitive, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      const updatedAt = new Date().toISOString();
      for (const [key, entry] of Object.entries({ ...incoming, ...retained })) {
        insert.run(key, entry.value, entry.sensitive ? 1 : 0, updatedAt);
      }
      this.database.prepare(
        "UPDATE profile_meta SET meta_value = ? WHERE meta_key = 'remote_version'",
      ).run(String(version));
    });
    apply();
  }

  getMeta(key: string): string | undefined {
    const row = this.database.prepare(
      "SELECT meta_value FROM profile_meta WHERE meta_key = ?",
    ).get(key) as { meta_value?: string } | undefined;
    return row?.meta_value;
  }

  setMeta(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO profile_meta(meta_key, meta_value) VALUES (?, ?)
      ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value
    `).run(key, value);
  }

  getProfileVersion(): number {
    const row = this.database.prepare(
      "SELECT meta_value FROM profile_meta WHERE meta_key = 'remote_version'",
    ).get() as { meta_value: string };
    const version = Number(row.meta_value);
    if (!Number.isSafeInteger(version) || version < 0) throw new Error("个人配置版本损坏");
    return version;
  }

  /** 中文注释：本地快照与 pending journal 必须同一 SQLite 事务，中途失败整段回滚。 */
  runAtomic(work: () => void): void {
    this.database.transaction(work)();
  }

  upsertPendingMutation(mutation: ProfilePendingMutation): void {
    validateProfileKey(mutation.key);
    if (mutation.op !== "set" && mutation.op !== "delete") {
      throw new Error("个人配置 pending 操作无效");
    }
    if (mutation.op === "set") {
      if (!mutation.entry) throw new Error("个人配置 pending set 缺少条目");
      validateStoredEntry(mutation.key, mutation.entry);
    }
    this.database.prepare(`
      INSERT INTO profile_pending_mutations(setting_key, op, setting_value, sensitive, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET
        op = excluded.op,
        setting_value = excluded.setting_value,
        sensitive = excluded.sensitive,
        updated_at = excluded.updated_at
    `).run(
      mutation.key,
      mutation.op,
      mutation.op === "set" ? mutation.entry!.value : null,
      mutation.op === "set" && mutation.entry?.sensitive ? 1 : 0,
      new Date().toISOString(),
    );
  }

  listPendingMutations(): ProfilePendingMutation[] {
    const rows = this.database.prepare(
      "SELECT setting_key, op, setting_value, sensitive FROM profile_pending_mutations ORDER BY setting_key",
    ).all() as Array<{ setting_key: string; op: string; setting_value: string | null; sensitive: number }>;
    return rows.map((row) => {
      const mutation: ProfilePendingMutation = {
        key: row.setting_key,
        op: row.op === "delete" ? "delete" : "set",
      };
      if (mutation.op === "set" && row.setting_value != null) {
        mutation.entry = { value: row.setting_value, sensitive: row.sensitive === 1 };
      }
      return mutation;
    });
  }

  hasPendingMutations(): boolean {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS c FROM profile_pending_mutations",
    ).get() as { c: number };
    return Number(row.c) > 0;
  }

  clearPendingMutations(): void {
    this.database.prepare("DELETE FROM profile_pending_mutations").run();
  }

  close(): void {
    this.database.close();
  }

  private readStoredRows(
    include: (key: string) => boolean,
  ): Record<string, StoredProfileEntry> {
    const rows = this.database.prepare(
      "SELECT setting_key, setting_value, sensitive FROM profile_settings ORDER BY setting_key",
    ).all() as Array<{ setting_key: string; setting_value: string; sensitive: number }>;
    return Object.fromEntries(rows.filter((row) => include(row.setting_key)).map((row) => [
      row.setting_key,
      { value: row.setting_value, sensitive: row.sensitive === 1 },
    ]));
  }
}

function validateProfileKey(key: string): void {
  if (!/^[a-z][a-z0-9_.-]{0,127}$/i.test(key) || /^(?:team|project)\./i.test(key)) {
    throw new Error("个人配置键无效");
  }
}

function validateStoredEntry(key: string, entry: StoredProfileEntry): void {
  validateProfileKey(key);
  if (
    typeof entry.value !== "string"
    || (entry.sensitive && !entry.value.startsWith("tj-profile:v1:"))
    || (!entry.sensitive && !entry.value.startsWith("plain:"))
  ) {
    throw new Error("个人配置快照包含无效条目");
  }
}
