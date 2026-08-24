// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

vi.mock("@/utils/axios", () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: { data: [] } }),
    post: vi.fn().mockResolvedValue({ data: { data: [] } }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import StoryboardWorkspace from "@/views/storyboardProject/index.vue";

describe("分镜导入导出入口", () => {
  it("工作台必须提供可用的导入和导出操作", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/storyboard-project", component: StoryboardWorkspace }],
    });
    await router.push("/storyboard-project");
    const wrapper = mount(StoryboardWorkspace, {
      global: {
        plugins: [
          pinia,
          router,
          createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
        ],
        stubs: {
          TButton: { template: "<button><slot /></button>" },
          TDialog: { template: "<div><slot /></div>" },
        },
      },
    });
    await flushPromises();
    expect(wrapper.text()).toMatch(/导入/);
    expect(wrapper.text()).toMatch(/导出/);
    wrapper.unmount();
  });
});
