// @vitest-environment jsdom
/**
 * R21-fix2 RED：必须真实触发开关 change；POST 返回 logged_in 后界面立即显示
 * installed/logged_in、绝对路径和积分，不得只断言开关存在。
 */
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

const axiosGet = vi.fn();
const axiosPost = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
  },
}));

describe("R21-fix2 开启即梦后必须收敛到 logged_in", () => {
  it("开关 change 后必须用接口最终状态显示已登录，而不是 unchecked/last_known", async () => {
    setActivePinia(createPinia());
    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("dreaminaCli/getSettings")) {
        return Promise.resolve({
          data: { executablePath: "dreamina", enabled: false, maxConcurrency: 1, pauseNewClaims: false },
        });
      }
      if (String(url).includes("dreaminaCli/getStatus")) {
        return Promise.resolve({
          data: {
            install: { state: "not_installed", version: null, executablePath: null },
            account: { state: "unknown", verified: false },
            capability: { state: "not_checked", snapshot: null },
            queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 },
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    axiosPost.mockImplementation((url: string, body?: { enabled?: boolean }) => {
      if ((String(url).includes("dreaminaCli/setEnabled") || String(url).includes("dreaminaCli/updateSettings")) && body?.enabled === true) {
        return Promise.resolve({
          data: {
            enabled: true,
            executablePath: "E:\\\\cli\\\\dreamina.exe",
            install: {
              state: "installed",
              version: "r21-fix2",
              executablePath: "E:\\\\cli\\\\dreamina.exe",
            },
            account: { state: "logged_in", points: "128", verified: true },
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
            emits: ["change"],
            template: `<button data-field="dreamina-enabled" type="button" @click="$emit('change', true)">{{ modelValue }}</button>`,
          },
        },
      },
    });
    await flushPromises();
    expect(wrapper.get("[data-summary=account]").attributes("data-account-display")).not.toBe("logged_in");
    await wrapper.get('[data-field="dreamina-enabled"]').trigger("click");
    await flushPromises();
    expect(axiosPost).toHaveBeenCalled();
    const posted = axiosPost.mock.calls.find((call) => String(call[0]).includes("setEnabled") || String(call[0]).includes("updateSettings"));
    expect(posted?.[0]).toContain("setEnabled");
    expect(posted?.[1]).toMatchObject({ enabled: true });
    expect(wrapper.get("[data-summary=account]").attributes("data-account-display")).toBe("logged_in");
    expect(wrapper.get("[data-summary=account]").attributes("data-account-verified")).toBe("true");
    expect(wrapper.text()).toContain("已登录");
    expect(wrapper.text()).toContain("已安装");
    expect(wrapper.text()).toContain("128");
    expect(wrapper.text()).toContain("E:\\\\cli\\\\dreamina.exe");
    wrapper.unmount();
  });
});
