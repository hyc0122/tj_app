// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@/utils/axios", () => ({
  default: {
    get: mocks.get,
    put: mocks.put,
  },
}));

import HelloGuide from "@/components/hello.vue";

function mountGuide() {
  return mount(HelloGuide, {
    global: {
      plugins: [
        createPinia(),
        createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
      ],
      stubs: {
        TDialog: {
          props: ["visible"],
          template: '<section v-if="visible" class="dialog"><slot /></section>',
        },
        TButton: {
          props: ["loading", "disabled"],
          emits: ["click"],
          template: '<button :disabled="loading || disabled" @click="$emit(\'click\')"><slot /></button>',
        },
        TDropdown: { template: "<div><slot /></div>" },
        TAlert: { props: ["message"], template: '<p class="save-error">{{ message }}</p>' },
        TSteps: true,
        TStepItem: true,
        TIcon: true,
        TQrcode: { template: '<div class="legacy-qrcode" />' },
        ITranslate: true,
      },
    },
  });
}

describe("引导状态不得使用 localStorage", () => {
  beforeEach(() => {
    mocks.get.mockReset().mockImplementation(async (url: string) => {
      if (url.includes("client-config")) {
        return { data: { config: { onboarding: { guideRevision: 2, supportQrCodeUrl: "" } } } };
      }
      return { data: { completedRevision: 0 } };
    });
    mocks.put.mockReset();
  });

  it("hello.vue 使用本地 onboarding API 且无 helloGuideDone", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/components/hello.vue"),
      "utf8",
    );
    expect(source).not.toContain("helloGuideDone");
    expect(source).not.toContain("useLocalStorage");
    expect(source).toContain("/tianjiang/client-state/onboarding");
    expect(source).toContain("/tianjiang/public/client-config");
    expect(source).toContain("supportQrCodeUrl");
    expect(source).not.toContain("work.weixin.qq.com/u/");
  });

  it("PUT 失败保持引导打开并显示单一可重试提示，重试成功才关闭", async () => {
    mocks.put.mockRejectedValueOnce(new Error("offline"));
    const wrapper = mountGuide();
    await flushPromises();
    const skip = wrapper.findAll("button").find((button) => button.text().includes("跳过"));
    expect(skip).toBeTruthy();
    await skip!.trigger("click");
    await flushPromises();

    expect(wrapper.find(".dialog").exists()).toBe(true);
    expect(wrapper.findAll(".save-error")).toHaveLength(1);
    expect(wrapper.find(".save-error").text()).toContain("保存失败");

    mocks.put.mockResolvedValueOnce({ data: { completedRevision: 2 } });
    const retry = wrapper.findAll("button").find((button) => button.text().includes("跳过"));
    await retry!.trigger("click");
    await flushPromises();
    expect(wrapper.find(".dialog").exists()).toBe(false);
    expect(mocks.put).toHaveBeenCalledTimes(2);
  });

  it("完成页直接展示后台图片且不把图片 URL 二次编码成二维码", async () => {
    const imageUrl = "https://cdn.example.com/support.png";
    mocks.get.mockImplementation(async (url: string) => {
      if (url.includes("client-config")) {
        return { data: { config: { onboarding: { guideRevision: 2, supportQrCodeUrl: imageUrl } } } };
      }
      return { data: { completedRevision: 0 } };
    });
    const wrapper = mountGuide();
    await flushPromises();

    for (const label of ["开始配置", "下一步", "下一步"]) {
      const button = wrapper.findAll("button").find((item) => item.text().includes(label));
      expect(button).toBeTruthy();
      await button!.trigger("click");
    }

    const image = wrapper.find(".qrcodeBox img");
    expect(image.exists()).toBe(true);
    expect(image.attributes("src")).toBe(imageUrl);
    expect(image.attributes("alt")).toBe("客服支持二维码");
    expect(wrapper.find(".legacy-qrcode").exists()).toBe(false);
  });

  it("后台未配置二维码时完成页不渲染图片", async () => {
    const wrapper = mountGuide();
    await flushPromises();
    for (const label of ["开始配置", "下一步", "下一步"]) {
      const button = wrapper.findAll("button").find((item) => item.text().includes(label));
      await button!.trigger("click");
    }
    expect(wrapper.find(".qrcodeBox img").exists()).toBe(false);
    expect(wrapper.find(".legacy-qrcode").exists()).toBe(false);
  });
});
