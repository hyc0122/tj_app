// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
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

const expectedVideoModels = [
  "seedance2.0",
  "seedance2.0fast",
  "seedance2.0mini",
  "seedance2.0_vip",
  "seedance2.0fast_vip",
] as const;

function buildStatus(videoModels?: string[]) {
  return {
    preferredExecutionTarget: "windows_native",
    effectiveExecutionTarget: "windows_native",
    install: { state: "installed", version: "a857341-dirty", executablePath: "dreamina.exe", managed: true },
    account: { state: "logged_in", points: "32", reason: "已登录" },
    capability: {
      state: "ready",
      snapshot: {
        capabilities: ["text2video", "image2video", "frames2video"],
        videoModels,
      },
    },
    queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 },
  };
}

const environment = {
  target: "windows_native",
  dependencies: [],
  suggestWsl: false,
  linuxReleaseAvailable: false,
};

function mountPanel(): VueWrapper {
  return mount(DreaminaProviderPanel, {
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
      stubs: {
        TButton: { template: "<button><slot name=\"icon\"/><slot/></button>" },
        TDialog: { template: "<section><slot/></section>" },
        TTag: { template: "<span data-video-model><slot /></span>" },
        TIcon: { template: "<i />" },
      },
    },
  });
}

beforeEach(() => {
  axiosGet.mockReset();
  axiosPost.mockReset().mockResolvedValue({ data: {} });
  axiosGet.mockImplementation((url: string) => {
    if (url.includes("getEnvironment")) return Promise.resolve({ data: environment });
    return Promise.resolve({ data: buildStatus([...expectedVideoModels]) });
  });
});

describe("Round27 即梦 CLI 模型与模块交互合同", () => {
  it("模型卡只展示 snapshot.videoModels 的五个 Seedance 模型，不展示命令能力", async () => {
    const wrapper = mountPanel();
    await flushPromises();

    const models = wrapper.findAll('[data-section="models"] [data-video-model]').map((node) => node.text());
    expect(models).toEqual([...expectedVideoModels]);
    expect(models).not.toContain("text2video");
    wrapper.unmount();
  });

  it("videoModels 缺失时回退同一份五模型产品列表", async () => {
    axiosGet.mockImplementation((url: string) => {
      if (url.includes("getEnvironment")) return Promise.resolve({ data: environment });
      return Promise.resolve({ data: buildStatus(undefined) });
    });
    const wrapper = mountPanel();
    await flushPromises();

    const models = wrapper.findAll('[data-section="models"] [data-video-model]').map((node) => node.text());
    expect(models).toEqual([...expectedVideoModels]);
    wrapper.unmount();
  });

  it("四张摘要卡和五张业务卡分别使用共享的小卡片与面板悬浮类", async () => {
    const wrapper = mountPanel();
    await flushPromises();

    const summaries = wrapper.findAll("[data-summary]");
    expect(summaries).toHaveLength(4);
    for (const summary of summaries) expect(summary.classes()).toContain("module-interactive--sm");

    for (const section of ["install", "environment", "account", "models", "queue"]) {
      expect(wrapper.get(`[data-section="${section}"]`).classes(), section).toContain("module-interactive--panel");
    }
    wrapper.unmount();
  });

});
