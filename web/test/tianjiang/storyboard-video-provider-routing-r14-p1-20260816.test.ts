// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import { modelCatalogStore, setAccountScope } from "@/features/models/modelCatalogStore";
import StoryboardGenerationSettings from "@/views/storyboardProject/components/StoryboardGenerationSettings.vue";
import StoryboardBatchGenerationDialog from "@/views/storyboardProject/components/StoryboardBatchGenerationDialog.vue";
import StoryboardDetailDrawer from "@/views/storyboardProject/components/StoryboardDetailDrawer.vue";

const axiosGet = vi.fn();
const axiosPost = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    patch: vi.fn(),
  },
}));

vi.mock("@/stores/setting", () => ({
  default: () => ({ activeMenu: "", showSetting: false }),
}));

const projectUuid = "d1414141-1414-4141-a141-141414141141";
const shotUuid = "d1414141-1414-4141-a141-141414141101";
const importedPrompt = "吉庆阁码头，黄晚棠从人群中挤到前面。";

const catalogItems = [
  {
    id: "vendor-alpha",
    name: "普通供应商甲",
    label: "Kling Video",
    value: "kling-v1",
    type: "video",
    disabled: false,
  },
  {
    id: "vendor-beta",
    name: "普通供应商乙",
    label: "Runway Video",
    value: "gen3-turbo",
    type: "video",
    disabled: false,
  },
  {
    id: "dreamina-cli",
    name: "即梦 CLI",
    label: "Seedance 2.0 Fast",
    value: "dreamina-cli:seedance2.0fast",
    type: "video",
    disabled: false,
  },
];

const expectedCatalogValues = [
  "vendor-alpha:kling-v1",
  "vendor-beta:gen3-turbo",
  "dreamina-cli:seedance2.0fast",
];

const tdesignStubs = {
  TButton: {
    inheritAttrs: true,
    props: ["loading", "disabled"],
    template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
  },
  TIcon: { template: "<i />" },
  TAvatar: { template: "<span />" },
  TSelect: {
    props: ["modelValue", "disabled", "placeholder"],
    emits: ["update:modelValue", "change", "popup-visible-change"],
    template: `<select name="providerModel" :value="modelValue" :disabled="disabled" :data-placeholder="placeholder" @change="$emit('update:modelValue', $event.target.value); $emit('change', $event.target.value, { option: { label: $event.target.selectedOptions[0]?.textContent } })"><slot /><slot name="empty" /></select>`,
  },
  TOptionGroup: {
    props: ["label"],
    template: '<optgroup :label="label"><slot /></optgroup>',
  },
  TOption: {
    props: ["value", "label", "disabled"],
    template: '<option :value="value" :label="label" :disabled="disabled">{{ label }}<slot /></option>',
  },
  TDialog: {
    inheritAttrs: false,
    props: ["visible", "header"],
    emits: ["close"],
    template: '<section v-if="visible" role="dialog"><h2>{{ header }}</h2><slot /><slot name="footer" /></section>',
  },
};

function i18n() {
  return createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
}

function installCatalog(items = catalogItems, options: { reject?: boolean; accountScopeId?: string } = {}) {
  axiosGet.mockResolvedValue({ data: { data: { catalogVersion: 14 } } });
  axiosPost.mockImplementation((url: string, payload?: Record<string, unknown>) => {
    if (String(url).endsWith("/modelSelect/getModelList")) {
      if (options.reject) return Promise.reject(new Error("catalog failed C:\\\\secret"));
      expect(payload).toMatchObject({ type: "video" });
      return Promise.resolve({
        data: {
          data: {
            accountScopeId: options.accountScopeId ?? "account:1414",
            catalogVersion: 14,
            items,
            providers: items.map((item) => ({
              providerId: item.id,
              providerName: item.name,
              state: "ready",
            })),
          },
        },
      });
    }
    return Promise.resolve({ data: {} });
  });
}

const defaultSettings = {
  mediaType: "video" as const,
  providerModel: "dreamina-cli:seedance2.0fast",
  mode: "auto" as const,
  durationMs: 15_000,
  aspectRatio: "9:16",
  resolution: "720p",
};

function mountSettings(providerModel = defaultSettings.providerModel) {
  return mount(StoryboardGenerationSettings, {
    props: {
      modelValue: { ...defaultSettings, providerModel },
      videoModels: [
        { value: "dreamina-cli:seedance2.0", label: "seedance2.0" },
        { value: "dreamina-cli:seedance2.0fast", label: "seedance2.0fast" },
        { value: "dreamina-cli:seedance2.0mini", label: "seedance2.0mini" },
        { value: "dreamina-cli:seedance2.0_vip", label: "seedance2.0_vip" },
        { value: "dreamina-cli:seedance2.0fast_vip", label: "seedance2.0fast_vip" },
      ],
    },
    global: { plugins: [i18n()], stubs: tdesignStubs },
  });
}

function mountDrawer(providerModel = "dreamina-cli:seedance2.0fast") {
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
      videoModels: [{ value: "dreamina-cli:seedance2.0fast", label: "seedance2.0fast" }],
      generationSettings: { ...defaultSettings, providerModel },
    },
    global: { plugins: [i18n()], stubs: tdesignStubs },
  });
}

describe("R14 工作台视频能力文案不得再写成仅限即梦", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setAccountScope(1414);
    modelCatalogStore.invalidateAll();
    axiosGet.mockReset();
    axiosPost.mockReset();
    installCatalog();
  });

  it("右侧标题必须是视频生成，不得再写即梦视频生成", async () => {
    const wrapper = mountSettings();
    await flushPromises();
    expect(wrapper.text()).toContain("视频生成");
    expect(wrapper.text()).not.toContain("即梦视频生成");
    wrapper.unmount();
  });

  it("批量弹窗标题必须是批量视频生成", async () => {
    const wrapper = mount(StoryboardBatchGenerationDialog, {
      props: {
        open: true,
        shotCount: 2,
        settings: defaultSettings,
        videoModels: [{ value: "dreamina-cli:seedance2.0fast", label: "seedance2.0fast" }],
      },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    await flushPromises();
    expect(wrapper.get("h2").text()).toBe("批量视频生成");
    expect(wrapper.text()).not.toContain("批量即梦视频生成");
    wrapper.unmount();
  });
});

describe("R14 模型下拉必须复用当前账号已配置视频目录", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setAccountScope(1414);
    modelCatalogStore.invalidateAll();
    axiosGet.mockReset();
    axiosPost.mockReset();
    installCatalog();
  });

  it("当前账号两个普通供应商视频模型与即梦模型都必须出现，且不得使用静态即梦名单", async () => {
    const wrapper = mountSettings("");
    await flushPromises();
    await flushPromises();
    const values = wrapper.findAll('select[name="providerModel"] option').map((option) => option.attributes("value"));
    expect(values).toEqual(expectedCatalogValues);
    expect(values).not.toEqual([
      "dreamina-cli:seedance2.0",
      "dreamina-cli:seedance2.0fast",
      "dreamina-cli:seedance2.0mini",
      "dreamina-cli:seedance2.0_vip",
      "dreamina-cli:seedance2.0fast_vip",
    ]);
    expect(values.some((value) => value === "dreamina-cli:dreamina-cli:seedance2.0fast")).toBe(false);
    const listCalls = axiosPost.mock.calls.filter(([url]) => String(url).endsWith("/modelSelect/getModelList"));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0][1]).toEqual({ type: "video" });
    wrapper.unmount();
  });

  it("选择普通供应商后 preview 与 generate 必须逐字使用同一 providerModel", async () => {
    axiosPost.mockImplementation((url: string, payload?: Record<string, unknown>) => {
      if (String(url).endsWith("/modelSelect/getModelList")) {
        return Promise.resolve({
          data: {
            data: {
              accountScopeId: "account:1414",
              catalogVersion: 14,
              items: catalogItems,
              providers: [],
            },
          },
        });
      }
      if (String(url).includes("/generate/preview")) {
        return Promise.resolve({
          data: {
            previewDigest: "b".repeat(64),
            providerModel: payload?.providerModel,
            routeKind: "vendor",
            prompt: importedPrompt,
            options: {
              aspectRatio: "9:16",
              durationMs: 15_000,
              resolution: "720p",
              mode: "text2video",
            },
          },
        });
      }
      return Promise.resolve({ data: { code: 0 } });
    });
    const wrapper = mountDrawer("");
    await flushPromises();
    await flushPromises();
    const select = wrapper.get('select[name="providerModel"]');
    await select.setValue("vendor-alpha:kling-v1");
    await flushPromises();
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();
    expect((wrapper.get('[data-action="submit-current-shot"]').element as HTMLButtonElement).disabled).toBe(false);
    await wrapper.get('[data-action="submit-current-shot"]').trigger("click");
    await flushPromises();
    const preview = axiosPost.mock.calls.find(([url]) => String(url).includes("/generate/preview"));
    expect(preview?.[1]).toMatchObject({ providerModel: "vendor-alpha:kling-v1" });
    const emitted = wrapper.emitted("generate")?.[0]?.[0] as { settings?: { providerModel?: string } };
    expect(emitted.settings?.providerModel).toBe("vendor-alpha:kling-v1");
    wrapper.unmount();
  });

  it("切换模型必须立即让旧预览失效", async () => {
    axiosPost.mockImplementation((url: string, payload?: Record<string, unknown>) => {
      if (String(url).endsWith("/modelSelect/getModelList")) {
        return Promise.resolve({
          data: {
            data: {
              accountScopeId: "account:1414",
              catalogVersion: 14,
              items: catalogItems,
              providers: [],
            },
          },
        });
      }
      return Promise.resolve({
        data: {
          previewDigest: "c".repeat(64),
          providerModel: payload?.providerModel,
          routeKind: "vendor",
          prompt: importedPrompt,
          options: {
            aspectRatio: "9:16",
            durationMs: 15_000,
            resolution: "720p",
            mode: "text2video",
          },
        },
      });
    });
    const wrapper = mountDrawer("vendor-alpha:kling-v1");
    await flushPromises();
    await flushPromises();
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();
    expect((wrapper.get('[data-action="submit-current-shot"]').element as HTMLButtonElement).disabled).toBe(false);
    await wrapper.get('select[name="providerModel"]').setValue("vendor-beta:gen3-turbo");
    await flushPromises();
    expect((wrapper.get('[data-action="submit-current-shot"]').element as HTMLButtonElement).disabled).toBe(true);
    expect(wrapper.get("[data-preview-status]").text()).toMatch(/重新预览/);
    expect(wrapper.emitted("generate")).toBeUndefined();
    wrapper.unmount();
  });

  it("目录为空或失败时不得回退写死即梦模型，并禁用预览与提交", async () => {
    installCatalog([], { reject: true });
    const wrapper = mountDrawer("dreamina-cli:seedance2.0fast");
    await flushPromises();
    await flushPromises();
    const values = wrapper.findAll('select[name="providerModel"] option').map((option) => option.attributes("value"));
    expect(values.some((value) => String(value).startsWith("dreamina-cli:"))).toBe(false);
    expect(wrapper.text()).toContain("当前账号未配置可用视频模型");
    expect((wrapper.get('[data-action="preview-shot-video"]').element as HTMLButtonElement).disabled).toBe(true);
    expect((wrapper.get('[data-action="submit-current-shot"]').element as HTMLButtonElement).disabled).toBe(true);
    wrapper.unmount();
  });

  it("批量弹窗同样使用当前账号视频模型目录", async () => {
    const wrapper = mount(StoryboardBatchGenerationDialog, {
      props: {
        open: true,
        shotCount: 2,
        settings: { ...defaultSettings, providerModel: "" },
        videoModels: [{ value: "dreamina-cli:seedance2.0fast", label: "seedance2.0fast" }],
      },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    await flushPromises();
    await flushPromises();
    const values = wrapper.findAll('select[name="providerModel"] option').map((option) => option.attributes("value"));
    expect(values).toEqual(expectedCatalogValues);
    wrapper.unmount();
  });
});
