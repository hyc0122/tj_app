// @vitest-environment jsdom
/**
 * R24 RED：原视频工作区切即梦不得黑屏；顶部业务菜单左移并显示标题；短页面无幽灵滚动。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import { useGenerateState } from "@/views/production/components/workbench/generate/composables/useGenerateState";
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
vi.mock("vue-router", () => ({
  useRouter: () => ({ push: routerPush }),
  useRoute: () => ({ path: "/production", fullPath: "/production" }),
}));

(globalThis as { $t?: (key: string) => string }).$t = (key: string) => key;

function workbenchSource(): string {
  return readFileSync(path.join(process.cwd(), "src/pages/workbench/index.vue"), "utf8");
}

function generatePageSource(): string {
  return readFileSync(
    path.join(process.cwd(), "src/views/production/components/workbench/generate/index.vue"),
    "utf8",
  );
}

describe("R24 原视频工作区切换即梦 CLI", () => {
  const hosts: Array<{ app: ReturnType<typeof createApp>; el: HTMLElement }> = [];

  afterEach(() => {
    for (const host of hosts) {
      host.app.unmount();
      host.el.remove();
    }
    hosts.length = 0;
    axiosPost.mockReset();
    vi.clearAllMocks();
  });

  function mountState() {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const pinia = createPinia();
    setActivePinia(pinia);
    projectStore().activateProject({
      id: "101",
      name: "R24",
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
    } as never, { mode: "readwrite", reason: "owner_lock", lockHolder: "" });
    let api!: ReturnType<typeof useGenerateState>;
    const app = createApp(defineComponent({
      setup() {
        api = useGenerateState(ref(9));
        return () => h("div");
      },
    }));
    app.use(pinia);
    app.mount(el);
    hosts.push({ app, el });
    return api;
  }

  it("即梦详情失败时不得把 modeOptions 写成空对象导致工作区渲染中断", async () => {
    const api = mountState();
    axiosPost.mockResolvedValueOnce({
      data: { name: "Seedance", modelName: "v", durationResolutionMap: [{ duration: [5], resolution: ["720p"] }], audio: false, type: "video", mode: ["text"] },
    });
    api.modelParmas.value.model = "volcengine:video";
    await flushPromises();
    axiosPost.mockResolvedValueOnce({
      data: { code: "DREAMINA_CLI_DISABLED", message: "即梦 CLI 已关闭" },
    });
    api.modelParmas.value.model = "dreamina-cli:seedance2.0fast";
    await flushPromises();
    await nextTick();
    expect(api.modeOptions.value && typeof api.modeOptions.value === "object").toBe(true);
    expect(Array.isArray(api.modeOptions.value.mode)).toBe(true);
    expect(String((api as { modelStatus?: { value?: string } }).modelStatus?.value ?? "")).toMatch(/即梦|关闭|不可用/);
  });

  it("旧的 getModelDetail 不得覆盖用户最新选择", async () => {
    const api = mountState();
    let releaseSlow!: (value: unknown) => void;
    const slow = new Promise((resolve) => { releaseSlow = resolve; });
    axiosPost.mockImplementation((url: string) => {
      if (String(url).includes("getModelDetail") && String(axiosPost.mock.calls.at(-1)?.[1] && (axiosPost.mock.calls.at(-1)?.[1] as { modelId?: string }).modelId) === "volcengine:video") {
        return slow.then(() => ({
          data: { name: "旧模型", modelName: "old", durationResolutionMap: [], audio: false, type: "video", mode: ["text"] },
        }));
      }
      return Promise.resolve({
        data: { name: "即梦", modelName: "seedance2.0fast", durationResolutionMap: [{ duration: [5], resolution: ["720p"] }], audio: false, type: "video", mode: ["text"] },
      });
    });
    api.modelParmas.value.model = "volcengine:video";
    await Promise.resolve();
    api.modelParmas.value.model = "dreamina-cli:seedance2.0fast";
    await flushPromises();
    releaseSlow({});
    await flushPromises();
    expect(api.modeOptions.value.name).toBe("即梦");
    expect(api.modelParmas.value.model).toBe("dreamina-cli:seedance2.0fast");
  });

  it("视频工作区模板必须始终渲染主体分区，失败只能局部提示", () => {
    const source = generatePageSource();
    expect(source).toContain('data-video-workspace');
    expect(source).toContain('data-workspace-prompt');
    expect(source).toContain('data-workspace-model');
    expect(source).toContain('data-workspace-history');
    expect(source).toContain('data-workspace-status');
  });
});

describe("R24 顶部业务菜单", () => {
  afterEach(() => {
    routerPush.mockReset();
  });

  it("业务菜单必须在标题左侧并同时显示图标和中文标题，右侧容器不得再渲染", async () => {
    const source = workbenchSource();
    expect(source).toContain('data-business-nav');
    expect(source).toContain('data-page-title');
    expect(source).not.toMatch(/class="rightBtnList/);
    expect(source).not.toMatch(/\.rightBtnList[\s\S]*\.label\s*\{\s*display:\s*none/);
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
      imageModel: "",
      videoModel: "",
      projectType: "novel",
      imageQuality: "",
      mode: "",
      directorManual: "",
    } as never, { mode: "readwrite", reason: "owner_lock", lockHolder: "", projectUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } as never);
    const { default: Workbench } = await import("@/pages/workbench/index.vue");
    const wrapper = mount(Workbench, {
      global: {
        plugins: [
          pinia,
          createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
        ],
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
    const nav = wrapper.find("[data-business-nav]");
    expect(nav.exists()).toBe(true);
    const title = wrapper.find("[data-page-title]");
    expect(title.exists()).toBe(true);
    expect(wrapper.text()).toContain("小说原文");
    expect(wrapper.text()).toContain("剧本Agent");
    expect(wrapper.text()).toContain("剧本管理");
    expect(wrapper.text()).toContain("塑角造景");
    expect(wrapper.text()).toContain("视频生产");
    expect(wrapper.text()).toContain("资产中心");
    expect(wrapper.find(".rightBtnList").exists()).toBe(false);
    const expectedNav: Array<[string, string]> = [
      ["/novel", "小说原文"],
      ["/scriptAgent", "剧本Agent"],
      ["/script", "剧本管理"],
      ["/cornerScape", "塑角造景"],
      ["/production", "视频生产"],
      ["/assets", "资产中心"],
    ];
    for (const [path, title] of expectedNav) {
      const item = wrapper.find(`[data-nav-path="${path}"]`);
      expect(item.exists()).toBe(true);
      expect(item.find(".icon").exists() || item.find("component").exists() || item.html().includes("icon")).toBe(true);
      expect(item.text()).toContain(title);
    }
    const novel = wrapper.find('[data-nav-path="/novel"]');
    expect(novel.exists()).toBe(true);
    expect(novel.text()).toContain("小说原文");
    await novel.trigger("click");
    expect(routerPush).toHaveBeenCalledWith("/novel");
    wrapper.unmount();
  });
});

describe("R24 短页面滚动容器", () => {
  it("主壳不得用 100vw 或 100vh-32px，短内容只允许内容区滚动", () => {
    const source = workbenchSource();
    expect(source).not.toMatch(/width:\s*100vw/);
    expect(source).not.toMatch(/100vh\s*-\s*32px/);
    expect(source).toMatch(/--app-titlebar-height/);
    expect(source).toContain('data-page-shell');
    expect(source).toContain('data-content-scroll');
    expect(source).not.toMatch(/height:\s*calc\(100%\s*-\s*6vh\)/);
    const generate = generatePageSource();
    expect(generate).not.toMatch(/height:\s*calc\(100vh\s*-\s*120px\)/);
    const mainScss = readFileSync(path.join(process.cwd(), "src/assets/main.scss"), "utf8");
    expect(mainScss).not.toMatch(/scrollbar-gutter\s*:\s*stable/);
    expect(mainScss).toMatch(/html[\s\S]*body[\s\S]*#app[\s\S]*height:\s*100%/);
    const appSource = readFileSync(path.join(process.cwd(), "src/App.vue"), "utf8");
    expect(appSource).not.toMatch(/\.startup-error-page[\s\S]{0,200}width:\s*100vw/);
    expect(appSource).not.toMatch(/100vh\s*-\s*32px/);
  });

  it("常用桌面宽度下短内容由内容区滚动，长内容不得改回 body 双滚动", async () => {
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
      imageModel: "",
      videoModel: "",
      projectType: "novel",
      imageQuality: "",
      mode: "",
      directorManual: "",
    } as never, { mode: "readwrite", reason: "owner_lock", lockHolder: "", projectUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } as never);
    const { default: Workbench } = await import("@/pages/workbench/index.vue");
    const wrapper = mount(Workbench, {
      attachTo: document.body,
      global: {
        plugins: [
          pinia,
          createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
        ],
        stubs: {
          RouterView: {
            template: '<div data-long-fixture style="height: 2400px">长内容</div>',
          },
          hello: { template: "<div />" },
          ProjectWorkspaceGate: { template: "<slot />" },
          TTooltip: { template: "<div><slot /></div>" },
          TBadge: { template: "<div><slot /></div>" },
        },
      },
    });
    await flushPromises();
    const source = workbenchSource();
    expect(source).toMatch(/\.main[\s\S]*overflow:\s*hidden/);
    expect(source).toMatch(/\.viewBox[\s\S]*overflow:\s*auto/);
    for (const [width, height] of [[1280, 720], [1440, 900], [1920, 1080]] as const) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
      window.dispatchEvent(new Event("resize"));
      await nextTick();
      expect(wrapper.find("[data-page-shell]").exists()).toBe(true);
      expect(wrapper.find("[data-content-scroll]").exists()).toBe(true);
      expect(wrapper.find("[data-long-fixture]").exists()).toBe(true);
      expect(wrapper.find('[data-nav-path="/novel"]').text()).toContain("小说原文");
      expect(wrapper.find('[data-nav-path="/production"]').text()).toContain("视频生产");
    }
    wrapper.unmount();
  });
});
