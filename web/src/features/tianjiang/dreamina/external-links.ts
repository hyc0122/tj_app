export type DreaminaExternalKind = "official_docs" | "authorization";

/**
 * 中文注释：外部链接统一交给 Electron 主进程白名单处理，前端不得直接打开任意 URL。
 */
export async function openDreaminaExternal(
  kind: DreaminaExternalKind,
  authorizationUrl?: string,
): Promise<void> {
  const query = new URLSearchParams({ kind });
  if (kind === "authorization") {
    if (!authorizationUrl) throw new Error("授权地址不可用，请重新发起登录授权");
    query.set("url", authorizationUrl);
  }
  const response = await fetch(`tianjiang://openDreaminaExternal?${query.toString()}`);
  if (!response.ok) throw new Error("无法调用默认浏览器");
  const payload = await response.json() as { ok?: boolean; error?: string };
  if (!payload.ok) throw new Error(payload.error || "默认浏览器打开失败");
}
