// @vitest-environment jsdom
/**
 * R24-fix2 RED：真实模板 mode、映射合同、稳定选模型注入、完整壳滚动几何。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import projectStore from "@/stores/project";
import { parseVideoModelDetail } from "@/views/production/components/workbench/generate/composables/generateLogic";

const axiosPost = vi.fn(async (_url: string, _body?: unknown) => ({ data: {} }));
const axiosGet = vi.fn(async () => ({ data: {} }));
vi.mock("@/utils/axios", () => ({
  default: {
    post: (...args: unknown[]) => axiosPost(...(args as [string, unknown?])),
    get: (...args: unknown[]) => axiosGet(...(args as [string, unknown?])),
  },
}));
vi.mock("@/features/tianjiang/runtime/project-recovery", () => ({
  recoverActiveProjectAfterRuntimeRestart: vi.fn(),
}));

const routerPush = vi.fn();
const routePath = ref("/production");
vi.mock("vue-router", () => ({
  useRouter: () => ({ push: routerPush }),
  useRoute: () => ({ path: routePath.value, fullPath: routePath.value }),
}));

(globalThis as { $t?: (key: string) => string }).$t = (key: string) => key;

const ICON_STUBS = Object.fromEntries(
  [
    "i-bill",
    "i-setting-one",
    "i-folder-close",
    "i-view-list",
    "i-people",
    "i-notebook",
    "i-color-filter",
    "i-document-folder",
    "i-peoples-two",
    "i-carousel-video",
    "i-receive",
  ].map((name) => [name, { template: '<span class="icon" data-icon-stub></span>' }]),
);

const GENERATE_STUBS = {
  imageSelect: { template: '<div data-stub="refs" />' },
  modeMenu: { template: '<div data-stub="mode" />' },
  videoCard: { template: '<div data-stub="history-card">历史</div>' },
  newTrack: { template: '<div data-stub="track" />' },
  promptEditor: { template: "<textarea />" },
  TCard: { template: '<div class="t-card"><slot name="actions" /><slot /></div>' },
  TButton: { template: "<button type=\"button\"><slot /></button>" },
};

const TRACK = {
  id: 1,
  prompt: "夜戏跟拍",
  state: "未生成",
  medias: [],
  videoList: [{ id: 11, src: "/v.mp4", state: "已完成" }],
  duration: 5,
};

function activateProject() {
  const pinia = createPinia();
  setActivePinia(pinia);
  projectStore().activateProject({
    id: "101",
    name: "R24项目",
    intro: "",
    type: "video",
    artStyle: null,
    videoRatio: "9:16",
    createTime: 0,
    updatedAt: 0,
    imageModel: "volcengine:img",
    videoModel: "volcengine:video",
    projectType: "novel",
    imageQuality: "",
    mode: "text",
    directorManual: "",
  } as never, {
    mode: "readwrite",
    reason: "owner_lock",
    lockHolder: "",
    projectUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  } as never);
  return pinia;
}

function repoTemplate(name: string): string {
  return readFileSync(
    path.resolve(process.cwd(), "..", "app", "src", "provider-templates", name),
    "utf8",
  );
}

function overflowYOf(el: Element): string {
  const html = el as HTMLElement;
  if (html.style?.overflowY) return html.style.overflowY;
  if (html.style?.overflow) return html.style.overflow;
  const attr = html.getAttribute("style") || "";
  const match = attr.match(/overflow(?:-y)?\s*:\s*([a-z]+)/i);
  if (match?.[1]) return match[1];
  return getComputedStyle(html).overflowY || "visible";
}

function pageScrollers(root: Element): Element[] {
  const marked = [
    root,
    ...Array.from(root.querySelectorAll("[data-page-shell], [data-content-scroll], [data-video-workspace], [data-local-scroll]")),
  ];
  return [...new Set(marked)].filter((el) => {
    if ((el as HTMLElement).dataset?.localScroll != null) return false;
    const value = overflowYOf(el);
    return value === "auto" || value === "scroll";
  });
}

function applyExplicitBox(el: HTMLElement, height: number) {
  el.style.height = `${height}px`;
  el.style.maxHeight = `${height}px`;
  Object.defineProperty(el, "clientHeight", { configurable: true, value: height });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get() {
      let child = 0;
      for (const node of Array.from(el.children)) {
        const fromStyle = parseFloat((node as HTMLElement).style.height);
        child += Number.isFinite(fromStyle) ? fromStyle : 0;
      }
      return Math.max(height, child);
    },
  });
}

async function mountGenerate(detailFactory: (modelId: string) => Promise<unknown> | unknown) {
  axiosPost.mockImplementation(async (url: string, body?: unknown) => {
    if (String(url).includes("getGenerateData")) {
      return { data: { storyboardList: [], trackList: [TRACK] } };
    }
    if (String(url).includes("getModelDetail")) {
      const modelId = String((body as { modelId?: string } | undefined)?.modelId ?? "");
      return { data: await detailFactory(modelId) };
    }
    return { data: {} };
  });
  const pinia = activateProject();
  const { default: Generate } = await import(
    "@/views/production/components/workbench/generate/index.vue"
  );
  const wrapper = mount(Generate, {
    attachTo: document.body,
    global: {
      plugins: [
        pinia,
        createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
      ],
      provide: { episodesId: ref(9) },
      stubs: GENERATE_STUBS,
    },
  });
  await flushPromises();
  await nextTick();
  return wrapper;
}

beforeEach(() => {
  vi.spyOn(globalThis, "setInterval").mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
});

afterEach(() => {
  axiosPost.mockReset();
  axiosGet.mockReset();
  routerPush.mockReset();
  routePath.value = "/production";
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("R24-fix2 真实模板与映射合同", () => {
  it("必须接受现有模板中的 imageReference:N 等模式", () => {
    const files = [
      "volcengine.ts.template",
      "volcengineSd2.ts.template",
      "atlascloud.ts.template",
    ];
    for (const file of files) {
      const source = repoTemplate(file);
      expect(source).toMatch(/imageReference:\d+/);
      const parsed = parseVideoModelDetail({
        name: `模板-${file}`,
        modelName: "seedance",
        type: "video",
        audio: "optional",
        mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
        durationResolutionMap: [{ duration: [5, 8], resolution: ["720p"] }],
      });
      expect(parsed.ok, file).toBe(true);
    }
    expect(parseVideoModelDetail({
      name: "裸参考",
      modelName: "x",
      type: "video",
      audio: false,
      mode: [["imageReference", "videoReference", "textReference"]],
      durationResolutionMap: [{ duration: [5], resolution: ["720p"] }],
    }).ok).toBe(true);
    for (const bad of ["imageReference:0", "imageReference:-1", "imageReference:1.5", "imageReference:", "foo:9"]) {
      expect(parseVideoModelDetail({
        name: "坏参考",
        modelName: "x",
        type: "video",
        audio: false,
        mode: [[bad]],
        durationResolutionMap: [{ duration: [5], resolution: ["720p"] }],
      }).ok).toBe(false);
    }
  });

  it("空 durationResolutionMap、空组和非法数字必须拒绝", () => {
    const base = {
      name: "映射",
      modelName: "x",
      type: "video",
      audio: false,
      mode: ["text"],
    };
    expect(parseVideoModelDetail({ ...base, durationResolutionMap: [] }).ok).toBe(false);
    expect(parseVideoModelDetail({ ...base, durationResolutionMap: [{ duration: [], resolution: ["720p"] }] }).ok).toBe(false);
    expect(parseVideoModelDetail({ ...base, durationResolutionMap: [{ duration: [5], resolution: [] }] }).ok).toBe(false);
    expect(parseVideoModelDetail({ ...base, durationResolutionMap: [{ duration: [Number.NaN], resolution: ["720p"] }] }).ok).toBe(false);
    expect(parseVideoModelDetail({ ...base, durationResolutionMap: [{ duration: [Number.POSITIVE_INFINITY], resolution: ["720p"] }] }).ok).toBe(false);
    expect(parseVideoModelDetail({ ...base, durationResolutionMap: [{ duration: [0], resolution: ["720p"] }] }).ok).toBe(false);
    expect(parseVideoModelDetail({ ...base, durationResolutionMap: [{ duration: [5], resolution: [""] }] }).ok).toBe(false);
  });
});

describe("R24-fix2 真实选模型与滚动壳", () => {
  it("必须通过稳定注入切换模型，DOM 显示新名称且旧响应不得覆盖", async () => {
    let releaseSlow!: (value: unknown) => void;
    const slow = new Promise((resolve) => {
      releaseSlow = resolve;
    });
    const wrapper = await mountGenerate(async (modelId) => {
      if (modelId === "volcengine:video") {
        return slow.then(() => ({
          name: "旧模型",
          modelName: "old",
          type: "video",
          audio: false,
          mode: ["text"],
          durationResolutionMap: [{ duration: [5], resolution: ["720p"] }],
        }));
      }
      return {
        name: "即梦",
        modelName: "seedance2.0fast",
        type: "video",
        audio: false,
        mode: ["text"],
        durationResolutionMap: [{ duration: [5], resolution: ["720p"] }],
      };
    });
    const modelInput = wrapper.find("[data-video-model-input]");
    expect(modelInput.exists()).toBe(true);
    const node = modelInput.element as HTMLInputElement;
    node.value = "dreamina-cli:seedance2.0fast";
    await modelInput.trigger("input");
    await modelInput.trigger("change");
    const exposed = (wrapper.vm as unknown as { $?: { exposed?: { selectVideoModel?: (id: string) => void } } }).$?.exposed;
    expect(typeof exposed?.selectVideoModel).toBe("function");
    exposed?.selectVideoModel?.("dreamina-cli:seedance2.0fast");
    await flushPromises();
    await nextTick();
    expect(wrapper.find("[data-workspace-model-name]").exists()).toBe(true);
    expect(wrapper.find("[data-workspace-model-name]").text()).toBe("即梦");
    expect(wrapper.find("[data-video-workspace]").exists()).toBe(true);
    expect(wrapper.find("[data-workspace-history]").exists()).toBe(true);
    releaseSlow({});
    await flushPromises();
    await nextTick();
    expect(wrapper.find("[data-workspace-model-name]").text()).toBe("即梦");
    expect(wrapper.text()).not.toContain("旧模型");
    wrapper.unmount();
  });

  it("完整 workbench 壳：短内容无页面滚动，长内容只滚 viewBox", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    const pinia = activateProject();
    const { default: Workbench } = await import("@/pages/workbench/index.vue");
    const wrapper = mount({
      components: { Workbench },
      template: `
        <div id="app" data-app-root style="height: 900px; overflow: hidden">
          <div class="titleBar" data-titlebar style="height: 42px">天将漫创</div>
          <Workbench />
        </div>
      `,
    }, {
      attachTo: document.body,
      global: {
        plugins: [
          pinia,
          createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
        ],
        stubs: {
          ...ICON_STUBS,
          RouterView: { template: '<div data-route-child style="height: 80px">短内容</div>' },
          hello: { template: "<div />" },
          ProjectWorkspaceGate: { template: "<slot />" },
          TTooltip: { template: "<div><slot /></div>" },
          TBadge: { template: "<div><slot /></div>" },
        },
      },
    });
    await flushPromises();
    const root = wrapper.find("[data-app-root]").element as HTMLElement;
    const shell = wrapper.find("[data-page-shell]").element as HTMLElement;
    const scroller = wrapper.find("[data-content-scroll]").element as HTMLElement;
    applyExplicitBox(root, 900);
    applyExplicitBox(shell, 858);
    applyExplicitBox(scroller, 720);
    const shortChild = wrapper.find("[data-route-child]").element as HTMLElement;
    shortChild.style.height = "80px";
    expect(scroller.clientHeight).toBeGreaterThan(0);
    expect(scroller.scrollHeight).toBeLessThanOrEqual(scroller.clientHeight);
    expect(pageScrollers(shell)).toHaveLength(1);
    expect(pageScrollers(shell)[0]).toBe(scroller);
    shortChild.style.height = "2400px";
    await nextTick();
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    expect(pageScrollers(shell)).toHaveLength(1);
    expect(overflowYOf(scroller)).toMatch(/auto|scroll/);
    expect(overflowYOf(shell)).not.toMatch(/auto|scroll/);
    wrapper.unmount();
  });
});
