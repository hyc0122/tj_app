// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import Panel from "@/components/setting/components/vendorConfig/components/DreaminaEnvironmentPanel.vue";

const axiosGet = vi.fn();
vi.mock("@/utils/axios", () => ({
  default: { get: (...args: unknown[]) => axiosGet(...args), post: vi.fn() },
}));

describe("WSL 建议边界", () => {
  it("网络失败不得显示 WSL，平台不兼容才显示", async () => {
    axiosGet.mockResolvedValue({
      data: {
        dependencies: [{ id: "dreamina_binary", label: "即梦 CLI", installed: false, compatible: false }],
        suggestWsl: false,
        failureClass: "network",
      },
    });
    const wrapper = mount(Panel, {
      global: {
        plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
        stubs: { TButton: { template: "<button><slot /></button>" } },
      },
    });
    await flushPromises();
    expect(wrapper.text()).not.toMatch(/WSL/);
    wrapper.unmount();

    axiosGet.mockResolvedValue({
      data: {
        dependencies: [{ id: "dreamina_binary", label: "即梦 CLI", installed: false, compatible: false }],
        suggestWsl: true,
        failureClass: "platform_incompatible",
      },
    });
    const incompatible = mount(Panel, {
      global: {
        plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
        stubs: { TButton: { template: "<button><slot /></button>" } },
      },
    });
    await flushPromises();
    expect(incompatible.text()).toMatch(/WSL/);
    incompatible.unmount();
  });
});
