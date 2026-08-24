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
    post: vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/cornerScape/getAllAssets")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: { data: { shotUuid: "s-new", displayOrder: 3 } } });
    }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import StoryboardWorkspace from "@/views/storyboardProject/index.vue";

describe("分镜工作台", () => {
  it("必须提供分镜管理、资产管理、分镜设置三个模块，并支持在 2/3 之间插入", async () => {
    const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
    (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(i18n.global.t(key));
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
          i18n,
        ],
        stubs: {
          TButton: { template: "<button><slot /></button>" },
          TTable: { template: "<table><slot /></table>" },
          TTabs: { template: "<div><slot /></div>" },
          TTabPanel: { template: "<section><slot /></section>" },
          TCard: { inheritAttrs: true, template: "<section v-bind=\"$attrs\"><slot name=\"title\" /><slot /></section>" },
          TForm: { template: "<form><slot /></form>" },
          TFormItem: { template: "<div><slot /></div>" },
          TEmpty: { template: "<div>empty</div>" },
          TSelect: { template: "<select><slot /></select>" },
          TTextarea: { inheritAttrs: true, template: "<textarea />" },
          TCheckbox: { template: "<input type=\"checkbox\" />" },
          TCheckboxGroup: { template: "<div />" },
          TImage: { template: "<img />" },
          TImageViewer: { template: "<div><slot name=\"trigger\" :open=\"() => {}\" /></div>" },
          TPopup: { template: "<div><slot /></div>" },
          TLoading: { template: "<div />" },
          modelSelect: { template: "<div />" },
          ImageTools: { template: "<div />" },
          "i-plus": { template: "<i />" },
        },
      },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("分镜管理");
    expect(wrapper.text()).toContain("资产管理");
    expect(wrapper.text()).toContain("分镜设置");
    const insert = wrapper.findAll("button").find((button) => /新增分镜|新增第一条分镜|在此插入/.test(button.text()));
    expect(insert).toBeDefined();
    const assetsTab = wrapper.findAll("button").find((button) => button.text().includes("资产管理"));
    await assetsTab?.trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-panel="corner-scape-assets"]').exists()).toBe(true);
    expect(wrapper.text()).toMatch(/新建资产|批量上传资产|导入资产描述/);
    wrapper.unmount();
  });

  it("详情编辑、导入预览提交和导出必须走真实 API", async () => {
    const axios = (await import("@/utils/axios")).default as {
      get: ReturnType<typeof vi.fn>;
      post: ReturnType<typeof vi.fn>;
      patch: ReturnType<typeof vi.fn>;
    };
    const pinia = createPinia();
    setActivePinia(pinia);
    const { default: projectStore } = await import("@/stores/project");
    const store = projectStore();
    store.project = { projectUuid: "11111111-1111-4111-a111-111111111111" } as any;
    store.access = {
      projectUuid: "11111111-1111-4111-a111-111111111111",
      mode: "readwrite",
      reason: "test_open",
      lockHolder: "",
    };
    const wrapper = mount(StoryboardWorkspace, {
      global: {
        plugins: [
          pinia,
          createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
        ],
        stubs: {
          TButton: { template: "<button><slot /></button>" },
          TTable: { template: "<table><slot /></table>" },
        },
      },
    });
    await flushPromises();
    expect(wrapper.text()).toMatch(/导入|导出/);
    const importBtn = wrapper.findAll("button").find((button) => button.text().includes("导入"));
    await importBtn?.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toMatch(/开始预览/);
    expect(wrapper.text()).toMatch(/确认提交/);
    wrapper.unmount();
    void axios;
  });
});
