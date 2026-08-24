// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import settingStore from "@/stores/setting";
import VendorConfig from "@/components/setting/components/vendorConfig.vue";

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
// 本用例只验证环境面板；隔离普通供应商描述编辑器的卸载后防抖任务。
vi.mock("md-editor-v3", () => ({
  MdPreview: { template: "<div data-testid='vendor-description-preview' />" },
}));
vi.mock("@/components/setting/components/vendorConfig/components/VendorImportDialogs.vue", () => ({
  default: { template: "<div />" },
}));
vi.mock("@/components/setting/components/vendorConfig/components/VendorModelDialog.vue", () => ({
  default: { template: "<div />" },
}));

describe("即梦环境面板", () => {
  it("选中即梦后读取环境状态，不显示 Node/Git，也不自动安装", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    settingStore().activeMenu = "vendorConfig";
    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("getStatus")) {
        return Promise.resolve({
          data: {
            install: { state: "not_installed", version: null, executablePath: null },
            account: { state: "unknown" },
            capability: { state: "not_checked", snapshot: null },
            queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0 },
          },
        });
      }
      if (String(url).includes("getEnvironment")) {
        return Promise.resolve({
          data: {
            dependencies: [{
              id: "dreamina_binary",
              label: "即梦 CLI",
              required: true,
              installed: false,
              compatible: true,
            }],
            suggestWsl: false,
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    axiosPost.mockImplementation((url: string) => {
      if (String(url).includes("getVendorList")) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({ data: {} });
    });

    const wrapper = mount(VendorConfig, {
      global: {
        plugins: [
          pinia,
          createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
        ],
        stubs: {
          TMenu: { template: "<div><slot /></div>" },
          TMenuItem: {
            props: ["value"],
            template: "<button class='vendor-item' :data-id='value'><slot /></button>",
          },
          TButton: { template: "<button><slot /></button>" },
          TSwitch: { template: "<input type='checkbox' />" },
          TEmpty: { template: "<div />" },
          TForm: { template: "<form><slot /></form>" },
          TFormItem: { template: "<div><slot /></div>" },
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
    const native = wrapper.find('[data-id="native:dreamina-cli"]');
    expect(native.exists()).toBe(true);
    await native.trigger("click");
    await flushPromises();

    expect(axiosGet.mock.calls.some((item) => String(item[0]).includes("getEnvironment"))).toBe(true);
    expect(axiosPost.mock.calls.some((item) => String(item[0]).includes("install"))).toBe(false);
    expect(wrapper.text()).not.toMatch(/Node\.js/);
    expect(wrapper.text()).not.toMatch(/\bGit\b/);
    wrapper.unmount();
  });
});
