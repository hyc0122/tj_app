// @vitest-environment jsdom
/**
 * R21-fix3 RED：设置页首次挂载必须用 getStatus 的 verified logged_in
 * 直接显示已登录、积分和绝对路径；不得点击开关、手动检测或重新授权。
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

async function mountPanel() {
  setActivePinia(createPinia());
  const { default: DreaminaProviderPanel } = await import(
    "@/components/setting/components/vendorConfig/components/DreaminaProviderPanel.vue"
  );
  return mount(DreaminaProviderPanel, {
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
}

describe("R21-fix3 首次挂载必须显示启动检测后的真实登录态", () => {
  it("首次挂载收到 logged_in + verified 后必须直接显示已登录、积分和路径", async () => {
    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("dreaminaCli/getSettings")) {
        return Promise.resolve({
          data: { executablePath: "E:\\\\cli\\\\dreamina.exe", enabled: true, maxConcurrency: 1, pauseNewClaims: false },
        });
      }
      if (String(url).includes("dreaminaCli/getStatus")) {
        return Promise.resolve({
          data: {
            enabled: true,
            install: {
              state: "installed",
              version: "r21-fix3",
              executablePath: "E:\\\\cli\\\\dreamina.exe",
            },
            account: { state: "logged_in", points: "256", verified: true },
            capability: { state: "ready", snapshot: null },
            queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 },
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    axiosPost.mockResolvedValue({ data: {} });
    const wrapper = await mountPanel();
    await flushPromises();
    expect(axiosGet.mock.calls.some((call) => String(call[0]).includes("getStatus"))).toBe(true);
    expect(axiosPost).not.toHaveBeenCalled();
    expect(wrapper.get("[data-summary=account]").attributes("data-account-display")).toBe("logged_in");
    expect(wrapper.get("[data-summary=account]").attributes("data-account-verified")).toBe("true");
    expect(wrapper.text()).toContain("已登录");
    expect(wrapper.text()).toContain("已安装");
    expect(wrapper.text()).toContain("256");
    expect(wrapper.text()).toContain("E:\\\\cli\\\\dreamina.exe");
    expect(wrapper.text()).not.toContain("未检测");
    expect(wrapper.text()).not.toContain("上次状态：已登录");
    wrapper.unmount();
  });

  it("未登录必须显示 logged_out，检测失败或未验证不得伪装已登录", async () => {
    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("dreaminaCli/getSettings")) {
        return Promise.resolve({
          data: { executablePath: "E:\\\\cli\\\\dreamina.exe", enabled: true },
        });
      }
      if (String(url).includes("dreaminaCli/getStatus")) {
        return Promise.resolve({
          data: {
            install: { state: "installed", executablePath: "E:\\\\cli\\\\dreamina.exe" },
            account: { state: "logged_out", verified: true },
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    const loggedOut = await mountPanel();
    await flushPromises();
    expect(loggedOut.get("[data-summary=account]").attributes("data-account-display")).toBe("logged_out");
    expect(loggedOut.text()).toContain("未登录");
    expect(loggedOut.get("[data-summary=account]").attributes("data-account-display")).not.toBe("logged_in");
    loggedOut.unmount();

    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("dreaminaCli/getSettings")) {
        return Promise.resolve({ data: { executablePath: "dreamina", enabled: true } });
      }
      if (String(url).includes("dreaminaCli/getStatus")) {
        return Promise.resolve({
          data: {
            install: { state: "installed", executablePath: "E:\\\\cli\\\\dreamina.exe" },
            account: { state: "logged_in", lastKnownState: "logged_in", verified: false, points: "9" },
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    const stale = await mountPanel();
    await flushPromises();
    expect(["last_known", "unchecked"]).toContain(
      stale.get("[data-summary=account]").attributes("data-account-display"),
    );
    expect(stale.get("[data-summary=account]").attributes("data-account-display")).not.toBe("logged_in");
    expect(stale.get("[data-summary=account]").attributes("data-account-verified")).not.toBe("true");
    stale.unmount();

    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("dreaminaCli/getSettings")) {
        return Promise.resolve({ data: { enabled: true } });
      }
      return Promise.resolve({
        data: {
          install: { state: "failed", executablePath: null },
          account: { state: "failed", verified: false },
        },
      });
    });
    const failed = await mountPanel();
    await flushPromises();
    expect(failed.get("[data-summary=account]").attributes("data-account-display")).not.toBe("logged_in");
    expect(failed.text()).not.toContain("已登录");
    failed.unmount();
  });
});
