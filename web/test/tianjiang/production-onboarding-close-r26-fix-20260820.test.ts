/** @vitest-environment jsdom */

import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { createI18n } from "vue-i18n";
import { Guide } from "tdesign-vue-next";

import ProductionGuideControls from "@/views/production/components/ProductionGuideControls.vue";
import {
  PRODUCTION_GUIDE_VERSION,
  createProductionGuideController,
} from "@/views/production/production-guide";
import en from "@/locales/language/en.json";
import jaJP from "@/locales/language/ja_JP.json";
import ruRU from "@/locales/language/ru_RU.json";
import thTH from "@/locales/language/th_TH.json";
import viVN from "@/locales/language/vi-VN.json";
import zhCN from "@/locales/language/zh-CN.json";
import zhTW from "@/locales/language/zh-TW.json";

const steps = Array.from({ length: 4 }, (_, index) => ({
  element: "body",
  title: `步骤${index + 1}`,
  body: `说明${index + 1}`,
}));

const GuideStub = defineComponent({
  name: "TGuide",
  props: {
    modelValue: { type: Number, required: true },
    steps: { type: Array, required: true },
  },
  setup(props, { slots }) {
    return () => h("section", { "data-testid": "guide-stub" }, slots.content?.({
      current: props.modelValue,
      total: props.steps.length,
      handlePrev: vi.fn(),
      handleNext: vi.fn(),
      handleSkip: vi.fn(),
      handleFinish: vi.fn(),
    }));
  },
});

const localeMessages = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  "ja-JP": jaJP,
  "ru-RU": ruRU,
  "th-TH": thTH,
  "vi-VN": viVN,
};

const expectedGuideActions = {
  "zh-CN": ["关闭引导", "跳过", "上一步", "下一步", "完成"],
  "zh-TW": ["關閉引導", "跳過", "上一步", "下一步", "完成"],
  en: ["Close tutorial", "Skip", "Previous", "Next", "Finish"],
  "ja-JP": ["ガイドを閉じる", "スキップ", "前へ", "次へ", "完了"],
  "ru-RU": ["Закрыть подсказки", "Пропустить", "Назад", "Далее", "Готово"],
  "th-TH": ["ปิดคำแนะนำ", "ข้าม", "ก่อนหน้า", "ถัดไป", "เสร็จสิ้น"],
  "vi-VN": ["Đóng hướng dẫn", "Bỏ qua", "Trước", "Tiếp", "Hoàn tất"],
};

function createTestI18n(locale = "zh-CN") {
  return createI18n({ legacy: false, locale, messages: localeMessages });
}

function mountGuide(complete: () => Promise<boolean>, initialStep = 0) {
  return mount(defineComponent({
    setup() {
      const current = ref(initialStep);
      return () => h(ProductionGuideControls, {
        modelValue: current.value,
        steps,
        complete,
        "onUpdate:modelValue": (value: number) => {
          current.value = value;
        },
      });
    },
  }), {
    global: {
      stubs: { TGuide: GuideStub },
      plugins: [createTestI18n()],
    },
  });
}

function mountControllerGuide(controller: ReturnType<typeof createProductionGuideController>) {
  return mount(defineComponent({
    setup() {
      return () => h(ProductionGuideControls, {
        modelValue: controller.current.value,
        steps,
        complete: controller.complete,
        "onUpdate:modelValue": (value: number) => {
          controller.current.value = value;
        },
      });
    },
  }), {
    global: {
      stubs: { TGuide: GuideStub },
      plugins: [createTestI18n()],
    },
  });
}

describe("R26-fix 视频生产引导应用自有关闭操作", () => {
  it("使用真实 TDesign Guide 的 content slot 时仍能渲染并点击应用自有关闭按钮", async () => {
    const current = ref(0);
    const complete = vi.fn(async () => {
      current.value = -1;
      return true;
    });
    const i18n = createTestI18n();
    const wrapper = mount(defineComponent({
      setup() {
        return () => h(ProductionGuideControls, {
          modelValue: current.value,
          steps,
          complete,
          "onUpdate:modelValue": (value: number) => {
            current.value = value;
          },
        });
      },
    }), {
      attachTo: document.body,
      global: {
        components: { TGuide: Guide },
        plugins: [i18n],
      },
    });

    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flushPromises();
    const closeButton = document.body.querySelector<HTMLButtonElement>('[data-testid="production-guide-close"]');
    expect(closeButton?.textContent?.trim()).toBe("关闭引导");
    closeButton?.click();
    await flushPromises();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(current.value).toBe(-1);
    wrapper.unmount();
  });

  it("真实 TDesign Guide 中应用自有跳过与完成按钮都可点击", async () => {
    const mountRealGuideAt = (initialStep: number, complete: () => Promise<boolean>) => {
      const current = ref(initialStep);
      const wrapper = mount(defineComponent({
        setup() {
          return () => h(ProductionGuideControls, {
            modelValue: current.value,
            steps,
            complete,
            "onUpdate:modelValue": (value: number) => {
              current.value = value;
            },
          });
        },
      }), {
        attachTo: document.body,
        global: {
          components: { TGuide: Guide },
          plugins: [createTestI18n()],
        },
      });
      return { current, wrapper };
    };

    const skipComplete = vi.fn().mockResolvedValue(true);
    const skipGuide = mountRealGuideAt(0, skipComplete);
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flushPromises();
    document.body.querySelector<HTMLButtonElement>('[data-testid="production-guide-skip"]')?.click();
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flushPromises();
    expect(skipComplete).toHaveBeenCalledTimes(1);
    skipGuide.wrapper.unmount();

    const finishComplete = vi.fn().mockResolvedValue(true);
    const finishGuide = mountRealGuideAt(steps.length - 1, finishComplete);
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flushPromises();
    document.body.querySelector<HTMLButtonElement>('[data-testid="production-guide-finish"]')?.click();
    await flushPromises();
    expect(finishComplete).toHaveBeenCalledTimes(1);
    finishGuide.wrapper.unmount();
  });

  it("真实点击关闭按钮会等待保存；失败保持原步骤并允许原位重试，成功后才关闭", async () => {
    const client = {
      get: vi.fn(),
      put: vi.fn()
        .mockRejectedValueOnce(new Error("E:\\private\\db.sqlite SELECT cookie=secret stack.ts:9"))
        .mockResolvedValueOnce({
          code: 0,
          data: { completedRevision: PRODUCTION_GUIDE_VERSION },
        }),
    };
    const controller = createProductionGuideController(client);
    controller.current.value = 2;
    const wrapper = mountControllerGuide(controller);

    const closeButton = wrapper.get('[data-testid="production-guide-close"]');
    expect(closeButton.text()).toBe("关闭引导");

    await closeButton.trigger("click");
    await flushPromises();
    expect(client.put).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="production-guide-close"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="production-guide-step"]').text()).toContain("3/4");
    expect(controller.errorMessage.value).toBe("新手引导完成状态保存失败，请重试");
    expect(controller.errorMessage.value).not.toMatch(/private|sqlite|select|cookie|secret|stack/i);

    await wrapper.get('[data-testid="production-guide-close"]').trigger("click");
    await flushPromises();
    expect(client.put).toHaveBeenCalledTimes(2);
    expect(controller.current.value).toBe(-1);
    expect(wrapper.find('[data-testid="production-guide-close"]').exists()).toBe(false);
  });

  it("应用自有跳过和完成按钮与关闭按钮共用同一个异步完成入口", async () => {
    const complete = vi.fn().mockResolvedValue(false);
    const firstStep = mountGuide(complete, 0);
    await firstStep.get('[data-testid="production-guide-skip"]').trigger("click");
    await flushPromises();

    const lastStep = mountGuide(complete, steps.length - 1);
    await lastStep.get('[data-testid="production-guide-finish"]').trigger("click");
    await flushPromises();

    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("切换七种语言时所有应用自有引导按钮都使用对应翻译", async () => {
    for (const [locale, labels] of Object.entries(expectedGuideActions)) {
      const i18n = createI18n({ legacy: false, locale, messages: localeMessages });
      const mountAt = (initialStep: number) => mount(ProductionGuideControls, {
        props: {
          modelValue: initialStep,
          steps,
          complete: vi.fn().mockResolvedValue(false),
        },
        global: {
          stubs: { TGuide: GuideStub },
          plugins: [i18n],
        },
      });

      const first = mountAt(0);
      expect(first.get('[data-testid="production-guide-close"]').text()).toBe(labels[0]);
      expect(first.get('[data-testid="production-guide-skip"]').text()).toBe(labels[1]);
      expect(first.findAll("button").map((button) => button.text())).toContain(labels[3]);
      first.unmount();

      const middle = mountAt(1);
      expect(middle.findAll("button").map((button) => button.text())).toContain(labels[2]);
      middle.unmount();

      const last = mountAt(steps.length - 1);
      expect(last.get('[data-testid="production-guide-finish"]').text()).toBe(labels[4]);
      last.unmount();
    }
  });
});
