// @vitest-environment jsdom
/**
 * R15 RED：模板弹窗、音频完整播放器、全选后批量按钮、17 秒入口。
 */
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import { modelCatalogStore, setAccountScope } from "@/features/models/modelCatalogStore";
import projectStore from "@/stores/project";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";
import StoryboardSettings from "@/views/storyboardProject/components/StoryboardSettings.vue";
import StoryboardGenerationSettings from "@/views/storyboardProject/components/StoryboardGenerationSettings.vue";
import StoryboardTable from "@/views/storyboardProject/components/StoryboardTable.vue";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const axiosPatch = vi.fn();
const axiosPut = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    patch: (...args: unknown[]) => axiosPatch(...args),
    put: (...args: unknown[]) => axiosPut(...args),
    delete: vi.fn(),
  },
}));

vi.mock("@/stores/setting", () => ({
  default: () => ({ activeMenu: "", showSetting: false }),
}));

const projectUuid = "f1515151-1515-4151-a151-151515151151";
const shotOne = "f1515151-1515-4151-a151-151515151101";
const shotTwo = "f1515151-1515-4151-a151-151515151102";
const safeAudioSrc = `/tianjiang/runtime/projects/${projectUuid}/files/audios/voice.mp3`;

const tdesignStubs = {
  TButton: {
    inheritAttrs: true,
    props: ["loading", "disabled"],
    template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
  },
  TIcon: { template: "<i />" },
  TAvatar: { template: "<span />" },
  TSelect: {
    props: ["modelValue", "disabled", "placeholder", "name", "options"],
    emits: ["update:modelValue"],
    template: `<select :name="name" :value="modelValue" :disabled="disabled" @change="$emit('update:modelValue', $event.target.value)"><slot /><slot name="empty" /></select>`,
  },
  TOptionGroup: { props: ["label"], template: '<optgroup :label="label"><slot /></optgroup>' },
  TOption: { props: ["value", "label"], template: '<option :value="value">{{ label }}</option>' },
  TDialog: {
    inheritAttrs: false,
    props: ["visible", "header"],
    template: '<section v-if="visible" role="dialog"><h2>{{ header }}</h2><slot /><slot name="footer" /></section>',
  },
  TDrawer: {
    inheritAttrs: true,
    props: ["visible", "modelValue"],
    template: '<aside v-if="visible || modelValue" v-bind="$attrs"><slot /><slot name="footer" /></aside>',
  },
  TTag: { template: "<span><slot /></span>" },
  TForm: { template: "<form><slot /></form>" },
  TFormItem: { inheritAttrs: true, template: '<div v-bind="$attrs"><slot /></div>' },
  TInput: { template: "<input />" },
  TTextarea: { inheritAttrs: true, template: "<textarea />" },
  TLoading: { template: "<div><slot /></div>" },
};

function i18n() {
  return createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
}

function videoCatalog() {
  return {
    accountScopeId: "",
    catalogVersion: 15,
    items: [{
      id: "dreamina-cli",
      name: "即梦 CLI",
      label: "Seedance 2.0 Fast",
      value: "dreamina-cli:seedance2.0fast",
      type: "video",
      disabled: false,
    }],
    providers: [{ providerId: "dreamina-cli", providerName: "即梦 CLI", state: "ready" }],
  };
}

function shots() {
  return [
    {
      shotUuid: shotOne,
      displayOrder: 1,
      videoPrompt: "第一镜",
      durationMs: 5000,
      aspectRatio: "9:16",
      bindings: [],
      candidates: [],
      generationTasks: [],
    },
    {
      shotUuid: shotTwo,
      displayOrder: 2,
      videoPrompt: "第二镜",
      durationMs: 8000,
      aspectRatio: "9:16",
      bindings: [],
      candidates: [],
      generationTasks: [],
    },
  ];
}

function mountWorkspace(videoModel = ""): VueWrapper {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = projectStore();
  store.project = {
    projectUuid,
    name: "R15",
    describe: "提示词与时长",
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
    videoModel,
  } as any;
  store.access = { projectUuid, mode: "readwrite", reason: "test_open", lockHolder: "" };
  return mount(StoryboardWorkspace, {
    global: {
      plugins: [pinia, i18n()],
      stubs: { ...tdesignStubs, ImageTools: { template: "<div />" }, "i-plus": { template: "<i />" } },
    },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  setAccountScope(null);
  modelCatalogStore.invalidateAll();
  axiosGet.mockReset();
  axiosPost.mockReset();
  axiosPatch.mockReset();
  axiosPut.mockReset();
  axiosGet.mockImplementation((url: string) => {
    if (String(url).endsWith("/shots")) return Promise.resolve({ data: { data: shots() } });
    if (String(url).includes("/storyboard/assets")) {
      return Promise.resolve({ data: { data: { sourceProjectUuid: projectUuid, assets: [] } } });
    }
    if (String(url).includes("/modelSelect/getCatalogVersion")) {
      return Promise.resolve({ data: { data: { catalogVersion: 15 } } });
    }
    if (String(url).includes("/storyboard/settings")) {
      return Promise.resolve({ data: { data: { aspectRatio: "9:16", durationMs: 5000 } } });
    }
    return Promise.resolve({ data: { data: {} } });
  });
  axiosPost.mockImplementation((url: string) => {
    if (String(url).endsWith("/modelSelect/getModelList")) {
      return Promise.resolve({ data: { data: videoCatalog() } });
    }
    return Promise.resolve({ data: { code: 0, data: {} } });
  });
});

describe("R15 全选后批量按钮必须启用", () => {
  it("两条分镜且目录 ready 时全选必须启用批量生成，并记录门禁", async () => {
    const wrapper = mountWorkspace("");
    await flushPromises();
    await flushPromises();
    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-selected-count]").text()).toContain("2");
    const batch = wrapper.get('[data-action="open-batch-generation"]');
    expect(batch.attributes("data-batch-readonly")).toBe("false");
    expect(batch.attributes("data-batch-unsaved")).toBe("false");
    expect(batch.attributes("data-batch-empty-selection")).toBe("false");
    expect(batch.attributes("data-batch-video-ready")).toBe("true");
    expect((batch.element as HTMLButtonElement).disabled).toBe(false);
    expect(wrapper.get("[data-batch-disabled-reason]").text()).toBe("");
    wrapper.unmount();
  });
});

describe("R15 分镜设置必须提供视频指令模板", () => {
  it("设置页必须能打开模板管理并保存用于当前项目", async () => {
    const wrapper = mount(StoryboardSettings, {
      props: { projectUuid, providerModel: "dreamina-cli:seedance2.0fast" },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    await flushPromises();
    expect(wrapper.get('[data-action="open-video-template-manager"]').exists()).toBe(true);
    await wrapper.get('[data-action="open-video-template-manager"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-dialog="storyboard-video-template"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("变量来源说明");
    expect(wrapper.get('[data-action="save-video-template"]').exists()).toBe(true);
    expect(wrapper.get('[data-action="save-and-use-video-template"]').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe("R15 时长必须支持 4-30 整数秒", () => {
  it("表格、生成设置和分镜设置都要能输入 17 秒", async () => {
    const table = mount(StoryboardTable, {
      props: {
        shots: shots(),
        assets: [],
      },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    const tableInput = table.get('[data-shot-id] [name="durationSeconds"]');
    expect(tableInput.attributes("min")).toBe("4");
    expect(tableInput.attributes("max")).toBe("30");
    expect(tableInput.attributes("step")).toBe("1");
    await tableInput.setValue("17");
    expect(table.emitted("changeDuration")?.[0]).toEqual([shotOne, 17_000]);
    table.unmount();

    const settings = mount(StoryboardGenerationSettings, {
      props: {
        modelValue: {
          mediaType: "video",
          providerModel: "dreamina-cli:seedance2.0fast",
          mode: "auto",
          durationMs: 5000,
          aspectRatio: "9:16",
        },
      },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    const settingInput = settings.get('[name="durationSeconds"]');
    expect(settingInput.attributes("min")).toBe("4");
    expect(settingInput.attributes("max")).toBe("30");
    await settingInput.setValue("17");
    expect((settings.emitted("update:modelValue") ?? []).some((entry) => (
      (entry[0] as { durationMs?: number }).durationMs === 17_000
    ))).toBe(true);
    settings.unmount();
  });
});

describe("R15 角色音频必须是完整播放器", () => {
  it("角色详情音频参考要有原生控件和下载，非角色不得显示", () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../src/views/cornerScape/components/CornerScapeWorkspace.vue"),
      "utf8",
    );
    expect(source).toContain("<audio");
    expect(source).toContain("controls");
    expect(source).toContain('preload="metadata"');
    expect(source).toContain('data-action="download-role-audio"');
    expect(source).toContain("下载");
    expect(source).toContain('currentItem.type === \'role\'');
  });
});
