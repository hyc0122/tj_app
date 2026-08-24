import { describe, expect, it } from "vitest";
import { createModelCatalogStore } from "../../src/features/models/modelCatalogStore";

describe("前端账号范围缓存失效", () => {
  it("登出/切账号必须清缓存且保留当前选择语义由调用方负责", async () => {
    let calls = 0;
    const store = createModelCatalogStore({
      fetchCatalog: async () => {
        calls += 1;
        return {
          accountScopeId: calls === 1 ? "a" : "b",
          catalogVersion: calls,
          items: [{ id: "v1", label: "图", value: "img", type: "image", name: "普通" }],
          providers: [{ providerId: "v1", providerName: "普通", state: "ready" }],
        };
      },
    });
    await store.ensure("a", "image");
    expect(store.peek("a", "image")?.items).toHaveLength(1);
    store.invalidateAccount("a");
    expect(store.peek("a", "image")).toBeUndefined();
    await store.ensure("b", "image");
    expect(store.peek("a", "image")).toBeUndefined();
    expect(store.peek("b", "image")?.items).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
