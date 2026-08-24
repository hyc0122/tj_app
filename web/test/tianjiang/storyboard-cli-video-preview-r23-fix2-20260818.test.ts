// @vitest-environment jsdom
/**
 * R23-fix2 RED：POST 必须原子合并 queue；同 revision 旧 GET 不得回退 enabled/queue。
 */
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
  },
}));

describe("R23-fix2 启停 POST 必须原子合并 queue", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("POST 关闭后立即显示 queue.paused，同 revision 旧 GET 不得回退", async () => {
    setActivePinia(createPinia());
    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("getSettings")) {
        return Promise.resolve({ data: { executablePath: "dreamina", enabled: true, updatedAt: 400 } });
      }
      return Promise.resolve({
        data: {
          install: { state: "installed", version: "r23-fix2" },
          account: { state: "logged_in", verified: true },
          capability: { state: "ready" },
          queue: { paused: false, maxConcurrency: 1, queued: 3, active: 0, unknown: 0 },
          enabled: true,
          updatedAt: 400,
        },
      });
    });
    axiosPost.mockResolvedValue({
      data: {
        enabled: false,
        updatedAt: 400,
        install: { state: "installed" },
        account: { state: "unknown" },
        queue: { paused: true, maxConcurrency: 1, queued: 3, active: 0, unknown: 0 },
      },
    });
    const { default: DreaminaProviderPanel } = await import(
      "@/components/setting/components/vendorConfig/components/DreaminaProviderPanel.vue"
    );
    const wrapper = mount(DreaminaProviderPanel, {
      global: {
        plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
        stubs: {
          TButton: { template: "<button><slot /></button>" },
          TIcon: { template: "<i />" },
          TSwitch: { template: "<button data-field=\"dreamina-enabled\" />" },
        },
      },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("运行中");
    await wrapper.get('[data-action="set-dreamina-enabled"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("已关闭");
    expect(wrapper.text()).toContain("已暂停");
    expect(wrapper.text()).not.toContain("运行中");
    axiosGet.mockImplementation(() => Promise.resolve({
      data: {
        install: { state: "installed" },
        account: { state: "logged_in", verified: true },
        enabled: true,
        updatedAt: 400,
        queue: { paused: false, queued: 3 },
      },
    }));
    const reloadStatus = (wrapper.vm as { reloadStatus?: () => Promise<void> }).reloadStatus
      ?? (wrapper.vm.$ as { setupState?: { reloadStatus?: () => Promise<void> } }).setupState?.reloadStatus;
    expect(typeof reloadStatus).toBe("function");
    await reloadStatus!();
    await flushPromises();
    expect(wrapper.text()).toContain("已关闭");
    expect(wrapper.text()).toContain("已暂停");
    expect(wrapper.text()).not.toContain("已开启");
    expect(wrapper.text()).not.toContain("运行中");
    wrapper.unmount();
  });

  it("POST 打开与乱序 GET 也必须按 revision 原子覆盖 queue", async () => {
    setActivePinia(createPinia());
    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("getSettings")) {
        return Promise.resolve({ data: { executablePath: "dreamina", enabled: false, updatedAt: 500 } });
      }
      return Promise.resolve({
        data: {
          install: { state: "not_installed" },
          account: { state: "unknown" },
          queue: { paused: true, queued: 1 },
          enabled: false,
          updatedAt: 500,
        },
      });
    });
    axiosPost.mockResolvedValue({
      data: {
        enabled: true,
        updatedAt: 600,
        install: { state: "installed" },
        account: { state: "logged_in", verified: true },
        queue: { paused: false, queued: 1 },
      },
    });
    const { default: DreaminaProviderPanel } = await import(
      "@/components/setting/components/vendorConfig/components/DreaminaProviderPanel.vue"
    );
    const wrapper = mount(DreaminaProviderPanel, {
      global: {
        plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
        stubs: {
          TButton: { template: "<button><slot /></button>" },
          TIcon: { template: "<i />" },
          TSwitch: { template: "<button data-field=\"dreamina-enabled\" />" },
        },
      },
    });
    await flushPromises();
    await wrapper.get('[data-action="set-dreamina-enabled"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("已开启");
    expect(wrapper.text()).toContain("运行中");
    axiosGet.mockImplementation(() => Promise.resolve({
      data: {
        enabled: false,
        updatedAt: 500,
        queue: { paused: true, queued: 1 },
        install: { state: "not_installed" },
      },
    }));
    const reloadStatus = (wrapper.vm as { reloadStatus?: () => Promise<void> }).reloadStatus
      ?? (wrapper.vm.$ as { setupState?: { reloadStatus?: () => Promise<void> } }).setupState?.reloadStatus;
    await reloadStatus!();
    await flushPromises();
    expect(wrapper.text()).toContain("已开启");
    expect(wrapper.text()).toContain("运行中");
    expect(wrapper.text()).not.toContain("已关闭");
    wrapper.unmount();
  });
});
