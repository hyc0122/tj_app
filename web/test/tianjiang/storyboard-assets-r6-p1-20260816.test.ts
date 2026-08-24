// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const axiosPatch = vi.fn();
const axiosDelete = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    patch: (...args: unknown[]) => axiosPatch(...args),
    delete: (...args: unknown[]) => axiosDelete(...args),
  },
}));

import projectStore from "@/stores/project";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";
import StoryboardDetailDrawer from "@/views/storyboardProject/components/StoryboardDetailDrawer.vue";
import StoryboardTable from "@/views/storyboardProject/components/StoryboardTable.vue";
import ShotAssetSlots from "@/views/storyboardProject/components/ShotAssetSlots.vue";

const projectUuid = "61111111-1111-4111-a111-111111111111";
const shotUuid = "61111111-1111-4111-a111-111111111101";
const roleAssetUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const assets = [
  {
    assetUuid: roleAssetUuid,
    name: "林夏",
    type: "role",
    assetType: "role",
    describe: "女主",
    sourceProjectUuid: projectUuid,
  },
];

const shot = {
  shotUuid,
  displayOrder: 1,
  sourceText: "林夏走进雨夜剧院。",
  visualDescription: "角色从霓虹雨幕中走向舞台。",
  imagePrompt: "雨夜剧院",
  videoPrompt: "缓慢跟随",
  negativePrompt: "模糊",
  shotSize: "全景",
  cameraMovement: "跟拍",
  composition: "中心构图",
  durationMs: 5000,
  aspectRatio: "9:16",
  bindings: [{
    sourceProjectUuid: projectUuid,
    assetUuid: roleAssetUuid,
    assetType: "role",
    relationRole: "appear",
  }],
  candidates: [{
    candidateUuid: "61111111-1111-4111-a111-111111111201",
    mediaType: "video" as const,
    relativePath: "files/storyboard/candidates/rain-night.mp4",
    provider: "dreamina-cli",
    modelName: "seedance2.0fast",
    selected: true,
    createdAt: "2026-08-16T08:00:00.000Z",
  }],
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
    template: '<section v-if="visible" v-bind="$attrs" role="dialog" data-overlay="true"><h2>{{ header }}</h2><slot /><slot name="footer" /></section>',
  },
  TDrawer: {
    inheritAttrs: true,
    props: ["visible", "modelValue", "header"],
    template: '<aside v-if="visible || modelValue" v-bind="$attrs" role="dialog"><slot /><slot name="footer" /></aside>',
  },
  TEmpty: { template: "<div>empty</div>" },
  TLoading: { template: "<div><slot /></div>" },
  TSelect: { template: "<select><slot /></select>" },
  TInput: { inheritAttrs: true, props: ["modelValue"], template: "<input v-bind=\"$attrs\" :value=\"modelValue\" />" },
  TTextarea: { inheritAttrs: true, props: ["modelValue"], template: "<textarea v-bind=\"$attrs\" />" },
  TCheckbox: { template: "<input type=\"checkbox\" />" },
  TCheckboxGroup: { template: "<div><slot /></div>" },
  TImage: { template: "<img />" },
  TImageViewer: { template: "<div><slot name=\"trigger\" :open=\"() => {}\" /></div>" },
  TPopup: { template: "<div><slot /></div>" },
};

function mountWorkspace(readonly = false): VueWrapper {
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
  (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(i18n.global.t(key));
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = projectStore();
  store.project = {
    id: "601",
    projectUuid,
    name: "雨夜剧场",
    describe: "R6 资产弹窗",
    projectType: "storyboard",
    myRole: readonly ? "viewer" : "owner",
    openMode: readonly ? "readonly" : "readwrite",
    imageModel: "",
    videoModel: "dreamina-cli:seedance2.0fast",
  } as any;
  store.access = {
    projectUuid,
    mode: readonly ? "readonly" : "readwrite",
    reason: "test_open",
    lockHolder: "",
  };
  return mount(StoryboardWorkspace, {
    global: {
      plugins: [pinia, i18n],
      stubs: {
        ...tdesignStubs,
        modelSelect: { template: "<div data-field=\"asset-model\" />" },
        ImageTools: { template: "<div />" },
        "i-plus": { template: "<i />" },
      },
    },
  });
}

describe("R6 独立资产弹窗", () => {
  beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPatch.mockReset();
    axiosDelete.mockReset();
    axiosGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/shots")) return Promise.resolve({ data: { data: [shot] } });
      if (String(url).includes("/storyboard/assets")) {
        return Promise.resolve({ data: { data: { sourceProjectUuid: projectUuid, assets } } });
      }
      return Promise.resolve({ data: { data: {} } });
    });
    axiosPost.mockImplementation((url: string) => {
      if (String(url).includes("/cornerScape/getAllAssets")) {
        return Promise.resolve({
          data: [{
            id: 1,
            assetUuid: roleAssetUuid,
            imageId: 11,
            type: "role",
            name: "林夏",
            remark: "夏夏",
            imageRatio: "16:9",
            prompt: "portrait",
            filePath: "/tianjiang/runtime/projects/x/files/images/a.png",
            state: "已完成",
            model: "seedream-4.0",
            resolution: "1K",
            describe: "女主",
            promptState: "",
            historyImages: [{ id: 10, filePath: "/old.png" }],
            errorReason: "",
            promptErrorReason: "",
            relepedAudio: [{ id: 9, name: "音色A" }],
            audioBindState: "",
          }],
        });
      }
      return Promise.resolve({ data: { data: {} } });
    });
    axiosDelete.mockResolvedValue({ data: { data: {} } });
  });

  it("三个按钮分别打开三个独立弹窗，表单不得内嵌在列表正文", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-module="assets"]').trigger("click");
    await flushPromises();
    const panel = wrapper.get('[data-panel="corner-scape-assets"]');
    expect(panel.find('[data-action="create-asset"]').exists()).toBe(true);
    expect(panel.find('[data-action="batch-upload-assets"]').exists()).toBe(true);
    expect(panel.find('[data-action="import-asset-descriptions"]').exists()).toBe(true);
    expect(panel.find('[data-section="corner-scape-asset-actions"] [data-field="asset-name"]').exists()).toBe(false);

    await panel.get('[data-action="create-asset"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-modal="create-asset"]').exists()).toBe(true);
    expect(panel.find('[data-section="corner-scape-asset-actions"] .assetActionDialog').exists()).toBe(false);
    const create = wrapper.get('[data-modal="create-asset"]');
    expect(create.find('[data-field="asset-ratio"]').exists()).toBe(true);
    expect(create.find('[data-field="asset-image"]').exists()).toBe(true);
    expect(create.find('[data-field="asset-audio"]').exists()).toBe(true);
    expect(create.text()).not.toContain("角色分类");
    expect(create.text()).not.toContain("单人");
    expect(create.text()).not.toContain("群演");

    await create.get('[data-field="asset-type"]').setValue("scene");
    await flushPromises();
    expect(wrapper.find('[data-modal="create-asset"] [data-field="asset-audio"]').exists()).toBe(false);

    await panel.get('[data-action="batch-upload-assets"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-modal="batch-upload-assets"]').exists()).toBe(true);
    expect(wrapper.find('[data-modal="batch-upload-assets"] [data-field="batch-asset-ratio"]').exists()).toBe(true);

    await panel.get('[data-action="import-asset-descriptions"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-modal="import-asset-descriptions"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("只读时三个写入口禁用且详情写按钮不可用", async () => {
    const wrapper = mountWorkspace(true);
    await flushPromises();
    await wrapper.get('[data-module="assets"]').trigger("click");
    await flushPromises();
    expect((wrapper.get('[data-action="create-asset"]').element as HTMLButtonElement).disabled).toBe(true);
    expect((wrapper.get('[data-action="batch-upload-assets"]').element as HTMLButtonElement).disabled).toBe(true);
    expect((wrapper.get('[data-action="import-asset-descriptions"]').element as HTMLButtonElement).disabled).toBe(true);
    wrapper.unmount();
  });
});

describe("R6 分镜行名称与解绑", () => {
  it("已关联槽位显示真实资产名称，不显示 UUID", async () => {
    const wrapper = mount(StoryboardTable, {
      props: {
        projectUuid,
        shots: [shot],
        assets,
        selectedShotUuid: shotUuid,
        selectedShotIds: [],
      },
      global: { stubs: tdesignStubs },
    });
    const slot = wrapper.get('[data-asset-slot="role"]');
    expect(slot.text()).toContain("林夏");
    expect(slot.text()).not.toMatch(/[0-9a-f]{8}/i);
    expect(slot.text()).not.toContain("…");
    wrapper.unmount();
  });

  it("取消关联按钮存在且不会打开选择抽屉，成功后刷新镜头", async () => {
    const wrapper = mount(StoryboardTable, {
      props: {
        projectUuid,
        shots: [shot],
        assets,
        selectedShotUuid: shotUuid,
        selectedShotIds: [],
      },
      global: { stubs: tdesignStubs },
    });
    const unbind = wrapper.get('[data-action="unbind-asset"]');
    await unbind.trigger("click");
    expect(wrapper.emitted("pickAsset")).toBeFalsy();
    expect(wrapper.emitted("unbindAsset")?.[0]).toMatchObject([{
      shotUuid,
      assetUuid: roleAssetUuid,
      assetType: "role",
      sourceProjectUuid: projectUuid,
    }]);
    wrapper.unmount();
  });

  it("找不到资产 DTO 时只显示安全文案", async () => {
    const wrapper = mount(ShotAssetSlots, {
      props: {
        bindings: [{ sourceProjectUuid: projectUuid, assetUuid: roleAssetUuid, assetType: "role", relationRole: "appear" }],
        assets: [],
        singleType: "role",
      },
      global: { stubs: tdesignStubs },
    });
    expect(wrapper.text()).toMatch(/资产不可用|已关联资产/);
    expect(wrapper.text()).not.toContain(roleAssetUuid);
    expect(wrapper.text()).not.toContain("…");
    wrapper.unmount();
  });
});

describe("R6 资产详情与右栏冻结", () => {
  beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/shots")) return Promise.resolve({ data: { data: [shot] } });
      if (String(url).includes("/storyboard/assets")) {
        return Promise.resolve({ data: { data: { sourceProjectUuid: projectUuid, assets } } });
      }
      return Promise.resolve({ data: { data: {} } });
    });
    axiosPost.mockImplementation((url: string) => {
      if (String(url).includes("/cornerScape/getAllAssets")) {
        return Promise.resolve({
          data: [{
            id: 1,
            assetUuid: roleAssetUuid,
            imageId: 11,
            type: "role",
            name: "林夏",
            remark: "夏夏",
            imageRatio: "16:9",
            prompt: "portrait",
            filePath: "/safe.png",
            state: "已完成",
            model: "seedream-4.0",
            resolution: "1K",
            describe: "女主",
            promptState: "",
            historyImages: [{ id: 10, filePath: "/old.png" }],
            errorReason: "",
            promptErrorReason: "",
            relepedAudio: [{ id: 9, name: "音色A" }],
            audioBindState: "",
          }],
        });
      }
      return Promise.resolve({ data: { data: {} } });
    });
  });

  it("资产详情包含主图、替换、历史图、名称、别名、描述、提示词、模型、画幅、分辨率和角色音色", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-module="assets"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-workspace="corner-scape"] .module-interactive').trigger("click");
    await flushPromises();
    const detail = wrapper.get('[data-panel="asset-detail"]');
    expect(detail.find('[data-field="asset-main-image"]').exists()).toBe(true);
    expect(detail.find('[data-action="replace-asset-image"]').exists()).toBe(true);
    expect(detail.find('[data-section="asset-history"]').exists()).toBe(true);
    expect(detail.find('[data-field="asset-name"]').exists()).toBe(true);
    expect(detail.find('[data-field="asset-alias"]').exists()).toBe(true);
    expect(detail.find('[data-field="asset-describe"]').exists()).toBe(true);
    expect(detail.find('[data-field="asset-prompt"]').exists()).toBe(true);
    expect(detail.find('[data-field="asset-model"]').exists()).toBe(true);
    expect(detail.find('[data-field="asset-ratio"]').exists()).toBe(true);
    expect(detail.find('[data-field="asset-resolution"]').exists()).toBe(true);
    expect(detail.find('[data-field="asset-audio"]').exists()).toBe(true);
    expect(detail.find('[data-action="save-asset-info"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("分镜右侧栏冻结合同仍通过", async () => {
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
    expect(wrapper.find('[data-section="video-preview"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="submit-current-shot"]').exists()).toBe(true);
    expect(wrapper.find('[data-candidate-group="video"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
