// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import settingStore from "@/stores/setting";

const axiosGet = vi.fn();
const axiosPost = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
  },
}));

vi.mock("monaco-editor", () => ({ editor: {}, languages: {} }));
vi.mock("monaco-editor-vue3", () => ({ default: { template: "<div />" } }));
// 本用例只验证模型服务目录；隔离编辑器内部防抖任务，避免卸载后访问已销毁的 jsdom。
vi.mock("md-editor-v3", () => ({
  MdPreview: { template: "<div data-testid='vendor-description-preview' />" },
}));
vi.mock("@/components/setting/components/vendorConfig/components/VendorImportDialogs.vue", () => ({
  default: { template: "<div />" },
}));
vi.mock("@/components/setting/components/vendorConfig/components/VendorModelDialog.vue", () => ({
  default: { template: "<div />" },
}));

vi.mock("@/components/setting/components/uiConfig.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/languageConfig.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/agentConfog.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/promptManage.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/otherConfig.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/dbConfig.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/about.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/logoutConfig.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/memoryConfig.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/fileManagement.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/skillManagement.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/devConfig.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/modelMap.vue", () => ({ default: { template: "<div />" } }));

import SettingPanel from "@/components/setting/index.vue";
import VendorConfig from "@/components/setting/components/vendorConfig.vue";

function i18n() {
  return createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
}

describe("即梦必须作为模型服务同层级原生供应商", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("client-config")) {
        return Promise.resolve({ data: { config: { featureFlags: {} } } });
      }
      if (String(url).includes("dreaminaCli/getStatus")) {
        return Promise.resolve({
          data: {
            preferredExecutionTarget: "windows_native",
            effectiveExecutionTarget: null,
            install: { state: "not_installed", version: null, executablePath: null, managed: false, checkedAt: null },
            account: { state: "unknown" },
            capability: { state: "not_checked", snapshot: null, checkedAt: null },
            queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 },
          },
        });
      }
      if (String(url).includes("dreaminaCli/getSettings")) {
        return Promise.resolve({
          data: {
            executablePath: null,
            maxConcurrency: 1,
            pauseNewClaims: false,
            preferredExecutionTarget: "windows_native",
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    axiosPost.mockImplementation((url: string) => {
      if (String(url).includes("getVendorList")) {
        return Promise.resolve({
          data: [{
            id: "vendor-1",
            name: "普通供应商",
            author: "tester",
            enable: 1,
            inputs: [],
            inputValues: {},
            models: [],
          }],
        });
      }
      return Promise.resolve({ data: {} });
    });
    (window as any).$message = { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() };
  });

  it("设置左侧只有模型服务入口，旧 dreaminaCli deep link 迁到模型服务", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    settingStore().activeMenu = "dreaminaCli";
    const wrapper = mount(SettingPanel, {
      global: {
        plugins: [pinia, i18n()],
        stubs: {
          TMenu: { template: "<nav data-testid='setting-menu'><slot /></nav>" },
          TMenuItem: {
            props: ["value"],
            template: "<button :data-menu='value'><slot name='icon' /><slot /></button>",
          },
          TBadge: { template: "<span><slot /></span>" },
        },
      },
    });
    await flushPromises();
    const menuKeys = wrapper.findAll("[data-menu]").map((item) => item.attributes("data-menu"));
    expect(menuKeys).toContain("vendorConfig");
    expect(menuKeys).not.toContain("dreaminaCli");
    expect(settingStore().activeMenu).toBe("vendorConfig");
    wrapper.unmount();
  });

  it("模型服务目录把即梦与普通供应商放在同级，且即梦不可删除", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    settingStore().activeMenu = "vendorConfig";
    const wrapper = mount(VendorConfig, {
      global: {
        plugins: [pinia, i18n()],
        stubs: {
          TMenu: { template: "<div class='vendor-menu'><slot /></div>" },
          TMenuItem: {
            props: ["value"],
            template: "<button class='vendor-item' :data-id='value'><slot /><slot name='icon' /></button>",
          },
          TSwitch: { template: "<input class='vendor-switch' type='checkbox' />" },
          TButton: { template: "<button><slot /></button>" },
          TEmpty: { template: "<div />" },
          TForm: { template: "<form><slot /></form>" },
          TFormItem: { template: "<div><slot name='label' /><slot /></div>" },
          TCard: { template: "<div><slot /></div>" },
          TTag: { template: "<span><slot /></span>" },
          TAlert: { template: "<div><slot /></div>" },
          TLoading: { template: "<div><slot /></div>" },
          TInput: { template: "<input />" },
          TAvatar: { template: "<span />" },
          TIcon: { template: "<i />" },
        },
      },
    });
    await flushPromises();
    const ids = wrapper.findAll(".vendor-item").map((item) => item.attributes("data-id"));
    expect(ids).toContain("native:dreamina-cli");
    expect(ids).toContain("vendor-1");
    const dreaminaIndex = ids.indexOf("native:dreamina-cli");
    const vendorIndex = ids.indexOf("vendor-1");
    expect(dreaminaIndex).toBeGreaterThanOrEqual(0);
    expect(vendorIndex).toBeGreaterThanOrEqual(0);

    const dreaminaButton = wrapper.find('[data-id="native:dreamina-cli"]');
    await dreaminaButton.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toMatch(/即梦/);
    expect(wrapper.html()).not.toMatch(/settings\.vendor\.deleteVendor/);
    expect(wrapper.html()).not.toMatch(/settings\.vendor\.editCode/);
    wrapper.unmount();
  });
});
