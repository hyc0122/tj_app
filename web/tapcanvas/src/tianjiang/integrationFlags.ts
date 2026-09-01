/** 中文注释：天将漫创接入开关。团队/社区入口隐藏但不删除后续扩展能力。 */
export const TAPCANVAS_HIDE_TEAM = true;
export const TAPCANVAS_HIDE_COMMUNITY = true;
export const TAPCANVAS_TIANJIANG_ADAPTER = true;
export const TAPCANVAS_BASE = "/tapcanvas";

export function stripTapcanvasBase(pathname: string): string {
  if (
    pathname === "/tapcanvas"
    || pathname === "/tapcanvas/"
    || pathname === "/tapcanvas/index.html"
  ) {
    return "/canvas";
  }
  if (pathname.startsWith("/tapcanvas/")) {
    const rest = pathname.slice("/tapcanvas".length);
    return rest.startsWith("/") ? rest : `/${rest}`;
  }
  return pathname;
}
