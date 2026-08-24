// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const axiosPatch = vi.fn();
const axiosPut = vi.fn();
const axiosDelete = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    patch: (...args: unknown[]) => axiosPatch(...args),
    put: (...args: unknown[]) => axiosPut(...args),
    delete: (...args: unknown[]) => axiosDelete(...args),
  },
}));

import projectStore from "@/stores/project";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";
import StoryboardSettings from "@/views/storyboardProject/components/StoryboardSettings.vue";
import AssetManager from "@/views/storyboardProject/components/AssetManager.vue";
import { buildStoryboardSettingsUrl } from "@/views/storyboardProject/components/storyboardSettingsUrl";

const projectUuid = "11111111-1111-4111-a111-111111111111";
const shots = [
  {
    shotUuid: "11111111-1111-4111-a111-111111111101",
    displayOrder: 1,
    sourceText: "雨夜，林夏推开旧剧院的门。",
    visualDescription: "霓虹倒映在积水中，人物背影进入画面。",
    imagePrompt: "电影感雨夜，紫蓝霓虹",
    videoPrompt: "镜头缓慢跟随人物向前移动",
    negativePrompt: "模糊，低清",
    shotSize: "全景",
    cameraMovement: "跟拍",
    composition: "中心构图",
    durationMs: 5000,
    aspectRatio: "9:16",
    bindings: [{ assetType: "role", assetUuid: "role-1", sourceProjectUuid: projectUuid, relationRole: "appear" }],
    candidates: [
      {
        candidateUuid: "11111111-1111-4111-a111-111111111201",
        mediaType: "image",
        relativePath: "files/images/storyboard/shot-1/image.png",
        selected: true,
        createdAt: "2026-08-15T00:00:00.000Z",
      },
    ],
    generationTasks: [
      {
        taskUuid: "11111111-1111-4111-a111-111111111301",
        mediaType: "video",
        providerId: "dreamina-cli",
        modelName: "dreamina-cli:seedance2.0fast",
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  },
  {
    shotUuid: "11111111-1111-4111-a111-111111111102",
    displayOrder: 2,
    sourceText: "她停在舞台中央，抬头看向二楼包厢。",
    visualDescription: "冷色顶光落在脸上，尘埃漂浮。",
    imagePrompt: "人物近景，冷色顶光",
    videoPrompt: "从中景缓慢推到近景",
    negativePrompt: "畸形手部",
    shotSize: "中景",
    cameraMovement: "推进",
    composition: "三分法",
    durationMs: 6500,
    aspectRatio: "9:16",
    bindings: [],
    candidates: [],
    generationTasks: [],
  },
  {
    shotUuid: "11111111-1111-4111-a111-111111111103",
    displayOrder: 3,
    sourceText: "包厢里传来一声轻笑。",
    visualDescription: "黑暗中只有一双眼睛被微光照亮。",
    imagePrompt: "悬疑，极暗光影",
    videoPrompt: "快速切换到眼睛特写",
    negativePrompt: "过曝",
    shotSize: "特写",
    cameraMovement: "固定",
    composition: "对称构图",
    durationMs: 3500,
    aspectRatio: "9:16",
    bindings: [],
    candidates: [],
    generationTasks: [],
  },
];

function mountWorkspace(): VueWrapper {
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
  (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(i18n.global.t(key));
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = projectStore();
  store.project = {
    id: "111",
    projectUuid,
    name: "雨夜剧场",
    describe: "悬疑漫剧分镜",
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
  } as any;
  // 动态写权限必须由本次打开响应显式建立，不能只依赖项目角色快照。
  store.access = { projectUuid, mode: "readwrite", reason: "test_open", lockHolder: "" };
  return mount(StoryboardWorkspace, {
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
        TSelect: { template: "<select><slot /></select>" },
        TTextarea: { inheritAttrs: true, template: "<textarea v-bind=\"$attrs\" />" },
        TCheckbox: { template: "<input type=\"checkbox\" />" },
        TCheckboxGroup: { template: "<div><slot /></div>" },
        TImage: { template: "<img />" },
        TImageViewer: { template: "<div><slot name=\"trigger\" :open=\"() => {}\" /></div>" },
        TPopup: { template: "<div><slot /></div>" },
        modelSelect: { template: "<div />" },
        ImageTools: { template: "<div />" },
        "i-plus": { template: "<i />" },
        TDialog: {
          inheritAttrs: false,
          props: ["visible", "header"],
          emits: ["close"],
          template: "<section v-if=\"visible\" role=\"dialog\"><h2>{{ header }}</h2><slot/><slot name=\"footer\"/></section>",
        },
      },
    },
  });
}

beforeEach(() => {
  axiosGet.mockReset();
  axiosPost.mockReset();
  axiosPatch.mockReset();
  axiosGet.mockImplementation((url: string) => {
    if (url.endsWith("/shots")) return Promise.resolve({ data: { data: shots } });
    if (url.endsWith("/assets")) {
      return Promise.resolve({
        data: {
          data: {
            sourceProjectUuid: projectUuid,
            assets: [
              { assetUuid: "role-1", name: "林夏", type: "role", describe: "雨夜剧场女主角", sourceProjectUuid: projectUuid },
              { assetUuid: "scene-1", name: "旧剧院", type: "scene", describe: "霓虹雨夜中的旧剧院", sourceProjectUuid: projectUuid },
              { assetUuid: "tool-1", name: "旧钥匙", type: "tool", describe: "剧情关键道具", sourceProjectUuid: projectUuid },
            ],
          },
        },
      });
    }
    if (url === "/setting/dreaminaCli/getStatus") {
      return Promise.resolve({
        data: { data: { queue: { paused: false, maxConcurrency: 3, queued: 2, active: 1, unknown: 1 } } },
      });
    }
    return Promise.resolve({ data: {} });
  });
  axiosPost.mockImplementation((url: string) => {
    if (url.endsWith("/shots")) {
      return Promise.resolve({ data: { data: { ...shots[1], shotUuid: "11111111-1111-4111-a111-111111111199", displayOrder: 3 } } });
    }
    if (url.includes("/import/preview")) {
      return Promise.resolve({ data: { digest: "preview-digest", rows: [shots[0]], errors: [] } });
    }
    if (String(url).includes("/cornerScape/getAllAssets")) return Promise.resolve({ data: [] });
    return Promise.resolve({ data: {} });
  });
  axiosPatch.mockResolvedValue({ data: { data: shots[1] } });
});

describe("分镜产品工作台", () => {
  it("渲染项目摘要、连续分镜列表和绑定当前分镜的详情编辑器", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();

    expect(wrapper.attributes("data-layout")).toBe("storyboard-product-workspace");
    expect(wrapper.findAll("[data-summary]")).toHaveLength(3);
    expect(wrapper.text()).toContain("雨夜剧场");
    expect(wrapper.text()).toContain("3 个分镜");
    expect(wrapper.text()).toContain("15 秒");

    const secondShot = wrapper.get(`[data-shot-id="${shots[1].shotUuid}"]`);
    await secondShot.trigger("click");
    await flushPromises();
    const detail = wrapper.get(`[data-selected-shot="${shots[1].shotUuid}"]`);
    expect((detail.get('[name="videoPrompt"]').element as HTMLTextAreaElement).value).toBe(shots[1].videoPrompt);
    expect(detail.text()).toContain("镜头 02");
    wrapper.unmount();
  });

  it("在第二条后插入会调用真实 API，并显示可观察反馈", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();

    await wrapper.get(`[data-action="insert-after"][data-shot-id="${shots[1].shotUuid}"]`).trigger("click");
    await flushPromises();

    expect(axiosPost).toHaveBeenCalledWith(
      `/tianjiang/runtime/projects/${projectUuid}/storyboard/shots`,
      { afterShotUuid: shots[1].shotUuid },
    );
    expect(wrapper.get('[data-feedback="storyboard-action"]').text()).toContain("已插入");
    wrapper.unmount();
  });

  it("资产、设置、导入导出使用同一产品导航和对话框", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();

    await wrapper.get('[data-module="assets"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-panel="corner-scape-assets"]').exists()).toBe(true);
    expect(wrapper.find('[data-workspace="corner-scape"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("新建资产");

    await wrapper.get('[data-module="settings"]').trigger("click");
    expect(wrapper.find('[data-panel="storyboard-settings"]').exists()).toBe(true);

    await wrapper.get('[data-action="open-import"]').trigger("click");
    expect(wrapper.get('[data-dialog="storyboard-import"]').attributes("role")).toBe("dialog");
    expect(wrapper.text()).toContain("先预览，再安全写入项目");
    wrapper.unmount();
  });

  it("分镜设置只依赖显式项目身份，独立挂载不得读取环境 Pinia", async () => {
    expect(buildStoryboardSettingsUrl("project / 26")).toBe(
      "/tianjiang/runtime/projects/project%20%2F%2026/storyboard/settings",
    );
    expect(() => buildStoryboardSettingsUrl(undefined)).toThrow("缺少项目身份");

    setActivePinia(undefined);
    const wrapper = mount(StoryboardSettings, {
      props: { projectUuid },
      global: {
        stubs: {
          TButton: { template: "<button><slot name='icon'/><slot/></button>" },
          TIcon: { template: "<i />" },
        },
      },
    });
    await flushPromises();

    expect(axiosGet).toHaveBeenCalledWith(
      `/tianjiang/runtime/projects/${projectUuid}/storyboard/settings`,
    );
    wrapper.unmount();
  });

  it("资产面板只消费父级传入的项目身份，不从环境 Store 猜测账号项目", async () => {
    setActivePinia(undefined);
    const wrapper = mount(AssetManager, {
      props: { projectUuid },
      global: {
        stubs: {
          TButton: { template: "<button><slot name='icon'/><slot/></button>" },
          TIcon: { template: "<i />" },
        },
      },
    });
    await flushPromises();

    expect(axiosGet).toHaveBeenCalledWith(
      `/tianjiang/runtime/projects/${projectUuid}/storyboard/assets`,
    );
    expect(wrapper.text()).toContain("林夏");
    wrapper.unmount();
  });
});
