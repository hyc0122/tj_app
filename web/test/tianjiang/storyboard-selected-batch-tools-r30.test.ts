// @vitest-environment jsdom
/**
 * RED3：字面量计数游标、模块切换写锁、已打开导入弹窗只读。
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

const projectUuid = "30000000-0000-4000-a000-000000000001";
const sourceProjectUuid = "30000000-0000-4000-a000-000000000002";
const shotOneUuid = "30000000-0000-4000-a000-000000000101";

const shots = [
  {
    shotUuid: shotOneUuid,
    displayOrder: 1,
    sourceText: "源一",
    visualDescription: "画面一",
    videoPrompt: "aaaa",
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
  return Boolean((wrapper.get(selector).element as HTMLButtonElement).disabled);
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
    name: "R30 勾选工具",
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
    videoModel: "dreamina-cli:seedance2.0fast",
  } as any;
  store.access = { projectUuid, mode: "readwrite", reason: "test_open", lockHolder: "" };
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
  axiosGet.mockImplementation((url: string) => {
    if (url.endsWith("/shots")) return Promise.resolve({ data: { data: shots } });
    if (url.endsWith("/assets")) return Promise.resolve({ data: { data: { sourceProjectUuid, assets } } });
    return Promise.resolve({ data: { data: { queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 } } } });
  });
  axiosPost.mockImplementation((url: string) => {
    if (url.endsWith("/modelSelect/getModelList")) {
      return Promise.resolve({
        data: { data: { items: [{ value: "dreamina-cli:seedance2.0fast", type: "video", disabled: false }], providers: [] } },
      });
    }
    if (String(url).includes("/import/preview")) {
      return Promise.resolve({ data: { data: { digest: "preview-digest", rows: [{ sourceText: "一条" }] } } });
    }
    return Promise.resolve({ data: { code: 0, data: {} } });
  });
});

describe("R30 计数与写锁", () => {
  it("纯计数/规划函数对不重叠 aa 计为 2，且不调用 split/join/replaceAll", async () => {
    const spec = ["../../src/views/storyboardProject/", "storyboard-prompt-replace"].join("");
    const mod = await import(/* @vite-ignore */ spec);
    const originalSplit = String.prototype.split;
    const originalJoin = Array.prototype.join;
    const originalReplaceAll = String.prototype.replaceAll;
    let forbiddenCalls = 0;
    String.prototype.split = function (...args: [any, ...any[]]) {
      forbiddenCalls += 1;
      return originalSplit.apply(this, args);
    };
    Array.prototype.join = function (...args: [any, ...any[]]) {
      forbiddenCalls += 1;
      return originalJoin.apply(this, args);
    };
    String.prototype.replaceAll = function (...args: [any, ...any[]]) {
      forbiddenCalls += 1;
      return originalReplaceAll.apply(this, args);
    };
    try {
      expect(mod.countLiteralOccurrences("aaaa", "aa")).toBe(2);
      expect(mod.countLiteralOccurrences("aaa", "aa")).toBe(1);
      expect(mod.planLiteralReplacement("aaaa", "aa", "b")).toEqual({ count: 2, projectedLength: 2 });
      expect(mod.applyLiteralReplacement("aaaa", "aa", "b")).toBe("bb");
      expect(forbiddenCalls).toBe(0);
    } finally {
      String.prototype.split = originalSplit;
      Array.prototype.join = originalJoin;
      String.prototype.replaceAll = originalReplaceAll;
    }
  });

  it("匹配 pending 时三个模块按钮禁用，点击资产管理/设置仍停留分镜，导入不得写", async () => {
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
      if (String(url).includes("/import/preview")) {
        return Promise.resolve({ data: { data: { digest: "preview-digest", rows: [{ sourceText: "一条" }] } } });
      }
      if (url.endsWith("/shots/actions/auto-match-assets")) return pending;
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = await mountWorkspace();
    await wrapper.get(".storyboardToolbar [data-action=\"open-import\"]").trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-dialog="storyboard-import"]').exists()).toBe(true);
    await wrapper.get("textarea").setValue("场景,人物,道具,分镜提示词\nA,B,C,D");
    await wrapper.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();

    await wrapper.get(`[data-shot-select="${shotOneUuid}"]`).setValue(true);
    await wrapper.get('[data-action="auto-match-assets"]').trigger("click");
    await flushPromises();

    expect(isDisabled(wrapper, '[data-module="shots"]')).toBe(true);
    expect(isDisabled(wrapper, '[data-module="assets"]')).toBe(true);
    expect(isDisabled(wrapper, '[data-module="settings"]')).toBe(true);
    await wrapper.get('[data-module="assets"]').trigger("click");
    await wrapper.get('[data-module="settings"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-module="shots"]').classes()).toContain("active");
    expect(wrapper.find('[data-panel="corner-scape-assets"]').exists()).toBe(false);

    const importWritesBefore = axiosPost.mock.calls.filter(([url]) => String(url).includes("/import/commit")).length;
    await wrapper.get('[data-action="commit-import"]').trigger("click");
    await flushPromises();
    const importWritesAfter = axiosPost.mock.calls.filter(([url]) => String(url).includes("/import/commit")).length;
    expect(importWritesAfter).toBe(importWritesBefore);

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
});
