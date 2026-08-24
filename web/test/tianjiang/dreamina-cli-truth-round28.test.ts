// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const staleLoggedIn = {
  preferredExecutionTarget: "windows_native",
  effectiveExecutionTarget: null,
  install: {
    state: "not_installed",
    version: null,
    executablePath: null,
    managed: false,
    checkedAt: null,
    reason: "未配置可执行文件",
  },
  account: {
    state: "unknown",
    lastKnownState: "logged_in",
    verified: false,
    reason: "未找到可执行文件",
  },
  capability: { state: "not_checked", snapshot: null, checkedAt: null },
  queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 },
};

const settings = {
  executablePath: "E:\\\\tools\\\\dreamina.exe",
  maxConcurrency: 1,
  pauseNewClaims: false,
  preferredExecutionTarget: "windows_native",
};

function mountPanel(): VueWrapper {
  return mount(DreaminaProviderPanel, {
    global: {
      plugins: [
        createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
      ],
      stubs: {
        TButton: {
          inheritAttrs: true,
          props: ["loading", "disabled"],
          template: "<button v-bind=\"$attrs\" :disabled=\"disabled || loading\"><slot name=\"icon\"/><slot/></button>",
        },
        TDialog: {
          inheritAttrs: false,
          props: ["visible", "header"],
          template: "<section v-if=\"visible\" role=\"dialog\"><h2>{{ header }}</h2><slot/><slot name=\"footer\"/></section>",
        },
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

beforeEach(() => {
  axiosGet.mockReset();
  axiosPost.mockReset();
  axiosGet.mockImplementation((url: string) => {
    if (String(url).includes("getSettings")) return Promise.resolve({ data: settings });
    if (String(url).includes("getEnvironment")) {
      return Promise.resolve({
        data: {
          target: "windows_native",
          dependencies: [],
          suggestWsl: false,
          linuxReleaseAvailable: false,
        },
      });
    }
    return Promise.resolve({ data: staleLoggedIn });
  });
  axiosPost.mockResolvedValue({ data: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("即梦 CLI 真值面板", () => {
  it("挂载时读取路径设置，且不得把缓存登录显示成绿色已登录", async () => {
    const wrapper = mountPanel();
    await flushPromises();

    expect(axiosGet.mock.calls.some(([url]) => String(url).includes("/setting/dreaminaCli/getSettings"))).toBe(true);
    expect(wrapper.get('[data-field="executable-path"]').element).toHaveProperty("value", settings.executablePath);
    expect(wrapper.get('[data-account-verified]').attributes("data-account-verified")).toBe("false");
    expect(wrapper.get('[data-account-display]').attributes("data-account-display")).not.toBe("logged_in");
    expect(wrapper.text()).toMatch(/未检测|上次状态/);
    expect(wrapper.get('[data-account-display]').text()).not.toBe("已登录");
    wrapper.unmount();
  });

  it("默认显示 dreamina 命令，检测成功后必须把绝对路径填回输入框", async () => {
    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("getSettings")) {
        return Promise.resolve({ data: { ...settings, executablePath: "dreamina" } });
      }
      if (String(url).includes("getEnvironment")) {
        return Promise.resolve({ data: { target: "windows_native", dependencies: [], suggestWsl: false } });
      }
      return Promise.resolve({ data: staleLoggedIn });
    });
    axiosPost.mockImplementation((url: string) => {
      if (String(url).includes("checkCli")) {
        return Promise.resolve({
          data: {
            available: true,
            resolvedExecutablePath: "C:\\Users\\tester\\bin\\dreamina.exe",
            version: "1.4.4",
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    const wrapper = mountPanel();
    await flushPromises();
    const pathInput = wrapper.get('[data-field="executable-path"]');
    expect(pathInput.element).toHaveProperty("value", "dreamina");

    await wrapper.get('[data-action="check-cli"]').trigger("click");
    await flushPromises();
    expect(pathInput.element).toHaveProperty("value", "C:\\Users\\tester\\bin\\dreamina.exe");
    expect(wrapper.text()).toContain("C:\\Users\\tester\\bin\\dreamina.exe");
    wrapper.unmount();
  });

  it("保存路径后回到未检测，并拆分检测 CLI 与检测登录", async () => {
    axiosPost.mockImplementation((url: string) => {
      if (String(url).includes("updateSettings")) {
        return Promise.resolve({ data: { executablePath: "E:\\\\fake\\\\dreamina.exe" } });
      }
      if (String(url).includes("checkCli")) {
        return Promise.resolve({
          data: {
            available: true,
            resolvedExecutablePath: "E:\\\\fake\\\\dreamina.exe",
            version: "1.4.4",
          },
        });
      }
      if (String(url).includes("checkLogin")) {
        return Promise.resolve({
          data: {
            account: { state: "logged_out", verified: true, reason: "未登录即梦账号" },
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    const wrapper = mountPanel();
    await flushPromises();

    const pathInput = wrapper.get('[data-field="executable-path"]');
    await pathInput.setValue("E:\\\\fake\\\\dreamina.exe");
    await wrapper.get('[data-action="save-path"]').trigger("click");
    await flushPromises();

    expect(axiosPost).toHaveBeenCalledWith(
      "/setting/dreaminaCli/updateSettings",
      expect.objectContaining({ executablePath: "E:\\\\fake\\\\dreamina.exe" }),
    );
    expect(wrapper.get('[data-account-display]').attributes("data-account-display")).toBe("unchecked");

    await wrapper.get('[data-action="check-cli"]').trigger("click");
    await flushPromises();
    expect(axiosPost).toHaveBeenCalledWith("/setting/dreaminaCli/checkCli");
    expect(wrapper.text()).toContain("E:\\\\fake\\\\dreamina.exe");

    await wrapper.get('[data-action="check-login"]').trigger("click");
    await flushPromises();
    expect(axiosPost).toHaveBeenCalledWith("/setting/dreaminaCli/checkLogin");
    expect(wrapper.get('[data-account-display]').attributes("data-account-display")).toBe("logged_out");
    wrapper.unmount();
  });
});
