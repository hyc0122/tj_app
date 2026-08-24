// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

describe("modelCatalogStore 账号范围缓存", () => {
  it("ensure 先返回已有快照并合并相同请求", async () => {
    const { createModelCatalogStore } = await import("../../src/features/models/modelCatalogStore");
    const fetchImpl = vi.fn(async () => ({
      accountScopeId: "acc-1",
      catalogVersion: 1,
      items: [{ id: "vendor-a", label: "A", value: "a", type: "image", name: "A", disabled: false }],
      providers: [{ providerId: "vendor-a", providerName: "A", state: "ready" as const }],
    }));
    const store = createModelCatalogStore({ fetchCatalog: fetchImpl });
    const [a, b] = await Promise.all([store.ensure("acc-1", "image"), store.ensure("acc-1", "image")]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a.items).toHaveLength(1);
    expect(b.items).toHaveLength(1);
    store.invalidateAccount("acc-1");
    expect(store.peek("acc-1", "image")).toBeUndefined();
  });
});
