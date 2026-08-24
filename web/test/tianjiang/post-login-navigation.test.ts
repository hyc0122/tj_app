// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { navigateToProjectAfterAuth } from "@/features/tianjiang/auth/post-login-navigation";

describe("登录后导航必须真实进入 /project", () => {
  it("路由成功到达 /project 时 ok=true", async () => {
    const router = {
      push: vi.fn(async () => {
        router.currentRoute.value.path = "/project";
      }),
      currentRoute: { value: { path: "/login" } },
    };
    const result = await navigateToProjectAfterAuth(router);
    expect(router.push).toHaveBeenCalledWith("/project");
    expect(result).toEqual({ ok: true, path: "/project" });
  });

  it("守卫重定向回 /login 时 ok=false，不得视为成功", async () => {
    const router = {
      push: vi.fn(async () => {
        // 模拟会话探测失败：最终停在登录页。
        router.currentRoute.value.path = "/login";
      }),
      currentRoute: { value: { path: "/login" } },
    };
    const result = await navigateToProjectAfterAuth(router);
    expect(result.ok).toBe(false);
    expect(result.path).toBe("/login");
  });
});
