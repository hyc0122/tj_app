/**
 * 第三波：真实入口调用 assets/cornerScape/generate 本地 projectId 契约。
 * 每个 endpoint：调用次数 + URL + projectId 值/typeof；非法 ID 零请求。
 * 使用最小 Vue 宿主挂载含生命周期的 composable，禁止假覆盖。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";

const messageApi = {
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
};
// 全局 $t 与 $message（禁止用 stubGlobal 覆盖整个 window 导致 $message 丢失）
(globalThis as any).$t = (key: string) => key;
if (typeof window !== "undefined") {
  (window as any).$message = messageApi;
  (globalThis as any).$message = messageApi;
}

const axiosPost = vi.fn(async (_url: string, _body?: unknown) => ({ data: {} }));
vi.mock("@/utils/axios", () => ({
  default: {
    post: (...args: unknown[]) => axiosPost(...(args as [string, unknown?])),
    get: vi.fn(),
  },
}));

vi.mock("@/stores/setting", async () => {
  const { defineStore } = await import("pinia");
  const { ref: vref } = await import("vue");
  return {
    default: defineStore("setting-local-id-test", () => ({
      otherSetting: vref({ assetsBatchGenereateSize: 2 }),
    })),
  };
});

/** useFileDialog 可控回调 */
let fileDialogOnChange: ((files: FileList | null) => void) | null = null;
let fileDialogOnCancel: (() => void) | null = null;
vi.mock("@vueuse/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vueuse/core")>();
  return {
    ...actual,
    useFileDialog: () => ({
      open: vi.fn(() => {
        // open 后由测试侧注入 FileList
      }),
      onChange: (cb: (files: FileList | null) => void) => {
        fileDialogOnChange = cb;
      },
      onCancel: (cb: () => void) => {
        fileDialogOnCancel = cb;
      },
    }),
  };
});

vi.mock("tdesign-vue-next", () => ({
  DialogPlugin: {
    confirm: (opts: { onConfirm?: () => void | Promise<void> }) => {
      const dialog = { destroy: vi.fn() };
      queueMicrotask(() => {
        void opts.onConfirm?.();
      });
      return dialog;
    },
  },
}));

import { LocalProjectIdError, localProjectBody, toLocalProjectId } from "@/features/tianjiang/project/local-project-id";
import { useAssetsBatchActions } from "@/views/assets/composables/useAssetsBatchActions";
import { useAssetsItemActions } from "@/views/assets/composables/useAssetsItemActions";
import { useCornerScapeBatchActions } from "@/views/cornerScape/composables/useCornerScapeBatchActions";
import { useCornerScapeDrawer } from "@/views/cornerScape/composables/useCornerScapeDrawer";
import { useCornerScapePolling } from "@/views/cornerScape/composables/useCornerScapePolling";
import { useGenerateActions } from "@/views/production/components/workbench/generate/composables/useGenerateActions";
import { useGeneratePolling } from "@/views/production/components/workbench/generate/composables/useGeneratePolling";
import { useGenerateState } from "@/views/production/components/workbench/generate/composables/useGenerateState";
import type { AssetRecord } from "@/views/assets/composables/assetsLogic";
import type { CornerScapeItem } from "@/views/cornerScape/composables/cornerScapeTypes";
import type { GenerateState } from "@/views/production/components/workbench/generate/composables/useGenerateState";
import projectStore, { type Project } from "@/stores/project";

function postsExact(urlPart: string) {
  return axiosPost.mock.calls
    .filter(([url]) => String(url) === urlPart || String(url).endsWith(urlPart))
    .map(([url, body]) => ({ url: String(url), body: body as Record<string, unknown> }));
}

function postsInclude(part: string) {
  return axiosPost.mock.calls
    .filter(([url]) => String(url).includes(part))
    .map(([url, body]) => ({ url: String(url), body: body as Record<string, unknown> }));
}

function assertNumberProjectId(posts: Array<{ url: string; body: Record<string, unknown> }>, expected = 101) {
  expect(posts.length).toBeGreaterThan(0);
  for (const p of posts) {
    expect(p.body.projectId, p.url).toBe(expected);
    expect(typeof p.body.projectId, p.url).toBe("number");
  }
}

const baseProject = (id = "101"): Project => ({
  id,
  name: "p",
  intro: "",
  type: "",
  artStyle: null,
  videoRatio: null,
  createTime: 0,
  updatedAt: 0,
  imageModel: "",
  videoModel: "",
  projectType: "script",
  imageQuality: "",
  mode: "",
  directorManual: "",
  projectUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
});

function mockAssetsState(projectId: string = "101") {
  const asset: AssetRecord = {
    id: 11,
    name: "a1",
    type: "role",
    describe: "d",
    prompt: "p-prompt",
    state: "",
    promptState: "",
    sonAssets: [],
  } as AssetRecord;
  return {
    project: ref({ id: projectId }),
    tableData: ref([{ ...asset, sonAssets: [] }]),
    selectedRowKeys: ref<Array<string | number>>([11]),
    selectedSubRowKeys: ref<Array<string | number>>([]),
    assetOptions: ref("role"),
    findAssetById: (id: number) => (id === 11 ? asset : undefined),
    getFilteredData: vi.fn(async () => undefined),
  } as any;
}

function mockCornerState(projectId: string = "101") {
  const item: CornerScapeItem = {
    id: 21,
    name: "c1",
    type: "props",
    describe: "d",
    prompt: "hello",
    promptState: "",
    state: "",
    audioBindState: "",
    historyImages: [],
    relepedAudio: [],
    filePath: "",
    model: "",
    resolution: "1K",
  } as CornerScapeItem;
  return {
    project: ref({ id: projectId }),
    dataList: ref([{ ...item }]),
    selectedIds: ref([21]),
    checkboxValue: ref("props"),
    selectValue: ref("model-a"),
    resolution: ref("1K"),
    otherTextPrompt: ref("extra-hint"),
    getFilteredData: vi.fn(async () => undefined),
    createAbortController: () => new AbortController(),
  } as any;
}

function mockGenerateState(projectId: string = "101"): GenerateState {
  const track = {
    id: 31,
    state: "未生成",
    prompt: "v-prompt",
    medias: [] as any[],
    videoList: [{ id: 41, state: "生成中", src: "" }],
  };
  return {
    project: ref({ id: projectId, videoModel: "", mode: "" }),
    currentTrack: computed({
      get: () => track as any,
      set: () => undefined,
    }),
    modelParmas: ref({
      mode: "text",
      model: "m1",
      resolution: "480p",
      duration: 5,
      audio: false,
    }),
    // 中文注释：与当前生成动作契约保持一致，详情状态必须始终是可读的响应式字段。
    modeOptions: ref({
      name: "测试视频模型",
      modelName: "m1",
      durationResolutionMap: [],
      audio: false,
      type: "video",
      mode: ["text"],
    }),
    modelStatus: ref(""),
    imageList: ref([]),
    trackList: ref([track as any]),
  } as any;
}

/** 最小 Vue 宿主：挂载 setup，避免 onUnmounted 无实例警告 */
function mountComposable<T>(setup: () => T): { result: T; app: App; el: HTMLElement } {
  let result!: T;
  const el = document.createElement("div");
  document.body.appendChild(el);
  const app = createApp(
    defineComponent({
      setup() {
        result = setup();
        return () => h("div");
      },
    }),
  );
  app.use(createPinia());
  app.mount(el);
  return { result, app, el };
}

function unmountHost(host: { app: App; el: HTMLElement }) {
  host.app.unmount();
  host.el.remove();
}

/** 构造单文件 FileList */
function makeFileList(name = "clip.png"): FileList {
  const file = new File(["x"], name, { type: "image/png" });
  return {
    0: file,
    length: 1,
    item: (i: number) => (i === 0 ? file : null),
    [Symbol.iterator]: function* () {
      yield file;
    },
  } as FileList;
}

describe("localProjectBody 防覆盖", () => {
  it("extraBody.projectId 不得覆盖规范化 number", () => {
    const body = localProjectBody("101", { projectId: "bad" } as any);
    expect(body.projectId).toBe(101);
    expect(typeof body.projectId).toBe("number");
  });
});

describe("Assets 批量：独立状态 + 精确 endpoint", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosPost.mockClear();
    axiosPost.mockResolvedValue({ data: {} });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handleBatchGeneratePrompt 仅一次 batchPolish 且 projectId 为 number，含 otherTextPrompt", async () => {
    const state = mockAssetsState("101");
    const batch = useAssetsBatchActions(state);
    await batch.handleBatchGeneratePrompt();
    const polish = postsInclude("/assetsGenerate/batchPolishAssetsPrompt");
    expect(polish).toHaveLength(1);
    expect(polish[0].url).toContain("/assetsGenerate/batchPolishAssetsPrompt");
    assertNumberProjectId(polish, 101);
    expect(polish[0].body.otherTextPrompt).toBe("");
  });

  it("handleBatchGenerateImage 独立状态，仅一次 batchGenerateImageAssets", async () => {
    const state = mockAssetsState("101");
    const batch = useAssetsBatchActions(state);
    batch.selectValue.value = "model-x";
    batch.resolution.value = "1K";
    await batch.handleBatchGenerateImage();
    const gen = postsInclude("/assetsGenerate/batchGenerateImageAssets");
    expect(gen).toHaveLength(1);
    expect(gen[0].url).toContain("/assetsGenerate/batchGenerateImageAssets");
    assertNumberProjectId(gen, 101);
    expect(gen[0].body.model).toBe("model-x");
  });

  it("非法 projectId 时 batch 不发请求", async () => {
    const state = mockAssetsState(" 101 ");
    const batch = useAssetsBatchActions(state);
    batch.selectValue.value = "m";
    batch.resolution.value = "1K";
    await batch.handleBatchGenerateImage();
    // 错误被 catch 吞掉，但不得成功 post
    expect(axiosPost).toHaveBeenCalledTimes(0);
  });
});

describe("Assets uploadClip：真实 handleAdd('clip')", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosPost.mockClear();
    axiosPost.mockResolvedValue({ data: {} });
    fileDialogOnChange = null;
    fileDialogOnCancel = null;
    // FileReader mock：立即 onload
    class FR {
      result: string | ArrayBuffer | null = null;
      onload: ((ev: ProgressEvent<FileReader>) => void) | null = null;
      readAsDataURL(_f: Blob) {
        this.result = "data:image/png;base64,xx";
        queueMicrotask(() => {
          this.onload?.({} as ProgressEvent<FileReader>);
        });
      }
    }
    vi.stubGlobal("FileReader", FR);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("handleAdd clip 经 FileReader 后请求 /assets/uploadClip 且 projectId 为 number", async () => {
    const state = mockAssetsState("101");
    const items = useAssetsItemActions(state);
    const pending = items.handleAdd("clip");
    await Promise.resolve();
    expect(fileDialogOnChange).toBeTypeOf("function");
    fileDialogOnChange!(makeFileList("a.png"));
    await pending;
    await new Promise((r) => queueMicrotask(r));
    await new Promise((r) => queueMicrotask(r));
    const up = postsInclude("/assets/uploadClip");
    expect(up).toHaveLength(1);
    expect(up[0].url).toContain("/assets/uploadClip");
    assertNumberProjectId(up, 101);
    expect(up[0].body.name).toBe("a.png");
  });

  it("非法/空白/超安全整数 projectId 请求前失败，axios 次数为 0", async () => {
    for (const bad of [" 101 ", "0", String(Number.MAX_SAFE_INTEGER + 1)]) {
      axiosPost.mockClear();
      const state = mockAssetsState(bad);
      const items = useAssetsItemActions(state);
      const pending = items.handleAdd("clip");
      await Promise.resolve();
      expect(fileDialogOnChange).toBeTypeOf("function");
      fileDialogOnChange!(makeFileList());
      // onload 抛 LocalProjectIdError：捕获 unhandled 并确认零请求
      await pending.catch(() => undefined);
      await new Promise((r) => queueMicrotask(r));
      await new Promise((r) => queueMicrotask(r));
      expect(axiosPost.mock.calls.length, `bad=${bad}`).toBe(0);
    }
  });
});

describe("CornerScape：独立状态 + 公开入口 + 真实轮询", () => {
  const hosts: Array<{ app: App; el: HTMLElement }> = [];
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosPost.mockClear();
    axiosPost.mockResolvedValue({ data: [] });
  });
  afterEach(() => {
    while (hosts.length) unmountHost(hosts.pop()!);
    vi.restoreAllMocks();
  });

  it("batchGenerationPrompt 独立状态，一次 batchPolish + otherTextPrompt", async () => {
    const state = mockCornerState("101");
    const host = mountComposable(() => {
      const drawer = useCornerScapeDrawer(state);
      const batch = useCornerScapeBatchActions(state, drawer);
      return { batch };
    });
    hosts.push(host);
    await host.result.batch.batchGenerationPrompt();
    const polish = postsInclude("/assetsGenerate/batchPolishAssetsPrompt");
    expect(polish).toHaveLength(1);
    assertNumberProjectId(polish, 101);
    expect(polish[0].body.otherTextPrompt).toBe("extra-hint");
  });

  it("batchSelectBindAudio 独立状态，一次 batchBindAudio", async () => {
    const state = mockCornerState("101");
    const host = mountComposable(() => {
      const drawer = useCornerScapeDrawer(state);
      const batch = useCornerScapeBatchActions(state, drawer);
      return { batch };
    });
    hosts.push(host);
    await host.result.batch.batchSelectBindAudio();
    const bind = postsInclude("/cornerScape/batchBindAudio");
    expect(bind).toHaveLength(1);
    assertNumberProjectId(bind, 101);
  });

  it("batchGenerationImage 独立状态，一次 batchGenerateImageAssets", async () => {
    const state = mockCornerState("101");
    const host = mountComposable(() => {
      const drawer = useCornerScapeDrawer(state);
      const batch = useCornerScapeBatchActions(state, drawer);
      return { batch };
    });
    hosts.push(host);
    await host.result.batch.batchGenerationImage();
    const gen = postsInclude("/assetsGenerate/batchGenerateImageAssets");
    expect(gen).toHaveLength(1);
    assertNumberProjectId(gen, 101);
  });

  it("Drawer open/save/polish 经公开入口，projectId 为 number", async () => {
    const state = mockCornerState("101");
    axiosPost.mockImplementation(async (url: string) => {
      if (String(url).includes("getAllAssets")) {
        return { data: state.dataList.value };
      }
      return { data: { assetsId: 21, prompt: "polished" } };
    });
    const host = mountComposable(() => {
      const drawer = useCornerScapeDrawer(state);
      return { drawer };
    });
    hosts.push(host);
    const { drawer } = host.result;

    await drawer.openDrawer(state.dataList.value[0]);
    const gets = postsInclude("/cornerScape/getAllAssets");
    expect(gets.length).toBeGreaterThanOrEqual(1);
    assertNumberProjectId(gets, 101);

    axiosPost.mockClear();
    drawer.editForm.prompt = "changed-prompt";
    state.dataList.value[0].prompt = "old";
    drawer.currentItem.value = state.dataList.value[0];
    await drawer.savePromptOnBlur();
    const saves = postsInclude("/assets/saveAssets");
    expect(saves).toHaveLength(1);
    assertNumberProjectId(saves, 101);

    axiosPost.mockClear();
    await drawer.polishPrompts();
    const polish = postsInclude("/assetsGenerate/polishAssetsPrompt");
    expect(polish).toHaveLength(1);
    assertNumberProjectId(polish, 101);

    axiosPost.mockClear();
    // regenerate 公开入口
    drawer.editForm.prompt = "gen-prompt";
    drawer.editForm.resolution = "1K";
    drawer.editForm.model = "model-a";
    drawer.currentItem.value = state.dataList.value[0];
    drawer.regenerateItem();
    await new Promise((r) => setTimeout(r, 0));
    const gen = postsInclude("/assetsGenerate/generateAssets");
    expect(gen.length).toBeGreaterThanOrEqual(1);
    assertNumberProjectId(gen, 101);
  });

  it("Polling 经公开 polling* 入口在完成态触发 getAllAssets", async () => {
    const state = mockCornerState("101");
    // 初始生成中
    state.dataList.value[0].promptState = "生成中";
    state.dataList.value[0].state = "生成中";
    state.dataList.value[0].audioBindState = "生成中";

    axiosPost.mockImplementation(async (url: string, body?: unknown) => {
      const u = String(url);
      if (u.includes("pollingPromptAssets")) {
        return { data: [{ id: 21, promptState: "已完成", prompt: "done" }] };
      }
      if (u.includes("pollingImageAssets")) {
        return { data: [{ id: 21, state: "已完成", filePath: "/x.png" }] };
      }
      if (u.includes("pollingAudio")) {
        return { data: [{ id: 21, audioBindState: "已完成", filePath: "/a.mp3" }] };
      }
      if (u.includes("getAllAssets")) {
        return {
          data: [
            {
              ...state.dataList.value[0],
              historyImages: [{ id: 1, filePath: "/h.png" }],
              relepedAudio: [],
            },
          ],
        };
      }
      return { data: [] };
    });

    const host = mountComposable(() => {
      const drawer = useCornerScapeDrawer(state);
      const polling = useCornerScapePolling(state, drawer);
      return { polling, drawer };
    });
    hosts.push(host);

    await host.result.polling.pollingPromptAssets();
    await host.result.polling.pollingImageAssets();
    await host.result.polling.pollingAudioBind();

    const allAssets = postsInclude("/cornerScape/getAllAssets");
    // 三种轮询在 completed 时各触发一次 refreshRelatedData → getAllAssets
    expect(allAssets.length).toBeGreaterThanOrEqual(3);
    assertNumberProjectId(allAssets, 101);
  });
});

describe("Production generate：真实调用 + episodesId 未就绪零请求", () => {
  const hosts: Array<{ app: App; el: HTMLElement }> = [];
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosPost.mockClear();
    axiosPost.mockResolvedValue({ data: 99 });
  });
  afterEach(() => {
    while (hosts.length) unmountHost(hosts.pop()!);
    vi.restoreAllMocks();
  });

  it("genText/generateVideo/checkVideo* projectId number、scriptId 正整数", async () => {
    const state = mockGenerateState("101");
    const episodesId = ref(7);
    const host = mountComposable(() => {
      const actions = useGenerateActions(state, episodesId);
      const polling = useGeneratePolling(state, episodesId);
      return { actions, polling };
    });
    hosts.push(host);

    await host.result.actions.genText();
    const promptPosts = postsInclude("/production/workbench/generateVideoPrompt");
    expect(promptPosts).toHaveLength(1);
    assertNumberProjectId(promptPosts, 101);

    host.result.actions.generateVideo();
    await new Promise((r) => queueMicrotask(r));
    await new Promise((r) => queueMicrotask(r));
    const videoPosts = postsInclude("/production/workbench/generateVideo").filter(
      (p) => !p.url.includes("Prompt") && !p.url.includes("batch"),
    );
    expect(videoPosts).toHaveLength(1);
    assertNumberProjectId(videoPosts, 101);
    expect(videoPosts[0].body.scriptId).toBe(7);

    await host.result.polling.getVideoList();
    await host.result.polling.getTrackPromptList();
    const checks = [
      ...postsInclude("/production/workbench/checkVideoStateList"),
      ...postsInclude("/production/workbench/checkVideoPrompt"),
    ];
    expect(checks.length).toBe(2);
    assertNumberProjectId(checks, 101);
    for (const p of checks) {
      expect(p.body.scriptId).toBe(7);
      expect(typeof p.body.scriptId).toBe("number");
    }
  });

  it("episodesId 未初始化时 getVideoList 失败且零请求", async () => {
    const state = mockGenerateState("101");
    const episodesId = ref(undefined as unknown as number);
    const host = mountComposable(() => useGeneratePolling(state, episodesId));
    hosts.push(host);
    axiosPost.mockClear();
    await expect(host.result.getVideoList()).rejects.toThrow(LocalProjectIdError);
    expect(axiosPost).toHaveBeenCalledTimes(0);
  });

  it("getGenerateData 在 episodesId 就绪后发送 number scriptId", async () => {
    axiosPost.mockResolvedValue({
      data: { storyboardList: [], trackList: [] },
    });
    const episodesId = ref(0 as number);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const pinia = createPinia();
    setActivePinia(pinia);
    projectStore().activateProject(baseProject("101"), {
      mode: "readwrite",
      reason: "owner_lock",
      lockHolder: "",
    });
    let api!: ReturnType<typeof useGenerateState>;
    const app = createApp(
      defineComponent({
        setup() {
          api = useGenerateState(episodesId);
          return () => h("div");
        },
      }),
    );
    app.use(pinia);
    app.mount(el);
    hosts.push({ app, el });

    axiosPost.mockClear();
    // scriptId=0 非法，请求前失败
    await expect(api.getGenerateData()).rejects.toThrow(LocalProjectIdError);
    expect(axiosPost).toHaveBeenCalledTimes(0);

    episodesId.value = 9;
    await api.getGenerateData();
    const posts = postsInclude("/production/workbench/getGenerateData");
    expect(posts).toHaveLength(1);
    assertNumberProjectId(posts, 101);
    expect(posts[0].body.scriptId).toBe(9);
  });
});

describe("中央 UUID / 任务中心", () => {
  it("projectUuid 非法作为 toLocalProjectId", () => {
    expect(() => toLocalProjectId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toThrow(LocalProjectIdError);
  });
});
