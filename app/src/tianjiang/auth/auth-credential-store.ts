import type { CentralPublicUser } from "./central-session";
import {
  CredentialDecryptionError,
  type CredentialStore,
} from "../crypto/credential-store";

/** 按业务账号隔离的安全凭据与中央会话持久化（底层必须走 safeStorage 加密）。 */
const ACTIVE_USERNAME_KEY = "auth:active-username";
const passwordKey = (username: string) => `auth:password:${normalizeUsername(username)}`;
const sessionKey = (username: string) => `auth:session:${normalizeUsername(username)}`;

export interface SavedCentralSessionPayload {
  serverUrl: string;
  token: string;
  expiresAt: number;
  user: CentralPublicUser;
}

export interface AuthFillCredentials {
  username: string;
  password: string;
}

export class AuthCredentialStore {
  constructor(private readonly credentials: CredentialStore) {}

  /** 登录成功后默认保存：账号密码 + 中央会话材料，全部按用户名隔离。 */
  saveAfterLogin(
    username: string,
    password: string,
    session: SavedCentralSessionPayload,
  ): void {
    const normalized = normalizeUsername(username);
    if (!normalized) throw new Error("用户名无效");
    this.credentials.applyBatch({
      set: {
        [ACTIVE_USERNAME_KEY]: normalized,
        [passwordKey(normalized)]: password,
        [sessionKey(normalized)]: JSON.stringify(session),
      },
      delete: [],
    });
  }

  /** 资料修改后迁移用户名键并持久化轮换后的会话，不需要用户再次输入密码。 */
  updateAfterProfileChange(
    previousUsername: string,
    session: SavedCentralSessionPayload,
  ): void {
    const previous = normalizeUsername(previousUsername);
    const next = normalizeUsername(session.user.username);
    if (!next) throw new Error("用户名无效");
    const savedPassword = this.credentials.get(passwordKey(previous));

    const set: Record<string, string> = {
      [ACTIVE_USERNAME_KEY]: next,
      [sessionKey(next)]: JSON.stringify(session),
    };
    if (savedPassword !== undefined) set[passwordKey(next)] = savedPassword;
    const deleteKeys = previous && previous !== next
      ? [passwordKey(previous), sessionKey(previous)]
      : [];
    // 中文注释：新键写入、active 指针切换与旧键删除必须在一次原子凭据提交中完成。
    this.credentials.applyBatch({ set, delete: deleteKeys });
  }

  /** 密码修改成功后只保存新密码，禁止继续自动登录旧密码。 */
  updateAfterPasswordChange(
    username: string,
    newPassword: string,
    session: SavedCentralSessionPayload,
  ): void {
    this.saveAfterLogin(username, newPassword, session);
  }

  getActiveUsername(): string | undefined {
    const value = this.credentials.get(ACTIVE_USERNAME_KEY);
    return value ? normalizeUsername(value) : undefined;
  }

  getPassword(username: string): string | undefined {
    return this.credentials.get(passwordKey(username));
  }

  getSavedCredentials(): AuthFillCredentials | null {
    const username = this.getActiveUsername();
    if (!username) return null;
    const password = this.getPassword(username);
    if (password === undefined) return null;
    return { username, password };
  }

  getSession(username?: string): SavedCentralSessionPayload | null {
    const active = username ?? this.getActiveUsername();
    if (!active) return null;
    const raw = this.credentials.get(sessionKey(active));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as SavedCentralSessionPayload;
      if (
        typeof parsed.token !== "string"
        || typeof parsed.serverUrl !== "string"
        || typeof parsed.expiresAt !== "number"
        || !parsed.user
        || typeof parsed.user.id !== "number"
        || typeof parsed.user.username !== "string"
      ) {
        return null;
      }
      return parsed;
    } catch (error) {
      if (error instanceof CredentialDecryptionError) throw error;
      return null;
    }
  }

  /** 显式退出或令牌被服务器拒绝：只清会话，保留账号密码供回填。 */
  clearSessionOnly(username?: string): void {
    const active = username ?? this.safeActiveUsername();
    if (!active) return;
    this.credentials.delete(sessionKey(active));
  }

  /**
   * “清除已保存账号”：仅清 auth 命名空间键。
   * 禁止删除 device-recovery-* / profile-key:*。
   */
  clearAllSavedAccounts(): void {
    const active = this.safeActiveUsername();
    if (active) {
      this.credentials.delete(passwordKey(active));
      this.credentials.delete(sessionKey(active));
    }
    this.credentials.delete(ACTIVE_USERNAME_KEY);
  }

  /** 本地判断令牌是否已过期（时钟以本机为准，最终仍以服务器校验为准）。 */
  isSessionExpired(session: SavedCentralSessionPayload, now = Date.now()): boolean {
    return !Number.isFinite(session.expiresAt) || session.expiresAt <= now;
  }

  private safeActiveUsername(): string | undefined {
    try {
      return this.getActiveUsername();
    } catch (error) {
      if (error instanceof CredentialDecryptionError) return undefined;
      throw error;
    }
  }
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}
