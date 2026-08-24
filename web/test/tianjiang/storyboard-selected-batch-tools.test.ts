// @vitest-environment jsdom
/**
 * RED：勾选分镜的自动匹配资产、批量替换，以及分镜页顶部业务入口隐藏。
 */
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
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

vi.mock("@/features/tianjiang/runtime/project-recovery", () => ({
  recoverActiveProjectAfterRuntimeRestart: vi.fn(),
}));

const { routePath, routerPush } = vi.hoisted(() => ({
  routePath: { value: "/storyboard-project" },
  routerPush: vi.fn(),
}));
vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-router")>();
  return {
    ...actual,
    useRoute: () => ({ path: routePath.value, fullPath: routePath.value }),
    useRouter: () => ({ push: routerPush, currentRoute: { value: { path: routePath.value } } }),
    onBeforeRouteLeave: () => undefined,
  };
});

import projectStore from "@/stores/project";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";
import { useStoryboardWorkspace } from "@/views/storyboardProject/useStoryboardWorkspace";

const projectUuid = "28000000-0000-4000-a000-000000000001";
const projectBUuid = "28000000-0000-4000-a000-000000000002";
const sourceProjectUuid = "28000000-0000-4000-a000-000000000003";
const shotOneUuid = "28000000-0000-4000-a000-000000000101";
const shotTwoUuid = "28000000-0000-4000-a000-000000000102";
const shotThreeUuid = "28000000-0000-4000-a000-000000000103";
const shotBUuid = "28000000-0000-4000-a000-000000000201";
const baseA = `/tianjiang/runtime/projects/${projectUuid}/storyboard`;
const baseB = `/tianjiang/runtime/projects/${projectBUuid}/storyboard`;

const shots = [
  {
    shotUuid: shotOneUuid,
    displayOrder: 1,
    sourceText: "林夏走进雨夜剧院。",
    visualDescription: "角色从霓虹雨幕中走向舞台。",
    imagePrompt: "雨夜剧院，人物全身",
    videoPrompt: "小许在老许农资拿起文件夹，小许回头。",
    negativePrompt: "模糊，水印",
    durationMs: 5000,
    aspectRatio: "9:16",
    bindings: [],
    candidates: [],
    generationTasks: [],
  },
  {
    shotUuid: shotTwoUuid,
    displayOrder: 2,
    sourceText: "舞台上的帷幕突然拉开。",
    visualDescription: "空舞台被一束冷光照亮。",
    imagePrompt: "空舞台，冷色顶光",
    videoPrompt: "镜头推进到舞台中央",
    negativePrompt: "过曝",
    durationMs: 5000,
    aspectRatio: "9:16",
    bindings: [],
    candidates: [],
    generationTasks: [],
  },
  {
    shotUuid: shotThreeUuid,
    displayOrder: 3,
    sourceText: "监管工作人员进门。",
    visualDescription: "门口逆光。",
    imagePrompt: "门口逆光",
    videoPrompt: "小许看见监管工作人员进门。",
    negativePrompt: "模糊",
    durationMs: 5000,
    aspectRatio: "9:16",
    bindings: [],
    candidates: [],
    generationTasks: [],
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
  {
    assetUuid: "scene-farm",
    sourceProjectUuid,
    name: "老许农资",
    assetType: "scene",
    type: "scene",
    description: "主要场景",
  },
  {
    assetUuid: "tool-folder",
    sourceProjectUuid,
    name: "文件夹",
    assetType: "tool",
    type: "tool",
    description: "关键道具",
  },
];

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

const workspaceStubs = {
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
    emits: ["update:modelValue", "change"],
    template: "<select :name=\"name\" :value=\"modelValue\" :disabled=\"disabled\" @change=\"$emit('update:modelValue', $event.target.value)\"><slot /></select>",
  },
  TOptionGroup: { props: ["label"], template: "<optgroup :label=\"label\"><slot /></optgroup>" },
  TOption: { props: ["value", "label", "disabled"], template: "<option :value=\"value\" :disabled=\"disabled\">{{ label }}</option>" },
  modelSelect: { template: "<div data-stub=\"model-select\" />" },
  TTextarea: { inheritAttrs: true, template: "<textarea v-bind=\"$attrs\" />" },
  TInput: {
    inheritAttrs: true,
    props: ["modelValue", "disabled"],
    emits: ["update:modelValue"],
    template: "<input v-bind=\"$attrs\" :value=\"modelValue\" :disabled=\"disabled\" @input=\"$emit('update:modelValue', $event.target.value)\" />",
  },
  TCheckbox: { template: "<input type=\"checkbox\" />" },
  TImage: { template: "<img />" },
  TImageViewer: { template: "<div><slot name=\"trigger\" :open=\"() => {}\" /></div>" },
  TPopup: { template: "<div><slot /></div>" },
  TDialog: {
    inheritAttrs: false,
    props: ["visible", "header"],
    emits: ["close"],
    template: "<section v-if=\"visible\" role=\"dialog\"><h2>{{ header }}</h2><slot/><slot name=\"footer\"/></section>",
  },
  TDrawer: {
    inheritAttrs: true,
    props: ["visible", "modelValue", "header"],
    template: "<aside v-if=\"visible || modelValue\" v-bind=\"$attrs\"><slot /></aside>",
  },
  ImageTools: { template: "<div />" },
};

function isDisabled(wrapper: VueWrapper, selector: string): boolean {
  const el = wrapper.get(selector).element as HTMLButtonElement;
  return Boolean(el.disabled);
}

async function mountWorkspace(): Promise<VueWrapper> {
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
  (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(i18n.global.t(key));
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = projectStore();
  store.project = {
    projectUuid,
    assetSourceProjectUuid: sourceProjectUuid,
    name: "分镜勾选工具项目",
    describe: "自动匹配与批量替换",
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
    videoModel: "dreamina-cli:seedance2.0fast",
  } as any;
  store.access = {
    projectUuid,
    mode: "readwrite",
    reason: "test_open",
    lockHolder: "",
  };
  const wrapper = mount(StoryboardWorkspace, {
    global: {
      plugins: [pinia, i18n],
      stubs: workspaceStubs,
    },
  });
  await flushPromises();
  return wrapper;
}

function postCalls(suffix: string): unknown[][] {
  return axiosPost.mock.calls.filter(([url]) => String(url).endsWith(suffix));
}

function assertNoGenerationOrCliWrites(): void {
  const writeUrls = [...axiosPost.mock.calls, ...axiosPatch.mock.calls, ...axiosPut.mock.calls]
    .map(([url]) => String(url));
  expect(writeUrls.some((url) => url.includes("/generate"))).toBe(false);
  expect(writeUrls.some((url) => /dreaminaCli|jimeng|cli\/start|cli\/generate/i.test(url))).toBe(false);
}

beforeEach(() => {
  routePath.value = "/storyboard-project";
  routerPush.mockReset();
  setAccountScope(null);
  modelCatalogStore.invalidateAll();
  axiosGet.mockReset();
  axiosPost.mockReset();
  axiosPatch.mockReset();
  axiosPut.mockReset();
  axiosDelete.mockReset();
  axiosGet.mockImplementation((url: string) => {
    if (url.endsWith("/shots")) return Promise.resolve({ data: { data: shots } });
    if (url.endsWith("/assets")) {
      return Promise.resolve({
        data: { data: { sourceProjectUuid, assets } },
      });
    }
    if (url.endsWith("/settings")) {
      return Promise.resolve({
        data: {
          data: {
            aspectRatio: "9:16",
            durationMs: 5000,
            globalVideoPrompt: "",
          },
        },
      });
    }
    if (String(url).includes("/setting/dreaminaCli/getStatus")) {
      return Promise.resolve({
        data: { data: { queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 } } },
      });
    }
    return Promise.resolve({ data: { data: {} } });
  });
  axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
    if (url.endsWith("/modelSelect/getModelList")) {
      return Promise.resolve({ data: { data: defaultVideoCatalog() } });
    }
    if (url.endsWith("/shots/actions/auto-match-assets")) {
      return Promise.resolve({
        data: {
          code: 0,
          data: {
            selectedCount: Array.isArray(payload?.shotUuids) ? payload.shotUuids.length : 0,
            processedCount: Array.isArray(payload?.shotUuids) ? payload.shotUuids.length : 0,
            matchedCount: 3,
            createdBindingCount: 3,
            existingBindingCount: 0,
            emptyPromptCount: 0,
            conflictCount: 0,
            shots: (payload?.shotUuids ?? []).map((shotUuid: string) => ({
              shotUuid,
              matchedCount: 1,
              createdBindingCount: 1,
            })),
          },
        },
      });
    }
    if (url.endsWith("/shots/actions/batch-replace-prompt")) {
      return Promise.resolve({
        data: {
          code: 0,
          data: {
            selectedCount: Array.isArray(payload?.shotUuids) ? payload.shotUuids.length : 0,
            affectedShotCount: 2,
            replacementCount: 3,
            shots: [
              { shotUuid: shotOneUuid, replacementCount: 2 },
              { shotUuid: shotThreeUuid, replacementCount: 1 },
            ],
          },
        },
      });
    }
    return Promise.resolve({ data: { code: 0, data: {} } });
  });
});

describe("分镜勾选批量工具", () => {
  it("自动匹配资产和批量替换位于刷新旁，顺序为批量生成、匹配、替换、刷新", async () => {
    const wrapper = await mountWorkspace();
    const actions = wrapper.get(".storyboardToolbar__actions")
      .findAll("[data-action]")
      .map((button) => button.attributes("data-action"));
    expect(actions).toEqual([
      "toggle-select-all",
      "open-import",
      "open-batch-generation",
      "auto-match-assets",
      "open-batch-replace",
      "refresh-shots",
      "insert-first",
    ]);
    expect(wrapper.get('[data-action="auto-match-assets"]').text()).toContain("自动匹配资产");
    expect(wrapper.get('[data-action="open-batch-replace"]').text()).toContain("批量替换");
    wrapper.unmount();
  });

  it("无勾选时两个按钮都禁用，勾选后才发送对应 UUID", async () => {
    const wrapper = await mountWorkspace();
    expect(isDisabled(wrapper, '[data-action="auto-match-assets"]')).toBe(true);
    expect(isDisabled(wrapper, '[data-action="open-batch-replace"]')).toBe(true);
    await wrapper.get(`[data-shot-select="${shotOneUuid}"]`).setValue(true);
    await wrapper.get(`[data-shot-select="${shotThreeUuid}"]`).setValue(true);
    await flushPromises();
    expect(isDisabled(wrapper, '[data-action="auto-match-assets"]')).toBe(false);
    expect(isDisabled(wrapper, '[data-action="open-batch-replace"]')).toBe(false);
    await wrapper.get('[data-action="auto-match-assets"]').trigger("click");
    await flushPromises();
    expect(postCalls("/shots/actions/auto-match-assets")).toHaveLength(1);
    expect(postCalls("/shots/actions/auto-match-assets")[0]?.[1]).toEqual({
      shotUuids: [shotOneUuid, shotThreeUuid],
    });
    assertNoGenerationOrCliWrites();
    wrapper.unmount();
  });

  it("全选使用当前真实 selectedShotIds，有搜索时不得扩大到未选分镜", async () => {
    const wrapper = await mountWorkspace();
    await wrapper.get(".storyboardSearch input").setValue("舞台中央");
    await flushPromises();
    await wrapper.get('[data-action="toggle-select-all"]').trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-selected-count]").text()).toContain("已选 1 条");
    await wrapper.get('[data-action="auto-match-assets"]').trigger("click");
    await flushPromises();
    expect(postCalls("/shots/actions/auto-match-assets")[0]?.[1]).toEqual({
      shotUuids: [shotTwoUuid],
    });
    expect(JSON.stringify(postCalls("/shots/actions/auto-match-assets")[0]?.[1])).not.toContain(shotOneUuid);
    expect(JSON.stringify(postCalls("/shots/actions/auto-match-assets")[0]?.[1])).not.toContain(shotThreeUuid);
    wrapper.unmount();
  });

  it("批量替换对话框显示选择数、命中分镜数和总出现次数，并拒绝空查找或相同内容", async () => {
    const wrapper = await mountWorkspace();
    await wrapper.get(`[data-shot-select="${shotOneUuid}"]`).setValue(true);
    await wrapper.get(`[data-shot-select="${shotTwoUuid}"]`).setValue(true);
    await wrapper.get(`[data-shot-select="${shotThreeUuid}"]`).setValue(true);
    await wrapper.get('[data-action="open-batch-replace"]').trigger("click");
    await flushPromises();
    const dialog = wrapper.get('[data-dialog="storyboard-batch-replace"]');
    expect(dialog.text()).toContain("已选择 3 条分镜");
    await dialog.get('[data-field="find-text"]').setValue("");
    await flushPromises();
    expect(isDisabled(wrapper, '[data-action="confirm-batch-replace"]')).toBe(true);
    await dialog.get('[data-field="find-text"]').setValue("小许");
    await dialog.get('[data-field="replace-text"]').setValue("小许");
    await flushPromises();
    expect(dialog.text()).toContain("替换后内容没有变化");
    expect(isDisabled(wrapper, '[data-action="confirm-batch-replace"]')).toBe(true);
    expect(postCalls("/shots/actions/batch-replace-prompt")).toHaveLength(0);
    await dialog.get('[data-field="replace-text"]').setValue("许禾");
    await flushPromises();
    expect(dialog.get("[data-hit-shot-count]").text()).toContain("2");
    expect(dialog.get("[data-replacement-count]").text()).toContain("3");
    await wrapper.get('[data-action="confirm-batch-replace"]').trigger("click");
    await flushPromises();
    expect(postCalls("/shots/actions/batch-replace-prompt")).toHaveLength(1);
    expect(postCalls("/shots/actions/batch-replace-prompt")[0]?.[1]).toEqual({
      shotUuids: [shotOneUuid, shotTwoUuid, shotThreeUuid],
      findText: "小许",
      replaceText: "许禾",
    });
    wrapper.unmount();
  });

  it("成功刷新后保留仍然存在的勾选集合，且双击只发送一次请求", async () => {
    let releaseMatch!: (value: unknown) => void;
    const pendingMatch = new Promise((resolve) => {
      releaseMatch = resolve;
    });
    axiosPost.mockImplementation((url: string, payload?: Record<string, any>) => {
      if (url.endsWith("/modelSelect/getModelList")) {
        return Promise.resolve({ data: { data: defaultVideoCatalog() } });
      }
      if (url.endsWith("/shots/actions/auto-match-assets")) {
        return pendingMatch.then(() => ({
          data: {
            code: 0,
            data: {
              selectedCount: payload?.shotUuids?.length ?? 0,
              processedCount: payload?.shotUuids?.length ?? 0,
              matchedCount: 1,
              createdBindingCount: 1,
              existingBindingCount: 0,
              emptyPromptCount: 0,
              conflictCount: 0,
              shots: [],
            },
          },
        }));
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = await mountWorkspace();
    await wrapper.get(`[data-shot-select="${shotOneUuid}"]`).setValue(true);
    await wrapper.get(`[data-shot-select="${shotThreeUuid}"]`).setValue(true);
    await wrapper.get('[data-action="auto-match-assets"]').trigger("click");
    await wrapper.get('[data-action="auto-match-assets"]').trigger("click");
    expect(postCalls("/shots/actions/auto-match-assets")).toHaveLength(1);
    releaseMatch({});
    await flushPromises();
    const selected = wrapper.findAll("[data-shot-select]").filter((input) => (
      (input.element as HTMLInputElement).checked
    ));
    expect(selected.map((input) => input.attributes("data-shot-select"))).toEqual([
      shotOneUuid,
      shotThreeUuid,
    ]);
    assertNoGenerationOrCliWrites();
    wrapper.unmount();
  });
});

describe("勾选批量工具项目隔离", () => {
  type Deferred<T> = {
    promise: Promise<T>;
    resolve(value: T): void;
  };

  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((onResolve) => {
      resolve = onResolve;
    });
    return { promise, resolve };
  }

  function activate(uuid: string, name: string): void {
    projectStore().project = {
      projectUuid: uuid,
      name,
      projectType: "storyboard",
      myRole: "owner",
      openMode: "readwrite",
    } as any;
    projectStore().access = {
      projectUuid: uuid,
      mode: "readwrite",
      reason: "test_open",
      lockHolder: "",
    };
  }

  it("项目切换后旧匹配/替换响应不得污染新项目，卸载后不得弹出旧成功提示", async () => {
    const staleMatch = deferred<any>();
    axiosGet.mockImplementation((url: string) => {
      if (url === `${baseA}/shots` || url === `${baseB}/shots`) {
        const shotUuid = url.includes(projectBUuid) ? shotBUuid : shotOneUuid;
        return Promise.resolve({
          data: {
            data: [{
              shotUuid,
              displayOrder: 1,
              sourceText: url.includes(projectBUuid) ? "B 分镜" : "A 分镜",
              videoPrompt: "小许在门口",
              bindings: [],
              candidates: [],
              generationTasks: [],
            }],
          },
        });
      }
      if (url.endsWith("/assets")) {
        return Promise.resolve({ data: { data: { sourceProjectUuid: url.includes(projectBUuid) ? projectBUuid : projectUuid, assets } } });
      }
      return Promise.resolve({ data: { data: { queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 } } } });
    });
    axiosPost.mockImplementation((url: string) => {
      if (url === `${baseA}/shots/actions/auto-match-assets`) return staleMatch.promise;
      if (url === `${baseB}/shots/actions/batch-replace-prompt`) {
        return Promise.resolve({
          data: {
            code: 0,
            data: { selectedCount: 1, affectedShotCount: 1, replacementCount: 1, shots: [] },
          },
        });
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });

    setActivePinia(createPinia());
    activate(projectUuid, "项目 A");
    const workspace = useStoryboardWorkspace() as ReturnType<typeof useStoryboardWorkspace> & Record<string, any>;
    expect(typeof workspace.autoMatchAssets).toBe("function");
    expect(typeof workspace.batchReplacePrompt).toBe("function");
    const stale = workspace.autoMatchAssets([shotOneUuid]);
    activate(projectBUuid, "项目 B");
    await workspace.refreshProductionState();
    workspace.actionFeedback.value = "B 已就绪";
    await workspace.batchReplacePrompt([shotBUuid], "小许", "许禾");
    expect(workspace.actionFeedback.value).toMatch(/选中 1 条|影响 1 条|替换 1 处/);
    staleMatch.resolve({
      data: {
        code: 0,
        data: {
          selectedCount: 1,
          processedCount: 1,
          matchedCount: 9,
          createdBindingCount: 9,
          existingBindingCount: 0,
          emptyPromptCount: 0,
          conflictCount: 0,
          shots: [],
        },
      },
    });
    await stale;
    expect(workspace.shots.value.map((item: { sourceText: string }) => item.sourceText)).toEqual(["B 分镜"]);
    expect(workspace.actionFeedback.value).not.toMatch(/匹配 9|9 个新关联/);
    expect(workspace.autoMatchBusy.value).toBe(false);
    expect(workspace.batchReplaceBusy.value).toBe(false);
  });
});

describe("分镜页顶部业务入口", () => {
  async function mountWorkbench(path: string, projectType: "novel" | "storyboard") {
    const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
    (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(i18n.global.t(key));
    const pinia = createPinia();
    setActivePinia(pinia);
    projectStore().activateProject({
      id: "2801",
      name: "导航验收项目",
      intro: "",
      type: "video",
      artStyle: null,
      videoRatio: "9:16",
      createTime: 0,
      updatedAt: 0,
      imageModel: "",
      videoModel: "",
      projectType,
      imageQuality: "",
      mode: "",
      directorManual: "",
    } as never, {
      mode: "readwrite",
      reason: "owner_lock",
      lockHolder: "",
      projectUuid,
    } as never);
    routePath.value = path;
    const { default: Workbench } = await import("@/pages/workbench/index.vue");
    const wrapper = mount(Workbench, {
      global: {
        plugins: [pinia, i18n],
        stubs: {
          RouterView: { template: "<div />" },
          hello: { template: "<div />" },
          ProjectWorkspaceGate: { template: "<slot />" },
          TTooltip: { template: "<div><slot /></div>" },
          TBadge: { template: "<div><slot /></div>" },
        },
      },
    });
    await flushPromises();
    await nextTick();
    return wrapper;
  }

  it("分镜项目页隐藏剧本管理、塑角造景、视频生产和资产中心，但保留项目名和左侧入口", async () => {
    const wrapper = await mountWorkbench("/storyboard-project", "storyboard");
    expect(wrapper.get("[data-page-title]").text()).toContain("导航验收项目");
    expect(wrapper.find('[data-nav-path="/script"]').exists()).toBe(false);
    expect(wrapper.find('[data-nav-path="/cornerScape"]').exists()).toBe(false);
    expect(wrapper.find('[data-nav-path="/production"]').exists()).toBe(false);
    expect(wrapper.find('[data-nav-path="/assets"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("剧本管理");
    expect(wrapper.text()).not.toContain("塑角造景");
    expect(wrapper.text()).not.toContain("视频生产");
    expect(wrapper.text()).not.toContain("资产中心");
    expect(wrapper.text()).toContain("我的项目");
    expect(wrapper.text()).toContain("任务中心");
    expect(wrapper.text()).toContain("团队");
    expect(wrapper.text()).toContain("设置");
    wrapper.unmount();
  });

  it("其他页面仍显示四个业务入口", async () => {
    const wrapper = await mountWorkbench("/production", "novel");
    expect(wrapper.find('[data-nav-path="/script"]').exists()).toBe(true);
    expect(wrapper.find('[data-nav-path="/cornerScape"]').exists()).toBe(true);
    expect(wrapper.find('[data-nav-path="/production"]').exists()).toBe(true);
    expect(wrapper.find('[data-nav-path="/assets"]').exists()).toBe(true);
    expect(wrapper.find('[data-nav-path="/script"]').text()).toContain("剧本管理");
    expect(wrapper.find('[data-nav-path="/cornerScape"]').text()).toContain("塑角造景");
    expect(wrapper.find('[data-nav-path="/production"]').text()).toContain("视频生产");
    expect(wrapper.find('[data-nav-path="/assets"]').text()).toContain("资产中心");
    expect(wrapper.text()).toContain("我的项目");
    wrapper.unmount();
  });
});
