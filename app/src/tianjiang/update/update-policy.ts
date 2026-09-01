import type { PublicClientConfig } from "../client-config/contracts";

export type DesktopUpdatePolicy = PublicClientConfig["updatePolicy"];

/** feed 只能由主进程按严格 channel、平台和架构映射，renderer 和公开配置都不能提供 URL。 */
export function resolveDesktopUpdateFeed(
  channel: DesktopUpdatePolicy["channel"],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const target = platform === "win32" && arch === "x64" ? "windows/x64"
    : platform === "darwin" && (arch === "x64" || arch === "arm64") ? `macos/${arch}`
      : platform === "linux" && (arch === "x64" || arch === "arm64") ? `linux/${arch}`
        : undefined;
  if (!target) throw new Error("不支持的更新平台或架构");
  if (channel !== "stable" && channel !== "beta") throw new Error("更新通道无效");
  return `https://cdn.j11.com.cn/desktop/${channel}/${target}`;
}

/** 新双通道 Catalog 当前只批准 Windows x64，原生 updater feed 复用同一固定目标。 */
export function resolveWindowsX64UpdateFeed(
  channel: DesktopUpdatePolicy["channel"],
): string {
  return resolveDesktopUpdateFeed(channel, "win32", "x64");
}
