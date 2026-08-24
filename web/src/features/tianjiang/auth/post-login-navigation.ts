/**
 * 登录 API 成功后必须真正进入 /project 才算客户端登录完成。
 * 路由守卫若因会话 Cookie 失败重定向回 /login，不得提示“登录成功”。
 */
export interface ProjectRouterLike {
  push(to: string): Promise<unknown> | unknown;
  currentRoute: { value: { path: string } } | { path: string };
}

export interface PostLoginNavigationResult {
  readonly ok: boolean;
  readonly path: string;
}

function readPath(router: ProjectRouterLike): string {
  const route = router.currentRoute as { value?: { path: string }; path?: string };
  if (route && typeof route === "object" && "value" in route && route.value) {
    return route.value.path;
  }
  return (route as { path: string }).path;
}

export async function navigateToProjectAfterAuth(
  router: ProjectRouterLike,
): Promise<PostLoginNavigationResult> {
  try {
    await Promise.resolve(router.push("/project"));
  } catch {
    return { ok: false, path: readPath(router) };
  }
  const path = readPath(router);
  return {
    ok: path === "/project",
    path,
  };
}
