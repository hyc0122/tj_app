// @vitest-environment jsdom
/**
 * R22-fix RED：抽屉单项必须提交模型 B；即梦四态错误必须分码且不得回显路径/SQL。
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
  if (key === "workbench.cornerScape.msg.genSuccess") return `生成成功:${named?.name ?? ""}`;
  if (named?.name) return `${key}:${named.name}`;
  return key;
};
if (typeof window !== "undefined") {
  (window as any).$message = messageApi;
  (globalThis as any).$message = messageApi;
}

const axiosPost = vi.fn(async (_url: string, _body?: unknown) => ({ data: { path: "/ok.jpg", assetsId: 21 } }));
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
    default: defineStore("setting-r22-fix", () => ({
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

describe("R22-fix 抽屉模型 B 与即梦四态分码", () => {
  const hosts: Array<{ app: App; el: HTMLElement }> = [];
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosPost.mockClear();
    axiosPost.mockResolvedValue({ data: { path: "/ok.jpg", assetsId: 21 } });
    messageApi.warning.mockClear();
    messageApi.error.mockClear();
    messageApi.success.mockClear();
  });
  afterEach(() => {
    while (hosts.length) {
      const host = hosts.pop()!;
      host.app.unmount();
      host.el.remove();
    }
  });

  it("左侧批量为空时单项必须提交抽屉模型 B 并走成功回执", async () => {
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
    await Promise.resolve();
    expect(messageApi.warning).not.toHaveBeenCalledWith("请选择生成模型");
    const posted = axiosPost.mock.calls.find((call) => String(call[0]).includes("/assetsGenerate/generateAssets"));
    expect(posted?.[1]).toMatchObject({
      model: SEEDREAM_B,
      resolution: "2K",
      prompt: "一把古剑",
      id: 21,
    });
    expect(JSON.stringify(posted?.[1])).not.toContain(SEEDREAM_A);
    expect(state.selectValue.value).toBe("");
    expect(messageApi.success).toHaveBeenCalled();
    expect(messageApi.error).not.toHaveBeenCalled();
  });

  it("左侧批量为模型 A 时单项仍只发送模型 B", async () => {
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
  });

  it("即梦四态与暂存失败必须保持稳定分码，不得回显路径或 SQL", () => {
    expect(readSafeGenerationSubmitError(
      { code: "DREAMINA_CLI_NOT_INSTALLED", message: "未安装即梦 CLI 或无法执行" },
      "提交生成失败，请重试",
    )).toBe("未安装即梦 CLI 或无法执行");
    expect(readSafeGenerationSubmitError(
      { code: "DREAMINA_CLI_NOT_LOGGED_IN", message: "未登录即梦账号" },
      "提交生成失败，请重试",
    )).toBe("未登录即梦账号");
    expect(readSafeGenerationSubmitError(
      { code: "STORYBOARD_DREAMINA_CLI_UNAVAILABLE", message: "即梦 CLI 不可用" },
      "提交生成失败，请重试",
    )).toBe("即梦 CLI 不可用");
    expect(readSafeGenerationSubmitError(
      { code: "STORYBOARD_DREAMINA_MODE_UNSUPPORTED", message: "当前即梦 CLI 不支持 multimodal2video" },
      "提交生成失败，请重试",
    )).toBe("当前即梦 CLI 不支持 multimodal2video");
    expect(readSafeGenerationSubmitError(
      { code: "VENDOR_MEDIA_STAGING_FAILED", message: "参考素材暂存失败，请检查网络或稍后重试" },
      "提交生成失败，请重试",
    )).toBe("参考素材暂存失败，请检查网络或稍后重试");
    expect(readSafeGenerationSubmitError(
      { code: "RAW", message: "E:\\\\app\\\\db.sqlite sk-live cookie SELECT 1" },
      "提交生成失败，请重试",
    )).toBe("提交生成失败，请重试");
  });
});
