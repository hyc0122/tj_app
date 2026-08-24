// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { describe, expect, it } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

describe("即梦授权对话框", () => {
  it("只展示授权地址和用户码，并提供复制与默认浏览器打开", async () => {
    const { default: Dialog } = await import(
      "../../src/components/setting/components/vendorConfig/components/DreaminaAuthorizationDialog.vue"
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => undefined },
    });
    const wrapper = mount(Dialog, {
      props: {
        visible: true,
        verificationUri: "https://jimeng.jianying.com/auth",
        userCode: "ABCD-1234",
        expiresAt: Date.now() + 60_000,
      },
      global: {
        plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
        stubs: { TDialog: { template: "<div><slot /></div>" }, TButton: { template: "<button><slot /></button>" } },
      },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("https://jimeng.jianying.com/auth");
    expect(wrapper.text()).toContain("ABCD-1234");
    expect(wrapper.text()).not.toMatch(/device_code|deviceCode|cookie|token/i);
    expect(wrapper.text()).toMatch(/复制/);
    expect(wrapper.text()).toMatch(/浏览器/);
    wrapper.unmount();
  });
});
