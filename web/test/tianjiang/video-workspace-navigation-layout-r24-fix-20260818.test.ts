// @vitest-environment jsdom
/**
 * R24-fix RED：真实挂载视频工作区与业务菜单；严格模型详情；几何滚动合同。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import projectStore from "@/stores/project";

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

(globalThis as { $t?: (key: string) => string }).$t = (key: string) => {
  const table: Record<string, string> = {
    "workbench.menu.novel": "小说原文",
    "workbench.menu.scriptAgent": "剧本Agent",
    "workbench.menu.scriptManage": "剧本管理",
    "workbench.menu.cornerScape": "塑角造景",
    "workbench.menu.production": "视频生产",
    "workbench.menu.assetCenter": "资产中心",
  };
  return table[key] ?? key;
};

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

const VALID_VIDEO = {
  name: "即梦",
  modelName: "seedance2.0fast",
  type: "video",
  audio: false,
  mode: ["text"],
  durationResolutionMap: [{ duration: [5], resolution: ["720p"] }],
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
  const unique = [...new Set(marked)];
  return unique.filter((el) => {
    if ((el as HTMLElement).dataset?.localScroll != null) return false;
    const value = overflowYOf(el);
    return value === "auto" || value === "scroll";
  });
}

function boxHeight(el: HTMLElement): number {
  const fromStyle = parseFloat(el.style.height);
  if (Number.isFinite(fromStyle) && fromStyle > 0) return fromStyle;
  const computed = parseFloat(getComputedStyle(el).height);
  return Number.isFinite(computed) && computed > 0 ? computed : 0;
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
        child += boxHeight(node as HTMLElement);
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

function expectWorkspaceAlive(wrapper: VueWrapper) {
  expect(wrapper.find("[data-video-workspace]").exists()).toBe(true);
  expect(wrapper.find("[data-workspace-prompt]").exists()).toBe(true);
  expect(wrapper.find("[data-workspace-history]").exists()).toBe(true);
  expect(wrapper.find("[data-workspace-model]").exists()).toBe(true);
}

async function mountWorkbench() {
  const pinia = activateProject();
  const { default: Workbench } = await import("@/pages/workbench/index.vue");
  return mount(Workbench, {
    attachTo: document.body,
    global: {
      plugins: [
        pinia,
        createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
      ],
      stubs: {
        ...ICON_STUBS,
        RouterView: {
          template: '<div data-route-child style="height: 80px">短内容</div>',
        },
        hello: { template: "<div />" },
        ProjectWorkspaceGate: { template: "<slot />" },
        TTooltip: { template: "<div><slot /></div>" },
        TBadge: { template: "<div><slot /></div>" },
      },
    },
  });
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

describe("R24-fix 视频工作区必须真实挂载并严格解析详情", () => {
  it("Promise reject / 空对象 / 空 mode / 图片 / 缺 audio / 无效映射都只显示局部错误", async () => {
    const cases: Array<{ name: string; payload: unknown | (() => Promise<never>) }> = [
      { name: "reject", payload: () => Promise.reject(new Error("boom")) },
      { name: "empty", payload: {} },
      { name: "empty-mode", payload: { ...VALID_VIDEO, name: "空模式", mode: [] } },
      { name: "image", payload: { ...VALID_VIDEO, name: "图片模型", type: "image", mediaType: "image" } },
      { name: "no-audio", payload: { name: "无音频", modelName: "x", type: "video", mode: ["text"], durationResolutionMap: [{ duration: [5], resolution: ["720p"] }] } },
      { name: "bad-map", payload: { ...VALID_VIDEO, name: "坏映射", durationResolutionMap: [{ duration: "5", resolution: 720 }] } },
    ];
    for (const item of cases) {
      const wrapper = await mountGenerate(async () => {
        if (typeof item.payload === "function") return item.payload();
        return item.payload;
      });
      expectWorkspaceAlive(wrapper);
      const status = wrapper.find("[data-workspace-status]");
      expect(status.exists()).toBe(true);
      expect(status.text()).toMatch(/不可用|无效|失败|关闭|详情/);
      expect(wrapper.text()).not.toContain("图片模型");
      expect(wrapper.text()).not.toContain("空模式");
      wrapper.unmount();
    }
  });

  it("先慢后快乱序响应不得覆盖新模型，主体与历史区仍在", async () => {
    let releaseSlow!: (value: unknown) => void;
    const slow = new Promise((resolve) => {
      releaseSlow = resolve;
    });
    const wrapper = await mountGenerate(async (modelId) => {
      if (modelId === "volcengine:video") {
        return slow.then(() => ({ ...VALID_VIDEO, name: "旧模型", modelName: "old" }));
      }
      return { ...VALID_VIDEO, name: "即梦" };
    });
    const apiModel = wrapper.vm as { modelParmas?: { model?: string } };
    void apiModel;
    const generateStateHost = wrapper.find("[data-video-workspace]");
    expect(generateStateHost.exists()).toBe(true);
    const input = wrapper.vm as unknown as { modelParmas: { model: string } };
    if (input.modelParmas) {
      input.modelParmas.model = "dreamina-cli:seedance2.0fast";
    }
    await flushPromises();
    releaseSlow({});
    await flushPromises();
    await nextTick();
    expectWorkspaceAlive(wrapper);
    expect(wrapper.text()).not.toContain("旧模型");
    wrapper.unmount();
  });
});

describe("R24-fix 滚动几何", () => {
  it("短页面不得出现根滚动；长页面只能有一个纵向滚动容器", async () => {
    axiosPost.mockImplementation(async (url: string) => {
      if (String(url).includes("getGenerateData")) {
        return { data: { storyboardList: [], trackList: [TRACK] } };
      }
      if (String(url).includes("getModelDetail")) return { data: VALID_VIDEO };
      return { data: {} };
    });
    const workbench = await mountWorkbench();
    const generate = await mountGenerate(async () => VALID_VIDEO);
    await flushPromises();
    const shell = workbench.find("[data-page-shell]").element as HTMLElement;
    const scroller = workbench.find("[data-content-scroll]").element as HTMLElement;
    applyExplicitBox(shell, 400);
    applyExplicitBox(scroller, 320);
    const shortChild = workbench.find("[data-route-child]").element as HTMLElement;
    shortChild.style.height = "80px";
    expect(getComputedStyle(document.documentElement).scrollbarGutter || "auto").not.toBe("stable");
    expect(overflowYOf(shell) === "hidden" || overflowYOf(shell) === "clip").toBe(true);
    const workspace = generate.find("[data-video-workspace]").element;
    expect(overflowYOf(workspace)).not.toMatch(/auto|scroll/);
    const generateCss = readFileSync(
      path.join(process.cwd(), "src/views/production/components/workbench/generate/styles/generate-page.scss"),
      "utf8",
    );
    expect(generateCss).not.toMatch(/\.index\s*\{[^}]*overflow-y:\s*auto/);
    const shortScrollers = pageScrollers(shell);
    expect(shortScrollers).toHaveLength(1);
    expect(shortScrollers[0]).toBe(scroller);
    expect(scroller.scrollHeight).toBeLessThanOrEqual(scroller.clientHeight);
    shortChild.style.height = "2400px";
    await nextTick();
    const longScrollers = pageScrollers(shell);
    expect(longScrollers).toHaveLength(1);
    expect(longScrollers[0]).toBe(scroller);
    expect(overflowYOf(scroller)).toMatch(/auto|scroll/);
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    expect(overflowYOf(shell)).not.toMatch(/auto|scroll/);
    generate.unmount();
    workbench.unmount();
  });
});

describe("R24-fix 左上业务菜单", () => {
  it("六个菜单是按钮，可点击/键盘激活，并保持 active 与窄宽布局", async () => {
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    const wrapper = await mountWorkbench();
    await flushPromises();
    const unresolved = warnings.filter((item) => item.includes("Failed to resolve component"));
    expect(unresolved).toEqual([]);
    warnSpy.mockRestore();
    const nav = wrapper.find("[data-business-nav]");
    expect(nav.exists()).toBe(true);
    const title = wrapper.find("[data-page-title]");
    expect(title.exists()).toBe(true);
    const expected: Array<[string, string]> = [
      ["/novel", "小说原文"],
      ["/scriptAgent", "剧本Agent"],
      ["/script", "剧本管理"],
      ["/cornerScape", "塑角造景"],
      ["/production", "视频生产"],
      ["/assets", "资产中心"],
    ];
    for (const [href, label] of expected) {
      const item = wrapper.find(`[data-nav-path="${href}"]`);
      expect(item.exists()).toBe(true);
      expect(item.element.tagName).toBe("BUTTON");
      expect(getComputedStyle(item.element).display).toBe("flex");
      expect(getComputedStyle(item.element).alignItems).toBe("center");
      expect(item.find(".icon").exists()).toBe(true);
      expect(item.text()).toContain(label);
    }
    const production = wrapper.find('[data-nav-path="/production"]');
    expect(production.classes()).toContain("active");
    expect(production.attributes("aria-current")).toBe("page");
    const novel = wrapper.find('[data-nav-path="/novel"]');
    await novel.trigger("click");
    expect(routerPush).toHaveBeenCalledWith("/novel");
    routerPush.mockReset();
    await wrapper.find('[data-nav-path="/assets"]').trigger("keydown.enter");
    expect(routerPush).toHaveBeenCalledWith("/assets");
    routerPush.mockReset();
    await wrapper.find('[data-nav-path="/script"]').trigger("keydown.space");
    expect(routerPush).toHaveBeenCalledWith("/script");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(wrapper.find("[data-page-title]").exists()).toBe(true);
    expect(wrapper.find('[data-nav-path="/novel"]').text()).toContain("小说原文");
    expect(getComputedStyle(nav.element).flexWrap === "wrap" || nav.element.clientWidth <= (wrapper.find("[data-page-shell]").element as HTMLElement).clientWidth).toBe(true);
    wrapper.unmount();
  });
});
