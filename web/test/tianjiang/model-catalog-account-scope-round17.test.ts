// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

describe("modelCatalogStore 必须按真实账号身份隔离并跟随 catalogVersion", () => {
  it("账号 A 的目录不得在切换 B 后复用", async () => {
    const { createModelCatalogStore } = await import("../../src/features/models/modelCatalogStore");
    const fetchImpl = vi.fn(async () => ({
      accountScopeId: fetchImpl.mock.calls.length <= 1 ? "account:1" : "account:2",
      catalogVersion: 1,
      items: [{
        id: "vendor",
        label: fetchImpl.mock.calls.length <= 1 ? "A模" : "B模",
        value: fetchImpl.mock.calls.length <= 1 ? "a" : "b",
        type: "image",
        name: fetchImpl.mock.calls.length <= 1 ? "A" : "B",
      }],
      providers: [],
    }));
    const store = createModelCatalogStore({ fetchCatalog: fetchImpl });
    const a = await store.ensure("account:1", "image");
    expect(a.items[0]?.label).toBe("A模");
    const b = await store.ensure("account:2", "image");
    expect(b.items[0]?.label).toBe("B模");
    expect(store.peek("account:1", "image")?.items[0]?.label).toBe("A模");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("catalogVersion 提升后必须重新拉取，未变化时不得再打 getModelList", async () => {
    const { createModelCatalogStore } = await import("../../src/features/models/modelCatalogStore");
    let version = 4;
    const fetchImpl = vi.fn(async () => ({
      accountScopeId: "account:9",
      catalogVersion: version,
      items: [{ id: "v", label: `v${version}`, value: "x", type: "image", name: "N" }],
      providers: [],
    }));
    const fetchVersion = vi.fn(async () => version);
    const store = createModelCatalogStore({
      fetchCatalog: fetchImpl,
      fetchCatalogVersion: fetchVersion,
    });
    await store.ensure("account:9", "image");
    await store.ensure("account:9", "image");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    version = 5;
    const next = await store.ensure("account:9", "image");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(next.items[0]?.label).toBe("v5");
  });
});
