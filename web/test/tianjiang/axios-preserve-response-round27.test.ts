// @vitest-environment jsdom
import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const discoverRuntimeConnectionSingleFlight = vi.hoisted(() => vi.fn());

vi.mock("@/bootstrap/runtime-connection", () => ({
  discoverRuntimeConnectionSingleFlight,
}));

import axios from "@/utils/axios";
import settingStore from "@/stores/setting";

const originalAdapter = axios.defaults.adapter;

function responseFor(
  config: InternalAxiosRequestConfig,
  status: number,
  data: unknown,
): AxiosResponse {
  return {
    data,
    status,
    statusText: status === 202 ? "Accepted" : "OK",
    headers: {},
    config,
    request: undefined,
  };
}

describe("Axios 按请求保留真实 HTTP 响应", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    discoverRuntimeConnectionSingleFlight.mockReset();
  });

  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
  });

  it("默认请求继续只返回业务正文", async () => {
    axios.defaults.adapter = async (config) => responseFor(config, 200, { value: "body-only" });

    await expect(axios.get("/ordinary-response")).resolves.toEqual({ value: "body-only" });
  });

  it("preserveResponse 请求返回完整 AxiosResponse 与真实状态码", async () => {
    axios.defaults.adapter = async (config) => responseFor(config, 202, {
      code: 0,
      data: { clientOperationId: "operation-202", tasks: [{ taskUuid: "task-202" }] },
    });

    const response = await axios.get<unknown, AxiosResponse>("/preserved-response", {
      preserveResponse: true,
    });

    expect(response.status).toBe(202);
    expect(response.data).toMatchObject({
      data: { clientOperationId: "operation-202" },
    });
  });

  it("本地运行时重连重放仍保留 preserveResponse", async () => {
    const settings = settingStore();
    settings.isElectron = true;
    settings.baseUrl = "http://127.0.0.1:10588/api";
    discoverRuntimeConnectionSingleFlight.mockResolvedValue({
      mode: "electron",
      state: "ready",
      url: "http://127.0.0.1:10666/api",
    });
    const attempts: Array<{ preserveResponse: unknown; retried: unknown; baseURL: unknown }> = [];
    axios.defaults.adapter = async (config) => {
      attempts.push({
        preserveResponse: (config as InternalAxiosRequestConfig & { preserveResponse?: boolean }).preserveResponse,
        retried: (config as InternalAxiosRequestConfig & { __tianjiangRuntimeRetried?: boolean }).__tianjiangRuntimeRetried,
        baseURL: config.baseURL,
      });
      if (attempts.length === 1) {
        throw Object.assign(new Error("Network Error"), {
          code: "ERR_NETWORK",
          config,
        });
      }
      return responseFor(config, 202, { code: 0, data: { clientOperationId: "retried-202", tasks: [{}] } });
    };

    const response = await axios.post<unknown, AxiosResponse>(
      "/preserved-retry",
      { value: true },
      { preserveResponse: true },
    );

    expect(attempts).toEqual([
      { preserveResponse: true, retried: undefined, baseURL: "http://127.0.0.1:10588/api" },
      { preserveResponse: true, retried: true, baseURL: "http://127.0.0.1:10666/api" },
    ]);
    expect(response.status).toBe(202);
    expect(response.data).toMatchObject({ data: { clientOperationId: "retried-202" } });
  });
});
