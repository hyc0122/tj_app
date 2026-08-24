// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/utils/axios", () => ({
  default: { get: mocks.get, post: mocks.post },
}));

import AboutPage from "@/components/setting/components/about.vue";

const channel = (overrides: Record<string, unknown> = {}) => ({
  status: "current",
  source: "network",
  required: false,
  downloadAllowed: false,
  ...overrides,
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  state: "available",
  currentVersion: "1.1.11",
  stable: channel({ status: "available", latestVersion: "1.1.12", required: true, downloadAllowed: true }),
  beta: channel({ status: "available", latestVersion: "1.2.0-beta.1", downloadAllowed: false }),
  stableRequired: true,
  loginAllowed: false,
  selectedChannel: "stable",
  ...overrides,
});

const stubs = {
  TCard: { template: "<section><slot /></section>" },
  TBadge: { template: "<div><slot /></div>" },
  TTag: { template: "<span><slot /></span>" },
  TButton: {
    props: ["loading", "disabled"],
    emits: ["click"],
    template: '<button type="button" :disabled="loading || disabled" @click="$emit(\'click\')"><slot name="icon" /><slot /></button>',
  },
  TDialog: {
    props: ["visible"],
    template: '<div v-if="visible"><slot /><slot name="footer" /></div>',
  },
  IRefresh: true,
};

function mountAbout() {
  return mount(AboutPage, {
    global: {
      plugins: [
        createPinia(),
        createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
      ],
      stubs,
    },
  });
}

function buttonByText(wrapper: ReturnType<typeof mountAbout>, text: string) {
  return wrapper.findAll("button").find((button) => button.text().includes(text));
}

describe("关于页 Stable/Beta 双通道更新", () => {
  beforeEach(() => {
    mocks.get.mockReset().mockResolvedValue({ data: "1.1.11" });
    mocks.post.mockReset().mockResolvedValue({ data: snapshot() });
    window.$message = { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
  });

  it("同一快照展示两张独立通道卡和版本，强制 Stable 禁用 Beta", async () => {
    const wrapper = mountAbout();
    await flushPromises();
    await buttonByText(wrapper, "检查更新")!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("正式版 Stable");
    expect(wrapper.text()).toContain("v1.1.12");
    expect(wrapper.text()).toContain("测试版 Beta");
    expect(wrapper.text()).toContain("v1.2.0-beta.1");
    expect(wrapper.text()).toContain("强制更新");
    expect(buttonByText(wrapper, "更新测试版")?.attributes("disabled")).toBeDefined();
    expect(buttonByText(wrapper, "更新正式版")?.attributes("disabled")).toBeUndefined();
  });

  it("没有 Stable 强更时 Beta 始终可选，并提交固定 Beta 动作", async () => {
    mocks.post.mockResolvedValueOnce({
      data: snapshot({
        stable: channel({ latestVersion: "1.1.11" }),
        beta: channel({ status: "available", latestVersion: "1.2.0-beta.1", downloadAllowed: true }),
        stableRequired: false,
        loginAllowed: true,
        selectedChannel: null,
      }),
    }).mockResolvedValueOnce({
      data: snapshot({
        state: "downloading",
        stable: channel({ latestVersion: "1.1.11" }),
        beta: channel({ status: "available", latestVersion: "1.2.0-beta.1", downloadAllowed: true }),
        stableRequired: false,
        loginAllowed: true,
        selectedChannel: "beta",
      }),
    });
    const wrapper = mountAbout();
    await flushPromises();
    await buttonByText(wrapper, "检查更新")!.trigger("click");
    await flushPromises();
    const betaButton = buttonByText(wrapper, "更新测试版")!;
    expect(betaButton.attributes("disabled")).toBeUndefined();
    await betaButton.trigger("click");
    await flushPromises();

    expect(mocks.post).toHaveBeenLastCalledWith(
      "/setting/about/downloadApp",
      { action: "download-differential", channel: "beta" },
    );
    expect(mocks.post.mock.calls.at(-1)?.[1]).not.toHaveProperty("url");
  });

  it("异步动作单飞，失败结果在卡片中可见且可重试", async () => {
    let rejectCheck!: (error: Error) => void;
    mocks.post.mockImplementation(() => new Promise((_resolve, reject) => { rejectCheck = reject; }));
    const wrapper = mountAbout();
    await flushPromises();
    const refresh = buttonByText(wrapper, "检查更新")!;
    await refresh.trigger("click");
    await refresh.trigger("click");
    expect(mocks.post).toHaveBeenCalledTimes(1);

    rejectCheck(new Error("更新服务暂不可用"));
    await flushPromises();
    expect(wrapper.text()).toContain("更新服务暂不可用");
    expect(buttonByText(wrapper, "检查更新")).toBeDefined();
  });

  it("通道内部错误码只渲染稳定中文分类，未知码使用通用文案", async () => {
    mocks.post.mockResolvedValueOnce({
      data: snapshot({
        stable: channel({ status: "error", errorCode: "CATALOG_UNAVAILABLE" }),
        beta: channel({ status: "error", errorCode: "INTERNAL_PROVIDER_FAILURE" }),
        stableRequired: false,
        loginAllowed: true,
        selectedChannel: null,
      }),
    });
    const wrapper = mountAbout();
    await flushPromises();
    await buttonByText(wrapper, "检查更新")!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("更新目录暂不可用，请稍后重试");
    expect(wrapper.text()).toContain("更新检查失败，请稍后重试");
    expect(wrapper.text()).not.toContain("CATALOG_UNAVAILABLE");
    expect(wrapper.text()).not.toContain("INTERNAL_PROVIDER_FAILURE");
  });
});
