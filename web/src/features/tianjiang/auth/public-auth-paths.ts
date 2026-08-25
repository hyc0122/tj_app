/**
 * 公开认证路径：其 401 表示凭据/验证码错误，绝不能当成“已有登录过期”。
 */
const PUBLIC_AUTH_PATHS = new Set([
  "/tianjiang/auth/login",
  "/tianjiang/auth/register",
  "/tianjiang/auth/captcha",
  "/tianjiang/auth/bootstrap",
  "/tianjiang/auth/clear-saved-account",
]);

/** 原密码挑战返回 401 仅表示本次凭据错误，不代表当前业务 JWT 已失效。 */
const CREDENTIAL_CHALLENGE_PATHS = new Set([
  "/tianjiang/auth/profile/password",
]);

export function isPublicAuthPath(pathname: string): boolean {
  const normalized = pathname.startsWith("/api/")
    ? pathname.slice(4)
    : pathname;
  return PUBLIC_AUTH_PATHS.has(normalized);
}

export function isCredentialChallengePath(pathname: string): boolean {
  const normalized = pathname.startsWith("/api/")
    ? pathname.slice(4)
    : pathname;
  return CREDENTIAL_CHALLENGE_PATHS.has(normalized);
}

/** 静默会话探测：空会话 401 只表示尚未登录。 */
export function isSilentSessionProbe(
  method: string | undefined,
  pathname: string,
): boolean {
  const normalized = pathname.startsWith("/api/")
    ? pathname.slice(4)
    : pathname;
  return method?.toLowerCase() === "get" && normalized === "/tianjiang/auth/session";
}

/**
 * 是否应弹出“登录已过期”全局提示。
 * 公开认证接口与静默会话探测一律禁止。
 */
export function shouldAnnounceSessionExpired(
  status: number | undefined,
  method: string | undefined,
  pathname: string,
): boolean {
  if (status !== 401) return false;
  if (isSilentSessionProbe(method, pathname)) return false;
  if (isPublicAuthPath(pathname)) return false;
  if (isCredentialChallengePath(pathname)) return false;
  return true;
}
