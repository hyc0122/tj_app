import { describe, expect, it } from "vitest";

import {
  classifyTransportFailure,
} from "@/features/tianjiang/runtime/error-guidance";

describe("客户端运行错误分类", () => {
  it("中央 API 503 必须显示中央服务不可达且不引导修复本地运行库", () => {
    const guidance = classifyTransportFailure({
      message: "Request failed with status code 503",
      response: {
        data: {
          code: "CENTRAL_API_UNREACHABLE",
          message: "中央 API 不可达，请检查网络连接或稍后重试。",
        },
      },
    }, true);

    expect(guidance).toEqual({
      kind: "central-api",
      title: "中央 API 不可达",
      detail: "本地服务已启动，但暂时无法连接中央 API。请检查网络连接或稍后重试。",
    });
    expect(guidance?.detail).not.toMatch(/运行库|安装程序|管理员/);
  });

  it("Electron 到本地服务的 Network Error 必须保留本地服务分类", () => {
    expect(classifyTransportFailure({ message: "Network Error" }, true)).toEqual({
      kind: "local-service",
      title: "本地服务连接中断",
      detail: "已自动尝试恢复本地服务连接；若仍失败，请重新启动应用并查看启动诊断日志。",
    });
  });

  it("普通业务错误不应伪装成网络或启动错误", () => {
    expect(classifyTransportFailure({
      message: "账号或密码错误",
      response: { data: { code: 401, message: "中央认证失败" } },
    }, true)).toBeNull();
  });
});
