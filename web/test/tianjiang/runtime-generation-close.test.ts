import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const axiosMock = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@/utils/axios", () => ({
  default: axiosMock,
}));

import projectStore from "@/stores/project";
import {
  closeCatalogProject,
  openCatalogProject,
} from "@/features/tianjiang/project/catalog";

describe("Web open 保存 generation，close 原样携带", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosMock.post.mockReset();
  });

  it("open 返回 runtimeGeneration 并在 close 请求中发送", async () => {
    axiosMock.post.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/open")) {
        return {
          data: {
            projectUuid: "11111111-1111-4111-a111-111111111111",
            kind: "personal",
            editable: true,
            recoveryRequired: false,
            accessMode: "readwrite",
            runtimeGeneration: 7,
            project: {
              id: 11,
              name: "demo",
              projectType: "novel",
            },
          },
        };
      }
      return { data: { state: "closed" } };
    });
    const opened = await openCatalogProject("11111111-1111-4111-a111-111111111111");
    expect(opened.runtimeGeneration).toBe(7);
    const store = projectStore();
    store.activateProject(opened.project, {
      projectUuid: opened.projectUuid,
      mode: opened.accessMode,
      reason: "",
      lockHolder: "",
      runtimeGeneration: opened.runtimeGeneration,
    });
    expect(store.access.runtimeGeneration).toBe(7);
    await closeCatalogProject(opened.projectUuid, store.access.runtimeGeneration);
    const closeCall = axiosMock.post.mock.calls.find((call) => String(call[0]).endsWith("/close"));
    expect(closeCall?.[1]).toEqual({ runtimeGeneration: 7 });
  });
});
