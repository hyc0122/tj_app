import { describe, expect, it, vi } from "vitest";
import {
  discoverRuntimeConnection,
  discoverRuntimeConnectionSingleFlight,
  resetRuntimeConnectionDiscoveryForTests,
} from "@/bootstrap/runtime-connection";

describe("Electron 本地服务启动握手", () => {
  it("在安装路由前取得主进程分配的随机端口", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        state: "ready",
        url: "http://127.0.0.1:10463/api",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(discoverRuntimeConnection({
      pageProtocol: "file:",
      fetcher,
    })).resolves.toEqual({
      mode: "electron",
      state: "ready",
      url: "http://127.0.0.1:10463/api",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("拒绝非精确 IPv4 环回握手地址、异常端口、路径和 URL 附加数据", async () => {
    const invalidUrls = [
      "http://localhost:10463/api",
      "http://192.168.1.8:10463/api",
      "http://127.0.0.1/api",
      "http://127.0.0.1:0/api",
      "http://127.0.0.1:65536/api",
      "http://127.0.0.1:080/api",
      "http://127.0.0.1:010463/api",
      "http://user@127.0.0.1:10463/api",
      "http://user:pass@127.0.0.1:10463/api",
      "http://127.0.0.1:10463/api?target=admin",
      "http://127.0.0.1:10463/api#admin",
      "http://127.0.0.1:10463/admin/api",
    ];

    for (const url of invalidUrls) {
      const fetcher = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          ok: true,
          state: "ready",
          url,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      await expect(discoverRuntimeConnection({
        pageProtocol: "file:",
        fetcher,
      })).resolves.toMatchObject({
        mode: "electron",
        state: "failed",
        code: "LOCAL_SERVICE_START_FAILED",
      });
    }
  });

  it("主进程启动失败时返回可展示的诊断信息，不回退到固定 10588 端口", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: false,
        state: "failed",
        code: "NATIVE_MODULE_LOAD_FAILED",
        message: "本地数据组件加载失败",
        logPath: "C:\\Users\\tester\\AppData\\Roaming\\天将漫创\\logs\\startup.log",
      }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(discoverRuntimeConnection({
      pageProtocol: "file:",
      fetcher,
    })).resolves.toEqual({
      mode: "electron",
      state: "failed",
      code: "NATIVE_MODULE_LOAD_FAILED",
      message: "本地数据组件加载失败",
      logPath: "C:\\Users\\tester\\AppData\\Roaming\\天将漫创\\logs\\startup.log",
    });
  });

  it("普通浏览器模式不请求 Electron 私有协议", async () => {
    const fetcher = vi.fn();
    await expect(discoverRuntimeConnection({
      pageProtocol: "https:",
      fetcher,
    })).resolves.toEqual({
      mode: "browser",
      state: "ready",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("Vite HTTP 开发模式只要带桌面标记也必须执行随机端口握手", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        state: "ready",
        url: "http://127.0.0.1:12666/api",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(discoverRuntimeConnection({
      pageProtocol: "http:",
      desktopRuntime: true,
      fetcher,
    })).resolves.toEqual({
      mode: "electron",
      state: "ready",
      url: "http://127.0.0.1:12666/api",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("并发网络失败只执行一次主进程端口重发现", async () => {
    resetRuntimeConnectionDiscoveryForTests();
    let resolveResponse!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));

    const first = discoverRuntimeConnectionSingleFlight({
      pageProtocol: "file:",
      fetcher,
    });
    const second = discoverRuntimeConnectionSingleFlight({
      pageProtocol: "file:",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledOnce();
    resolveResponse(new Response(JSON.stringify({
      ok: true,
      state: "ready",
      url: "http://127.0.0.1:13131/api",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { mode: "electron", state: "ready", url: "http://127.0.0.1:13131/api" },
      { mode: "electron", state: "ready", url: "http://127.0.0.1:13131/api" },
    ]);
  });
});
