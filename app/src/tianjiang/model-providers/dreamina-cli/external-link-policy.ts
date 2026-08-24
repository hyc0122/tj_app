export const DREAMINA_OFFICIAL_DOCS_URL =
  "https://bytedance.larkoffice.com/wiki/FVTwwm0bGiishxkKOoScdHR2nsg";

export type TrustedDreaminaExternalTarget =
  | { kind: "official_docs" }
  | { kind: "authorization"; url: string };

export function resolveDreaminaExternalTarget(
  target: TrustedDreaminaExternalTarget,
): { ok: true; url: string } | { ok: false; reason: string } {
  if (target.kind === "official_docs") {
    return { ok: true, url: DREAMINA_OFFICIAL_DOCS_URL };
  }
  let parsed: URL;
  try {
    parsed = new URL(target.url);
  } catch {
    return { ok: false, reason: "授权地址无效" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "授权地址必须是 HTTPS" };
  if (parsed.username || parsed.password) return { ok: false, reason: "授权地址不得包含用户名或密码" };
  // 中文注释：只允许精确官方授权主机，拒绝后缀仿冒。
  if (parsed.hostname !== "jimeng.jianying.com") {
    return { ok: false, reason: "授权地址主机不在白名单" };
  }
  return { ok: true, url: parsed.toString() };
}
