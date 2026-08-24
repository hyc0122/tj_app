// @vitest-environment jsdom
/**
 * Round19 RED：真实 renderer（require === undefined）必须得到 account:id；
 * 晚响应不得污染切换后的账号，也不得复活已失效缓存。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

describe("真实 renderer 账号 scope 与晚响应隔离", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ESM 账号作用域在无 raw require 时中央用户 1 必须得到 account:1", async () => {
    const { currentAccountScopeId, setAccountScope } = await import("../../src/features/models/modelCatalogStore");
    setAccountScope(1);
    expect(currentAccountScopeId()).toBe("account:1");
    expect(currentAccountScopeId()).not.toBe("");
  });

  it("后端 accountScopeId 与请求 scope 不一致时不得写缓存", async () => {
    const { createModelCatalogStore } = await import("../../src/features/models/modelCatalogStore");
    const store = createModelCatalogStore({
      fetchCatalog: async () => ({
        accountScopeId: "account:2",
        catalogVersion: 1,
        items: [{ id: "v", label: "错号", value: "x", type: "image", name: "x" }],
        providers: [],
      }),
    });
    await expect(store.ensure("account:1", "image")).rejects.toThrow(/scope|账号|不一致/i);
    expect(store.peek("account:1", "image")).toBeUndefined();
    expect(store.peek("account:2", "image")).toBeUndefined();
  });

  it("A 请求仍在途时切换到 B，A 晚返回不得污染 B 也不得复活 A", async () => {
    const { createModelCatalogStore } = await import("../../src/features/models/modelCatalogStore");
    let releaseA: ((value: {
      accountScopeId: string;
      catalogVersion: number;
      items: Array<{ id: string; label: string; value: string; type: string; name: string }>;
      providers: [];
    }) => void) | undefined;
    let releaseB: typeof releaseA;
    let fetchCount = 0;
    const store = createModelCatalogStore({
      fetchCatalog: async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return await new Promise((resolve) => {
            releaseA = resolve;
          });
        }
        return await new Promise((resolve) => {
          releaseB = resolve;
        });
      },
    });
    const pendingA = store.ensure("account:1", "image");
    store.invalidateAccount("account:1");
    const pendingB = store.ensure("account:2", "image");
    releaseA?.({
      accountScopeId: "account:1",
      catalogVersion: 1,
      items: [{ id: "a", label: "A模", value: "a", type: "image", name: "A" }],
      providers: [],
    });
    await pendingA.catch(() => undefined);
    expect(store.peek("account:1", "image")).toBeUndefined();
    expect(store.peek("account:2", "image")?.items[0]?.label).not.toBe("A模");
    releaseB?.({
      accountScopeId: "account:2",
      catalogVersion: 1,
      items: [{ id: "b", label: "B模", value: "b", type: "image", name: "B" }],
      providers: [],
    });
    const b = await pendingB;
    expect(b.items[0]?.label).toBe("B模");
    expect(store.peek("account:2", "image")?.items[0]?.label).toBe("B模");
    expect(store.peek("account:1", "image")).toBeUndefined();
    expect(fetchCount).toBe(2);
  });

  it("A/B 必须得到各自独立目录，logout 必须清掉正确 cache 和 inflight", async () => {
    const { createModelCatalogStore } = await import("../../src/features/models/modelCatalogStore");
    const store = createModelCatalogStore({
      fetchCatalog: async () => ({
        accountScopeId: "should-be-replaced",
        catalogVersion: 1,
        items: [{ id: "v", label: "X", value: "x", type: "image", name: "x" }],
        providers: [],
      }),
    });
    await store.ensure("account:1", "image").catch(() => undefined);
    await store.ensure("account:2", "image").catch(() => undefined);
    store.invalidateAccount("account:1");
    expect(store.peek("account:1", "image")).toBeUndefined();
    store.invalidateAccount("");
    store.invalidateAll();
    expect(store.peek("account:2", "image")).toBeUndefined();
  });
});
