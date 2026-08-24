// @vitest-environment jsdom
/**
 * R22 RED：抽屉单项重新生成必须提交 editForm.model；
 * 左侧批量继续用 selectValue；Seedream 4.5 不得被空的批量模型挡住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import zhCN from "@/locales/language/zh-CN.json";
import { readSafeGenerationSubmitError } from "@/views/storyboardProject/storyboard-generation-preview";

const messageApi = {
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
};
(globalThis as any).$t = (key: string, named?: Record<string, unknown>) => {
  if (key === "workbench.cornerScape.msg.selectModel") return "请选择生成模型";
  if (named?.name) return `${key}:${named.name}`;
  return key;
};
if (typeof window !== "undefined") {
  (window as any).$message = messageApi;
  (globalThis as any).$message = messageApi;
}

const axiosPost = vi.fn(async (_url: string, _body?: unknown) => ({ data: {} }));
vi.mock("@/utils/axios", () => ({
  default: {
    post: (...args: unknown[]) => axiosPost(...(args as [string, unknown?])),
    get: vi.fn(),
  },
}));

vi.mock("@/stores/setting", async () => {
  const { defineStore } = await import("pinia");
  const { ref: vref } = await import("vue");
  return {
    default: defineStore("setting-r22", () => ({
      otherSetting: vref({ assetsBatchGenereateSize: 2 }),
    })),
  };
});

vi.mock("tdesign-vue-next", () => ({
  DialogPlugin: { confirm: () => ({ destroy: vi.fn() }) },
}));

import { useCornerScapeBatchActions } from "@/views/cornerScape/composables/useCornerScapeBatchActions";
import { useCornerScapeDrawer } from "@/views/cornerScape/composables/useCornerScapeDrawer";
import type { CornerScapeItem } from "@/views/cornerScape/composables/cornerScapeTypes";

const SEEDREAM_A = "volcengine:doubao-seedream-4-0-250828";
const SEEDREAM_B = "volcengine:doubao-seedream-4-5-251128";

function mockCornerState() {
  const item: CornerScapeItem = {
    id: 21,
    name: "剑",
    type: "tool",
    describe: "d",
    prompt: "一把古剑",
    promptState: "",
    state: "",
    audioBindState: "",
    historyImages: [],
    relepedAudio: [],
    filePath: "",
    model: SEEDREAM_A,
    resolution: "2K",
  } as CornerScapeItem;
  return {
    project: ref({ id: "101" }),
    dataList: ref([{ ...item }]),
    selectedIds: ref([21]),
    checkboxValue: ref("tool"),
    selectValue: ref(""),
    resolution: ref("1K"),
    otherTextPrompt: ref(""),
    getFilteredData: vi.fn(async () => undefined),
    createAbortController: () => new AbortController(),
  } as any;
}

function mountComposable<T>(setup: () => T): { result: T; app: App; el: HTMLElement } {
  let result!: T;
  const el = document.createElement("div");
  document.body.appendChild(el);
  const app = createApp(
    defineComponent({
      setup() {
        result = setup();
        return () => h("div");
      },
    }),
  );
  app.use(createPinia());
  app.use(createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }));
  app.mount(el);
  return { result, app, el };
}

describe("R22 抽屉单项重新生成与批量模型隔离", () => {
  const hosts: Array<{ app: App; el: HTMLElement }> = [];
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosPost.mockClear();
    axiosPost.mockResolvedValue({ data: {} });
    messageApi.warning.mockClear();
    messageApi.error.mockClear();
  });
  afterEach(() => {
    while (hosts.length) {
      const host = hosts.pop()!;
      host.app.unmount();
      host.el.remove();
    }
  });

  it("selectValue 为空且 editForm.model 有值时单项重新生成必须提交抽屉模型", async () => {
    const state = mockCornerState();
    const host = mountComposable(() => {
      const drawer = useCornerScapeDrawer(state);
      drawer.currentItem.value = state.dataList.value[0];
      drawer.editForm.model = SEEDREAM_B;
      drawer.editForm.prompt = "一把古剑";
      drawer.editForm.resolution = "2K";
      return { drawer };
    });
    hosts.push(host);
    host.result.drawer.regenerateItem();
    await Promise.resolve();
    expect(messageApi.warning).not.toHaveBeenCalledWith("请选择生成模型");
    const posted = axiosPost.mock.calls.find((call) => String(call[0]).includes("/assetsGenerate/generateAssets"));
    expect(posted).toBeTruthy();
    expect(posted?.[1]).toMatchObject({
      model: SEEDREAM_B,
      resolution: "2K",
      prompt: "一把古剑",
      id: 21,
    });
    expect(posted?.[1]).not.toMatchObject({ model: "" });
    expect(state.selectValue.value).toBe("");
  });

  it("抽屉从模型 A 切到 B 后请求只发送 B，批量仍读 selectValue", async () => {
    const state = mockCornerState();
    state.selectValue.value = SEEDREAM_A;
    const host = mountComposable(() => {
      const drawer = useCornerScapeDrawer(state);
      const batch = useCornerScapeBatchActions(state, drawer);
      drawer.currentItem.value = state.dataList.value[0];
      drawer.editForm.model = SEEDREAM_A;
      drawer.editForm.prompt = "一把古剑";
      drawer.editForm.resolution = "2K";
      return { drawer, batch };
    });
    hosts.push(host);
    host.result.drawer.editForm.model = SEEDREAM_B;
    host.result.drawer.regenerateItem();
    await Promise.resolve();
    const single = axiosPost.mock.calls.find((call) => String(call[0]).includes("/assetsGenerate/generateAssets"));
    expect(single?.[1]).toMatchObject({ model: SEEDREAM_B });
    expect(JSON.stringify(single?.[1])).not.toContain(SEEDREAM_A);

    axiosPost.mockClear();
    await host.result.batch.batchGenerationImage();
    const batch = axiosPost.mock.calls.find((call) => String(call[0]).includes("batchGenerateImageAssets"));
    expect(batch?.[1]).toMatchObject({ model: SEEDREAM_A });
    expect(host.result.drawer.editForm.model).toBe(SEEDREAM_B);
    expect(state.selectValue.value).toBe(SEEDREAM_A);
  });

  it("P1-4 阶段错误必须保持稳定文案，不得把密钥或路径回显", () => {
    expect(readSafeGenerationSubmitError(
      { code: "VENDOR_GENERATION_FAILED", message: "普通供应商生成失败，请检查模型配置或稍后重试" },
      "提交生成失败，请重试",
    )).toBe("普通供应商生成失败，请检查模型配置或稍后重试");
    expect(readSafeGenerationSubmitError(
      { code: "VENDOR_PREPARE_FAILED", message: "当前视频模型配置或请求参数不可用" },
      "提交生成失败，请重试",
    )).toBe("当前视频模型配置或请求参数不可用");
    expect(readSafeGenerationSubmitError(
      { code: "RAW", message: "E:\\\\app\\\\db.sqlite sk-live cookie" },
      "提交生成失败，请重试",
    )).toBe("提交生成失败，请重试");
  });
});
