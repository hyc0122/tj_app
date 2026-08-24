// @vitest-environment jsdom
/**
 * RED2：成功后增量合并、写锁、对话框 maxlength。
 */
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import { modelCatalogStore, setAccountScope } from "@/features/models/modelCatalogStore";

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

vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-router")>();
  return {
    ...actual,
    useRoute: () => ({ path: "/storyboard-project", fullPath: "/storyboard-project" }),
    useRouter: () => ({ push: vi.fn(), currentRoute: { value: { path: "/storyboard-project" } } }),
    onBeforeRouteLeave: () => undefined,
  };
});

import projectStore from "@/stores/project";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";
import { useStoryboardWorkspace } from "@/views/storyboardProject/useStoryboardWorkspace";

const projectUuid = "29000000-0000-4000-a000-000000000001";
const sourceProjectUuid = "29000000-0000-4000-a000-000000000002";
const shotOneUuid = "29000000-0000-4000-a000-000000000101";
const shotTwoUuid = "29000000-0000-4000-a000-000000000102";
const base = `/tianjiang/runtime/projects/${projectUuid}/storyboard`;

const shots = [
  {
    shotUuid: shotOneUuid,
    displayOrder: 1,
    sourceText: "源一",
    visualDescription: "画面一",
    videoPrompt: "小许在门口",
    bindings: [],
    candidates: [],
    generationTasks: [],
    durationMs: 5000,
    aspectRatio: "9:16",
  },
  {
    shotUuid: shotTwoUuid,
    displayOrder: 2,
    sourceText: "源二",
    visualDescription: "画面二",
    videoPrompt: "镜头推进",
    bindings: [],
    candidates: [],
    generationTasks: [],
    durationMs: 5000,
    aspectRatio: "9:16",
  },
];

const assets = [
  {
    assetUuid: "role-xuhe",
    sourceProjectUuid,
    name: "许禾",
    assetType: "role",
    type: "role",
    description: "男主角",
  },
];

const workspaceStubs = {
  TButton: {
    inheritAttrs: true,
    props: ["loading", "disabled"],
    template: "<button v-bind=\"$attrs\" :disabled=\"disabled || loading\"><slot name=\"icon\"/><slot/></button>",
  },
  TIcon: { template: "<i />" },
  TDialog: {
    inheritAttrs: false,
    props: ["visible", "header"],
    template: "<section v-if=\"visible\" role=\"dialog\"><h2>{{ header }}</h2><slot/><slot name=\"footer\"/></section>",
  },
  TDrawer: { inheritAttrs: true, props: ["visible", "modelValue"], template: "<aside v-if=\"visible || modelValue\" v-bind=\"$attrs\"><slot /></aside>" },
  modelSelect: { template: "<div data-stub=\"model-select\" />" },
  TSelect: { template: "<select><slot /></select>" },
  TTextarea: { inheritAttrs: true, template: "<textarea v-bind=\"$attrs\" />" },
  TEmpty: { template: "<div />" },
  TLoading: { template: "<div />" },
  TPopup: { template: "<div><slot /></div>" },
  TImage: { template: "<img />" },
  TImageViewer: { template: "<div><slot /></div>" },
  TCard: { inheritAttrs: true, template: "<section v-bind=\"$attrs\"><slot /></section>" },
  TForm: { template: "<form><slot /></form>" },
  TFormItem: { template: "<div><slot /></div>" },
  ImageTools: { template: "<div />" },
};

function isDisabled(wrapper: VueWrapper, selector: string): boolean {
  return Boolean((wrapper.get(selector).element as HTMLButtonElement | HTMLInputElement).disabled);
}

function shotsGets(): number {
  return axiosGet.mock.calls.filter(([url]) => String(url).endsWith("/shots")).length;
}

function activateProject(): void {
  const store = projectStore();
  store.project = {
    projectUuid,
    assetSourceProjectUuid: sourceProjectUuid,
    name: "R29 勾选工具",
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
    videoModel: "dreamina-cli:seedance2.0fast",
  } as any;
  store.access = { projectUuid, mode: "readwrite", reason: "test_open", lockHolder: "" };
}

async function mountWorkspace(): Promise<VueWrapper> {
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
  (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(i18n.global.t(key));
  const pinia = createPinia();
  setActivePinia(pinia);
  activateProject();
  const wrapper = mount(StoryboardWorkspace, {
    global: { plugins: [pinia, i18n], stubs: workspaceStubs },
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  setAccountScope(null);
  modelCatalogStore.invalidateAll();
  axiosGet.mockReset();
  axiosPost.mockReset();
  axiosPatch.mockReset();
  axiosPut.mockReset();
  axiosDelete.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  axiosGet.mockImplementation((url: string) => {
    if (url.endsWith("/shots")) return Promise.resolve({ data: { data: shots.map((shot) => ({ ...shot, bindings: [] })) } });
    if (url.endsWith("/assets")) return Promise.resolve({ data: { data: { sourceProjectUuid, assets } } });
    if (String(url).includes("/setting/dreaminaCli/getStatus")) {
      return Promise.resolve({ data: { data: { queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 } } } });
    }
    return Promise.resolve({ data: { data: {} } });
  });
  axiosPost.mockImplementation((url: string) => {
    if (url.endsWith("/modelSelect/getModelList")) {
      return Promise.resolve({
        data: {
          data: {
            items: [{ value: "dreamina-cli:seedance2.0fast", type: "video", disabled: false }],
            providers: [{ providerId: "dreamina-cli", state: "ready" }],
          },
        },
      });
    }
    return Promise.resolve({ data: { code: 0, data: {} } });
  });
});

describe("R29 增量合并与写锁", () => {
  it("成功匹配/替换后不得再全量 GET /shots，必须按 shotUuid 合并返回 DTO", async () => {
    setActivePinia(createPinia());
    activateProject();
    const workspace = useStoryboardWorkspace() as ReturnType<typeof useStoryboardWorkspace> & Record<string, any>;
    axiosGet.mockImplementation((url: string) => {
      if (url === `${base}/shots`) return Promise.resolve({ data: { data: shots.map((shot) => ({ ...shot, bindings: [] })) } });
      if (url.endsWith("/assets")) return Promise.resolve({ data: { data: { sourceProjectUuid, assets } } });
      return Promise.resolve({ data: { data: { queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 } } } });
    });
    await workspace.refreshProductionState();
    const getsAfterLoad = shotsGets();
    axiosPost.mockImplementation((url: string) => {
      if (url === `${base}/shots/actions/auto-match-assets`) {
        return Promise.resolve({
          data: {
            code: 0,
            data: {
              selectedCount: 1,
              processedCount: 1,
              matchedCount: 1,
              createdBindingCount: 1,
              existingBindingCount: 0,
              emptyPromptCount: 0,
              conflictCount: 0,
              shots: [{
                ...shots[0],
                videoPrompt: "小许在门口",
                bindings: [{
                  sourceProjectUuid,
                  assetUuid: "role-xuhe",
                  assetType: "role",
                  relationRole: "appear",
                  voiceEnabled: true,
                }],
                matchedCount: 1,
                createdBindingCount: 1,
              }],
            },
          },
        });
      }
      if (url === `${base}/shots/actions/batch-replace-prompt`) {
        return Promise.resolve({
          data: {
            code: 0,
            data: {
              selectedCount: 1,
              affectedShotCount: 1,
              replacementCount: 1,
              shots: [{
                ...shots[0],
                videoPrompt: "许禾在门口",
                bindings: [],
                replacementCount: 1,
              }],
            },
          },
        });
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });

    await workspace.autoMatchAssets([shotOneUuid]);
    expect(shotsGets()).toBe(getsAfterLoad);
    expect(workspace.shots.value.find((shot: { shotUuid: string }) => shot.shotUuid === shotOneUuid)?.bindings).toEqual([{
      sourceProjectUuid,
      assetUuid: "role-xuhe",
      assetType: "role",
      relationRole: "appear",
      voiceEnabled: true,
    }]);
    expect(workspace.shots.value.find((shot: { shotUuid: string }) => shot.shotUuid === shotTwoUuid)?.videoPrompt).toBe("镜头推进");

    await workspace.batchReplacePrompt([shotOneUuid], "小许", "许禾");
    expect(shotsGets()).toBe(getsAfterLoad);
    expect(workspace.shots.value.find((shot: { shotUuid: string }) => shot.shotUuid === shotOneUuid)?.videoPrompt).toBe("许禾在门口");
    expect(workspace.shots.value.find((shot: { shotUuid: string }) => shot.shotUuid === shotTwoUuid)?.videoPrompt).toBe("镜头推进");
  });

  it("autoMatchBusy 期间新增、导入、移动、删除、保存、绑定和生成必须禁用并被 handler 拦截", async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith("/modelSelect/getModelList")) {
        return Promise.resolve({
          data: { data: { items: [{ value: "dreamina-cli:seedance2.0fast", type: "video", disabled: false }], providers: [] } },
        });
      }
      if (url.endsWith("/shots/actions/auto-match-assets")) return pending;
      return Promise.resolve({ data: { code: 0, data: { shotUuid: "new" } } });
    });
    const wrapper = await mountWorkspace();
    await wrapper.get(`[data-shot-select="${shotOneUuid}"]`).setValue(true);
    await wrapper.get('[data-action="auto-match-assets"]').trigger("click");
    await flushPromises();

    expect(isDisabled(wrapper, ".storyboardToolbar [data-action=\"insert-first\"]")).toBe(true);
    expect(isDisabled(wrapper, ".storyboardToolbar [data-action=\"open-import\"]")).toBe(true);
    expect(isDisabled(wrapper, '[data-action="open-import"]')).toBe(true);
    expect(isDisabled(wrapper, `[data-action="generate-video"]`)).toBe(true);
    expect(isDisabled(wrapper, `[data-action="move-shot-up"]`)).toBe(true);
    expect(isDisabled(wrapper, `[data-action="delete-shot"]`)).toBe(true);
    expect(isDisabled(wrapper, `[data-action="pick-asset"]`)).toBe(true);
    expect(isDisabled(wrapper, '[data-action="save-shot"]')).toBe(true);

    const postsBefore = axiosPost.mock.calls.length;
    const patchesBefore = axiosPatch.mock.calls.length;
    const putsBefore = axiosPut.mock.calls.length;
    await wrapper.get(".storyboardToolbar [data-action=\"insert-first\"]").trigger("click");
    await wrapper.get(".storyboardHero [data-action=\"open-import\"]").trigger("click");
    await wrapper.get('[data-action="move-shot-down"]').trigger("click");
    await wrapper.get('[data-action="delete-shot"]').trigger("click");
    await wrapper.get('[data-action="save-shot"]').trigger("click");
    await wrapper.get('[data-action="pick-asset"]').trigger("click");
    await wrapper.get('[data-action="generate-video"]').trigger("click");
    await flushPromises();
    expect(axiosPost.mock.calls.length).toBe(postsBefore);
    expect(axiosPatch.mock.calls.length).toBe(patchesBefore);
    expect(axiosPut.mock.calls.length).toBe(putsBefore);
    expect(wrapper.find('[data-dialog="storyboard-import"]').exists()).toBe(false);

    release({
      data: {
        code: 0,
        data: {
          selectedCount: 1,
          processedCount: 1,
          matchedCount: 0,
          createdBindingCount: 0,
          existingBindingCount: 0,
          emptyPromptCount: 0,
          conflictCount: 0,
          shots: [{ ...shots[0], bindings: [] }],
        },
      },
    });
    await flushPromises();
    wrapper.unmount();
  });

  it("批量替换对话框查找/替换 maxlength 必须与服务端 4000/8000 一致", async () => {
    const wrapper = await mountWorkspace();
    await wrapper.get(`[data-shot-select="${shotOneUuid}"]`).setValue(true);
    await wrapper.get('[data-action="open-batch-replace"]').trigger("click");
    await flushPromises();
    const find = wrapper.get('[data-field="find-text"]');
    const replace = wrapper.get('[data-field="replace-text"]');
    expect(find.attributes("maxlength")).toBe("4000");
    expect(replace.attributes("maxlength")).toBe("8000");
    wrapper.unmount();
  });
});
