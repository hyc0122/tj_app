// @vitest-environment jsdom
/**
 * R21-fix RED：native-dreamina 设置页必须显示启用开关；Web 必须展示 DREAMINA_CLI_DISABLED。
 */
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import { readSafeGenerationSubmitError } from "@/views/storyboardProject/storyboard-generation-preview";

const axiosGet = vi.fn();
const axiosPost = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
  },
}));

describe("R21-fix 即梦开关与安全错误", () => {
  it("关闭即梦的稳定错误必须白名单展示，未知错误仍兜底", () => {
    expect(readSafeGenerationSubmitError(
      { code: "DREAMINA_CLI_DISABLED", message: "即梦 CLI 已关闭" },
      "提交生成失败，请重试",
    )).toBe("即梦 CLI 已关闭");
    expect(readSafeGenerationSubmitError(
      { code: "DREAMINA_TRACE", message: "ENOENT C:\\\\cli\\\\dreamina.exe cookie=abc" },
      "提交生成失败，请重试",
    )).toBe("提交生成失败，请重试");
  });

  it("native-dreamina 设置页必须显示持久化启用开关", async () => {
    setActivePinia(createPinia());
    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("dreaminaCli/getSettings")) {
        return Promise.resolve({
          data: { executablePath: "dreamina", enabled: true, maxConcurrency: 1, pauseNewClaims: false },
        });
      }
      if (String(url).includes("dreaminaCli/getStatus")) {
        return Promise.resolve({
          data: {
            install: { state: "installed", version: "r21", executablePath: "C:\\\\cli\\\\dreamina.exe" },
            account: { state: "logged_in", verified: true },
            capability: { state: "ready", snapshot: null },
            queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 },
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    const { default: DreaminaProviderPanel } = await import(
      "@/components/setting/components/vendorConfig/components/DreaminaProviderPanel.vue"
    );
    const wrapper = mount(DreaminaProviderPanel, {
      global: {
        plugins: [
          createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
        ],
        stubs: {
          TButton: { template: "<button><slot /></button>" },
          TIcon: { template: "<i />" },
          TSwitch: {
            props: ["modelValue"],
            template: `<button data-field="dreamina-enabled" type="button">{{ modelValue }}</button>`,
          },
        },
      },
    });
    await flushPromises();
    expect(wrapper.find('[data-field="dreamina-enabled"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
