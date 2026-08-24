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

import { modelCatalogStore, setAccountScope } from "@/features/models/modelCatalogStore";
import projectStore from "@/stores/project";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";
import type { WorkspaceShot } from "@/views/storyboardProject/storyboard-workbench-types";

function videoCatalog() {
  return {
    accountScopeId: "",
    catalogVersion: 28,
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

const projectUuid = "11111111-1111-4111-a111-111111111111";
const shotOne = "11111111-1111-4111-a111-111111111101";
const shotTwo = "11111111-1111-4111-a111-111111111102";
const roleAssetUuid = "11111111-1111-4111-a111-111111111281";

const shots: WorkspaceShot[] = [
  {
    shotUuid: shotOne,
    displayOrder: 1,
    sourceText: "雨夜，林夏推开旧剧院的门。",
    visualDescription: "霓虹倒映在积水中。",
    videoPrompt: "镜头缓慢跟随人物向前移动",
    durationMs: 5000,
    aspectRatio: "9:16",
    bindings: [{
      sourceProjectUuid: projectUuid,
      assetUuid: roleAssetUuid,
      assetType: "role",
      relationRole: "appear",
    }],
    candidates: [{
      candidateUuid: "11111111-1111-4111-a111-111111111201",
      mediaType: "video",
      relativePath: "files/videos/shot-01.mp4",
      selected: true,
      createdAt: "2026-08-15T00:00:00.000Z",
    }],
    generationTasks: [],
  },
  {
    shotUuid: shotTwo,
    displayOrder: 2,
    sourceText: "她停在舞台中央。",
    visualDescription: "冷色顶光落在脸上。",
    videoPrompt: "",
    durationMs: 4000,
    aspectRatio: "9:16",
    bindings: [],
    candidates: [],
    generationTasks: [],
  },
];

function mountWorkspace(): VueWrapper {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = projectStore();
  store.project = {
    projectUuid,
    name: "雨夜剧场",
    describe: "悬疑漫剧分镜",
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
    videoModel: "dreamina-cli:seedance2.0fast",
  } as any;
  store.access = { projectUuid, mode: "readwrite", reason: "test_open", lockHolder: "" };
  return mount(StoryboardWorkspace, {
    global: {
      plugins: [
        pinia,
        createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
      ],
      stubs: {
        TButton: {
          inheritAttrs: true,
          props: ["loading", "disabled"],
          template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
        },
        TIcon: { template: "<i />" },
        TDrawer: { template: "<div><slot /></div>" },
        TDialog: { template: "<div><slot /></div>" },
      },
    },
  });
}

beforeEach(() => {
  setAccountScope(null);
  modelCatalogStore.invalidateAll();
  axiosGet.mockReset();
  axiosPost.mockReset();
  axiosPatch.mockReset();
  axiosPut.mockReset();
  axiosDelete.mockReset();
  axiosGet.mockImplementation((url: string) => {
    if (String(url).includes("/storyboard/shots")) return Promise.resolve({ data: { data: shots } });
    if (String(url).includes("/storyboard/assets")) {
      return Promise.resolve({
        data: {
          data: {
            sourceProjectUuid: projectUuid,
            assets: [{
              assetUuid: roleAssetUuid,
              name: "林夏",
              type: "role",
              describe: "女主角",
              sourceProjectUuid: projectUuid,
            }],
          },
        },
      });
    }
    if (String(url).includes("/modelSelect/getCatalogVersion")) {
      return Promise.resolve({ data: { data: { catalogVersion: 28 } } });
    }
    if (String(url).includes("getStatus")) {
      return Promise.resolve({ data: { queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 } } });
    }
    return Promise.resolve({ data: {} });
  });
  axiosPost.mockImplementation((url: string) => {
    if (String(url).endsWith("/modelSelect/getModelList")) {
      return Promise.resolve({ data: { data: videoCatalog() } });
    }
    return Promise.resolve({ data: { data: {} } });
  });
  axiosPatch.mockResolvedValue({ data: { data: shots[0] } });
  axiosPut.mockResolvedValue({ data: { data: { orderedShotUuids: [shotTwo, shotOne] } } });
  axiosDelete.mockResolvedValue({ data: { data: { deleted: 1 } } });
  vi.stubGlobal("confirm", vi.fn(() => true));
});

describe("紧凑分镜生产工作台", () => {
  it("一屏展示多条紧凑行，并移除叙事内容与镜头语言", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const text = wrapper.text();
    expect(text).not.toContain("叙事内容");
    expect(text).not.toContain("镜头语言");
    expect(text).not.toContain("脚本与画面");
    expect(wrapper.find('[data-section="narrative"]').exists()).toBe(false);
    expect(wrapper.findAll("tr[data-shot-id]")).toHaveLength(2);
    expect(wrapper.get(`[data-shot-id="${shotOne}"] [data-field="video-prompt"]`).text()).toContain("镜头缓慢跟随人物向前移动");
    expect(wrapper.get(`[data-shot-id="${shotTwo}"] [data-field="video-prompt"]`).text()).toContain("冷色顶光落在脸上");
    expect(wrapper.get(`[data-asset-slot="role"][data-asset-id="${roleAssetUuid}"]`).attributes("data-bound")).toBe("true");
    expect(wrapper.get('[data-panel="shot-production"]').exists()).toBe(true);
    expect(wrapper.get('[data-action="preview-shot"]').exists()).toBe(true);
    expect(wrapper.get('[data-action="submit-current-shot"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("批量生成只使用勾选分镜，未勾选时禁用", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    await flushPromises();
    const batch = wrapper.get('[data-action="open-batch-generation"]');
    expect((batch.element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.get(`[data-shot-select="${shotOne}"]`).setValue(true);
    await flushPromises();
    expect(wrapper.get("[data-selected-count]").text()).toContain("1");
    expect((wrapper.get('[data-action="open-batch-generation"]').element as HTMLButtonElement).disabled).toBe(false);
    wrapper.unmount();
  });

  it("上移提交完整有序 UUID 列表，删除前确认并调用现有删除接口", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get(`[data-action="move-shot-up"][data-shot-id="${shotTwo}"]`).trigger("click");
    await flushPromises();
    expect(axiosPut).toHaveBeenCalledWith(
      `/tianjiang/runtime/projects/${projectUuid}/storyboard/shots/reorder`,
      { orderedShotUuids: [shotTwo, shotOne] },
    );

    await wrapper.get(`[data-action="delete-shot"][data-shot-id="${shotTwo}"]`).trigger("click");
    await flushPromises();
    expect(window.confirm).toHaveBeenCalled();
    expect(axiosDelete).toHaveBeenCalledWith(
      `/tianjiang/runtime/projects/${projectUuid}/storyboard/shots`,
      { data: { shotUuids: [shotTwo] } },
    );
    wrapper.unmount();
  });
});
