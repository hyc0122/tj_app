// @vitest-environment jsdom
/**
 * Round20 RED：空 accountScopeId 不得回填已登录 scope；setAccountScope 必须让旧 epoch 晚响应失效。
 * 生产入口：modelCatalogStore.ensure / setAccountScope。
 */
import { describe, expect, it } from "vitest";

describe("模型目录空 scope 与账号 epoch", () => {
  it("后端返回空 scope 时，account:1 请求不得写缓存", async () => {
    const { createModelCatalogStore } = await import("../../src/features/models/modelCatalogStore");
    const store = createModelCatalogStore({
      fetchCatalog: async () => ({
        accountScopeId: "",
        catalogVersion: 1,
        items: [{ id: "v", label: "空号", value: "x", type: "image", name: "x" }],
        providers: [],
      }),
    });
    await expect(store.ensure("account:1", "image")).rejects.toThrow(/scope|账号|不一致|空/i);
    expect(store.peek("account:1", "image")).toBeUndefined();
  });

  it("setAccountScope 切换后旧 epoch 晚响应必须丢弃，不得靠手工 invalidateAccount", async () => {
    const { createModelCatalogStore, setAccountScope } = await import(
      "../../src/features/models/modelCatalogStore"
    );
    let releaseA: ((value: {
      accountScopeId: string;
      catalogVersion: number;
      items: Array<{ id: string; label: string; value: string; type: string; name: string }>;
      providers: [];
    }) => void) | undefined;
    setAccountScope(1);
    const store = createModelCatalogStore({
      fetchCatalog: async () => await new Promise((resolve) => {
        releaseA = resolve;
      }),
    });
    const pendingA = store.ensure("account:1", "image");
    setAccountScope(2);
    let lateResolved = false;
    const settled = pendingA.then((value) => {
      lateResolved = true;
      return value;
    }).catch((error: Error) => error);
    releaseA?.({
      accountScopeId: "account:1",
      catalogVersion: 1,
      items: [{ id: "a", label: "A模", value: "a", type: "image", name: "A" }],
      providers: [],
    });
    const result = await settled;
    expect(lateResolved).toBe(false);
    expect(result).toBeInstanceOf(Error);
    expect(String((result as Error).message)).toMatch(/过期|epoch|失效/i);
    expect(store.peek("account:1", "image")).toBeUndefined();
    expect(store.peek("account:2", "image")).toBeUndefined();
  });
});
