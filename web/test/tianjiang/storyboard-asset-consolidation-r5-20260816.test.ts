// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const axiosPatch = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    patch: (...args: unknown[]) => axiosPatch(...args),
  },
}));

import projectStore from "@/stores/project";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";
import StoryboardDetailDrawer from "@/views/storyboardProject/components/StoryboardDetailDrawer.vue";
import StoryboardTable from "@/views/storyboardProject/components/StoryboardTable.vue";

const projectUuid = "51111111-1111-4111-a111-111111111111";
const shotUuid = "51111111-1111-4111-a111-111111111101";

const shot = {
  shotUuid,
  displayOrder: 1,
  sourceText: "林夏走进雨夜剧院。",
  visualDescription: "角色从霓虹雨幕中走向舞台。",
  imagePrompt: "雨夜剧院",
  videoPrompt: "缓慢跟随角色走入剧院",
  negativePrompt: "模糊",
  shotSize: "全景",
  cameraMovement: "跟拍",
  composition: "中心构图",
  durationMs: 5000,
  aspectRatio: "9:16",
  bindings: [],
  candidates: [
    {
      candidateUuid: "51111111-1111-4111-a111-111111111201",
      mediaType: "video",
      relativePath: "files/storyboard/candidates/rain-night.mp4",
      provider: "dreamina-cli",
      modelName: "seedance2.0fast",
      selected: true,
      createdAt: "2026-08-16T08:00:00.000Z",
    },
  ],
  generationTasks: [],
};

const tdesignStubs = {
  TButton: {
    inheritAttrs: true,
    props: ["loading", "disabled"],
    template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
  },
  TIcon: { template: "<i />" },
  TTag: { template: "<span><slot /></span>" },
  TCard: { inheritAttrs: true, template: "<section v-bind=\"$attrs\"><slot name=\"title\" /><slot /></section>" },
  TForm: { template: "<form><slot /></form>" },
  TFormItem: { template: "<div><slot /></div>" },
  TDialog: {
    inheritAttrs: true,
    props: ["visible", "header"],
    template: '<section v-if="visible" v-bind="$attrs" role="dialog"><h2>{{ header }}</h2><slot /><slot name="footer" /></section>',
  },
  TDrawer: {
    inheritAttrs: true,
    props: ["visible", "modelValue", "header"],
    template: '<aside v-if="visible || modelValue" v-bind="$attrs" role="dialog"><slot /><slot name="footer" /></aside>',
  },
  TEmpty: { template: "<div>empty</div>" },
  TLoading: { template: "<div><slot /></div>" },
  TSelect: { template: "<select><slot /></select>" },
  TTextarea: { inheritAttrs: true, props: ["modelValue"], template: "<textarea v-bind=\"$attrs\" />" },
  TCheckbox: { template: "<input type=\"checkbox\" />" },
  TCheckboxGroup: { template: "<div><slot /></div>" },
  TImage: { template: "<img />" },
  TImageViewer: { template: "<div><slot name=\"trigger\" :open=\"() => {}\" /></div>" },
  TPopup: { template: "<div><slot /></div>" },
};

function mountWorkspace(): VueWrapper {
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
  (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(i18n.global.t(key));
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = projectStore();
  store.project = {
    id: "501",
    projectUuid,
    name: "雨夜剧场",
    describe: "资产归并验收",
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
    imageModel: "",
    videoModel: "dreamina-cli:seedance2.0fast",
  } as any;
  store.access = {
    projectUuid,
    mode: "readwrite",
    reason: "test_open",
    lockHolder: "",
  };
  return mount(StoryboardWorkspace, {
    global: {
      plugins: [pinia, i18n],
      stubs: {
        ...tdesignStubs,
        modelSelect: { template: "<div />" },
        ImageTools: { template: "<div />" },
        "i-plus": { template: "<i />" },
      },
    },
  });
}

describe("R5 分镜右侧栏精简", () => {
  beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPatch.mockReset();
    axiosGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/shots")) return Promise.resolve({ data: { data: [shot] } });
      if (String(url).endsWith("/assets")) return Promise.resolve({ data: { data: { sourceProjectUuid: projectUuid, assets: [] } } });
      return Promise.resolve({ data: { data: {} } });
    });
    axiosPost.mockResolvedValue({ data: { data: [] } });
  });

  it("右侧详情栏不再出现关联资产、图片生成和图片候选，但保留视频能力", async () => {
    const wrapper = mount(StoryboardDetailDrawer, {
      props: {
        shot,
        projectUuid,
        videoModels: [{ value: "dreamina-cli:seedance2.0fast", label: "Seedance 2.0 Fast" }],
        generationSettings: {
          mediaType: "video",
          providerModel: "dreamina-cli:seedance2.0fast",
          mode: "auto",
          durationMs: 5000,
          aspectRatio: "9:16",
        },
      },
      global: {
        plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
        stubs: tdesignStubs,
      },
    });
    await flushPromises();
    expect(wrapper.find('[data-section="asset-bindings"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="generate-image"]').exists()).toBe(false);
    expect(wrapper.find('[data-candidate-group="image"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("关联资产");
    expect(wrapper.text()).not.toContain("图片候选");
    expect(wrapper.find('[data-section="video-preview"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="submit-current-shot"]').exists()).toBe(true);
    expect(wrapper.find('[data-candidate-group="video"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="save-shot"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("分镜行的角色、场景、道具绑定入口仍可打开", async () => {
    const wrapper = mount(StoryboardTable, {
      props: {
        projectUuid,
        shots: [shot],
        selectedShotUuid: shotUuid,
        selectedShotIds: [],
      },
      global: { stubs: tdesignStubs },
    });
    expect(wrapper.find('[data-action="pick-asset"][data-asset-slot="role"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="pick-asset"][data-asset-slot="scene"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="pick-asset"][data-asset-slot="tool"]').exists()).toBe(true);
    await wrapper.get('[data-action="pick-asset"][data-asset-slot="role"]').trigger("click");
    expect(wrapper.emitted("pickAsset")?.[0]).toEqual([shotUuid, "role"]);
    wrapper.unmount();
  });
});

describe("R5 资产管理复用塑角造景", () => {
  beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPatch.mockReset();
    axiosGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/shots")) return Promise.resolve({ data: { data: [shot] } });
      if (String(url).includes("/storyboard/assets")) {
        return Promise.resolve({ data: { data: { sourceProjectUuid: projectUuid, assets: [] } } });
      }
      return Promise.resolve({ data: { data: {} } });
    });
    axiosPost.mockImplementation((url: string) => {
      if (String(url).includes("/cornerScape/getAllAssets")) return Promise.resolve({ data: [] });
      if (String(url).includes("/storyboard/assets")) {
        return Promise.resolve({
          data: {
            data: {
              assetUuid: "51111111-1111-4111-a111-111111111801",
              name: "林夏",
              type: "role",
              describe: "女主",
              sourceProjectUuid: projectUuid,
            },
          },
        });
      }
      return Promise.resolve({ data: { data: {} } });
    });
  });

  it("顶部资产管理复用塑角造景工作区，不再挂载重复 AssetManager", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-module="assets"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-panel="asset-manager"]').exists()).toBe(false);
    expect(wrapper.findComponent({ name: "AssetManager" }).exists()).toBe(false);
    expect(wrapper.find('[data-panel="corner-scape-assets"]').exists()).toBe(true);
    expect(wrapper.find('[data-workspace="corner-scape"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("新建、批量上传、导入描述三个入口存在并校验输入", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-module="assets"]').trigger("click");
    await flushPromises();
    const panel = wrapper.get('[data-panel="corner-scape-assets"]');
    expect(panel.find('[data-action="create-asset"]').exists()).toBe(true);
    expect(panel.find('[data-action="batch-upload-assets"]').exists()).toBe(true);
    expect(panel.find('[data-action="import-asset-descriptions"]').exists()).toBe(true);

    await panel.get('[data-action="create-asset"]').trigger("click");
    await flushPromises();
    await panel.get('[data-action="confirm-create-asset"]').trigger("click");
    await flushPromises();
    expect(panel.text()).toMatch(/名称|必填/);
    expect(axiosPost.mock.calls.some(([url]) => String(url).includes("/storyboard/assets"))).toBe(false);

    await panel.get('[data-field="asset-name"]').setValue("林夏");
    await panel.get('[data-field="asset-type"]').setValue("role");
    await panel.get('[data-action="confirm-create-asset"]').trigger("click");
    await flushPromises();
    expect(axiosPost.mock.calls.some(([url, payload]) => (
      String(url).endsWith(`/tianjiang/runtime/projects/${projectUuid}/storyboard/assets`)
      && (payload as { name?: string }).name === "林夏"
    ))).toBe(true);
    expect(axiosGet.mock.calls.some(([url]) => String(url).includes("/storyboard/assets"))).toBe(true);
    wrapper.unmount();
  });
});
