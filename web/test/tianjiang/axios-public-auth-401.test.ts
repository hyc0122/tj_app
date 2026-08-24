import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  isPublicAuthPath,
  shouldAnnounceSessionExpired,
} from "@/features/tianjiang/auth/public-auth-paths";

describe("Axios 全局 401 不得把公开认证当成登录过期", () => {
  it("登录/注册/验证码 401 不触发会话过期提示", () => {
    expect(isPublicAuthPath("/tianjiang/auth/login")).toBe(true);
    expect(isPublicAuthPath("/tianjiang/auth/register")).toBe(true);
    expect(isPublicAuthPath("/tianjiang/auth/captcha")).toBe(true);

    expect(shouldAnnounceSessionExpired(401, "post", "/tianjiang/auth/login")).toBe(false);
    expect(shouldAnnounceSessionExpired(401, "post", "/tianjiang/auth/register")).toBe(false);
    expect(shouldAnnounceSessionExpired(401, "post", "/tianjiang/auth/captcha")).toBe(false);
    expect(shouldAnnounceSessionExpired(401, "get", "/tianjiang/auth/session")).toBe(false);
    expect(shouldAnnounceSessionExpired(401, "get", "/tianjiang/runtime/projects")).toBe(true);
  });

  it("axios 拦截器必须接入公开认证路径判断", () => {
    const axiosSource = readFileSync(
      path.join(process.cwd(), "src/utils/axios.ts"),
      "utf8",
    );
    expect(axiosSource).toContain("shouldAnnounceSessionExpired");
    expect(axiosSource).toContain("isPublicAuthPath");
  });
});
