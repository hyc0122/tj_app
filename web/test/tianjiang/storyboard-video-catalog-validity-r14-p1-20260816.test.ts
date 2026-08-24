// @vitest-environment jsdom
/**
 * R14 P1 RED：视频模型可用必须是 ready + 非空目录 + providerModel 精确命中；
 * checking/failed/空目录/账号切换旧模型不得只靠非空字符串放行，且 handler 也必须零请求。
 */
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import { modelCatalogStore, setAccountScope } from "@/features/models/modelCatalogStore";
import projectStore from "@/stores/project";
import StoryboardDetailDrawer from "@/views/storyboardProject/components/StoryboardDetailDrawer.vue";
import StoryboardBatchGenerationDialog from "@/views/storyboardProject/components/StoryboardBatchGenerationDialog.vue";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";

const axiosGet = vi.fn();
const axiosPost = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    patch: vi.fn(),
    put: vi.fn(),
  },
}));

vi.mock("@/stores/setting", () => ({
  default: () => ({ activeMenu: "", showSetting: false }),
}));

const projectUuid = "d1414141-1414-4141-a141-141414141141";
const shotUuid = "d1414141-1414-4141-a141-141414141101";
const importedPrompt = "吉庆阁码头，黄晚棠从人群中挤到前面。";

const accountAItems = [{
  id: "vendor-alpha",
  name: "普通供应商甲",
  label: "Kling Video",
  value: "kling-v1",
  type: "video",
  disabled: false,
}];

const accountBItems = [{
  id: "vendor-beta",
  name: "普通供应商乙",
  label: "Runway Video",
  value: "gen3-turbo",
  type: "video",
  disabled: false,
}];

const tdesignStubs = {
  TButton: {
    inheritAttrs: true,
    props: ["loading", "disabled"],
    template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
  },
  TIcon: { template: "<i />" },
  TAvatar: { template: "<span />" },
  TSelect: {
    props: ["modelValue", "disabled", "placeholder", "name"],
    emits: ["update:modelValue", "change", "popup-visible-change"],
    template: `<select name="providerModel" :value="modelValue" :disabled="disabled" @change="$emit('update:modelValue', $event.target.value)"><slot /><slot name="empty" /></select>`,
  },
  TOptionGroup: { props: ["label"], template: '<optgroup :label="label"><slot /></optgroup>' },
  TOption: {
    props: ["value", "label", "disabled"],
    template: '<option :value="value" :disabled="disabled">{{ label }}</option>',
  },
  TDialog: {
    inheritAttrs: false,
    props: ["visible", "header"],
    emits: ["close"],
    template: '<section v-if="visible" role="dialog"><h2>{{ header }}</h2><slot /><slot name="footer" /></section>',
  },
  TDrawer: {
    inheritAttrs: true,
    props: ["visible", "modelValue", "header"],
    template: '<aside v-if="visible || modelValue" v-bind="$attrs" role="dialog"><slot /><slot name="footer" /></aside>',
  },
};

function i18n() {
  return createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function catalogPayload(items: typeof accountAItems, accountScopeId: string) {
  return {
    accountScopeId,
    catalogVersion: 14,
    items,
    providers: items.map((item) => ({
      providerId: item.id,
      providerName: item.name,
      state: "ready",
    })),
  };
}

function generationCalls() {
  return axiosPost.mock.calls.filter(([url]) => String(url).includes("/storyboard/generate"));
}

const defaultSettings = {
  mediaType: "video" as const,
  providerModel: "vendor-alpha:kling-v1",
  mode: "auto" as const,
  durationMs: 15_000,
  aspectRatio: "9:16",
};

function installCatalog(items: typeof accountAItems, options: {
  reject?: boolean;
  delay?: boolean;
  accountScopeId?: string;
} = {}) {
  const deferred = createDeferred<{ data: { data: ReturnType<typeof catalogPayload> } }>();
  const scope = options.accountScopeId ?? "account:1414";
  axiosGet.mockImplementation((url: string) => {
    if (String(url).includes("/modelSelect/getCatalogVersion")) {
      return Promise.resolve({ data: { data: { catalogVersion: 14 } } });
    }
    return Promise.resolve({ data: { data: {} } });
  });
  axiosPost.mockImplementation((url: string) => {
    if (String(url).endsWith("/modelSelect/getModelList")) {
      if (options.delay) return deferred.promise;
      if (options.reject) return Promise.reject(new Error("catalog failed C:\\\\secret"));
      return Promise.resolve({ data: { data: catalogPayload(items, scope) } });
    }
    if (String(url).includes("/generate")) {
      return Promise.resolve({
        data: {
          previewDigest: "b".repeat(64),
          providerModel: "vendor-alpha:kling-v1",
          routeKind: "vendor",
          prompt: importedPrompt,
          options: { aspectRatio: "9:16", durationMs: 15_000, mode: "text2video" },
        },
      });
    }
    return Promise.resolve({ data: { code: 0 } });
  });
  return deferred;
}

function mountDrawer(providerModel = defaultSettings.providerModel) {
  return mount(StoryboardDetailDrawer, {
    props: {
      shot: {
        shotUuid,
        displayOrder: 1,
        sourceText: importedPrompt,
        visualDescription: "",
        videoPrompt: importedPrompt,
        durationMs: 15_000,
        aspectRatio: "9:16",
        bindings: [],
        candidates: [],
        generationTasks: [],
      },
      projectUuid,
      generationSettings: { ...defaultSettings, providerModel },
    },
    global: { plugins: [i18n()], stubs: tdesignStubs },
  });
}

function mountWorkspace(): VueWrapper {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = projectStore();
  store.project = {
    projectUuid,
    name: "R14 目录有效性",
    describe: "视频模型可用合同",
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
    videoModel: "vendor-alpha:kling-v1",
  } as any;
  store.access = { projectUuid, mode: "readwrite", reason: "test_open", lockHolder: "" };
  axiosGet.mockImplementation((url: string) => {
    if (String(url).endsWith("/shots")) {
      return Promise.resolve({
        data: {
          data: [{
            shotUuid,
            displayOrder: 1,
            sourceText: importedPrompt,
            videoPrompt: importedPrompt,
            durationMs: 15_000,
            aspectRatio: "9:16",
            bindings: [],
            candidates: [],
            generationTasks: [],
          }],
        },
      });
    }
    if (String(url).includes("/storyboard/assets")) {
      return Promise.resolve({ data: { data: { sourceProjectUuid: projectUuid, assets: [] } } });
    }
    if (String(url).includes("/modelSelect/getCatalogVersion")) {
      return Promise.resolve({ data: { data: { catalogVersion: 14 } } });
    }
    return Promise.resolve({ data: { data: {} } });
  });
  return mount(StoryboardWorkspace, {
    global: {
      plugins: [pinia, i18n()],
      stubs: {
        ...tdesignStubs,
        ImageTools: { template: "<div />" },
        "i-plus": { template: "<i />" },
      },
    },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  setAccountScope(1414);
  modelCatalogStore.invalidateAll();
  axiosGet.mockReset();
  axiosPost.mockReset();
});

describe("R14 单镜头预览/提交必须消费目录有效状态", () => {
  it("目录 Promise 未完成时预览与提交必须禁用且零请求", async () => {
    installCatalog(accountAItems, { delay: true });
    const wrapper = mountDrawer("vendor-alpha:kling-v1");
    await flushPromises();
    expect(wrapper.get('[data-panel="storyboard-generation-settings"]').attributes("data-catalog-state")).toBe("checking");
    const preview = wrapper.get('[data-action="preview-shot-video"]');
    const submit = wrapper.get('[data-action="submit-current-shot"]');
    expect((preview.element as HTMLButtonElement).disabled).toBe(true);
    expect((submit.element as HTMLButtonElement).disabled).toBe(true);
    await preview.trigger("click");
    await submit.trigger("click");
    await flushPromises();
    expect(generationCalls()).toHaveLength(0);
    wrapper.unmount();
  });

  it("目录 reject 时预览与提交必须禁用且零请求", async () => {
    installCatalog([], { reject: true });
    const wrapper = mountDrawer("vendor-alpha:kling-v1");
    await flushPromises();
    await flushPromises();
    expect((wrapper.get('[data-action="preview-shot-video"]').element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await wrapper.get('[data-action="submit-current-shot"]').trigger("click");
    await flushPromises();
    expect(generationCalls()).toHaveLength(0);
    wrapper.unmount();
  });

  it("空目录时预览与提交必须禁用且零请求", async () => {
    installCatalog([]);
    const wrapper = mountDrawer("vendor-alpha:kling-v1");
    await flushPromises();
    await flushPromises();
    // 中文注释：显式选择失效后必须清空并提示，不允许静默回填项目默认或目录首项。
    expect(wrapper.text()).toContain("当前选择的视频模型已不可用，请重新选择");
    expect((wrapper.get('select[name="providerModel"]').element as HTMLSelectElement).value).toBe("");
    expect((wrapper.get('[data-action="preview-shot-video"]').element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await wrapper.get('[data-action="submit-current-shot"]').trigger("click");
    await flushPromises();
    expect(generationCalls()).toHaveLength(0);
    wrapper.unmount();
  });

  it("账号切换留下旧模型时预览与提交必须立即无效且零请求", async () => {
    installCatalog(accountAItems, { accountScopeId: "account:1414" });
    const wrapper = mountDrawer("vendor-alpha:kling-v1");
    await flushPromises();
    await flushPromises();
    const pending = createDeferred<{ data: { data: ReturnType<typeof catalogPayload> } }>();
    axiosPost.mockImplementation((url: string) => {
      if (String(url).endsWith("/modelSelect/getModelList")) return pending.promise;
      return Promise.resolve({
        data: {
          previewDigest: "b".repeat(64),
          providerModel: "vendor-alpha:kling-v1",
          routeKind: "vendor",
          prompt: importedPrompt,
          options: { aspectRatio: "9:16", durationMs: 15_000, mode: "text2video" },
        },
      });
    });
    setAccountScope(1415);
    await flushPromises();
    expect(wrapper.get('[data-panel="storyboard-generation-settings"]').attributes("data-catalog-state")).toBe("checking");
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await wrapper.get('[data-action="submit-current-shot"]').trigger("click");
    await flushPromises();
    expect(generationCalls()).toHaveLength(0);
    wrapper.unmount();
  });

  it("目录 ready 且选择属于当前账号时才恢复可用", async () => {
    installCatalog(accountAItems);
    const wrapper = mountDrawer("");
    await flushPromises();
    await flushPromises();
    expect(wrapper.get('[data-panel="storyboard-generation-settings"]').attributes("data-catalog-state")).toBe("ready");
    expect((wrapper.get('[data-action="preview-shot-video"]').element as HTMLButtonElement).disabled).toBe(false);
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();
    expect(generationCalls().some(([url]) => String(url).includes("/generate/preview"))).toBe(true);
    wrapper.unmount();
  });
});

describe("R14 行内与批量必须消费同一目录有效状态", () => {
  it("目录 Promise 未完成时行内生成与批量提交必须零请求", async () => {
    installCatalog(accountAItems, { delay: true });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    expect((wrapper.get('[data-action="generate-video"]').element as HTMLButtonElement).disabled).toBe(true);
    expect((wrapper.get('[data-action="open-batch-generation"]').element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.get('[data-action="generate-video"]').trigger("click");
    await wrapper.get('[data-action="open-batch-generation"]').trigger("click");
    if (wrapper.find('[data-dialog="storyboard-batch-generation"]').exists()) {
      const dialog = wrapper.get('[data-dialog="storyboard-batch-generation"]');
      await dialog.get('input[name="paidConfirmed"]').setValue(true);
      await dialog.get('[data-action="submit-batch-generation"]').trigger("click");
    }
    await flushPromises();
    expect(generationCalls()).toHaveLength(0);
    wrapper.unmount();
  });

  it("目录 reject 或空目录时行内与批量必须零请求", async () => {
    installCatalog([], { reject: true });
    const wrapper = mountWorkspace();
    await flushPromises();
    await flushPromises();
    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    await wrapper.get('[data-action="generate-video"]').trigger("click");
    await wrapper.get('[data-action="open-batch-generation"]').trigger("click");
    if (wrapper.find('[data-dialog="storyboard-batch-generation"]').exists()) {
      const dialog = wrapper.get('[data-dialog="storyboard-batch-generation"]');
      expect((dialog.get('[data-action="submit-batch-generation"]').element as HTMLButtonElement).disabled).toBe(true);
      await dialog.get('input[name="paidConfirmed"]').setValue(true);
      await dialog.get('[data-action="submit-batch-generation"]').trigger("click");
    }
    await flushPromises();
    expect(generationCalls()).toHaveLength(0);
    wrapper.unmount();
  });

  it("账号切换留下旧模型时已打开批量弹窗也必须失败关闭且零收费请求", async () => {
    installCatalog(accountAItems, { accountScopeId: "account:1414" });
    const wrapper = mountWorkspace();
    await flushPromises();
    await flushPromises();
    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    await wrapper.get('[data-action="open-batch-generation"]').trigger("click");
    const dialog = wrapper.get('[data-dialog="storyboard-batch-generation"]');
    await dialog.get('input[name="paidConfirmed"]').setValue(true);
    const pending = createDeferred<{ data: { data: ReturnType<typeof catalogPayload> } }>();
    axiosPost.mockImplementation((url: string) => {
      if (String(url).endsWith("/modelSelect/getModelList")) return pending.promise;
      return Promise.resolve({
        data: {
          previewDigest: "b".repeat(64),
          providerModel: "vendor-alpha:kling-v1",
          routeKind: "vendor",
          prompt: importedPrompt,
          options: { aspectRatio: "9:16", durationMs: 15_000, mode: "text2video" },
        },
      });
    });
    setAccountScope(1415);
    await flushPromises();
    expect((dialog.get('[data-action="submit-batch-generation"]').element as HTMLButtonElement).disabled).toBe(true);
    await dialog.get('[data-action="submit-batch-generation"]').trigger("click");
    await wrapper.get('[data-action="generate-video"]').trigger("click");
    await flushPromises();
    // 中文注释：切换前允许已发生非收费预览；切换后绝不能发出正式 generate。
    expect(generationCalls().filter(([url]) => String(url).endsWith("/generate"))).toHaveLength(0);
    wrapper.unmount();
  });

  it("目录 ready 且选择属于当前账号时行内预览才允许发出", async () => {
    installCatalog(accountAItems);
    const wrapper = mountWorkspace();
    await flushPromises();
    await flushPromises();
    expect((wrapper.get('[data-action="generate-video"]').element as HTMLButtonElement).disabled).toBe(false);
    await wrapper.get('[data-action="generate-video"]').trigger("click");
    await flushPromises();
    expect(generationCalls().some(([url]) => String(url).includes("/generate/preview"))).toBe(true);
    wrapper.unmount();
  });

  it("批量确认并提交在目录无效时即使已勾选付费也不得发出请求", async () => {
    installCatalog([]);
    const wrapper = mount(StoryboardBatchGenerationDialog, {
      props: {
        open: true,
        shotCount: 2,
        settings: defaultSettings,
      },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    await flushPromises();
    await flushPromises();
    await wrapper.get('input[name="paidConfirmed"]').setValue(true);
    expect((wrapper.get('[data-action="submit-batch-generation"]').element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.get('[data-action="submit-batch-generation"]').trigger("click");
    await flushPromises();
    expect(wrapper.emitted("submit")).toBeUndefined();
    wrapper.unmount();
  });
});
