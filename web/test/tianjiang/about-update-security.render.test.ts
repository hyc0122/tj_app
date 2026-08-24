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
  default: {
    get: mocks.get,
    post: mocks.post,
  },
}));

import AboutPage from "@/components/setting/components/about.vue";

const stubs = {
  TCard: { template: "<section><slot /></section>" },
  TBadge: { template: "<div><slot /></div>" },
  TButton: {
    props: ["loading", "disabled"],
    emits: ["click"],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot name="icon" /><slot /></button>',
  },
  TDialog: {
    template: '<div class="dialog"><slot /><slot name="footer" /></div>',
  },
  TTag: { template: "<span><slot /></span>" },
  TInput: {
    props: ["modelValue", "placeholder"],
    template: '<input :value="modelValue" :placeholder="placeholder" />',
  },
  IRefresh: true,
  INotes: true,
  IRight: true,
  IGithub: true,
  ICode: true,
  ICheckOne: true,
};

function mountAbout() {
  return mount(AboutPage, {
    global: {
      plugins: [
        createPinia(),
        createI18n({
          legacy: false,
          locale: "zh-CN",
          messages: { "zh-CN": zhCN },
        }),
      ],
      stubs,
    },
  });
}

describe("关于页更新地址安全边界", () => {
  beforeEach(() => {
    mocks.get.mockReset().mockResolvedValue({ data: "1.1.9" });
    mocks.post.mockReset().mockResolvedValue({
      data: {
        needUpdate: false,
        latestVersion: "1.1.9",
        reinstall: false,
        time: 0,
        url: "",
        version: "1.1.9",
      },
    });
    window.$message = {
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };
  });

  it("连续点击 Logo 也不会渲染自定义更新地址输入", async () => {
    const wrapper = mountAbout();
    await flushPromises();
    const logo = wrapper.get('img[alt="天将漫创 Logo"]');
    await logo.trigger("click");
    await logo.trigger("click");
    await logo.trigger("click");
    expect(wrapper.find('input[placeholder="输入自定义更新地址"]').exists()).toBe(false);
  });

  it("检查更新请求只发送受控动作，不发送 url 字段", async () => {
    const wrapper = mountAbout();
    await flushPromises();
    const buttons = wrapper.findAll("button");
    await buttons[0].trigger("click");
    await flushPromises();
    expect(mocks.post).toHaveBeenCalledWith(
      "/setting/about/checkUpdate",
      { action: "check" },
    );
    const payloads = mocks.post.mock.calls.map((call) => call[1] as Record<string, unknown>);
    for (const body of payloads) {
      expect(body).not.toHaveProperty("url");
      expect(body).not.toHaveProperty("feedBaseUrl");
    }
  });

  it("发现更新时展示安装包大小并提供稍后选择", async () => {
    mocks.post.mockResolvedValueOnce({
      data: {
        state: "available",
        currentVersion: "1.1.9",
        latestVersion: "1.2.0",
        packageSizeBytes: 10 * 1024 * 1024,
      },
    });
    const wrapper = mountAbout();
    await flushPromises();
    await wrapper.findAll("button")[0].trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("安装包大小：10 MB");
    expect(wrapper.findAll("button").some((button) => button.text() === "稍后")).toBe(true);
  });

  it("安装包下载完成后明确提供稍后安装", async () => {
    mocks.post.mockResolvedValueOnce({
      data: {
        state: "downloaded",
        currentVersion: "1.1.9",
        latestVersion: "1.2.0",
        packageSizeBytes: 20 * 1024 * 1024,
      },
    });
    const wrapper = mountAbout();
    await flushPromises();
    await wrapper.findAll("button")[0].trigger("click");
    await flushPromises();

    expect(wrapper.findAll("button").some((button) => button.text() === "稍后安装")).toBe(true);
  });
});
