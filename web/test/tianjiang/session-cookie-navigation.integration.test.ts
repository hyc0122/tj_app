// @vitest-environment jsdom
/**
 * 真实闭环：同源 API 设置 HttpOnly 会话 Cookie 后，
 * restoreCentralSession → 路由守卫允许进入 /project。
 * 禁止只 mock Router.push 当作登录完成。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { createApp, defineComponent, h, nextTick } from "vue";

const sessionHandler = vi.fn();

vi.mock("@/utils/axios", () => {
  const instance = {
    get: async (url: string) => {
      if (url === "/tianjiang/auth/session" || url.endsWith("/tianjiang/auth/session")) {
        return sessionHandler();
      }
      throw new Error(`unexpected get ${url}`);
    },
    post: async () => ({ data: {} }),
    interceptors: {
      request: { use: () => undefined },
      response: { use: () => undefined },
    },
  };
  return { default: instance };
});

import { restoreCentralSession } from "@/features/tianjiang/auth/client";
import { navigateToProjectAfterAuth } from "@/features/tianjiang/auth/post-login-navigation";

describe("Cookie 会话 → /auth/session → /project 闭环", () => {
  let router: Router;
  let app: ReturnType<typeof createApp> | null = null;

  beforeEach(async () => {
    sessionHandler.mockReset();
    document.cookie = "tj_session=opaque-session-id; path=/api";
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/login", component: defineComponent({ render: () => h("div", "login") }) },
        { path: "/project", component: defineComponent({ render: () => h("div", "project") }) },
      ],
    });
    router.beforeEach(async (to, _from, next) => {
      if (to.path === "/login") {
        next();
        return;
      }
      if (await restoreCentralSession()) next();
      else next("/login");
    });
    app = createApp(defineComponent({ render: () => h("div") }));
    app.use(router);
    await router.push("/login");
    await router.isReady();
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    document.cookie = "tj_session=; path=/api; Max-Age=0";
  });

  it("会话有效时导航到 /project 成功", async () => {
    sessionHandler.mockResolvedValue({
      data: { user: { id: 7, username: "alice", nickname: "Alice" } },
    });
    const result = await navigateToProjectAfterAuth(router);
    await nextTick();
    expect(sessionHandler).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(router.currentRoute.value.path).toBe("/project");
  });

  it("会话无效时守卫送回 /login，导航结果 ok=false", async () => {
    sessionHandler.mockRejectedValue({ code: 401, message: "中央会话不存在或已过期" });
    const result = await navigateToProjectAfterAuth(router);
    await nextTick();
    expect(result.ok).toBe(false);
    expect(router.currentRoute.value.path).toBe("/login");
  });
});
