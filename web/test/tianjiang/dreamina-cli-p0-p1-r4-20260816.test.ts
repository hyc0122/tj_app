// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

const axiosGet = vi.fn();
const axiosPost = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
  },
}));

import DreaminaProviderPanel from "@/components/setting/components/vendorConfig/components/DreaminaProviderPanel.vue";

const resolvedPath = "C:\\\\Users\\\\hyc19\\\\bin\\\\dreamina.exe";

function mountPanel() {
  return mount(DreaminaProviderPanel, {
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
      stubs: {
        TButton: {
          inheritAttrs: true,
          props: ["loading", "disabled"],
          template: "<button v-bind=\"$attrs\" :disabled=\"disabled || loading\"><slot/></button>",
        },
        TDialog: { template: "<section v-if=\"visible\" role=\"dialog\"><slot/></section>", props: ["visible"] },
        TTag: { template: "<span><slot /></span>" },
        TIcon: { template: "<i />" },
        TAlert: { template: "<div role=\"alert\"><slot /></div>" },
        TInput: {
          inheritAttrs: true,
          props: ["modelValue"],
          emits: ["update:modelValue"],
          template: "<input v-bind=\"$attrs\" :value=\"modelValue\" @input=\"$emit('update:modelValue', $event.target.value)\" />",
        },
      },
    },
  });
}

describe("R4 即梦路径自动回填", () => {
  beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("getSettings")) {
        return Promise.resolve({ data: { executablePath: "dreamina" } });
      }
      return Promise.resolve({
        data: {
          install: { state: "not_installed" },
          account: { state: "unknown", verified: false },
        },
      });
    });
  });

  it("检测成功后必须把解析出的绝对路径自动填入 CLI 可执行路径输入框", async () => {
    axiosPost.mockImplementation((url: string) => {
      if (String(url).includes("checkCli")) {
        return Promise.resolve({
          data: { available: true, resolvedExecutablePath: resolvedPath, version: "54f1bdf-dirty" },
        });
      }
      return Promise.resolve({ data: {} });
    });
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.get('[data-field="executable-path"]').element).toHaveProperty("value", "dreamina");

    await wrapper.get('[data-action="check-cli"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-field="executable-path"]').element).toHaveProperty("value", resolvedPath);
    expect(wrapper.text()).not.toContain("即梦 CLI 可执行文件不存在");
    wrapper.unmount();
  });
});
