import {
  resolveDreaminaExternalTarget,
  type TrustedDreaminaExternalTarget,
} from "./external-link-policy";

/** Electron 自定义协议会把主机名规范成小写，handler key 必须使用相同形式。 */
export const DREAMINA_EXTERNAL_PROTOCOL_HOST = "opendreaminaexternal";

/** 只有显式构造的公开错误才允许进入桌面协议响应。 */
export class DesktopProtocolPublicError extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage);
    this.name = "DesktopProtocolPublicError";
  }
}

export function normalizeDesktopProtocolHost(host: string): string {
  return host.trim().toLowerCase();
}

export async function openDreaminaDesktopExternal(
  input: TrustedDreaminaExternalTarget,
  openExternal: (url: string) => Promise<void>,
): Promise<{ ok: true }> {
  const resolved = resolveDreaminaExternalTarget(input);
  if (!resolved.ok) {
    throw new DesktopProtocolPublicError(resolved.reason);
  }

  try {
    // 中文注释：必须等待 Electron 的 Promise，浏览器调用失败才能回传给 renderer。
    await openExternal(resolved.url);
  } catch {
    // 中文注释：不拼接目标 URL 或底层异常，避免授权查询参数进入响应和日志。
    throw new DesktopProtocolPublicError("无法调用默认浏览器");
  }

  return { ok: true };
}

export async function settleDesktopProtocolAction(
  action: () => object | Promise<object>,
): Promise<{ status: 200 | 502; body: object }> {
  try {
    return { status: 200, body: await action() };
  } catch (error) {
    // 中文注释：未知异常可能带本机路径或授权参数，只有受控公开错误可透传安全文案。
    return {
      status: 502,
      body: {
        ok: false,
        error: error instanceof DesktopProtocolPublicError
          ? error.publicMessage
          : "桌面操作失败",
      },
    };
  }
}
