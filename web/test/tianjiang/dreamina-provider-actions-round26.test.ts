// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const clipboardWrite = vi.fn();
const protocolFetch = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
  },
}));

import DreaminaProviderPanel from "@/components/setting/components/vendorConfig/components/DreaminaProviderPanel.vue";

const cachedStatus = {
  preferredExecutionTarget: "windows_native",
  effectiveExecutionTarget: null,
  install: {
    state: "not_installed",
    version: null,
    executablePath: null,
    managed: false,
    checkedAt: null,
    reason: "尚未安装",
  },
  account: { state: "logged_out", reason: "未登录即梦账号" },
  capability: { state: "not_checked", snapshot: null, checkedAt: null },
  queue: { paused: false, maxConcurrency: 1, queued: 2, active: 1, unknown: 0 },
};

const environment = {
  target: "windows_native",
  dependencies: [{
    id: "dreamina_binary",
    label: "即梦 CLI",
    required: true,
    installed: false,
    compatible: true,
    reason: "等待安装",
  }],
  suggestWsl: false,
  linuxReleaseAvailable: false,
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
          emits: ["close"],
          template: "<section v-if=\"visible\" role=\"dialog\"><h2>{{ header }}</h2><slot/><slot name=\"footer\"/></section>",
        },
        TTag: { template: "<span><slot /></span>" },
        TIcon: { template: "<i />" },
        TAlert: { template: "<div role=\"alert\"><slot /></div>" },
      },
    },
  });
}

beforeEach(() => {
  axiosGet.mockReset();
  axiosPost.mockReset();
  clipboardWrite.mockReset().mockResolvedValue(undefined);
  protocolFetch.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true }),
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
  vi.stubGlobal("fetch", protocolFetch);
  axiosGet.mockImplementation((url: string) => {
    if (url.includes("getEnvironment")) return Promise.resolve({ data: environment });
    return Promise.resolve({ data: cachedStatus });
  });
  axiosPost.mockResolvedValue({ data: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("即梦 CLI 产品面板动作合同", () => {
  it("挂载只读缓存，并渲染四项总览和五张业务卡片", async () => {
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.attributes("data-layout")).toBe("dreamina-product-panel");
    expect(wrapper.findAll("[data-summary]")).toHaveLength(4);
    for (const section of ["install", "environment", "account", "models", "queue"]) {
      expect(wrapper.find(`[data-section="${section}"]`).exists(), section).toBe(true);
    }
    expect(axiosPost).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("2 个任务排队");
    wrapper.unmount();
  });

  it("显式重新检测调用 runSelfCheck，随后刷新缓存并显示成功反馈", async () => {
    axiosPost.mockImplementation((url: string) => {
      if (url.includes("runSelfCheck")) {
        return Promise.resolve({ data: { loggedIn: false, reason: "未登录" } });
      }
      return Promise.resolve({ data: {} });
    });
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.get('[data-action="recheck"]').trigger("click");
    await flushPromises();

    expect(axiosPost).toHaveBeenCalledWith("/setting/dreaminaCli/runSelfCheck");
    expect(axiosGet.mock.calls.filter(([url]) => String(url).includes("getStatus")).length).toBe(2);
    expect(wrapper.get('[data-feedback="dreamina-action"]').text()).toContain("检测完成");
    expect(wrapper.get('[data-action="recheck"]').attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("授权材料可复制、可经 Electron 白名单协议打开并可检查登录状态", async () => {
    axiosPost.mockImplementation((url: string) => {
      if (url.includes("startAuthorization")) {
        return Promise.resolve({
          data: {
            state: "authorization_required",
            verificationUri: "https://jimeng.jianying.com/device",
            userCode: "ABCD-1234",
            expiresAt: Date.now() + 300_000,
            pollIntervalSeconds: 30,
            authorizationId: "authorization-1",
          },
        });
      }
      if (url.includes("checkAuthorization")) {
        return Promise.resolve({ data: { state: "logged_in" } });
      }
      return Promise.resolve({ data: {} });
    });
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.get('[data-action="authorize"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);

    await wrapper.get('[data-action="copy-auth-url"]').trigger("click");
    await wrapper.get('[data-action="copy-user-code"]').trigger("click");
    await wrapper.get('[data-action="open-auth-browser"]').trigger("click");
    await wrapper.get('[data-action="check-authorization"]').trigger("click");
    await flushPromises();

    expect(clipboardWrite).toHaveBeenNthCalledWith(1, "https://jimeng.jianying.com/device");
    expect(clipboardWrite).toHaveBeenNthCalledWith(2, "ABCD-1234");
    expect(protocolFetch).toHaveBeenCalledWith(
      "tianjiang://openDreaminaExternal?kind=authorization&url=https%3A%2F%2Fjimeng.jianying.com%2Fdevice",
    );
    expect(axiosPost).toHaveBeenCalledWith(
      "/setting/dreaminaCli/checkAuthorization",
      { authorizationId: "authorization-1" },
    );
    expect(wrapper.text()).toContain("授权成功");
    wrapper.unmount();
  });

  it("复用已登录账号时关闭授权弹窗、刷新状态且不误报授权材料缺失", async () => {
    axiosGet.mockImplementation((url: string) => {
      if (url.includes("getEnvironment")) return Promise.resolve({ data: environment });
      return Promise.resolve({
        data: {
          ...cachedStatus,
          account: { state: "logged_in", reason: "已复用当前设备登录态" },
        },
      });
    });
    axiosPost.mockImplementation((url: string) => {
      if (url.includes("startAuthorization")) {
        return Promise.resolve({ data: { state: "already_logged_in" } });
      }
      return Promise.resolve({ data: {} });
    });
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.get('[data-action="authorize"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("账号已登录");
    expect(wrapper.text()).not.toContain("CLI 未返回完整授权材料");
    expect(axiosGet.mock.calls.filter(([url]) => String(url).includes("getStatus"))).toHaveLength(2);
    wrapper.unmount();
  });

  it.each(["expired", "failed"] as const)("授权进入 %s 终态后清空旧材料且不能继续提交", async (terminalState) => {
    axiosPost.mockImplementation((url: string) => {
      if (url.includes("startAuthorization")) {
        return Promise.resolve({
          data: {
            state: "authorization_required",
            verificationUri: "https://jimeng.jianying.com/device?session=old",
            userCode: "OLD-CODE",
            expiresAt: Date.now() + 300_000,
            pollIntervalSeconds: 30,
            authorizationId: "authorization-old",
          },
        });
      }
      if (url.includes("checkAuthorization")) return Promise.resolve({ data: { state: terminalState } });
      return Promise.resolve({ data: {} });
    });
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.get('[data-action="authorize"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);

    await wrapper.get('[data-action="check-authorization"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(wrapper.get('[data-action="copy-auth-url"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-action="copy-user-code"]').attributes("disabled")).toBeDefined();
    expect(wrapper.text()).not.toContain("OLD-CODE");
    expect(wrapper.text()).not.toContain("session=old");

    const checksBefore = axiosPost.mock.calls.filter(([url]) => String(url).includes("checkAuthorization")).length;
    await (wrapper.vm as unknown as { checkAuthorization: (manual: boolean) => Promise<void> }).checkAuthorization(true);
    await flushPromises();
    expect(axiosPost.mock.calls.filter(([url]) => String(url).includes("checkAuthorization"))).toHaveLength(checksBefore);
    wrapper.unmount();
  });

  it("新授权返回畸形材料时先清空旧授权，禁止沿用旧 authorizationId", async () => {
    let authorizationStarts = 0;
    axiosPost.mockImplementation((url: string) => {
      if (url.includes("startAuthorization")) {
        authorizationStarts += 1;
        if (authorizationStarts === 1) {
          return Promise.resolve({
            data: {
              state: "authorization_required",
              verificationUri: "https://jimeng.jianying.com/device?session=stale",
              userCode: "STALE-CODE",
              expiresAt: Date.now() + 300_000,
              pollIntervalSeconds: 30,
              authorizationId: "authorization-stale",
            },
          });
        }
        return Promise.resolve({
          data: {
            state: "authorization_required",
            verificationUri: "",
            userCode: "NEW-CODE",
            expiresAt: Date.now() + 300_000,
            pollIntervalSeconds: 30,
            authorizationId: "authorization-new",
          },
        });
      }
      if (url.includes("checkAuthorization")) return Promise.resolve({ data: { state: "authorizing" } });
      return Promise.resolve({ data: {} });
    });
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.get('[data-action="authorize"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);

    await wrapper.get('[data-action="authorize"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(wrapper.get('[data-action="copy-auth-url"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-action="copy-user-code"]').attributes("disabled")).toBeDefined();
    expect(wrapper.text()).not.toContain("STALE-CODE");
    expect(wrapper.text()).not.toContain("session=stale");

    await (wrapper.vm as unknown as { checkAuthorization: (manual: boolean) => Promise<void> }).checkAuthorization(true);
    await flushPromises();
    expect(axiosPost.mock.calls.some(([url]) => String(url).includes("checkAuthorization"))).toBe(false);
    wrapper.unmount();
  });

  it("安装失败留在卡片内可见，恢复按钮并允许重试", async () => {
    axiosPost.mockRejectedValueOnce({ message: "批准发行清单不存在" });
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.get('[data-action="install"]').trigger("click");
    await flushPromises();

    expect(axiosPost).toHaveBeenCalledWith(
      "/setting/dreaminaCli/install",
      { confirm: true },
    );
    expect(wrapper.get('[data-feedback="dreamina-action"]').text()).toContain("批准发行清单不存在");
    expect(wrapper.get('[data-action="install"]').attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("官方命令安装完成后必须检测 CLI，仍不可用时明确提示重启", async () => {
    axiosPost.mockImplementation((url: string) => {
      if (url.includes("/install")) return Promise.resolve({ data: { ok: true } });
      if (url.includes("/checkCli")) return Promise.resolve({ data: { available: false } });
      return Promise.resolve({ data: {} });
    });
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.get('[data-action="install"]').trigger("click");
    await flushPromises();

    expect(axiosPost).toHaveBeenCalledWith("/setting/dreaminaCli/install", { confirm: true });
    expect(axiosPost).toHaveBeenCalledWith("/setting/dreaminaCli/checkCli");
    expect(wrapper.get('[data-feedback="dreamina-action"]').text()).toContain("重启软件后再检测");
    wrapper.unmount();
  });
});
