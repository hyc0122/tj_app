import type { AuthCredentialStore } from "./auth-credential-store";
import type {
  CentralAuthGateway,
  CentralPublicUser,
  CreateCentralSession,
  MemoryCentralSessionStore,
} from "./central-session";
import { CentralBusinessError, CentralRequestError } from "./central-session";
import { CentralServiceUnavailableError } from "./central-service-error";
import { isKeyServiceUnavailableError } from "./key-service-error";
import { CredentialDecryptionError } from "../crypto/credential-store";

export type AuthBootstrapMode =
  | "session"
  | "auto_login"
  | "fill"
  | "offline"
  | "reauth_required"
  | "none";

export interface AuthBootstrapResult {
  mode: AuthBootstrapMode;
  user?: CentralPublicUser;
  username?: string;
  password?: string;
  keyServiceDegraded?: boolean;
  message?: string;
  sessionCookie?: {
    id: string;
    maxAgeSeconds: number;
  };
}

export interface AuthBootstrapDeps {
  credentialStore: AuthCredentialStore;
  sessionStore: MemoryCentralSessionStore;
  gateway: CentralAuthGateway;
  readCookieSessionId: () => string;
  onLogin: (session: {
    id: string;
    serverUrl: string;
    token: string;
    expiresAt: number;
    user: CentralPublicUser;
    validatedAt: number;
  }) => Promise<{ keyServiceDegraded: boolean }>;
  activateUserDatabase: (input: { issuer: string; userId: number }) => Promise<void>;
  now?: () => number;
}

/** 认证密文不可读时的安全中文提示（允许手工登录，不删 device/profile 密钥）。 */
export const REAUTH_REQUIRED_MESSAGE =
  "本地登录凭据无法解密，请重新输入账号密码登录以恢复同步。设备与个人配置密钥备份已保留。";

/**
 * 启动/登录页引导：
 * a) 有效 token → 自动登录
 * b) 失效/被拒 → 清 token，回填账号密码
 * c) 网络暂时不可用 → 不删凭据，提示离线重试
 * d) 认证密文不可解密 → reauth_required，允许手工登录，不删 device-recovery/profile-key
 */
export async function bootstrapAuthState(
  deps: AuthBootstrapDeps,
): Promise<AuthBootstrapResult> {
  const now = deps.now ?? Date.now;
  const cookieId = deps.readCookieSessionId();
  const live = cookieId ? deps.sessionStore.get(cookieId) : undefined;
  if (live) {
    return { mode: "session", user: live.user };
  }

  let saved: { username: string; password: string } | null = null;
  let persisted: ReturnType<AuthCredentialStore["getSession"]> = null;
  try {
    saved = deps.credentialStore.getSavedCredentials();
    persisted = deps.credentialStore.getSession();
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      // 不得静默 mode:none；不得删除 device-recovery-* / profile-key:*
      return {
        mode: "reauth_required",
        message: REAUTH_REQUIRED_MESSAGE,
        username: tryUsernameOnly(deps.credentialStore),
      };
    }
    throw error;
  }

  if (persisted) {
    if (deps.credentialStore.isSessionExpired(persisted, now())) {
      // 本地已过期：清 token，保留账号密码。
      deps.credentialStore.clearSessionOnly(persisted.user.username);
      return fillResult(saved, persisted.user.username);
    }

    let createdSessionId: string | undefined;
    try {
      const created = deps.sessionStore.create({
        serverUrl: persisted.serverUrl,
        token: persisted.token,
        expiresAt: persisted.expiresAt,
        user: persisted.user,
      });
      createdSessionId = created.id;
      await deps.gateway.validate(created);
      const loginResult = await deps.onLogin(created);
      await deps.activateUserDatabase({
        issuer: created.serverUrl,
        userId: created.user.id,
      });
      // 刷新持久化会话（validate 可能轮换 token）；保留原密码。
      if (saved?.password) {
        deps.credentialStore.saveAfterLogin(
          created.user.username,
          saved.password,
          {
            serverUrl: created.serverUrl,
            token: created.token,
            expiresAt: created.expiresAt,
            user: created.user,
          },
        );
      }
      const maxAge = Math.max(1, Math.floor((created.expiresAt - now()) / 1000));
      return {
        mode: "auto_login",
        user: created.user,
        keyServiceDegraded: loginResult.keyServiceDegraded,
        sessionCookie: { id: created.id, maxAgeSeconds: maxAge },
      };
    } catch (error) {
      if (createdSessionId) deps.sessionStore.delete(createdSessionId);
      if (error instanceof CredentialDecryptionError) {
        return {
          mode: "reauth_required",
          message: REAUTH_REQUIRED_MESSAGE,
          username: saved?.username ?? persisted.user.username,
        };
      }
      // 网络/中央暂不可用：保留 token 与账号密码。
      if (
        error instanceof CentralServiceUnavailableError
        || isNetworkish(error)
      ) {
        return {
          mode: "offline",
          username: saved?.username ?? persisted.user.username,
          password: saved?.password,
          message: "网络暂时不可用，已保留本地凭据，请稍后重试自动登录。",
        };
      }
      // 服务器拒绝或认证失败：只清 token。
      if (
        error instanceof CentralRequestError
        || error instanceof CentralBusinessError
        || (error && typeof error === "object" && "status" in error
          && Number((error as { status?: unknown }).status) === 401)
      ) {
        deps.credentialStore.clearSessionOnly(persisted.user.username);
        return fillResult(saved, persisted.user.username);
      }
      // 未知错误偏保守：不删凭据。
      return {
        mode: "offline",
        username: saved?.username ?? persisted.user.username,
        password: saved?.password,
        message: "自动登录暂时失败，已保留本地凭据，请重试。",
      };
    }
  }

  if (saved) {
    return {
      mode: "fill",
      username: saved.username,
      password: saved.password,
    };
  }
  return { mode: "none" };
}

function tryUsernameOnly(store: AuthCredentialStore): string | undefined {
  try {
    return store.getActiveUsername();
  } catch {
    return undefined;
  }
}

function fillResult(
  saved: { username: string; password: string } | null,
  fallbackUsername: string,
): AuthBootstrapResult {
  return {
    mode: "fill",
    username: saved?.username ?? fallbackUsername,
    password: saved?.password ?? "",
  };
}

function isNetworkish(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /network|timeout|ECONN|ENOTFOUND|fetch failed|AbortError/i.test(
    error.message,
  );
}

export function createSessionPayload(
  input: CreateCentralSession,
): {
  serverUrl: string;
  token: string;
  expiresAt: number;
  user: CentralPublicUser;
} {
  return {
    serverUrl: input.serverUrl,
    token: input.token,
    expiresAt: input.expiresAt,
    user: input.user,
  };
}

export { isKeyServiceUnavailableError };
