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
// 本用例只验证即梦面板；隔离普通供应商描述编辑器的卸载后防抖任务。
vi.mock("md-editor-v3", () => ({
  MdPreview: { template: "<div data-testid='vendor-description-preview' />" },
}));
vi.mock("@/components/setting/components/vendorConfig/components/VendorImportDialogs.vue", () => ({
  default: { template: "<div />" },
}));
vi.mock("@/components/setting/components/vendorConfig/components/VendorModelDialog.vue", () => ({
  default: { template: "<div />" },
}));

describe("即梦模型服务面板必须展示完整状态区域", () => {
  it("选中原生即梦后只请求 getStatus，并渲染安装/授权/账户/模型/队列/环境/文档", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    settingStore().activeMenu = "vendorConfig";
    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("dreaminaCli/getStatus")) {
        return Promise.resolve({
          data: {
            preferredExecutionTarget: "windows_native",
            effectiveExecutionTarget: null,
            install: {
              state: "not_installed",
              version: null,
              executablePath: null,
              managed: false,
              checkedAt: null,
            },
            account: { state: "unknown" },
            capability: { state: "not_checked", snapshot: null, checkedAt: null },
            queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 },
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

    const wrapper = mount(VendorConfig, {
      global: {
        plugins: [
          pinia,
          createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
        ],
        stubs: {
          TMenu: { template: "<div class='vendor-menu'><slot /></div>" },
          TMenuItem: {
            props: ["value"],
            template: "<button class='vendor-item' :data-id='value'><slot /></button>",
          },
          TSwitch: { template: "<input type='checkbox' />" },
          TButton: { template: "<button><slot /></button>" },
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

    const requested = axiosGet.mock.calls.map((item) => String(item[0]));
    expect(requested.some((url) => url.includes("/setting/dreaminaCli/getStatus"))).toBe(true);
    expect(requested.some((url) => url.includes("/setting/dreaminaCli/getSettings"))).toBe(true);
    expect(axiosPost.mock.calls.some((item) => String(item[0]).includes("install"))).toBe(false);

    const text = wrapper.text();
    expect(text).toMatch(/安装/);
    expect(text).toMatch(/版本|路径/);
    expect(text).toMatch(/登录|授权/);
    expect(text).toMatch(/余额|积分/);
    expect(text).toMatch(/套餐|到期/);
    expect(text).toMatch(/模型/);
    expect(text).toMatch(/队列/);
    expect(text).toMatch(/环境|检测/);
    expect(text).toMatch(/官方文档/);
    expect(text).toMatch(/CLI 未返回此字段/);
    expect(text).not.toMatch(/cookie|device_code|user_code|token/i);
    wrapper.unmount();
  });
});
