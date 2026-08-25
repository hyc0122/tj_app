// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/utils/axios", () => ({
  default: { post: mocks.post },
}));

import tianjiangUpdateStore from "@/stores/tianjiangUpdate";

const channel = (overrides: Record<string, unknown> = {}) => ({
  status: "current",
  source: "network",
  required: false,
  downloadAllowed: false,
  ...overrides,
});

const wireSnapshot = (overrides: Record<string, unknown> = {}) => ({
  state: "idle",
  currentVersion: "1.1.11",
  stable: channel(),
  beta: channel(),
  stableRequired: false,
  loginAllowed: true,
  selectedChannel: null,
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("桌面更新 Store 状态机", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.post.mockReset();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("普通检查成功返回干净完整快照时，清除登录检查遗留的后台重试", async () => {
    mocks.post
      .mockResolvedValueOnce({
        data: wireSnapshot({
          state: "error",
          stable: channel({
            status: "error",
            latestVersion: "1.1.12",
            errorCode: "NETWORK_ERROR",
          }),
          beta: channel({
            status: "error",
            latestVersion: "1.2.0-beta.1",
            errorCode: "NETWORK_ERROR",
          }),
          latestVersion: "1.1.12",
          progress: 67,
          downloadedPath: "C:\\old\\installer.exe",
          channel: "stable",
          warningMessage: "正式版检查失败，将稍后重试",
          errorMessage: "旧错误",
        }),
      })
      // 中文注释：模拟真实 JSON wire；Express 会省略 undefined，因此新快照没有任何旧可选字段。
      .mockResolvedValueOnce({ data: wireSnapshot() });

    const store = tianjiangUpdateStore();
    await store.checkLoginStable();
    await store.check();

    expect(store.snapshot.warningMessage).toBeUndefined();
    expect(store.snapshot.errorMessage).toBeUndefined();
    expect(store.snapshot.latestVersion).toBeUndefined();
    expect(store.snapshot.progress).toBeUndefined();
    expect(store.snapshot.downloadedPath).toBeUndefined();
    expect(store.snapshot.channel).toBeUndefined();
    expect(store.snapshot.stable.latestVersion).toBeUndefined();
    expect(store.snapshot.stable.errorCode).toBeUndefined();
    expect(store.snapshot.beta.latestVersion).toBeUndefined();
    expect(store.snapshot.beta.errorCode).toBeUndefined();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it("普通检查仍返回 Stable 失败警告时，30 秒后安排新的登录 Stable 检查", async () => {
    mocks.post
      .mockResolvedValueOnce({
        data: wireSnapshot({
          state: "error",
          warningMessage: "正式版检查失败，将稍后重试",
        }),
      })
      .mockResolvedValueOnce({ data: wireSnapshot() });
    const store = tianjiangUpdateStore();

    await store.check();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(mocks.post).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post).toHaveBeenNthCalledWith(
      2,
      "/setting/about/checkUpdate",
      { action: "check-login-stable" },
    );
  });

  it("只有语义相同的检查共享 Promise，不同检查动作明确 busy 拒绝", async () => {
    const gate = deferred<{ data: ReturnType<typeof wireSnapshot> }>();
    mocks.post.mockReturnValueOnce(gate.promise);
    const store = tianjiangUpdateStore();

    const first = store.checkLoginStable();
    const same = store.checkLoginStable();
    const different = store.check();

    gate.resolve({ data: wireSnapshot() });
    const [firstResult, sameResult] = await Promise.all([first, same]);
    expect(sameResult).toEqual(firstResult);
    await expect(different).rejects.toThrow(/更新操作正在进行|busy/i);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("Beta 下载跨过后台 Stable 重试点时，动作结束后重新发起 check-login-stable", async () => {
    const download = deferred<{ data: ReturnType<typeof wireSnapshot> }>();
    mocks.post
      .mockResolvedValueOnce({
        data: wireSnapshot({
          state: "error",
          warningMessage: "正式版检查失败，将稍后重试",
        }),
      })
      .mockReturnValueOnce(download.promise)
      .mockResolvedValueOnce({ data: wireSnapshot() });
    const store = tianjiangUpdateStore();

    await store.checkLoginStable();
    const downloading = store.download("download-differential", "beta");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.post).toHaveBeenCalledTimes(2);

    download.resolve({
      data: wireSnapshot({
        state: "downloaded",
        beta: channel({ status: "available", latestVersion: "1.2.0-beta.1", downloadAllowed: true }),
        selectedChannel: "beta",
        latestVersion: "1.2.0-beta.1",
        downloadedPath: "C:\\downloads\\beta.exe",
      }),
    });
    await downloading;
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.post).toHaveBeenCalledTimes(3);
    expect(mocks.post).toHaveBeenNthCalledWith(
      3,
      "/setting/about/checkUpdate",
      { action: "check-login-stable" },
    );
  });

  it("Store 销毁后在途检查落定也不得重新创建后台重试", async () => {
    const check = deferred<{ data: ReturnType<typeof wireSnapshot> }>();
    mocks.post.mockReturnValueOnce(check.promise);
    const store = tianjiangUpdateStore();

    const checking = store.check();
    store.$dispose();
    check.resolve({
      data: wireSnapshot({
        state: "error",
        warningMessage: "正式版检查失败，将稍后重试",
      }),
    });
    await checking;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
});
