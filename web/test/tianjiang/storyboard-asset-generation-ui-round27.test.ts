// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import zhCN from "@/locales/language/zh-CN.json";
import { modelCatalogStore, setAccountScope } from "@/features/models/modelCatalogStore";

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
  },
}));

import projectStore from "@/stores/project";
import StoryboardTable from "@/views/storyboardProject/components/StoryboardTable.vue";
import StoryboardBatchGenerationDialog from "@/views/storyboardProject/components/StoryboardBatchGenerationDialog.vue";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";

const projectUuid = "27000000-0000-4000-a000-000000000001";
const sourceProjectUuid = "27000000-0000-4000-a000-000000000002";
const shotOneUuid = "27000000-0000-4000-a000-000000000101";
const shotTwoUuid = "27000000-0000-4000-a000-000000000102";
const candidateUuid = "27000000-0000-4000-a000-000000000201";
const imageCandidateUuid = "27000000-0000-4000-a000-000000000202";
const alternateVideoCandidateUuid = "27000000-0000-4000-a000-000000000203";
const failedVideoTaskUuid = "27000000-0000-4000-a000-000000000301";
const completedVideoTaskUuid = "27000000-0000-4000-a000-000000000302";
const previewDigest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function defaultVideoCatalog() {
  return {
    accountScopeId: "",
    catalogVersion: 27,
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

// 中文注释：期望值手工固定，避免测试复用生产常量后形成镜像断言。
const dreaminaVideoModels = [
  "seedance2.0",
  "seedance2.0fast",
  "seedance2.0mini",
  "seedance2.0_vip",
  "seedance2.0fast_vip",
];

const shots = [
  {
    shotUuid: shotOneUuid,
    displayOrder: 1,
    sourceText: "林夏走进雨夜剧院。",
    visualDescription: "角色从霓虹雨幕中走向舞台。",
    imagePrompt: "雨夜剧院，人物全身",
    videoPrompt: "缓慢跟随角色走入剧院",
    negativePrompt: "模糊，水印",
    shotSize: "全景",
    cameraMovement: "跟拍",
    composition: "中心构图",
    durationMs: 5000,
    aspectRatio: "9:16",
    bindings: [],
    candidates: [
      {
        candidateUuid: imageCandidateUuid,
        mediaType: "image",
        relativePath: "files/storyboard/candidates/rain-night.png",
        provider: "configured-image-provider",
        modelName: "seedream-4.0",
        selected: true,
        createdAt: "2026-08-15T07:59:00.000Z",
      },
      {
        candidateUuid,
        mediaType: "video",
        relativePath: "files/storyboard/candidates/rain-night.mp4",
        provider: "dreamina-cli",
        modelName: "seedance2.0fast",
        selected: false,
        createdAt: "2026-08-15T08:00:00.000Z",
      },
      {
        candidateUuid: alternateVideoCandidateUuid,
        mediaType: "video",
        relativePath: "files/storyboard/candidates/rain-night-alt.mp4",
        provider: "dreamina-cli",
        modelName: "seedance2.0fast",
        selected: false,
        createdAt: "2026-08-15T08:01:00.000Z",
      },
    ],
    generationTasks: [
      {
        taskUuid: failedVideoTaskUuid,
        mediaType: "video",
        status: "failed",
        providerId: "dreamina-cli",
        modelName: "seedance2.0fast",
        providerModel: "dreamina-cli:seedance2.0fast",
        createdAt: 1786780800000,
        updatedAt: 1786780801000,
      },
    ],
  },
  {
    shotUuid: shotTwoUuid,
    displayOrder: 2,
    sourceText: "舞台上的帷幕突然拉开。",
    visualDescription: "空舞台被一束冷光照亮。",
    imagePrompt: "空舞台，冷色顶光",
    videoPrompt: "镜头推进到舞台中央",
    negativePrompt: "过曝",
    shotSize: "中景",
    cameraMovement: "推进",
    composition: "对称构图",
    durationMs: 5000,
    aspectRatio: "9:16",
    bindings: [],
    candidates: [],
    generationTasks: [
      {
        taskUuid: completedVideoTaskUuid,
        mediaType: "video",
        status: "completed",
        providerId: "dreamina-cli",
        modelName: "seedance2.0fast",
        providerModel: "dreamina-cli:seedance2.0fast",
        createdAt: 1786780802000,
        updatedAt: 1786780803000,
      },
    ],
  },
];

const assets = [
  {
    assetUuid: "role-linxia",
    sourceProjectUuid,
    name: "林夏",
    assetType: "role",
    description: "女主角",
    // 中文注释：生产网关只返回已转换的项目范围保护 URL，绝不把原始 filePath 或相对路径交给前端。
    coverUrl: `/api/tianjiang/runtime/projects/${sourceProjectUuid}/files/assets/linxia.png`,
  },
  { assetUuid: "scene-theatre", sourceProjectUuid, name: "雨夜剧院", assetType: "scene", description: "主要场景" },
  { assetUuid: "tool-umbrella", sourceProjectUuid, name: "黑色雨伞", assetType: "tool", description: "关键道具" },
];

function mountWorkspace(componentProps: Record<string, unknown> = {}, projectImageModel = ""): VueWrapper {
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
  (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(i18n.global.t(key));
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = projectStore();
  store.project = {
    projectUuid,
    assetSourceProjectUuid: sourceProjectUuid,
    name: "雨夜剧场",
    describe: "分镜资产与视频生成验收项目",
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
    imageModel: projectImageModel,
    videoModel: "dreamina-cli:seedance2.0fast",
  } as any;
  store.access = {
    projectUuid,
    mode: "readwrite",
    reason: "test_open",
    lockHolder: "",
  };
  return mount(StoryboardWorkspace, {
    props: componentProps,
    global: {
      plugins: [pinia, i18n],
      stubs: {
        TButton: {
          inheritAttrs: true,
          props: ["loading", "disabled"],
          template: "<button v-bind=\"$attrs\" :disabled=\"disabled || loading\"><slot name=\"icon\"/><slot/></button>",
        },
        TIcon: { template: "<i />" },
        TTag: { template: "<span><slot /></span>" },
        TCard: { inheritAttrs: true, template: "<section v-bind=\"$attrs\"><slot name=\"title\" /><slot /></section>" },
        TForm: { template: "<form><slot /></form>" },
        TFormItem: { template: "<div><slot /></div>" },
        TEmpty: { template: "<div>empty</div>" },
        TLoading: { template: "<div><slot /></div>" },
        TSelect: {
          props: ["modelValue", "disabled", "placeholder", "name", "size", "loading"],
          emits: ["update:modelValue", "change", "popup-visible-change"],
          template: "<select :name=\"name\" :value=\"modelValue\" :disabled=\"disabled\" @change=\"$emit('update:modelValue', $event.target.value); $emit('change', $event.target.value, { option: {} })\"><slot /><slot name='empty' /></select>",
        },
        TOptionGroup: { props: ["label"], template: "<optgroup :label=\"label\"><slot /></optgroup>" },
        TOption: { props: ["value", "label", "disabled"], template: "<option :value=\"value\" :disabled=\"disabled\">{{ label }}<slot /></option>" },
        TTextarea: { inheritAttrs: true, template: "<textarea v-bind=\"$attrs\" />" },
        TCheckbox: { template: "<input type=\"checkbox\" />" },
        TCheckboxGroup: { template: "<div><slot /></div>" },
        TImage: { template: "<img />" },
        TImageViewer: { template: "<div><slot name=\"trigger\" :open=\"() => {}\" /></div>" },
        TPopup: { template: "<div><slot /></div>" },
        TAvatar: { template: "<span />" },
        ImageTools: { template: "<div />" },
        "i-plus": { template: "<i />" },
        TDialog: {
          inheritAttrs: false,
          props: ["visible", "header"],
          emits: ["close"],
          template: "<section v-if=\"visible\" role=\"dialog\"><h2>{{ header }}</h2><slot/><slot name=\"footer\"/></section>",
        },
        TDrawer: {
          inheritAttrs: true,
          props: ["visible", "modelValue", "header"],
          emits: ["update:visible", "update:modelValue", "close"],
          template: "<aside v-if=\"visible || modelValue\" v-bind=\"$attrs\" role=\"dialog\"><h2>{{ header }}</h2><slot/><slot name=\"footer\"/></aside>",
        },
      },
    },
  });
}

function callsFor(urlSuffix: string): unknown[][] {
  return axiosPost.mock.calls.filter(([url]) => String(url).endsWith(urlSuffix));
}

async function waitForBatchCatalogReady(wrapper: VueWrapper): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 3_000) {
    await flushPromises();
    const panel = wrapper.find('[data-dialog="storyboard-batch-generation"] [data-panel="storyboard-generation-settings"]');
    if (panel.exists() && panel.attributes("data-catalog-valid") === "true") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const dialog = wrapper.get('[data-dialog="storyboard-batch-generation"]');
  expect(dialog.get('[data-panel="storyboard-generation-settings"]').attributes("data-catalog-valid")).toBe("true");
}

async function waitForBatchPreviewReady(wrapper: VueWrapper): Promise<void> {
  await vi.waitFor(() => {
    const submit = wrapper.get('[data-dialog="storyboard-batch-generation"] [data-action="submit-batch-generation"]');
    expect((submit.element as HTMLButtonElement).disabled).toBe(false);
  });
}

function installImageCatalog(options: {
  providerState?: string;
  includeModel?: boolean;
  reject?: boolean;
} = {}): void {
  const fallback = axiosPost.getMockImplementation();
  axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
    if (url.endsWith("/modelSelect/getModelList")) {
      if (payload?.type === "video") return Promise.resolve({ data: { data: defaultVideoCatalog() } });
      if (options.reject) return Promise.reject(new Error("catalog apiKey=sk-hidden C:\\Users\\secret"));
      return Promise.resolve({
        data: {
          data: {
            accountScopeId: "",
            catalogVersion: 27,
            items: options.includeModel === false ? [] : [{
              id: "configured-image-provider",
              name: "已配置图片供应商",
              label: "Seedream 4.0",
              value: "seedream-4.0",
              type: "image",
              disabled: false,
            }],
            providers: [{
              providerId: "configured-image-provider",
              providerName: "已配置图片供应商",
              state: options.providerState ?? "ready",
            }],
          },
        },
      });
    }
    return fallback?.(url, payload);
  });
}

const previewFixture = {
  previewDigest,
  providerModel: "dreamina-cli:seedance2.0fast",
  // 中文注释：R26 将执行路由纳入预览确认合同，旧夹具必须返回与模型一致的路由。
  routeKind: "dreamina-cli" as const,
  prompt: "服务端合并后的最终视频提示词",
  negativePrompt: "模糊，水印",
  references: [],
  options: {
    aspectRatio: "9:16",
    // 中文注释：R27 后服务端预览必须逐字回显已解析的视频分辨率。
    resolution: "720p",
    durationMs: 5000,
    mode: "text2video",
  },
  apiKey: "sk-preview-sensitive",
  localPath: "C:\\Users\\secret\\preview.json",
};

function acceptedGenerationResponse(
  payload?: Record<string, any>,
  clientOperationId = payload?.clientOperationId,
) {
  const itemCount = Array.isArray(payload?.items) ? payload.items.length : 1;
  return {
    status: 200,
    data: {
      code: 0,
      data: Array.from({ length: itemCount }, (_, index) => ({
        taskUuid: `ui-task-${index + 1}`,
        status: "queued",
        clientOperationId,
      })),
    },
  };
}

const originalAxiosPostMockImplementation = axiosPost.mockImplementation.bind(axiosPost);

function installCatalogAwarePostMock(): void {
  // 中文注释：相邻用例大量覆盖 axiosPost；视频目录必须始终按当前账号返回，不能被覆盖成空对象。
  axiosPost.mockImplementation = ((impl?: (url: string, payload?: Record<string, any>) => unknown) => {
    const next = impl ?? ((_url: string, _payload?: Record<string, any>) => Promise.resolve({ data: { code: 0, data: {} } }));
    return originalAxiosPostMockImplementation((url: string, payload?: Record<string, any>) => {
      if (String(url).endsWith("/modelSelect/getModelList") && payload?.type !== "image") {
        return Promise.resolve({ data: { data: defaultVideoCatalog() } });
      }
      return next(url, payload);
    });
  }) as typeof axiosPost.mockImplementation;
}

beforeEach(() => {
  setAccountScope(null);
  modelCatalogStore.invalidateAll();
  axiosGet.mockReset();
  axiosPost.mockReset();
  axiosPatch.mockReset();
  axiosPut.mockReset();
  installCatalogAwarePostMock();

  axiosGet.mockImplementation((url: string) => {
    if (url.endsWith("/shots")) return Promise.resolve({ data: { data: shots } });
    if (url.endsWith("/assets")) return Promise.resolve({ data: { data: { assets } } });
    if (url.endsWith("/settings")) {
      return Promise.resolve({
        data: {
          data: {
            aspectRatio: "9:16",
            defaultDurationMs: 5000,
            globalImagePrompt: "统一电影感",
            globalVideoPrompt: "动作自然，镜头稳定",
          },
        },
      });
    }
    if (String(url).includes("/modelSelect/getCatalogVersion")) {
      return Promise.resolve({ data: { data: { catalogVersion: 27 } } });
    }
    return Promise.resolve({ data: { data: {} } });
  });
  axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
    if (url.endsWith("/bindings")) return Promise.resolve({ data: { code: 0, data: { shotUuid: shotOneUuid } } });
    if (url.includes("/candidates/") && url.endsWith("/select")) {
      const selectedCandidateUuid = url.split("/candidates/")[1]?.split("/select")[0] ?? "";
      return Promise.resolve({ data: { code: 0, data: { shotUuid: shotOneUuid, candidateUuid: selectedCandidateUuid } } });
    }
    if (url.endsWith("/generate/preview")) {
      return Promise.resolve({
        data: {
          code: 0,
          data: {
            ...previewFixture,
            providerModel: String(payload?.providerModel ?? previewFixture.providerModel),
            options: {
              ...previewFixture.options,
              aspectRatio: String(payload?.shot?.aspectRatio ?? payload?.settings?.aspectRatio ?? "9:16"),
              durationMs: Number(payload?.shot?.durationMs ?? payload?.settings?.durationMs ?? 5000),
              // 中文注释：auto 由服务端解析成显式模式；正式请求不得继续携带 auto。
              mode: payload?.mode === "auto" ? "text2video" : String(payload?.mode ?? "text2video"),
            },
          },
        },
      });
    }
    if (url.endsWith("/generate")) return Promise.resolve(acceptedGenerationResponse(payload));
    if (url.endsWith("/modelSelect/getModelList")) {
      return Promise.resolve({
        data: { data: payload?.type === "image" ? {
          accountScopeId: "",
          catalogVersion: 27,
          items: [],
          providers: [],
        } : defaultVideoCatalog() },
      });
    }
    if (String(url).includes("/cornerScape/getAllAssets")) return Promise.resolve({ data: [] });
    return Promise.resolve({ data: { code: 0, data: {} } });
  });
  axiosPatch.mockResolvedValue({ data: { data: shots[0] } });
  axiosPut.mockResolvedValue({ data: { data: {} } });
});

describe("分镜资产选择与生成控制", () => {
  it.each([
    ["role", "role-linxia", ["scene-theatre", "tool-umbrella"]],
    ["scene", "scene-theatre", ["role-linxia", "tool-umbrella"]],
    ["tool", "tool-umbrella", ["role-linxia", "scene-theatre"]],
  ])("从 %s 槽位打开资产抽屉时只展示同类型资产", async (assetType, expectedAssetUuid, excludedAssetUuids) => {
    const wrapper = mountWorkspace();
    await flushPromises();

    await wrapper.get(`[data-action="pick-asset"][data-asset-type="${assetType}"]`).trigger("click");
    await flushPromises();

    const drawer = wrapper.get('[data-drawer="storyboard-asset-picker"]');
    expect(drawer.get(`[data-asset-id=\"${expectedAssetUuid}\"]`).exists()).toBe(true);
    for (const assetUuid of excludedAssetUuids) {
      expect(drawer.find(`[data-asset-id=\"${assetUuid}\"]`).exists()).toBe(false);
    }
    wrapper.unmount();
  });

  it("选中角色资产时不立即写入，明确确认后才绑定、关闭抽屉并刷新", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const shotsReadsBeforeBinding = axiosGet.mock.calls.filter(([url]) => String(url).endsWith("/shots")).length;

    await wrapper.get('[data-action="pick-asset"][data-asset-type="role"]').trigger("click");
    await flushPromises();
    const assetCard = wrapper.get('[data-drawer="storyboard-asset-picker"] [data-asset-id="role-linxia"]');
    await assetCard.trigger("click");
    await flushPromises();

    // 中文注释：卡片点击仅建立本地选择，明确确认前绝不触发绑定写入。
    expect(callsFor("/bindings")).toHaveLength(0);
    expect(assetCard.attributes("aria-pressed")).toBe("true");
    expect(wrapper.find('[data-drawer="storyboard-asset-picker"]').exists()).toBe(true);
    const selectedPreview = wrapper.get('[data-panel="selected-asset-preview"]');
    expect(selectedPreview.text()).toContain("镜头 01");
    expect(selectedPreview.text()).toContain("林夏");
    expect(selectedPreview.text()).toContain("女主角");
    expect(selectedPreview.get("img").attributes("src")).toBe(
      `/api/tianjiang/runtime/projects/${sourceProjectUuid}/files/assets/linxia.png`,
    );

    await wrapper.get('[data-action="confirm-asset-binding"]').trigger("click");
    await flushPromises();

    expect(axiosPost).toHaveBeenCalledWith(
      `/tianjiang/runtime/projects/${projectUuid}/storyboard/shots/${shotOneUuid}/bindings`,
      {
        sourceProjectUuid,
        assetUuid: "role-linxia",
        assetType: "role",
        relationRole: "appear",
      },
    );
    expect(wrapper.find('[data-drawer="storyboard-asset-picker"]').exists()).toBe(false);
    expect(axiosGet.mock.calls.filter(([url]) => String(url).endsWith("/shots")).length).toBeGreaterThan(shotsReadsBeforeBinding);
    wrapper.unmount();
  });

  it("详情生成设置展示账号视频模型目录，以及画幅、时长和模式", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    await flushPromises();

    const settings = wrapper.get('[data-panel="storyboard-generation-settings"]');
    const modelSelect = settings.get('select[name="providerModel"]');
    expect(modelSelect.findAll("option").map((option) => option.attributes("value"))).toContain(
      "dreamina-cli:seedance2.0fast",
    );
    expect(settings.get('select[name="aspectRatio"]').exists()).toBe(true);
    expect(settings.get('[name="durationSeconds"]').exists()).toBe(true);
    expect(settings.get('select[name="mode"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("详情候选先预览、再明确采用，采用后调用真实接口并刷新", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const shotsReadsBeforeSelection = axiosGet.mock.calls.filter(([url]) => String(url).endsWith("/shots")).length;

    const candidate = wrapper.get(
      `[data-section="candidate-results"] [data-candidate-group="video"] [data-candidate-id="${candidateUuid}"]`,
    );
    await candidate.trigger("click");
    await flushPromises();

    expect(callsFor("/select")).toHaveLength(0);
    const preview = wrapper.get('[data-section="candidate-results"] [data-candidate-preview="video"]');
    expect(preview.get("video").attributes("src")).toBe(
      `/api/tianjiang/runtime/projects/${projectUuid}/files/storyboard/candidates/rain-night.mp4`,
    );
    await preview.get('[data-action="confirm-candidate-selection"]').trigger("click");
    await flushPromises();

    expect(axiosPost.mock.calls.some(([url]) => String(url) === (
      `/tianjiang/runtime/projects/${projectUuid}/storyboard/shots/${shotOneUuid}/candidates/${candidateUuid}/select`
    ))).toBe(true);
    expect(axiosGet.mock.calls.filter(([url]) => String(url).endsWith("/shots")).length).toBeGreaterThan(shotsReadsBeforeSelection);
    wrapper.unmount();
  });

  it("资产抽屉未选择时显示镜头身份与明确空态", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();

    await wrapper.get('[data-action="pick-asset"][data-asset-type="scene"]').trigger("click");
    await flushPromises();

    const selectedPreview = wrapper.get('[data-panel="selected-asset-preview"]');
    expect(selectedPreview.text()).toContain("镜头 01");
    expect(selectedPreview.text()).toContain("尚未选择资产");
    expect(selectedPreview.find("img, video, [src]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("资产确认极快双击只绑定一次", async () => {
    let releaseBinding!: (value: unknown) => void;
    const pendingBinding = new Promise((resolve) => { releaseBinding = resolve; });
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith("/bindings")) return pendingBinding;
      if (url.endsWith("/generate/preview")) return Promise.resolve({ data: { code: 0, data: previewFixture } });
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();

    await wrapper.get('[data-action="pick-asset"][data-asset-type="role"]').trigger("click");
    await wrapper.get('[data-drawer="storyboard-asset-picker"] [data-asset-id="role-linxia"]').trigger("click");
    const confirm = wrapper.get('[data-action="confirm-asset-binding"]');
    await Promise.all([confirm.trigger("click"), confirm.trigger("click")]);

    expect(callsFor("/bindings")).toHaveLength(1);
    expect((confirm.element as HTMLButtonElement).disabled).toBe(true);
    releaseBinding({ data: { code: 0, data: { shotUuid: shotOneUuid } } });
    await flushPromises();
    wrapper.unmount();
  });

  it("真实页面把 projectUuid 传到生产行，并安全预览视频候选", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const panel = wrapper.get('[data-panel="shot-production"]');
    expect(panel.find('[data-candidate-group="image"]').exists()).toBe(false);
    expect(panel.get(`[data-candidate-id="${candidateUuid}"] video`).attributes("src")).toBe(
      `/api/tianjiang/runtime/projects/${projectUuid}/files/storyboard/candidates/rain-night.mp4`,
    );
    wrapper.unmount();
  });

  it("详情候选只保留视频分组，并复用安全媒体路由渲染真实预览", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const detail = wrapper.get('[data-section="candidate-results"]');
    expect(detail.find('[data-candidate-group="image"]').exists()).toBe(false);
    const videoGroup = detail.get('[data-candidate-group="video"]');
    expect(videoGroup.get(`[data-candidate-id="${candidateUuid}"] video`).attributes("src")).toBe(
      `/api/tianjiang/runtime/projects/${projectUuid}/files/storyboard/candidates/rain-night.mp4`,
    );
    wrapper.unmount();
  });

  it("生产行位置参数能打开正确类型资产抽屉", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const row = wrapper.get(`[data-shot-id="${shotOneUuid}"]`);

    await row.get('[data-action="pick-asset"][data-asset-type="scene"]').trigger("click");
    await flushPromises();

    const drawer = wrapper.get('[data-drawer="storyboard-asset-picker"]');
    expect(drawer.find('[data-asset-id="scene-theatre"]').exists()).toBe(true);
    expect(drawer.find('[data-asset-id="role-linxia"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("生产行候选缩略图只切换预览，明确采用后才命中真实接口", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const panel = wrapper.get('[data-section="candidate-results"]');

    await panel.get(`[data-candidate-id="${candidateUuid}"]`).trigger("click");
    await flushPromises();

    expect(callsFor("/select")).toHaveLength(0);
    const preview = panel.get('[data-candidate-preview="video"]');
    expect(preview.get("video").attributes("src")).toBe(
      `/api/tianjiang/runtime/projects/${projectUuid}/files/storyboard/candidates/rain-night.mp4`,
    );
    await preview.get('[data-action="confirm-candidate-selection"]').trigger("click");
    await flushPromises();

    expect(axiosPost).toHaveBeenCalledWith(
      `/tianjiang/runtime/projects/${projectUuid}/storyboard/shots/${shotOneUuid}/candidates/${candidateUuid}/select`,
      {},
    );
    wrapper.unmount();
  });

  it("候选采用并发按最后选择收敛，重复确认不得重复 POST", async () => {
    let releaseSelection!: (value: unknown) => void;
    const pendingSelection = new Promise((resolve) => { releaseSelection = resolve; });
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith(`/candidates/${alternateVideoCandidateUuid}/select`)) return pendingSelection;
      if (url.endsWith("/generate/preview")) return Promise.resolve({ data: { code: 0, data: previewFixture } });
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    const panel = wrapper.get('[data-section="candidate-results"]');

    await panel.get(`[data-candidate-id="${candidateUuid}"]`).trigger("click");
    await panel.get(`[data-candidate-id="${alternateVideoCandidateUuid}"]`).trigger("click");
    const confirm = panel.get('[data-candidate-preview="video"] [data-action="confirm-candidate-selection"]');
    await Promise.all([confirm.trigger("click"), confirm.trigger("click")]);

    expect(callsFor(`/candidates/${candidateUuid}/select`)).toHaveLength(0);
    expect(callsFor(`/candidates/${alternateVideoCandidateUuid}/select`)).toHaveLength(1);
    expect((confirm.element as HTMLButtonElement).disabled).toBe(true);
    releaseSelection({ data: { code: 0, data: { shotUuid: shotOneUuid, candidateUuid: alternateVideoCandidateUuid } } });
    await flushPromises();
    wrapper.unmount();
  });

  it("候选采用进行中禁用其他选择，完成后必须由用户重新确认第二意图", async () => {
    let releaseFirstSelection!: (value: unknown) => void;
    const pendingFirstSelection = new Promise((resolve) => { releaseFirstSelection = resolve; });
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith(`/candidates/${candidateUuid}/select`)) return pendingFirstSelection;
      if (url.includes("/candidates/") && url.endsWith("/select")) {
        return Promise.resolve({ data: { code: 0, data: { shotUuid: shotOneUuid } } });
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    const panel = wrapper.get('[data-section="candidate-results"]');

    await panel.get(`[data-candidate-id="${candidateUuid}"]`).trigger("click");
    await panel.get('[data-candidate-preview="video"] [data-action="confirm-candidate-selection"]').trigger("click");
    await nextTick();
    const alternate = panel.get(`[data-candidate-id="${alternateVideoCandidateUuid}"]`);
    expect((alternate.element as HTMLButtonElement).disabled).toBe(true);
    await alternate.trigger("click");
    expect(callsFor(`/candidates/${alternateVideoCandidateUuid}/select`)).toHaveLength(0);

    releaseFirstSelection({ data: { code: 0, data: { shotUuid: shotOneUuid, candidateUuid } } });
    await flushPromises();
    expect((alternate.element as HTMLButtonElement).disabled).toBe(false);
    await alternate.trigger("click");
    await panel.get('[data-candidate-preview="video"] [data-action="confirm-candidate-selection"]').trigger("click");
    await flushPromises();
    expect(callsFor(`/candidates/${alternateVideoCandidateUuid}/select`)).toHaveLength(1);
    wrapper.unmount();
  });

  it("生产行确认只使用已展示摘要提交，不重复预览也不等待 CLI 探测", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();

    await wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
    await flushPromises();

    const previewRequest = callsFor("/storyboard/generate/preview")[0]?.[1] as Record<string, any>;
    expect(previewRequest).toMatchObject({
      shotUuid: shotOneUuid,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "auto",
      settings: { durationMs: 5000, aspectRatio: "9:16" },
    });

    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    const confirmation = wrapper.get('[data-dialog="storyboard-generation-confirm"]');
    expect(confirmation.text()).toContain("服务端合并后的最终视频提示词");
    await confirmation.get('[data-action="confirm-row-generation"]').trigger("click");
    await flushPromises();
    // 中文注释：确认按钮只发一次耐久受理请求；服务端以摘要重新构建并拒绝陈旧意图。
    expect(callsFor("/storyboard/generate/preview")).toHaveLength(1);
    expect(axiosPost).toHaveBeenCalledWith(
      `/tianjiang/runtime/projects/${projectUuid}/storyboard/generate`,
      {
        clientOperationId: expect.stringMatching(uuidPattern),
        shotUuid: shotOneUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "text2video",
        routeKind: "dreamina-cli",
        durationMs: 5000,
        aspectRatio: "9:16",
        resolution: "720p",
        paidBatchConfirmed: false,
        expectedPreviewDigest: previewDigest,
      },
      { preserveResponse: true },
    );
    wrapper.unmount();
  });

  it("正式提交由服务端权威拒绝摘要漂移，前端不重复预览也不假报成功", async () => {
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({
          data: {
            data: {
              ...previewFixture,
              providerModel: String(payload?.providerModel ?? previewFixture.providerModel),
              prompt: "首次服务端预览",
              options: {
                ...previewFixture.options,
                aspectRatio: String(payload?.settings?.aspectRatio ?? "9:16"),
                durationMs: Number(payload?.settings?.durationMs ?? 5000),
                mode: "text2video",
              },
            },
          },
        });
      }
      if (url.endsWith("/generate")) {
        return Promise.reject({
          response: { data: { code: "STORYBOARD_PREVIEW_STALE", message: "最终请求已变化，请重新预览确认" } },
        });
      }
      return Promise.resolve({ data: { data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
    await flushPromises();

    const confirmation = wrapper.get('[data-dialog="storyboard-generation-confirm"]');
    expect(confirmation.text()).toContain("首次服务端预览");
    await confirmation.get('[data-action="confirm-row-generation"]').trigger("click");
    await flushPromises();

    expect(callsFor("/storyboard/generate/preview")).toHaveLength(1);
    expect(callsFor("/storyboard/generate")).toHaveLength(1);
    expect(wrapper.get('[data-feedback="storyboard-action"]').text()).toContain("最终请求已变化，请重新预览确认");
    expect(wrapper.find('[data-dialog="storyboard-generation-confirm"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain("提交完成，已进入任务队列");
    wrapper.unmount();
  });

  it("正式提交被拒后重试复用同一幂等 ID，且不额外请求预览", async () => {
    let generateCount = 0;
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({
          data: {
            code: 0,
            data: {
              ...previewFixture,
              providerModel: String(payload?.providerModel ?? previewFixture.providerModel),
            },
          },
        });
      }
      if (url.endsWith("/generate")) {
        generateCount += 1;
        if (generateCount === 1) {
          return Promise.reject({ response: { data: { code: "STORYBOARD_PREVIEW_STALE" } } });
        }
        return Promise.resolve(acceptedGenerationResponse(payload));
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
    await flushPromises();
    await wrapper.get('[data-dialog="storyboard-generation-confirm"] [data-action="confirm-row-generation"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-dialog="storyboard-generation-confirm"] [data-action="confirm-row-generation"]').trigger("click");
    await flushPromises();

    const requests = callsFor("/storyboard/generate").map((call) => call[1] as Record<string, unknown>);
    expect(callsFor("/storyboard/generate/preview")).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[1].clientOperationId).toBe(requests[0].clientOperationId);
    wrapper.unmount();
  });

  it("镜头有绑定素材时把 auto 交给服务端解析，并用预览返回的显式模式提交", async () => {
    const boundShots = [{
      ...shots[0],
      bindings: [{
        sourceProjectUuid,
        assetUuid: "role-linxia",
        assetType: "role",
        relationRole: "appear",
      }],
    }, shots[1]];
    axiosGet.mockImplementation((url: string) => {
      if (url.endsWith("/shots")) return Promise.resolve({ data: { data: boundShots } });
      if (url.endsWith("/assets")) return Promise.resolve({ data: { data: { assets } } });
      return Promise.resolve({ data: { data: {} } });
    });
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({
          data: {
            data: {
              ...previewFixture,
              providerModel: String(payload?.providerModel ?? previewFixture.providerModel),
              options: {
                ...previewFixture.options,
                aspectRatio: "9:16",
                durationMs: 5000,
                mode: "multimodal2video",
              },
            },
          },
        });
      }
      if (url.endsWith("/generate")) return Promise.resolve({ data: { data: { status: "queued" } } });
      return Promise.resolve({ data: { data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();

    await wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
    await flushPromises();
    expect(callsFor("/storyboard/generate/preview")[0]?.[1]).toMatchObject({
      shotUuid: shotOneUuid,
      mediaType: "video",
      mode: "auto",
    });
    await wrapper.get('[data-dialog="storyboard-generation-confirm"] [data-action="confirm-row-generation"]').trigger("click");
    await flushPromises();
    expect(callsFor("/storyboard/generate")[0]?.[1]).toMatchObject({
      shotUuid: shotOneUuid,
      mediaType: "video",
      mode: "multimodal2video",
      paidBatchConfirmed: false,
      expectedPreviewDigest: previewDigest,
    });
    wrapper.unmount();
  });

  it("服务端解析为 frames2video 时按真实模式确认，并携带预览摘要提交", async () => {
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({
          data: {
            code: 0,
            data: {
              ...previewFixture,
              providerModel: String(payload?.providerModel ?? previewFixture.providerModel),
              options: { ...previewFixture.options, mode: "frames2video" },
            },
          },
        });
      }
      if (url.endsWith("/generate")) return Promise.resolve({ data: { code: 0, data: { status: "queued" } } });
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
    await flushPromises();
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    await wrapper.get('[data-dialog="storyboard-generation-confirm"] [data-action="confirm-row-generation"]').trigger("click");
    await flushPromises();

    expect(callsFor("/storyboard/generate")[0]?.[1]).toMatchObject({
      shotUuid: shotOneUuid,
      mode: "frames2video",
      expectedPreviewDigest: previewDigest,
    });
    wrapper.unmount();
  });

  it("失败任务按钮明确写作重新生成，并先展示服务端预览再由用户确认新任务", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const retryButton = wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="retry-video"]`);

    expect(retryButton.text()).toBe("重试");
    expect(retryButton.attributes("data-source-task-id")).toBe(failedVideoTaskUuid);
    await retryButton.trigger("click");
    await flushPromises();

    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    const confirmation = wrapper.get('[data-dialog="storyboard-generation-confirm"]');
    expect(confirmation.text()).toContain("服务端合并后的最终视频提示词");
    await confirmation.get('[data-action="confirm-row-generation"]').trigger("click");
    await flushPromises();
    // 中文注释：taskUuid 仅标识失败来源；确认后的语义是按当前镜头参数新建任务，不伪造后端原任务重试。
    expect(axiosPost).toHaveBeenCalledWith(
      `/tianjiang/runtime/projects/${projectUuid}/storyboard/generate`,
      {
        clientOperationId: expect.stringMatching(uuidPattern),
        shotUuid: shotOneUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        routeKind: "dreamina-cli",
        mode: "text2video",
        durationMs: 5000,
        aspectRatio: "9:16",
        resolution: "720p",
        paidBatchConfirmed: false,
        expectedPreviewDigest: previewDigest,
      },
      { preserveResponse: true },
    );
    wrapper.unmount();
  });

  it("右侧生产栏不再提供图片生成入口，视频生成仍可用且保持零误请求", async () => {
    installImageCatalog();
    const wrapper = mountWorkspace({}, "configured-image-provider:seedream-4.0");
    await flushPromises();
    const panel = wrapper.get('[data-panel="shot-production"]');
    expect(panel.find('[data-action="generate-image"]').exists()).toBe(false);
    expect(panel.find('[data-generation-unavailable="image"]').exists()).toBe(false);
    expect(panel.find('[data-action="submit-current-shot"]').exists()).toBe(true);
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    wrapper.unmount();
  });

  it("行内预览期间锁住生成与重新生成，快速连续点击只打开一个确认流", async () => {
    let releaseGeneration!: (value: unknown) => void;
    const pendingGeneration = new Promise((resolve) => { releaseGeneration = resolve; });
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({
          data: {
            code: 0,
            data: {
              ...previewFixture,
              options: {
                ...previewFixture.options,
                aspectRatio: String(payload?.settings?.aspectRatio ?? "9:16"),
                durationMs: Number(payload?.settings?.durationMs ?? 5000),
              },
            },
          },
        });
      }
      if (url.endsWith("/generate")) return pendingGeneration;
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    const row = wrapper.get(`[data-shot-id="${shotOneUuid}"]`);

    await Promise.all([
      row.get('[data-action="generate-video"]').trigger("click"),
      row.get('[data-action="retry-video"]').trigger("click"),
    ]);

    expect(callsFor("/storyboard/generate/preview")).toHaveLength(1);
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    expect((row.get('[data-action="generate-video"]').element as HTMLButtonElement).disabled).toBe(true);
    expect((row.get('[data-action="retry-video"]').element as HTMLButtonElement).disabled).toBe(true);
    const confirmation = wrapper.get('[data-dialog="storyboard-generation-confirm"]');
    await confirmation.get('[data-action="confirm-row-generation"]').trigger("click");
    expect(callsFor("/storyboard/generate")).toHaveLength(1);
    releaseGeneration({ data: { code: 0, data: { status: "queued" } } });
    await flushPromises();
    wrapper.unmount();
  });

  it("陈旧或合成的 completed retry 事件不得新建任务", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();

    wrapper.getComponent(StoryboardTable).vm.$emit("retry", completedVideoTaskUuid, shotTwoUuid, "video");
    await flushPromises();

    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    wrapper.unmount();
  });

  it("保存失败只显示安全摘要，不回显本机路径、响应内容或供应商密钥", async () => {
    axiosPatch.mockRejectedValueOnce(new Error("ENOENT C:\\Users\\secret\\db2.sqlite apiKey=sk-sensitive"));
    const wrapper = mountWorkspace();
    await flushPromises();

    await wrapper.get('[data-action="save-shot"]').trigger("click");
    await flushPromises();

    const feedback = wrapper.get('[data-selected-shot] [role="status"]');
    expect(feedback.text()).toBe("保存分镜失败，请重试");
    expect(feedback.text()).not.toMatch(/C:\\|db2\.sqlite|sk-sensitive|apiKey/i);
    wrapper.unmount();
  });

  it.each(["readonly", "recovery"] as const)(
    "store access 动态切到 %s 后所有写控件原生禁用且保持零 POST/PATCH",
    async (mode) => {
      const wrapper = mountWorkspace();
      await flushPromises();
      const store = projectStore();
      store.access = { projectUuid, mode, reason: "test_lock", lockHolder: "another-device" };
      await nextTick();
      axiosPost.mockClear();
      axiosPatch.mockClear();

      const detail = wrapper.get('[data-selected-shot]');
      for (const control of detail.findAll("input, textarea, select")) {
        expect((control.element as HTMLInputElement).disabled).toBe(true);
      }

      const writeSelectors = [
        '[data-action="open-import"]',
        '[data-action="open-batch-generation"]',
        '[data-action="insert-first"]',
        `[data-shot-id="${shotOneUuid}"] [data-action="pick-asset"]`,
        `[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`,
        '[data-action="submit-current-shot"]',
        '[data-action="save-shot"]',
      ];
      for (const selector of writeSelectors) {
        const control = wrapper.get(selector);
        expect((control.element as HTMLButtonElement).disabled).toBe(true);
        await control.trigger("click");
      }
      await flushPromises();

      expect(axiosPost).not.toHaveBeenCalled();
      expect(axiosPatch).not.toHaveBeenCalled();
      wrapper.unmount();
    },
  );

  it("导入窗口打开后权限动态降级，预览与提交均原生禁用且零写请求", async () => {
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith("/import/preview")) {
        return Promise.resolve({ data: { data: { digest: "round27-import-digest", rows: [{ sourceText: "镜头一" }] } } });
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();

    await wrapper.get('[data-action="open-import"]').trigger("click");
    const dialog = wrapper.get('[data-dialog="storyboard-import"]');
    await dialog.get("textarea").setValue("镜头一");
    await dialog.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();
    expect(dialog.get('[data-action="commit-import"]').attributes("disabled")).toBeUndefined();

    projectStore().access = {
      projectUuid,
      mode: "recovery",
      reason: "test_lock_after_preview",
      lockHolder: "another-device",
    };
    await nextTick();
    axiosPost.mockClear();

    const previewButton = dialog.get('[data-action="preview-import"]');
    const commitButton = dialog.get('[data-action="commit-import"]');
    expect((previewButton.element as HTMLButtonElement).disabled).toBe(true);
    expect((commitButton.element as HTMLButtonElement).disabled).toBe(true);
    for (const control of dialog.findAll("textarea, select")) {
      expect((control.element as HTMLInputElement).disabled).toBe(true);
    }
    await previewButton.trigger("click");
    await commitButton.trigger("click");
    await flushPromises();
    expect(axiosPost).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("导入预览与提交失败只显示稳定安全摘要", async () => {
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith("/import/preview")) {
        return Promise.reject(new Error("ENOENT C:\\Users\\secret\\import.csv apiKey=sk-import"));
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-action="open-import"]').trigger("click");
    const dialog = wrapper.get('[data-dialog="storyboard-import"]');
    await dialog.get("textarea").setValue("镜头一");
    await dialog.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();

    const alert = dialog.get('[role="alert"]');
    expect(alert.text()).toBe("导入预览失败，请重试");
    expect(alert.text()).not.toMatch(/C:\\Users|sk-import|apiKey|import\.csv/i);
    wrapper.unmount();
  });

  it("导入提交失败只显示稳定安全摘要，不回显异常路径或凭据", async () => {
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith("/import/preview")) {
        return Promise.resolve({ data: { data: { digest: "round27-safe-commit", rows: [{ sourceText: "镜头一" }] } } });
      }
      if (url.endsWith("/import/commit")) {
        return Promise.reject(new Error("ENOENT C:\\Users\\secret\\commit.csv apiKey=sk-commit"));
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-action="open-import"]').trigger("click");
    const dialog = wrapper.get('[data-dialog="storyboard-import"]');
    await dialog.get("textarea").setValue("镜头一");
    await dialog.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();
    await dialog.get('[data-action="commit-import"]').trigger("click");
    await flushPromises();

    const alert = dialog.get('[role="alert"]');
    expect(alert.text()).toBe("导入提交失败，项目未被修改");
    expect(alert.text()).not.toMatch(/C:\\Users|sk-commit|apiKey|commit\.csv/i);
    wrapper.unmount();
  });

  it("导出失败只显示稳定安全摘要", async () => {
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith("/export")) {
        return Promise.reject(new Error("ENOENT C:\\Users\\secret\\export.csv token=secret-export"));
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-action="open-export"]').trigger("click");
    const dialog = wrapper.get('[data-dialog="storyboard-export"]');
    await dialog.get('[data-action="confirm-export"]').trigger("click");
    await flushPromises();

    const status = dialog.get('[role="status"]');
    expect(status.text()).toBe("导出失败，请重试");
    expect(status.text()).not.toMatch(/C:\\Users|secret-export|token|export\.csv/i);
    wrapper.unmount();
  });

  it("资产页复用塑角造景且不得伪装成分镜绑定入口", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-module="assets"]').trigger("click");
    await flushPromises();
    const panel = wrapper.get('[data-panel="corner-scape-assets"]');
    expect(wrapper.find('[data-panel="asset-manager"]').exists()).toBe(false);
    expect(panel.find('[data-workspace="corner-scape"]').exists()).toBe(true);
    expect(panel.findAll("button").some((button) => button.text().includes("绑定到分镜"))).toBe(false);
    expect(panel.find('[data-action="create-asset"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("详情 auto 预览解析为 text2video 后，正式提交必须使用相同模式", async () => {
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({
          data: {
            code: 0,
            data: {
              ...previewFixture,
              providerModel: String(payload?.providerModel ?? previewFixture.providerModel),
              // 中文注释：auto 由服务端依据持久化镜头与绑定素材解析，前端不得提前猜成 text2video。
              options: {
                ...previewFixture.options,
                aspectRatio: String(payload?.settings?.aspectRatio ?? "9:16"),
                durationMs: Number(payload?.settings?.durationMs ?? 5000),
                mode: "text2video",
              },
            },
          },
        });
      }
      if (url.endsWith("/generate")) return Promise.resolve({ data: { code: 0, data: { status: "queued" } } });
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    const settings = wrapper.get('[data-panel="storyboard-generation-settings"]');
    await settings.get('select[name="mode"]').setValue("auto");
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();

    const previewRequest = callsFor("/storyboard/generate/preview")[0]?.[1] as Record<string, unknown>;
    expect(previewRequest.mode).toBe("auto");
    await wrapper.get('[data-action="submit-current-shot"]').trigger("click");
    await flushPromises();

    const formalRequest = callsFor("/storyboard/generate")[0]?.[1] as Record<string, unknown>;
    expect(formalRequest.mode).toBe("text2video");
    wrapper.unmount();
  });

  it("详情提示词草稿未保存时禁止预览和正式生成，保存成功后才解锁", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const detail = wrapper.get('[data-selected-shot]');
    const videoPrompt = detail.get('textarea[name="videoPrompt"]');
    const previewButton = detail.get('[data-action="preview-shot-video"]');
    const generateButton = detail.get('[data-action="submit-current-shot"]');

    await videoPrompt.setValue("尚未保存的新视频提示词");
    await nextTick();
    expect((previewButton.element as HTMLButtonElement).disabled).toBe(true);
    expect((generateButton.element as HTMLButtonElement).disabled).toBe(true);
    await previewButton.trigger("click");
    await generateButton.trigger("click");
    await flushPromises();
    expect(callsFor("/storyboard/generate/preview")).toHaveLength(0);
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    expect(detail.text()).toContain("请先保存分镜内容");

    await detail.get('[data-action="save-shot"]').trigger("click");
    await flushPromises();
    expect((previewButton.element as HTMLButtonElement).disabled).toBe(false);
    await previewButton.trigger("click");
    await flushPromises();
    expect(callsFor("/storyboard/generate/preview")).toHaveLength(1);
    wrapper.unmount();
  });

  it("选中镜头存在未保存草稿时统一锁住行生成、重新生成和批量生成", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const detail = wrapper.get('[data-selected-shot]');
    await detail.get('textarea[name="videoPrompt"]').setValue("尚未保存、不得绕过的草稿");
    await nextTick();

    const row = wrapper.get(`[data-shot-id="${shotOneUuid}"]`);
    const rowGenerate = row.get('[data-action="generate-video"]');
    const rowRetry = row.get('[data-action="retry-video"]');
    const batch = wrapper.get('[data-action="open-batch-generation"]');
    expect((rowGenerate.element as HTMLButtonElement).disabled).toBe(true);
    expect((rowRetry.element as HTMLButtonElement).disabled).toBe(true);
    expect((batch.element as HTMLButtonElement).disabled).toBe(true);

    await rowGenerate.trigger("click");
    await rowRetry.trigger("click");
    await batch.trigger("click");
    await flushPromises();
    expect(callsFor("/storyboard/generate/preview")).toHaveLength(0);
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    wrapper.unmount();
  });

  it("未保存草稿存在时阻断切换镜头、跨行资产动作和生成，并明确提示先保存", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const detail = wrapper.get('[data-selected-shot]');
    const videoPrompt = detail.get('textarea[name="videoPrompt"]');
    await videoPrompt.setValue("切换镜头也不能丢失的本地草稿");
    await nextTick();

    const secondRow = wrapper.get(`[data-shot-id="${shotTwoUuid}"]`);
    await secondRow.trigger("click");
    await secondRow.get('[data-action="pick-asset"]').trigger("click");
    await secondRow.get('[data-action="generate-video"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-selected-shot]').attributes('data-selected-shot')).toBe(shotOneUuid);
    expect((wrapper.get('[data-selected-shot] textarea[name="videoPrompt"]').element as HTMLTextAreaElement).value)
      .toBe("切换镜头也不能丢失的本地草稿");
    expect(wrapper.find('[data-dialog="asset-picker"]').exists()).toBe(false);
    expect(callsFor("/storyboard/generate/preview")).toHaveLength(0);
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    expect(wrapper.get('[data-feedback="storyboard-action"]').text()).toContain("请先保存分镜内容");
    wrapper.unmount();
  });

  it("未保存草稿时禁用刷新、资产和候选写操作，同镜头远端对象变化不得覆盖本地字段", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const detail = wrapper.get('[data-selected-shot]');
    const videoPrompt = detail.get('textarea[name="videoPrompt"]');
    await videoPrompt.setValue("必须保留的本地草稿");
    await nextTick();

    const refreshButton = wrapper.get('[data-action="refresh-shots"]');
    const assetButton = wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="pick-asset"]`);
    const candidateButton = wrapper.get(`[data-section="candidate-results"] [data-candidate-id="${alternateVideoCandidateUuid}"]`);
    expect((refreshButton.element as HTMLButtonElement).disabled).toBe(true);
    expect((assetButton.element as HTMLButtonElement).disabled).toBe(true);
    expect((candidateButton.element as HTMLButtonElement).disabled).toBe(true);

    const initialShotReads = axiosGet.mock.calls.filter(([url]) => String(url).endsWith('/shots')).length;
    await refreshButton.trigger("click");
    await assetButton.trigger("click");
    await candidateButton.trigger("click");
    await flushPromises();
    expect(axiosGet.mock.calls.filter(([url]) => String(url).endsWith('/shots'))).toHaveLength(initialShotReads);
    expect(callsFor("/bindings")).toHaveLength(0);
    expect(callsFor("/select")).toHaveLength(0);
    expect((videoPrompt.element as HTMLTextAreaElement).value).toBe("必须保留的本地草稿");
    wrapper.unmount();
  });

  it.each(["assets", "settings"])("未保存草稿时阻断切换 %s 模块并保留本地字段", async (moduleName) => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const videoPrompt = wrapper.get('[data-selected-shot] textarea[name="videoPrompt"]');
    await videoPrompt.setValue("切换模块也不能丢失的草稿");
    await nextTick();

    await wrapper.get(`[data-module="${moduleName}"]`).trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-module="shots"]').classes()).toContain("active");
    expect(wrapper.find('[data-selected-shot]').exists()).toBe(true);
    expect((wrapper.get('[data-selected-shot] textarea[name="videoPrompt"]').element as HTMLTextAreaElement).value)
      .toBe("切换模块也不能丢失的草稿");
    expect(wrapper.get('[data-feedback="storyboard-action"]').text()).toContain("请先保存分镜内容");
    wrapper.unmount();
  });

  it("行确认展示后权限降级时确认按钮原生禁用且零生成", async () => {
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({ data: { code: 0, data: { ...previewFixture, providerModel: payload?.providerModel } } });
      }
      if (url.endsWith("/generate")) return Promise.resolve({ data: { code: 0 } });
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
    await flushPromises();

    const store = projectStore();
    store.access = { ...store.access!, mode: "readonly", reason: "permission_changed" };
    await nextTick();
    const confirm = wrapper.get('[data-dialog="storyboard-generation-confirm"] [data-action="confirm-row-generation"]');
    expect((confirm.element as HTMLButtonElement).disabled).toBe(true);
    await confirm.trigger("click");
    await flushPromises();

    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    wrapper.unmount();
  });

  it("行确认展示后切换项目时关闭旧确认并保持零生成", async () => {
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({ data: { code: 0, data: { ...previewFixture, providerModel: payload?.providerModel } } });
      }
      if (url.endsWith("/generate")) return Promise.resolve({ data: { code: 0 } });
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
    await flushPromises();

    const switchedProjectUuid = "27000000-0000-4000-a000-000000000099";
    const store = projectStore();
    store.project = { ...store.project!, projectUuid: switchedProjectUuid } as any;
    store.access = { ...store.access!, projectUuid: switchedProjectUuid };
    await nextTick();
    await flushPromises();

    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    expect(wrapper.find('[data-dialog="storyboard-generation-confirm"]').exists()).toBe(false);
    expect(wrapper.get('[data-selected-shot]').attributes('data-selected-shot')).toBe("");
    wrapper.unmount();
  });

  it("批量预览期间权限降级时整批零生成并保留冻结范围", async () => {
    const releases: Array<(value: unknown) => void> = [];
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith("/generate/preview")) {
        return new Promise((resolve) => { releases.push(resolve); });
      }
      if (url.endsWith("/generate")) return Promise.resolve({ data: { code: 0 } });
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    await wrapper.get('[data-action="open-batch-generation"]').trigger("click");
    await waitForBatchCatalogReady(wrapper);
    const batchDialog = wrapper.get('[data-dialog="storyboard-batch-generation"]');
    await batchDialog.get('input[name="paidConfirmed"]').setValue(true);
    void batchDialog.get('[data-action="submit-batch-generation"]').trigger("click");
    await nextTick();
    expect(releases).toHaveLength(2);

    const store = projectStore();
    store.access = { ...store.access!, mode: "recovery", reason: "key_recovery" };
    await nextTick();
    for (const release of releases) release({ data: { code: 0, data: previewFixture } });
    await flushPromises();

    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    expect(wrapper.text()).toContain("项目权限已变化，已取消生成");
    wrapper.unmount();
  });

  it("保存期间冻结编辑；若快照外仍发生变化，成功响应不得把新草稿误标为已保存", async () => {
    let releaseSave!: (value: unknown) => void;
    axiosPatch.mockImplementation(() => new Promise((resolve) => { releaseSave = resolve; }));
    const wrapper = mountWorkspace();
    await flushPromises();
    const detail = wrapper.get('[data-selected-shot]');
    const videoPrompt = detail.get('textarea[name="videoPrompt"]');
    await videoPrompt.setValue("保存请求中的快照");
    await detail.get('[data-action="save-shot"]').trigger("click");
    await nextTick();

    expect((videoPrompt.element as HTMLTextAreaElement).disabled).toBe(true);
    expect((detail.get('select[name="aspectRatio"]').element as HTMLSelectElement).disabled).toBe(true);
    // 中文注释：模拟浏览器扩展/程序化写入绕过 disabled；响应只能确认发送时的快照，不能确认后来的值。
    (videoPrompt.element as HTMLTextAreaElement).disabled = false;
    (videoPrompt.element as HTMLTextAreaElement).value = "请求发出后的新草稿";
    await videoPrompt.trigger("input");
    releaseSave({ data: { code: 0, data: {} } });
    await flushPromises();

    expect((videoPrompt.element as HTMLTextAreaElement).value).toBe("请求发出后的新草稿");
    expect(detail.text()).toContain("请先保存分镜内容");
    expect((wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).element as HTMLButtonElement).disabled).toBe(true);
    expect(axiosPatch.mock.calls[0]?.[1]).toMatchObject({ videoPrompt: "保存请求中的快照" });
    wrapper.unmount();
  });

  it("单镜头视频生成提交当前详情中的模型、画幅、时长和模式", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const settings = wrapper.get('[data-panel="storyboard-generation-settings"]');
    const generateButton = wrapper.get('[data-action="submit-current-shot"]');

    // 中文注释：未取得与当前参数匹配的非收费服务端预览前，正式生成必须不可提交。
    expect((generateButton.element as HTMLButtonElement).disabled).toBe(true);

    await settings.get('select[name="providerModel"]').setValue("dreamina-cli:seedance2.0fast");
    await settings.get('select[name="aspectRatio"]').setValue("16:9");
    await settings.get('[name="durationSeconds"]').setValue("10");
    await settings.get('select[name="mode"]').setValue("text2video");
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();

    const previewCalls = callsFor("/storyboard/generate/preview");
    expect(previewCalls).toHaveLength(1);
    expect(previewCalls[0][1]).toMatchObject({
      shotUuid: shotOneUuid,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "text2video",
      settings: { aspectRatio: "16:9", durationMs: 10000 },
      shot: { aspectRatio: "16:9", durationMs: 10000 },
    });
    const finalPreview = wrapper.get('[data-panel="request-preview"]');
    expect(finalPreview.text()).toContain("服务端合并后的最终视频提示词");
    expect(finalPreview.text()).not.toMatch(/sk-preview-sensitive|C:\\Users|preview\.json/i);
    expect((generateButton.element as HTMLButtonElement).disabled).toBe(false);

    await generateButton.trigger("click");
    await flushPromises();

    expect(axiosPost).toHaveBeenCalledWith(
      `/tianjiang/runtime/projects/${projectUuid}/storyboard/generate`,
      {
        clientOperationId: expect.stringMatching(uuidPattern),
        shotUuid: shotOneUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        routeKind: "dreamina-cli",
        aspectRatio: "16:9",
        durationMs: 10000,
        resolution: "720p",
        mode: "text2video",
        paidBatchConfirmed: false,
        expectedPreviewDigest: previewDigest,
      },
      { preserveResponse: true },
    );
    wrapper.unmount();
  });

  it("生成参数变化会使旧预览失效，重新预览前保持零正式生成", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const settings = wrapper.get('[data-panel="storyboard-generation-settings"]');
    const generateButton = wrapper.get('[data-action="submit-current-shot"]');

    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();
    expect((generateButton.element as HTMLButtonElement).disabled).toBe(false);
    axiosPost.mockClear();

    await settings.get('[name="durationSeconds"]').setValue("10");
    await nextTick();
    expect((generateButton.element as HTMLButtonElement).disabled).toBe(true);
    await generateButton.trigger("click");
    await flushPromises();

    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    expect(wrapper.get('[data-preview-status]').text()).toContain("参数已变化，请重新预览");
    wrapper.unmount();
  });

  it("服务端预览失败只显示安全摘要，并禁止任何正式生成请求", async () => {
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.reject(new Error("ENOENT C:\\Users\\secret\\preview.json apiKey=sk-sensitive"));
      }
      if (url.endsWith("/generate")) return Promise.resolve({ data: { code: 0 } });
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();

    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();

    const status = wrapper.get('[data-preview-status]');
    expect(status.text()).toBe("生成预览失败，请重试");
    expect(status.text()).not.toMatch(/C:\\|sk-sensitive|apiKey|preview\.json/i);
    const generateButton = wrapper.get('[data-action="submit-current-shot"]');
    expect((generateButton.element as HTMLButtonElement).disabled).toBe(true);
    await generateButton.trigger("click");
    await flushPromises();
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    wrapper.unmount();
  });

  it.each([
    ["缺失", undefined],
    ["格式错误", "NOT-A-VALID-DIGEST"],
  ])("服务端预览摘要%s时 fail-closed，零正式生成", async (_label, invalidDigest) => {
    const fallback = axiosPost.getMockImplementation();
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({
          data: {
            code: 0,
            data: { ...previewFixture, previewDigest: invalidDigest },
          },
        });
      }
      return fallback?.(url, payload);
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-dialog="storyboard-generation-confirm"]').exists()).toBe(false);
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    expect(wrapper.get('[data-feedback="storyboard-action"]').text()).toContain("生成预览失败，请重试");
    wrapper.unmount();
  });

  it("分镜设置页也只展示服务端最终请求预览，未保存提示词不得作废已确认预览", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-module="settings"]').trigger("click");
    await flushPromises();

    const panel = wrapper.get('[data-panel="storyboard-settings"]');
    expect(panel.get('[data-panel="request-preview"]').text()).toContain("等待服务端预览");
    await panel.get('[data-action="preview-storyboard-settings"]').trigger("click");
    await flushPromises();

    expect(callsFor("/storyboard/generate/preview")).toHaveLength(1);
    expect(panel.get('[data-panel="request-preview"]').text()).toContain("服务端合并后的最终视频提示词");
    expect(panel.text()).not.toMatch(/sk-preview-sensitive|C:\\Users|preview\.json/i);

    await panel.get('textarea[name="globalVideoPrompt"]').setValue("新的全局视频风格");
    await nextTick();
    // 中文注释：已确认指纹只跟已保存设置走，未保存 globalVideoPrompt 不得把预览打回等待态。
    expect(panel.get('[data-panel="request-preview"]').text()).toContain("服务端合并后的最终视频提示词");
    await panel.get('[data-action="preview-storyboard-settings"]').trigger("click");
    await flushPromises();
    expect(callsFor("/storyboard/generate/preview")).toHaveLength(1);
    expect(panel.get('[data-preview-status="settings"]').text()).toBe("请先保存设置再预览");
    expect(JSON.stringify(axiosPost.mock.calls)).not.toContain("新的全局视频风格");
    wrapper.unmount();
  });

  it("批量非收费预览在确认前完成，确认按钮只发送一次耐久受理请求", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();

    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    await wrapper.get('[data-action="open-batch-generation"]').trigger("click");
    await waitForBatchCatalogReady(wrapper);
    await vi.waitFor(() => {
      expect(callsFor("/storyboard/generate/preview")).toHaveLength(2);
    });
    const batchDialog = wrapper.get('[data-dialog="storyboard-batch-generation"]');
    await batchDialog.get('[data-action="submit-batch-generation"]').trigger("click");
    await flushPromises();
    expect(callsFor("/storyboard/generate")).toHaveLength(0);

    await batchDialog.get('input[name="paidConfirmed"]').setValue(true);
    await batchDialog.get('[data-action="submit-batch-generation"]').trigger("click");
    await flushPromises();

    const generationCalls = callsFor("/storyboard/generate");
    expect(generationCalls).toHaveLength(1);
    const batchRequest = generationCalls[0][1] as { paidBatchConfirmed?: boolean; items?: unknown[] };
    const previewCalls = callsFor("/storyboard/generate/preview");
    expect(previewCalls).toHaveLength(2);
    expect(previewCalls.map(([, payload]) => payload)).toEqual([
      expect.objectContaining({
        shotUuid: shotOneUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "auto",
        settings: expect.objectContaining({ aspectRatio: "9:16", durationMs: 5000 }),
      }),
      expect.objectContaining({
        shotUuid: shotTwoUuid,
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "auto",
        settings: expect.objectContaining({ aspectRatio: "9:16", durationMs: 5000 }),
      }),
    ]);
    expect(batchRequest.paidBatchConfirmed).toBe(true);
    // 中文注释：付费批次必须精确限定当前两条镜头，禁止夹带、重复或扩大收费范围。
    expect(batchRequest.items).toEqual([
        expect.objectContaining({
          shotUuid: shotOneUuid,
          mediaType: "video",
          providerModel: "dreamina-cli:seedance2.0fast",
          mode: "text2video",
          expectedPreviewDigest: previewDigest,
        }),
        expect.objectContaining({
          shotUuid: shotTwoUuid,
          mediaType: "video",
          providerModel: "dreamina-cli:seedance2.0fast",
          mode: "text2video",
          expectedPreviewDigest: previewDigest,
        }),
    ]);
    wrapper.unmount();
  });

  it("批量任一服务端预览失败时整批零生成，且不扩大冻结镜头范围", async () => {
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        if (payload?.shotUuid === shotTwoUuid) {
          return Promise.reject(new Error("ENOENT C:\\Users\\secret\\batch-preview.json apiKey=sk-sensitive"));
        }
        return Promise.resolve({
          data: {
            data: {
              ...previewFixture,
              providerModel: String(payload?.providerModel ?? previewFixture.providerModel),
              options: {
                ...previewFixture.options,
                aspectRatio: String(payload?.settings?.aspectRatio ?? "9:16"),
                durationMs: Number(payload?.settings?.durationMs ?? 5000),
                mode: String(payload?.mode ?? "text2video"),
              },
            },
          },
        });
      }
      if (url.endsWith("/generate")) return Promise.resolve({ data: { code: 0 } });
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();

    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    await wrapper.get('[data-action="open-batch-generation"]').trigger("click");
    await waitForBatchCatalogReady(wrapper);
    const batchDialog = wrapper.get('[data-dialog="storyboard-batch-generation"]');
    await batchDialog.get('input[name="paidConfirmed"]').setValue(true);
    await batchDialog.get('[data-action="submit-batch-generation"]').trigger("click");
    await flushPromises();

    expect(callsFor("/storyboard/generate/preview")).toHaveLength(2);
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    expect(wrapper.text()).not.toMatch(/C:\\Users|sk-sensitive|apiKey|batch-preview\.json/i);
    wrapper.unmount();
  });

  it("批量预览必须读取 Axios 响应中的安全错误并提示缺失参考素材", async () => {
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        if (payload?.shotUuid === shotOneUuid) {
          return Promise.reject({
            response: {
              status: 400,
              data: {
                code: "STORYBOARD_REFERENCE_MISSING",
                message: "分镜参考素材记录缺失",
              },
            },
          });
        }
        return Promise.resolve({ data: { code: 0, data: previewFixture } });
      }
      if (url.endsWith("/generate")) return Promise.resolve({ data: { code: 0 } });
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();

    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    await wrapper.get('[data-action="open-batch-generation"]').trigger("click");
    await waitForBatchCatalogReady(wrapper);
    const batchDialog = wrapper.get('[data-dialog="storyboard-batch-generation"]');
    await batchDialog.get('input[name="paidConfirmed"]').setValue(true);
    await batchDialog.get('[data-action="submit-batch-generation"]').trigger("click");
    await flushPromises();

    await vi.waitFor(() => expect(batchDialog.text()).toContain("分镜参考素材记录缺失"));
    const feedback = batchDialog.text();
    expect(feedback).toContain("分镜参考素材记录缺失");
    expect(feedback).not.toContain("批量生成预览失败，请重试");
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    wrapper.unmount();
  });

  it("批量任一服务端预览与当前指纹不匹配时整批零生成", async () => {
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({
          data: {
            data: {
              ...previewFixture,
              providerModel: payload?.shotUuid === shotTwoUuid
                ? "dreamina-cli:seedance2.0mini"
                : String(payload?.providerModel ?? previewFixture.providerModel),
              options: {
                ...previewFixture.options,
                aspectRatio: String(payload?.settings?.aspectRatio ?? "9:16"),
                durationMs: Number(payload?.settings?.durationMs ?? 5000),
                mode: String(payload?.mode ?? "text2video"),
              },
            },
          },
        });
      }
      if (url.endsWith("/generate")) return Promise.resolve({ data: { code: 0 } });
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();

    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    await wrapper.get('[data-action="open-batch-generation"]').trigger("click");
    await waitForBatchCatalogReady(wrapper);
    const batchDialog = wrapper.get('[data-dialog="storyboard-batch-generation"]');
    await batchDialog.get('input[name="paidConfirmed"]').setValue(true);
    await batchDialog.get('[data-action="submit-batch-generation"]').trigger("click");
    await flushPromises();

    expect(callsFor("/storyboard/generate/preview")).toHaveLength(2);
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    wrapper.unmount();
  });

  it("批量任一服务端预览缺失摘要时整批零生成", async () => {
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({
          data: {
            code: 0,
            data: {
              ...previewFixture,
              previewDigest: payload?.shotUuid === shotTwoUuid ? undefined : previewDigest,
              providerModel: String(payload?.providerModel ?? previewFixture.providerModel),
              options: {
                ...previewFixture.options,
                aspectRatio: String(payload?.settings?.aspectRatio ?? "9:16"),
                durationMs: Number(payload?.settings?.durationMs ?? 5000),
                mode: "text2video",
              },
            },
          },
        });
      }
      if (url.endsWith("/generate")) return Promise.resolve({ data: { code: 0 } });
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    await wrapper.get('[data-action="open-batch-generation"]').trigger("click");
    await waitForBatchCatalogReady(wrapper);
    const batchDialog = wrapper.get('[data-dialog="storyboard-batch-generation"]');
    await batchDialog.get('input[name="paidConfirmed"]').setValue(true);
    await batchDialog.get('[data-action="submit-batch-generation"]').trigger("click");
    await flushPromises();

    expect(callsFor("/storyboard/generate/preview")).toHaveLength(2);
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    wrapper.unmount();
  });

  it("详情服务端预览等待期间权限降级时丢弃旧预览并保持零生成", async () => {
    let releasePreview!: (value: unknown) => void;
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith("/generate/preview")) {
        return new Promise((resolve) => { releasePreview = resolve; });
      }
      if (url.endsWith("/generate")) return Promise.resolve({ data: { code: 0 } });
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();

    void wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await nextTick();
    const store = projectStore();
    store.access = { ...store.access!, mode: "readonly", reason: "permission_changed" };
    await nextTick();
    releasePreview({ data: { code: 0, data: previewFixture } });
    await flushPromises();

    const finalPreview = wrapper.get('[data-panel="request-preview"]');
    expect(finalPreview.text()).toContain("等待服务端预览");
    expect(finalPreview.text()).not.toContain(previewFixture.prompt);
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    expect(wrapper.text()).toContain("项目权限已变化，已取消预览");
    wrapper.unmount();
  });

  it("未保存草稿时 beforeunload 使用浏览器原生离开保护，卸载后移除监听", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-selected-shot] textarea[name="videoPrompt"]').setValue("刷新前必须保护的草稿");
    await nextTick();

    const guarded = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(guarded);
    expect(guarded.defaultPrevented).toBe(true);

    wrapper.unmount();
    const afterUnmount = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterUnmount);
    expect(afterUnmount.defaultPrevented).toBe(false);
  });

  it("未保存草稿时真实路由离开被阻断，保存后允许离开", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = projectStore();
    store.project = {
      projectUuid,
      assetSourceProjectUuid: sourceProjectUuid,
      name: "雨夜剧场",
      projectType: "storyboard",
      myRole: "owner",
      openMode: "readwrite",
      imageModel: "",
      videoModel: "dreamina-cli:seedance2.0fast",
    } as any;
    store.access = { projectUuid, mode: "readwrite", reason: "test_open", lockHolder: "" };
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/storyboard", component: StoryboardWorkspace },
        { path: "/other", component: { template: '<div data-page="other">其他页面</div>' } },
      ],
    });
    await router.push("/storyboard");
    await router.isReady();
    const wrapper = mount(RouterView, {
      global: {
        plugins: [pinia, router, createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
        stubs: {
          TButton: { inheritAttrs: true, props: ["loading", "disabled"], template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>' },
          TIcon: { template: "<i />" },
          TTag: { template: "<span><slot /></span>" },
          TDialog: { inheritAttrs: false, props: ["visible", "header"], emits: ["close"], template: '<section v-if="visible" role="dialog"><h2>{{ header }}</h2><slot/><slot name="footer"/></section>' },
          TDrawer: { inheritAttrs: true, props: ["visible", "modelValue", "header"], emits: ["update:visible", "update:modelValue", "close"], template: '<aside v-if="visible || modelValue" v-bind="$attrs" role="dialog"><h2>{{ header }}</h2><slot/><slot name="footer"/></aside>' },
        },
      },
    });
    await flushPromises();
    await wrapper.get('[data-selected-shot] textarea[name="videoPrompt"]').setValue("路由离开前必须保存的草稿");
    await nextTick();

    await router.push("/other");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/storyboard");
    expect(wrapper.find('[data-page="other"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("请先保存分镜内容");

    await wrapper.get('[data-action="save-shot"]').trigger("click");
    await flushPromises();
    await router.push("/other");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/other");
    wrapper.unmount();
  });

  it("预览摘要必须逐字节为64位小写hex，前后空白不得被宽松接受", async () => {
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({
          data: {
            code: 0,
            data: {
              ...previewFixture,
              previewDigest: ` ${previewDigest} `,
              providerModel: String(payload?.providerModel ?? previewFixture.providerModel),
            },
          },
        });
      }
      if (url.endsWith("/generate")) return Promise.resolve({ data: { code: 0 } });
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();

    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();

    const finalPreview = wrapper.get('[data-panel="request-preview"]');
    expect(finalPreview.text()).toContain("等待服务端预览");
    expect(finalPreview.text()).not.toContain(previewFixture.prompt);
    expect(wrapper.get('[data-preview-status]').text()).toBe("生成预览失败，请重试");
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    wrapper.unmount();
  });

  it("详情有未保存草稿时资产与候选写按钮必须原生禁用", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const detail = wrapper.get('[data-selected-shot]');
    await detail.get('textarea[name="videoPrompt"]').setValue("尚未保存的交互草稿");
    await nextTick();

    for (const button of wrapper.findAll('[data-action="pick-asset"]')) {
      expect((button.element as HTMLButtonElement).disabled).toBe(true);
    }
    for (const button of detail.findAll('[data-candidate-id]')) {
      expect((button.element as HTMLButtonElement).disabled).toBe(true);
    }
    wrapper.unmount();
  });

  it("详情同一次明确生成意图在网络失败后复用UUID幂等键", async () => {
    let generationAttempt = 0;
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({ data: { code: 0, data: previewFixture } });
      }
      if (url.endsWith("/generate")) {
        generationAttempt += 1;
        if (generationAttempt === 1) return Promise.reject(new Error("response_lost"));
        return Promise.resolve(acceptedGenerationResponse(payload));
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();

    await wrapper.get('[data-action="submit-current-shot"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="submit-current-shot"]').trigger("click");
    await flushPromises();

    const requests = callsFor("/storyboard/generate").map((call) => call[1] as Record<string, unknown>);
    expect(requests).toHaveLength(2);
    expect(requests[0].clientOperationId).toEqual(expect.stringMatching(uuidPattern));
    expect(requests[1].clientOperationId).toBe(requests[0].clientOperationId);
    wrapper.unmount();
  });

  it("关闭后重新打开行确认必须生成新UUID，不能把previewDigest当幂等键", async () => {
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) return Promise.resolve({ data: { code: 0, data: previewFixture } });
      if (url.endsWith("/generate")) {
        return Promise.resolve(acceptedGenerationResponse(payload));
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();

    for (let index = 0; index < 2; index += 1) {
      await wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
      await flushPromises();
      await wrapper.get('[data-dialog="storyboard-generation-confirm"] [data-action="confirm-row-generation"]').trigger("click");
      await flushPromises();
    }
    const requests = callsFor("/storyboard/generate").map((call) => call[1] as Record<string, unknown>);
    expect(requests).toHaveLength(2);
    expect(requests[0].clientOperationId).toEqual(expect.stringMatching(uuidPattern));
    expect(requests[1].clientOperationId).toEqual(expect.stringMatching(uuidPattern));
    expect(requests[1].clientOperationId).not.toBe(requests[0].clientOperationId);
    wrapper.unmount();
  });

  it("批量请求冻结顶层UUID且服务端回显不一致时失败关闭、不刷新成功状态", async () => {
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) return Promise.resolve({ data: { code: 0, data: previewFixture } });
      if (url.endsWith("/generate")) {
        return Promise.resolve(acceptedGenerationResponse(payload, "00000000-0000-4000-8000-000000000000"));
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    const readsBefore = axiosGet.mock.calls.filter(([url]) => String(url).endsWith("/shots")).length;
    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    await wrapper.get('[data-action="open-batch-generation"]').trigger("click");
    await waitForBatchCatalogReady(wrapper);
    const dialog = wrapper.get('[data-dialog="storyboard-batch-generation"]');
    await dialog.get('input[name="paidConfirmed"]').setValue(true);
    await dialog.get('[data-action="submit-batch-generation"]').trigger("click");
    await flushPromises();

    const request = callsFor("/storyboard/generate")[0]?.[1] as Record<string, unknown>;
    expect(request.clientOperationId).toEqual(expect.stringMatching(uuidPattern));
    expect(axiosGet.mock.calls.filter(([url]) => String(url).endsWith("/shots"))).toHaveLength(readsBefore);
    expect(wrapper.text()).toContain("提交批量生成失败，请重试");
    wrapper.unmount();
  });

  it("批量失败重试仅在规范化载荷完全相同时复用ID，设置变化必须换新ID", async () => {
    let generationAttempt = 0;
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({
          data: {
            code: 0,
            data: {
              ...previewFixture,
              options: {
                ...previewFixture.options,
                durationMs: Number(payload?.settings?.durationMs ?? 5000),
                aspectRatio: String(payload?.settings?.aspectRatio ?? "9:16"),
              },
            },
          },
        });
      }
      if (url.endsWith("/generate")) {
        generationAttempt += 1;
        if (generationAttempt === 1) return Promise.reject(new Error("response_lost"));
        return Promise.resolve(acceptedGenerationResponse(payload));
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    await wrapper.get('[data-action="open-batch-generation"]').trigger("click");
    await waitForBatchCatalogReady(wrapper);
    const dialog = wrapper.get('[data-dialog="storyboard-batch-generation"]');
    await dialog.get('input[name="paidConfirmed"]').setValue(true);
    await dialog.get('[data-action="submit-batch-generation"]').trigger("click");
    await flushPromises();
    await dialog.get('[name="durationSeconds"]').setValue("10");
    await waitForBatchPreviewReady(wrapper);
    await dialog.get('[data-action="submit-batch-generation"]').trigger("click");
    await flushPromises();
    // 中文注释：旧请求结果不确定时，载荷变化的这次点击只能失效旧确认，不能直接再发一批收费请求。
    expect(callsFor("/storyboard/generate")).toHaveLength(1);
    expect(wrapper.text()).toContain("批量生成内容已变化，请重新确认");
    await dialog.get('[data-action="submit-batch-generation"]').trigger("click");
    await flushPromises();

    const requests = callsFor("/storyboard/generate").map((call) => call[1] as Record<string, any>);
    expect(requests).toHaveLength(2);
    expect(requests[0].clientOperationId).toEqual(expect.stringMatching(uuidPattern));
    expect(requests[1].clientOperationId).toEqual(expect.stringMatching(uuidPattern));
    expect(requests[1].clientOperationId).not.toBe(requests[0].clientOperationId);
    expect(requests[0].items[0].durationMs).toBe(5000);
    expect(requests[1].items[0].durationMs).toBe(10000);
    wrapper.unmount();
  });

  it("批量响应丢失后同一确认直接重放原 ID，不重复请求预览", async () => {
    let generationAttempt = 0;
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({
          data: {
            code: 0,
            data: {
              ...previewFixture,
              previewDigest,
            },
          },
        });
      }
      if (url.endsWith("/generate")) {
        generationAttempt += 1;
        if (generationAttempt === 1) return Promise.reject(new Error("response_lost"));
        return Promise.resolve(acceptedGenerationResponse(payload));
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    await wrapper.get('[data-action="open-batch-generation"]').trigger("click");
    await waitForBatchCatalogReady(wrapper);
    const dialog = wrapper.get('[data-dialog="storyboard-batch-generation"]');
    await dialog.get('input[name="paidConfirmed"]').setValue(true);
    await dialog.get('[data-action="submit-batch-generation"]').trigger("click");
    await flushPromises();
    const firstRequest = callsFor("/storyboard/generate")[0]?.[1] as Record<string, unknown>;

    await dialog.get('[data-action="submit-batch-generation"]').trigger("click");
    await flushPromises();
    const requests = callsFor("/storyboard/generate").map((call) => call[1] as Record<string, unknown>);
    expect(requests).toHaveLength(2);
    expect(callsFor("/storyboard/generate/preview")).toHaveLength(2);
    expect(requests[1].clientOperationId).toBe(firstRequest.clientOperationId);
    wrapper.unmount();
  });

  it("行正式提交被服务端拒绝后重试沿用原 ID，不创建第二收费意图", async () => {
    const firstId = "11111111-1111-4111-8111-111111111111";
    const uuidSpy = vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue(firstId);
    let generateCount = 0;
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({ data: { code: 0, data: previewFixture } });
      }
      if (url.endsWith("/generate")) {
        generateCount += 1;
        if (generateCount === 1) {
          return Promise.reject({ response: { data: { code: "STORYBOARD_PREVIEW_STALE" } } });
        }
        return Promise.resolve(acceptedGenerationResponse(payload));
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    try {
      const wrapper = mountWorkspace();
      await flushPromises();
      await wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
      await flushPromises();
      const confirm = wrapper.get('[data-dialog="storyboard-generation-confirm"] [data-action="confirm-row-generation"]');
      await confirm.trigger("click");
      await flushPromises();
      expect(callsFor("/storyboard/generate")).toHaveLength(1);
      expect(wrapper.text()).toContain("最终请求已变化，请重新预览确认");
      await confirm.trigger("click");
      await flushPromises();

      const requests = callsFor("/storyboard/generate").map((call) => call[1] as Record<string, unknown>);
      expect(requests).toHaveLength(2);
      expect(requests[0].clientOperationId).toBe(firstId);
      expect(requests[1].clientOperationId).toBe(firstId);
      wrapper.unmount();
    } finally {
      uuidSpy.mockRestore();
    }
  });

  it("详情参数变化使旧意图失效，重新预览后使用新ID", async () => {
    const firstId = "33333333-3333-4333-8333-333333333333";
    const secondId = "44444444-4444-4444-8444-444444444444";
    const uuidSpy = vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce(firstId)
      .mockReturnValueOnce(secondId);
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({
          data: {
            code: 0,
            data: {
              ...previewFixture,
              options: {
                ...previewFixture.options,
                durationMs: Number(payload?.settings?.durationMs ?? 5000),
              },
            },
          },
        });
      }
      if (url.endsWith("/generate")) {
        return Promise.resolve(acceptedGenerationResponse(payload));
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    try {
      const wrapper = mountWorkspace();
      await flushPromises();
      await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
      await flushPromises();
      await wrapper.get('[data-panel="storyboard-generation-settings"] [name="durationSeconds"]').setValue("10");
      await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
      await flushPromises();
      await wrapper.get('[data-action="submit-current-shot"]').trigger("click");
      await flushPromises();

      const request = callsFor("/storyboard/generate")[0]?.[1] as Record<string, unknown>;
      expect(request.clientOperationId).toBe(secondId);
      wrapper.unmount();
    } finally {
      uuidSpy.mockRestore();
    }
  });

  it("详情响应丢失后同参数同摘要重新预览仍复用原ID", async () => {
    let generationAttempt = 0;
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) return Promise.resolve({ data: { code: 0, data: previewFixture } });
      if (url.endsWith("/generate")) {
        generationAttempt += 1;
        if (generationAttempt === 1) return Promise.reject(new Error("response_lost"));
        return Promise.resolve(acceptedGenerationResponse(payload));
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="submit-current-shot"]').trigger("click");
    await flushPromises();
    const firstRequest = callsFor("/storyboard/generate")[0]?.[1] as Record<string, unknown>;

    // 中文注释：用户按页面提示重新预览，但规范化输入与服务端摘要均未变化，仍属于同一不确定意图。
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="submit-current-shot"]').trigger("click");
    await flushPromises();

    const requests = callsFor("/storyboard/generate").map((call) => call[1] as Record<string, unknown>);
    expect(requests).toHaveLength(2);
    expect(requests[0].clientOperationId).toEqual(expect.stringMatching(uuidPattern));
    expect(requests[1].clientOperationId).toBe(firstRequest.clientOperationId);
    wrapper.unmount();
  });

  it("批量预览等待期间关闭再重开同范围，旧响应不得穿越打开epoch提交", async () => {
    const releases: Array<(value: unknown) => void> = [];
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return new Promise((resolve) => { releases.push(resolve); });
      }
      if (url.endsWith("/generate")) {
        return Promise.resolve(acceptedGenerationResponse(payload));
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    await wrapper.get('[data-action="open-batch-generation"]').trigger("click");
    await waitForBatchCatalogReady(wrapper);
    const firstDialog = wrapper.get('[data-dialog="storyboard-batch-generation"]');
    await firstDialog.get('input[name="paidConfirmed"]').setValue(true);
    void firstDialog.get('[data-action="submit-batch-generation"]').trigger("click");
    await nextTick();
    expect(releases).toHaveLength(2);

    wrapper.getComponent(StoryboardBatchGenerationDialog).vm.$emit("close");
    await nextTick();
    await wrapper.get('[data-action="open-batch-generation"]').trigger("click");
    await nextTick();
    expect(wrapper.find('[data-dialog="storyboard-batch-generation"]').exists()).toBe(true);

    for (const release of releases) release({ data: { code: 0, data: previewFixture } });
    await flushPromises();
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    wrapper.unmount();
  });

  it("切项目必须清空旧详情和全部项目级瞬态，且旧预览零生成", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-action="open-import"]').trigger("click");
    await wrapper.get('[data-action="open-export"]').trigger("click");
    await wrapper.get('[data-action="pick-asset"][data-asset-type="role"]').trigger("click");
    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    await wrapper.get('[data-action="open-batch-generation"]').trigger("click");
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
    await flushPromises();

    await wrapper.get('.storyboardSearch input').setValue("雨夜");
    await wrapper.get('textarea[name="videoPrompt"]').setValue("A 项目未保存草稿");
    await nextTick();

    expect(wrapper.find('[data-dialog="storyboard-import"]').exists()).toBe(true);
    expect(wrapper.find('[data-dialog="storyboard-export"]').exists()).toBe(true);
    expect(wrapper.find('[data-drawer="storyboard-asset-picker"]').exists()).toBe(true);
    expect(wrapper.find('[data-dialog="storyboard-batch-generation"]').exists()).toBe(true);
    expect(wrapper.find('[data-dialog="storyboard-generation-confirm"]').exists()).toBe(true);

    const store = projectStore();
    store.project = {
      ...store.project!,
      projectUuid: "27000000-0000-4000-a000-000000000099",
    } as any;
    store.access = { ...store.access!, projectUuid: "27000000-0000-4000-a000-000000000099" };
    await nextTick();

    // 中文注释：项目切换后不得继续展示 A 项目的镜头或任何携带 A 身份的确认对象。
    expect(wrapper.get('[data-selected-shot]').attributes('data-selected-shot')).toBe("");
    expect(wrapper.find('[data-action="submit-current-shot"]').exists()).toBe(false);
    expect(wrapper.find('[data-dialog="storyboard-import"]').exists()).toBe(false);
    expect(wrapper.find('[data-dialog="storyboard-export"]').exists()).toBe(false);
    expect(wrapper.find('[data-drawer="storyboard-asset-picker"]').exists()).toBe(false);
    expect(wrapper.find('[data-dialog="storyboard-batch-generation"]').exists()).toBe(false);
    expect(wrapper.find('[data-dialog="storyboard-generation-confirm"]').exists()).toBe(false);
    expect((wrapper.get('.storyboardSearch input').element as HTMLInputElement).value).toBe("");
    expect(wrapper.get('[data-action="refresh-shots"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-action="insert-first"]').attributes("disabled")).toBeUndefined();
    await flushPromises();
    expect(callsFor("/storyboard/generate")).toHaveLength(0);
    wrapper.unmount();
  });

  it("A 行预览挂起切 B 后必须立即可操作，B 先完成后 A 晚响应不得污染 B", async () => {
    const releases: Array<(value: unknown) => void> = [];
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith("/generate/preview")) {
        return new Promise((resolve) => { releases.push(resolve); });
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    const previewA = {
      ...previewFixture,
      previewDigest: "1111111111111111111111111111111111111111111111111111111111111111",
      prompt: "A 项目旧预览提示词",
    };
    const previewB = {
      ...previewFixture,
      previewDigest: "2222222222222222222222222222222222222222222222222222222222222222",
      prompt: "B 项目当前预览提示词",
    };

    void wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
    await nextTick();
    expect(releases).toHaveLength(1);

    const store = projectStore();
    const projectB = "27000000-0000-4000-a000-000000000099";
    store.project = { ...store.project!, projectUuid: projectB } as any;
    store.access = { ...store.access!, projectUuid: projectB };
    await nextTick();
    await wrapper.get('[data-action="refresh-shots"]').trigger("click");
    await flushPromises();

    const bGenerate = wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`);
    expect(bGenerate.attributes("disabled")).toBeUndefined();
    void bGenerate.trigger("click");
    await nextTick();
    expect(releases).toHaveLength(2);

    releases[1]({ data: { code: 0, data: previewB } });
    await flushPromises();
    expect(wrapper.find('[data-dialog="storyboard-generation-confirm"]').exists()).toBe(true);
    expect(wrapper.get('[data-dialog="storyboard-generation-confirm"]').text()).toContain("B 项目当前预览提示词");

    releases[0]({ data: { code: 0, data: previewA } });
    await flushPromises();
    const confirmation = wrapper.get('[data-dialog="storyboard-generation-confirm"]');
    expect(confirmation.text()).toContain("B 项目当前预览提示词");
    expect(confirmation.text()).not.toContain("A 项目旧预览提示词");
    expect(wrapper.text()).not.toContain("分镜内容已变化");
    expect(wrapper.text()).not.toContain("生成预览失败");
    wrapper.unmount();
  });

  it("A 旧 finally 不得释放 B 的新 busy，B 完成前禁止第三次预览", async () => {
    const releases: Array<(value: unknown) => void> = [];
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith("/generate/preview")) {
        return new Promise((resolve) => { releases.push(resolve); });
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    void wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
    await nextTick();

    const store = projectStore();
    const projectB = "27000000-0000-4000-a000-000000000099";
    store.project = { ...store.project!, projectUuid: projectB } as any;
    store.access = { ...store.access!, projectUuid: projectB };
    await nextTick();
    await wrapper.get('[data-action="refresh-shots"]').trigger("click");
    await flushPromises();
    void wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
    await nextTick();
    expect(releases).toHaveLength(2);

    releases[0]({ data: { code: 0, data: previewFixture } });
    await flushPromises();
    const bGenerateWhilePending = wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`);
    expect(bGenerateWhilePending.attributes("disabled")).toBeDefined();
    await bGenerateWhilePending.trigger("click");
    expect(releases).toHaveLength(2);

    releases[1]({ data: { code: 0, data: previewFixture } });
    await flushPromises();
    expect(wrapper.find('[data-dialog="storyboard-generation-confirm"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("A 到 B 再回 A 时旧 epoch 行预览不得复活确认", async () => {
    let releasePreview!: (value: unknown) => void;
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith("/generate/preview")) {
        return new Promise((resolve) => { releasePreview = resolve; });
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    void wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
    await nextTick();

    const store = projectStore();
    const originalProject = { ...store.project! };
    const projectB = "27000000-0000-4000-a000-000000000099";
    store.project = { ...store.project!, projectUuid: projectB } as any;
    store.access = { ...store.access!, projectUuid: projectB };
    await nextTick();
    store.project = originalProject as any;
    store.access = { ...store.access!, projectUuid };
    await nextTick();
    await wrapper.get('[data-action="refresh-shots"]').trigger("click");
    await flushPromises();

    releasePreview({ data: { code: 0, data: previewFixture } });
    await flushPromises();
    expect(wrapper.find('[data-dialog="storyboard-generation-confirm"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("预览已就绪");
    expect(wrapper.text()).not.toContain("分镜内容已变化");
    wrapper.unmount();
  });

  it("A 导入提交完成不得关闭 B 新弹窗或刷新 B", async () => {
    let releaseCommit!: (value: unknown) => void;
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith("/import/preview")) {
        return Promise.resolve({ data: { data: { digest: "round27-switch-import", rows: [{ sourceText: "镜头一" }] } } });
      }
      if (url.endsWith("/import/commit")) {
        return new Promise((resolve) => { releaseCommit = resolve; });
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-action="open-import"]').trigger("click");
    const importA = wrapper.get('[data-dialog="storyboard-import"]');
    await importA.get("textarea").setValue("镜头一");
    await importA.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();
    void importA.get('[data-action="commit-import"]').trigger("click");
    await nextTick();

    const store = projectStore();
    const projectB = "27000000-0000-4000-a000-000000000099";
    store.project = { ...store.project!, projectUuid: projectB } as any;
    store.access = { ...store.access!, projectUuid: projectB };
    await nextTick();
    await wrapper.get('[data-action="refresh-shots"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="open-import"]').trigger("click");
    const readsBeforeACompletes = axiosGet.mock.calls.filter(([url]) => String(url).endsWith("/shots")).length;

    releaseCommit({ data: { code: 0, data: {} } });
    await flushPromises();
    expect(wrapper.find('[data-dialog="storyboard-import"]').exists()).toBe(true);
    expect(axiosGet.mock.calls.filter(([url]) => String(url).endsWith("/shots"))).toHaveLength(readsBeforeACompletes);
    wrapper.unmount();
  });

  it("A 保存完成不得以 B 当前镜头身份触发刷新", async () => {
    let releaseSave!: (value: unknown) => void;
    axiosPatch.mockImplementation(() => new Promise((resolve) => { releaseSave = resolve; }));
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('textarea[name="videoPrompt"]').setValue("A 项目保存中的草稿");
    void wrapper.get('[data-action="save-shot"]').trigger("click");
    await nextTick();

    const store = projectStore();
    const projectB = "27000000-0000-4000-a000-000000000099";
    store.project = { ...store.project!, projectUuid: projectB } as any;
    store.access = { ...store.access!, projectUuid: projectB };
    await nextTick();
    await wrapper.get('[data-action="refresh-shots"]').trigger("click");
    await flushPromises();
    const readsBeforeACompletes = axiosGet.mock.calls.filter(([url]) => String(url).endsWith("/shots")).length;

    releaseSave({ data: { code: 0, data: {} } });
    await flushPromises();
    expect(axiosGet.mock.calls.filter(([url]) => String(url).endsWith("/shots"))).toHaveLength(readsBeforeACompletes);
    wrapper.unmount();
  });

  it("A 导出晚响应不得在 B 项目上下文触发下载", async () => {
    let releaseExport!: (value: unknown) => void;
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith("/export")) return new Promise((resolve) => { releaseExport = resolve; });
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const createUrlMock = vi.fn(() => "blob:round27-export");
    const revokeUrlMock = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrlMock });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeUrlMock });
    try {
      const wrapper = mountWorkspace();
      await flushPromises();
      await wrapper.get('[data-action="open-export"]').trigger("click");
      void wrapper.get('[data-dialog="storyboard-export"] [data-action="confirm-export"]').trigger("click");
      await nextTick();

      const store = projectStore();
      const projectB = "27000000-0000-4000-a000-000000000099";
      store.project = { ...store.project!, projectUuid: projectB } as any;
      store.access = { ...store.access!, projectUuid: projectB };
      await nextTick();
      await wrapper.get('[data-action="open-export"]').trigger("click");

      releaseExport("shotNumber,sourceText\n01,A 项目内容");
      await flushPromises();
      expect(clickSpy).not.toHaveBeenCalled();
      expect(wrapper.find('[data-dialog="storyboard-export"]').exists()).toBe(true);
      wrapper.unmount();
    } finally {
      clickSpy.mockRestore();
      delete (URL as unknown as Record<string, unknown>).createObjectURL;
      delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    }
  });

  it("行正式提交失败后不得创建新 UUID，重试沿用原幂等 ID", async () => {
    const firstId = "55555555-5555-4555-8555-555555555555";
    const uuidSpy = vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce(firstId)
      .mockImplementation(() => { throw new Error("不应创建第二个 UUID"); });
    let generateCount = 0;
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/generate/preview")) {
        return Promise.resolve({ data: { code: 0, data: previewFixture } });
      }
      if (url.endsWith("/generate")) {
        generateCount += 1;
        if (generateCount === 1) return Promise.reject(new Error("response_lost"));
        return Promise.resolve(acceptedGenerationResponse(payload));
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    try {
      const wrapper = mountWorkspace();
      await flushPromises();
      await wrapper.get(`[data-shot-id="${shotOneUuid}"] [data-action="generate-video"]`).trigger("click");
      await flushPromises();
      const confirm = wrapper.get('[data-dialog="storyboard-generation-confirm"] [data-action="confirm-row-generation"]');
      await confirm.trigger("click");
      await flushPromises();
      await confirm.trigger("click");
      await flushPromises();
      const requests = callsFor("/storyboard/generate").map((call) => call[1] as Record<string, unknown>);
      expect(requests).toHaveLength(2);
      expect(requests[0].clientOperationId).toBe(firstId);
      expect(requests[1].clientOperationId).toBe(firstId);
      wrapper.unmount();
    } finally {
      uuidSpy.mockRestore();
    }
  });
});
