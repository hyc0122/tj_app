// @vitest-environment jsdom
/**
 * R25-fix2 RED：工作台单项/批量视频提交必须在响应丢失后稳定重放，且不得泄漏底层错误。
 */
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import {
  computed,
  createApp,
  defineComponent,
  h,
  reactive,
  ref,
  type App,
} from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const axiosPost = vi.fn();
const dialogHarness = vi.hoisted(() => ({
  autoConfirm: true,
  callbacks: [] as Array<() => void | Promise<void>>,
}));
vi.mock("@/utils/axios", () => ({
  default: {
    post: (...args: unknown[]) => axiosPost(...args),
  },
}));

vi.mock("tdesign-vue-next", () => ({
  DialogPlugin: {
    confirm: (options: { onConfirm?: () => void | Promise<void> }) => {
      const dialog = { destroy: vi.fn() };
      if (options.onConfirm) dialogHarness.callbacks.push(options.onConfirm);
      if (dialogHarness.autoConfirm) queueMicrotask(() => void options.onConfirm?.());
      return dialog;
    },
  },
}));

import projectStore, { type Project } from "@/stores/project";
import { useGenerateActions } from "@/views/production/components/workbench/generate/composables/useGenerateActions";
import { safeWorkbenchVideoError } from "@/views/production/components/workbench/generate/composables/workbenchRequestIdentity";
import type { GenerateState } from "@/views/production/components/workbench/generate/composables/useGenerateState";
import { useTrackBatchActions } from "@/views/production/components/workbench/generate/components/composables/useTrackBatchActions";
import type {
  TrackComponentProps,
  TrackEmit,
} from "@/views/production/components/workbench/generate/components/composables/useTrackSelection";

const message = {
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
};

interface PostedRequest {
  url: string;
  body: Record<string, unknown>;
}

function projectFixture(): Project {
  return {
    id: "101",
    name: "R25-fix2",
    intro: "",
    type: "",
    artStyle: null,
    videoRatio: null,
    createTime: 0,
    updatedAt: 0,
    imageModel: "",
    videoModel: "dreamina-cli:seedance2.0fast",
    projectType: "script",
    imageQuality: "",
    mode: "",
    directorManual: "",
    projectUuid: "25252525-2525-4525-8525-252525252525",
  };
}

function videoPosts(endpoint: string): PostedRequest[] {
  return axiosPost.mock.calls
    .filter(([url]) => String(url) === endpoint)
    .map(([url, body]) => ({
      url: String(url),
      body: body as Record<string, unknown>,
    }));
}

function operationId(post: PostedRequest): string {
  const value = post.body.clientOperationId;
  expect(typeof value).toBe("string");
  expect(String(value)).not.toBe("");
  return String(value);
}

async function settleConfirm(): Promise<void> {
  await flushPromises();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await flushPromises();
}

async function settleMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

async function confirmNextDialog(): Promise<void> {
  const callback = dialogHarness.callbacks.shift();
  expect(callback).toBeTypeOf("function");
  await callback?.();
  await flushPromises();
}

function singleState(): {
  state: GenerateState;
  track: TrackItem;
  activeTrack: ReturnType<typeof ref<TrackItem | undefined>>;
} {
  const track: TrackItem = {
    id: 31,
    prompt: "镜头提示词 A",
    state: "未生成",
    medias: [],
    videoList: [],
    duration: 5,
  };
  const activeTrack = ref<TrackItem | undefined>(track);
  const state = {
    project: ref({ id: "101", videoModel: "dreamina-cli:seedance2.0fast", mode: "text" }),
    currentTrack: computed(() => activeTrack.value),
    modelParmas: ref({
      mode: "text",
      model: "dreamina-cli:seedance2.0fast",
      resolution: "720p",
      duration: 5,
      audio: false,
    }),
    modelStatus: ref(""),
    imageList: ref<UploadItem[]>([]),
    modeOptions: ref({
      name: "Seedance 2.0 Fast",
      modelName: "seedance2.0fast",
      type: "video" as const,
      mode: ["text" as const],
      audio: false as const,
      durationResolutionMap: [{ duration: [5], resolution: ["720p"] }],
    }),
  } as unknown as GenerateState;
  return { state, track, activeTrack };
}

function mountBatchComposable(pinia: Pinia): {
  app: App;
  el: HTMLElement;
  actions: ReturnType<typeof useTrackBatchActions>;
  props: TrackComponentProps;
  trackList: ReturnType<typeof ref<TrackItem[]>>;
  checkedTrackIds: ReturnType<typeof ref<number[]>>;
  episodesId: ReturnType<typeof ref<number>>;
} {
  const props = reactive<TrackComponentProps>({
    modelParmas: {
      mode: "text",
      model: "dreamina-cli:seedance2.0fast",
      resolution: "720p",
      duration: 5,
      audio: false,
    },
    imageList: [],
    clampDuration: (duration) => duration,
  });
  const trackList = ref<TrackItem[]>([
    { id: 41, prompt: "批量提示词 A", state: "未生成", medias: [], videoList: [], duration: 5 },
    { id: 42, prompt: "批量提示词 B", state: "未生成", medias: [], videoList: [], duration: 5 },
  ]);
  const activeTrackIndex = ref(0);
  const checkedTrackIds = ref([41, 42]);
  const checkAll = ref(true);
  const episodesId = ref(9);
  let actions!: ReturnType<typeof useTrackBatchActions>;
  const el = document.createElement("div");
  document.body.appendChild(el);
  const app = createApp(defineComponent({
    setup() {
      actions = useTrackBatchActions(
        props,
        activeTrackIndex,
        trackList,
        checkedTrackIds,
        checkAll,
        vi.fn() as unknown as TrackEmit,
      );
      return () => h("div");
    },
  }));
  app.use(pinia);
  app.provide("episodesId", episodesId);
  app.mount(el);
  return { app, el, actions, props, trackList, checkedTrackIds, episodesId };
}

describe("R25-fix2 工作台视频提交幂等身份", () => {
  const mounted: Array<{ app: App; el: HTMLElement }> = [];

  beforeEach(() => {
    const pinia = createPinia();
    setActivePinia(pinia);
    projectStore().activateProject(projectFixture(), {
      mode: "readwrite",
      reason: "owner_lock",
      lockHolder: "",
    });
    axiosPost.mockReset();
    message.error.mockReset();
    message.success.mockReset();
    message.warning.mockReset();
    dialogHarness.autoConfirm = true;
    dialogHarness.callbacks.length = 0;
    (globalThis as { $t?: (key: string) => string }).$t = (key) => key;
    (window as unknown as { $message: typeof message }).$message = message;
  });

  afterEach(() => {
    while (mounted.length) {
      const host = mounted.pop()!;
      host.app.unmount();
      host.el.remove();
    }
    vi.clearAllMocks();
  });

  it("单项：响应丢失复用 ID，成功清除，完整意图变化生成新 ID", async () => {
    const { state, track } = singleState();
    const actions = useGenerateActions(state, ref(9));

    axiosPost.mockRejectedValueOnce(new Error("response lost"));
    actions.generateVideo();
    await settleConfirm();

    axiosPost.mockResolvedValueOnce({ data: 501 });
    actions.generateVideo();
    await settleConfirm();

    let posts = videoPosts("/production/workbench/generateVideo");
    expect(posts).toHaveLength(2);
    expect(operationId(posts[1])).toBe(operationId(posts[0]));

    axiosPost.mockResolvedValueOnce({ data: 502 });
    actions.generateVideo();
    await settleConfirm();
    posts = videoPosts("/production/workbench/generateVideo");
    expect(operationId(posts[2])).not.toBe(operationId(posts[1]));

    axiosPost.mockRejectedValueOnce(new Error("response lost again"));
    actions.generateVideo();
    await settleConfirm();
    track.prompt = "镜头提示词 B";
    axiosPost.mockResolvedValueOnce({ data: 503 });
    actions.generateVideo();
    await settleConfirm();
    posts = videoPosts("/production/workbench/generateVideo");
    expect(operationId(posts[4])).not.toBe(operationId(posts[3]));
  });

  it("批量：响应丢失复用 ID，成功清除，跨轨道意图不误复用", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    projectStore().activateProject(projectFixture(), {
      mode: "readwrite",
      reason: "owner_lock",
      lockHolder: "",
    });
    const host = mountBatchComposable(pinia);
    mounted.push(host);

    axiosPost.mockRejectedValueOnce(new Error("response lost"));
    host.actions.batchGenVideo();
    await settleConfirm();

    axiosPost.mockResolvedValueOnce({
      data: [{ trackId: 41, videoId: 601 }, { trackId: 42, videoId: 602 }],
    });
    host.actions.batchGenVideo();
    await settleConfirm();

    let posts = videoPosts("/production/workbench/batchGenerateVideo");
    expect(posts).toHaveLength(2);
    expect(operationId(posts[1])).toBe(operationId(posts[0]));

    host.checkedTrackIds.value = [41, 42];
    axiosPost.mockResolvedValueOnce({
      data: [{ trackId: 41, videoId: 603 }, { trackId: 42, videoId: 604 }],
    });
    host.actions.batchGenVideo();
    await settleConfirm();
    posts = videoPosts("/production/workbench/batchGenerateVideo");
    expect(operationId(posts[2])).not.toBe(operationId(posts[1]));

    host.checkedTrackIds.value = [41, 42];
    axiosPost.mockRejectedValueOnce(new Error("response lost again"));
    host.actions.batchGenVideo();
    await settleConfirm();
    host.trackList.value[0]!.prompt = "批量提示词 A 已修改";
    axiosPost.mockResolvedValueOnce({
      data: [{ trackId: 41, videoId: 605 }, { trackId: 42, videoId: 606 }],
    });
    host.actions.batchGenVideo();
    await settleConfirm();
    posts = videoPosts("/production/workbench/batchGenerateVideo");
    expect(operationId(posts[4])).not.toBe(operationId(posts[3]));
  });

  it("旧并发成功响应不得清除同指纹后来分配的新 ID", async () => {
    const { state } = singleState();
    const actions = useGenerateActions(state, ref(9));
    let resolveFirst!: (value: { data: number }) => void;
    let resolveSecond!: (value: { data: number }) => void;
    axiosPost
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    actions.generateVideo();
    actions.generateVideo();
    await settleMicrotasks();
    let posts = videoPosts("/production/workbench/generateVideo");
    expect(posts).toHaveLength(2);
    const firstId = operationId(posts[0]);
    expect(operationId(posts[1])).toBe(firstId);

    resolveFirst({ data: 701 });
    await settleMicrotasks();
    axiosPost.mockRejectedValueOnce(new Error("third response lost"));
    actions.generateVideo();
    await settleConfirm();
    posts = videoPosts("/production/workbench/generateVideo");
    const newId = operationId(posts[2]);
    expect(newId).not.toBe(firstId);

    // 中文注释：旧响应此时才完成，不能把第三次请求保留的新 pending 身份删除。
    resolveSecond({ data: 702 });
    await settleMicrotasks();
    axiosPost.mockRejectedValueOnce(new Error("fourth response lost"));
    actions.generateVideo();
    await settleConfirm();
    posts = videoPosts("/production/workbench/generateVideo");
    expect(operationId(posts[3])).toBe(newId);
  });

  it.each([
    {
      label: "项目",
      prepare: (_state: GenerateState, _episodesId: ReturnType<typeof ref<number>>, _track: TrackItem) => undefined,
      mutate: (state: GenerateState) => {
        state.project.value = { ...state.project.value!, id: "202" };
      },
    },
    {
      label: "剧本",
      prepare: (_state: GenerateState, _episodesId: ReturnType<typeof ref<number>>, _track: TrackItem) => undefined,
      mutate: (_state: GenerateState, episodesId: ReturnType<typeof ref<number>>) => {
        episodesId.value = 10;
      },
    },
    {
      label: "轨道",
      prepare: (_state: GenerateState, _episodesId: ReturnType<typeof ref<number>>, _track: TrackItem) => undefined,
      mutate: (_state: GenerateState, _episodesId: ReturnType<typeof ref<number>>, track: TrackItem) => {
        track.prompt = "确认期间切换后的提示词";
      },
    },
    {
      label: "素材",
      prepare: (state: GenerateState) => {
        state.modelParmas.value.mode = "singleImage";
        state.imageList.value = [{
          id: 81,
          sources: "assets",
          fileType: "image",
          src: "/api/tianjiang/runtime/projects/p/files/files/images/a.png",
        }];
      },
      mutate: (state: GenerateState) => {
        state.imageList.value = [{
          id: 82,
          sources: "assets",
          fileType: "image",
          src: "/api/tianjiang/runtime/projects/p/files/files/images/b.png",
        }];
      },
    },
    {
      label: "模型参数",
      prepare: (_state: GenerateState, _episodesId: ReturnType<typeof ref<number>>, _track: TrackItem) => undefined,
      mutate: (state: GenerateState) => {
        state.modelParmas.value.resolution = "1080p";
      },
    },
  ])("单项确认框打开后$label身份变化必须拒绝混合请求", async ({ prepare, mutate }) => {
    const { state, track } = singleState();
    const episodesId = ref(9);
    prepare(state, episodesId, track);
    const actions = useGenerateActions(state, episodesId);
    dialogHarness.autoConfirm = false;

    actions.generateVideo();
    mutate(state, episodesId, track);
    await confirmNextDialog();

    expect(videoPosts("/production/workbench/generateVideo")).toHaveLength(0);
    expect(message.error).toHaveBeenLastCalledWith("生成配置已变化，请重新确认");
  });

  it("单项确认框打开后真正切换到另一轨道必须保持零请求", async () => {
    const { state, activeTrack } = singleState();
    const actions = useGenerateActions(state, ref(9));
    dialogHarness.autoConfirm = false;

    actions.generateVideo();
    activeTrack.value = {
      id: 32,
      prompt: "另一条轨道的提示词",
      state: "未生成",
      medias: [],
      videoList: [],
      duration: 5,
    };
    await confirmNextDialog();

    expect(videoPosts("/production/workbench/generateVideo")).toHaveLength(0);
    expect(message.error).toHaveBeenLastCalledWith("生成配置已变化，请重新确认");
  });

  it.each([
    {
      label: "项目",
      prepare: (_host: ReturnType<typeof mountBatchComposable>) => undefined,
      mutate: (_host: ReturnType<typeof mountBatchComposable>) => {
        const nextProject = projectFixture();
        nextProject.id = "202";
        projectStore().activateProject(nextProject, {
          mode: "readwrite",
          reason: "owner_lock",
          lockHolder: "",
        });
      },
    },
    {
      label: "剧本",
      prepare: (_host: ReturnType<typeof mountBatchComposable>) => undefined,
      mutate: (host: ReturnType<typeof mountBatchComposable>) => {
        host.episodesId.value = 10;
      },
    },
    {
      label: "勾选轨道身份",
      prepare: (_host: ReturnType<typeof mountBatchComposable>) => undefined,
      mutate: (host: ReturnType<typeof mountBatchComposable>) => {
        host.checkedTrackIds.value = [41];
      },
    },
    {
      label: "轨道提示词",
      prepare: (_host: ReturnType<typeof mountBatchComposable>) => undefined,
      mutate: (host: ReturnType<typeof mountBatchComposable>) => {
        host.trackList.value[0]!.prompt = "确认期间变化的批量提示词";
      },
    },
    {
      label: "素材",
      prepare: (host: ReturnType<typeof mountBatchComposable>) => {
        host.props.modelParmas.mode = "singleImage";
        host.props.imageList = [{
          id: 91,
          sources: "assets",
          fileType: "image",
          src: "/api/tianjiang/runtime/projects/p/files/files/images/a.png",
        }];
      },
      mutate: (host: ReturnType<typeof mountBatchComposable>) => {
        host.props.imageList = [{
          id: 92,
          sources: "assets",
          fileType: "image",
          src: "/api/tianjiang/runtime/projects/p/files/files/images/b.png",
        }];
      },
    },
    {
      label: "模型参数",
      prepare: (_host: ReturnType<typeof mountBatchComposable>) => undefined,
      mutate: (host: ReturnType<typeof mountBatchComposable>) => {
        host.props.modelParmas.resolution = "1080p";
      },
    },
  ])("批量确认框打开后$label变化必须拒绝混合请求", async ({ prepare, mutate }) => {
    const pinia = createPinia();
    setActivePinia(pinia);
    projectStore().activateProject(projectFixture(), {
      mode: "readwrite",
      reason: "owner_lock",
      lockHolder: "",
    });
    const host = mountBatchComposable(pinia);
    mounted.push(host);
    prepare(host);
    dialogHarness.autoConfirm = false;

    host.actions.batchGenVideo();
    mutate(host);
    await confirmNextDialog();

    expect(videoPosts("/production/workbench/batchGenerateVideo")).toHaveLength(0);
    expect(message.error).toHaveBeenLastCalledWith("生成配置已变化，请重新确认");
  });

  it("单项并发重放返回同一 videoId 时只保留一条 UI 记录", async () => {
    const { state, track } = singleState();
    const actions = useGenerateActions(state, ref(9));
    track.videoList.push({ id: 801, state: "已完成", src: "/files/completed.mp4" });
    let resolveFirst!: (value: { data: number }) => void;
    let resolveSecond!: (value: { data: number }) => void;
    axiosPost
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    actions.generateVideo();
    actions.generateVideo();
    await settleMicrotasks();
    const posts = videoPosts("/production/workbench/generateVideo");
    expect(posts).toHaveLength(2);
    expect(operationId(posts[1])).toBe(operationId(posts[0]));

    resolveFirst({ data: 801 });
    resolveSecond({ data: 801 });
    await settleConfirm();
    expect(track.videoList.filter((item) => item.id === 801)).toHaveLength(1);
    expect(track.videoList.find((item) => item.id === 801)).toMatchObject({
      state: "已完成",
      src: "/files/completed.mp4",
    });
  });

  it("批量并发重放返回相同 videoId 时逐轨只保留一条 UI 记录", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    projectStore().activateProject(projectFixture(), {
      mode: "readwrite",
      reason: "owner_lock",
      lockHolder: "",
    });
    const host = mountBatchComposable(pinia);
    mounted.push(host);
    host.trackList.value[0]!.videoList.push({
      id: 811,
      state: "已完成",
      src: "/files/completed-811.mp4",
    });
    host.trackList.value[1]!.videoList.push({
      id: 812,
      state: "生成失败",
      src: "",
      errorReason: "既有失败原因",
    });
    let resolveFirst!: (value: { data: Array<{ trackId: number; videoId: number }> }) => void;
    let resolveSecond!: (value: { data: Array<{ trackId: number; videoId: number }> }) => void;
    axiosPost
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    host.actions.batchGenVideo();
    host.actions.batchGenVideo();
    await settleMicrotasks();
    const posts = videoPosts("/production/workbench/batchGenerateVideo");
    expect(posts).toHaveLength(2);
    expect(operationId(posts[1])).toBe(operationId(posts[0]));

    const replay = [{ trackId: 41, videoId: 811 }, { trackId: 42, videoId: 812 }];
    resolveFirst({ data: replay });
    resolveSecond({ data: replay });
    await settleConfirm();
    expect(host.trackList.value[0]!.videoList.filter((item) => item.id === 811)).toHaveLength(1);
    expect(host.trackList.value[1]!.videoList.filter((item) => item.id === 812)).toHaveLength(1);
    expect(host.trackList.value[0]!.videoList.find((item) => item.id === 811)).toMatchObject({
      state: "已完成",
      src: "/files/completed-811.mp4",
    });
    expect(host.trackList.value[1]!.videoList.find((item) => item.id === 812)).toMatchObject({
      state: "生成失败",
      errorReason: "既有失败原因",
    });
  });

  it.each([
    ["Linux 绝对路径", "提交失败：/srv/tianjiang/db2.sqlite"],
    ["Windows 绝对路径", "提交失败：C:\\runtime\\db2.sqlite"],
    ["DROP SQL", "数据库失败：DROP TABLE o_video"],
    ["ALTER SQL", "数据库失败：ALTER TABLE o_video"],
    ["CREATE SQL", "数据库失败：CREATE TABLE o_video"],
    ["SQL 自由文本", "数据库失败：SQL error near task"],
    ["apiKey", "提交失败：apiKey=abc123"],
    ["api_key", "提交失败：api_key=abc123"],
    ["Cookie", "提交失败：Cookie=session-value"],
    ["token", "提交失败：token=token-value"],
    ["secret", "提交失败：secret=secret-value"],
    ["stack", "提交失败：Error: boom\nhelper@bundle.js:1:2"],
    ["未知中文自由文本", "服务端内部自由文本"],
  ])("错误脱敏：%s 不得作为服务端自由文本回显", (_label, unsafeMessage) => {
    expect(safeWorkbenchVideoError({ message: unsafeMessage }, "视频发起生成请求失败"))
      .toBe("视频发起生成请求失败");
  });

  it("错误展示只按稳定业务码映射本地中文，不采用服务端自由文案", () => {
    expect(safeWorkbenchVideoError({
      code: "DREAMINA_CLI_DISABLED",
      message: "服务端任意自由文本",
    }, "视频发起生成请求失败")).toBe("即梦 CLI 已关闭");
    expect(safeWorkbenchVideoError({
      code: "UNKNOWN_SERVER_CODE",
      message: "看似安全但未列入白名单的中文",
    }, "视频发起生成请求失败")).toBe("视频发起生成请求失败");
  });

  it("单项和批量均只显示稳定中文错误，不回显路径、SQL、Cookie 或令牌", async () => {
    const unsafe = new Error(
      "SQLITE_ERROR SELECT * FROM secret at C:\\runtime\\db2.sqlite cookie=session authorization=Bearer sk-secret",
    );
    const { state } = singleState();
    const actions = useGenerateActions(state, ref(9));
    axiosPost.mockRejectedValueOnce(unsafe);
    actions.generateVideo();
    await settleConfirm();
    expect(message.error).toHaveBeenLastCalledWith("视频发起生成请求失败");

    const pinia = createPinia();
    setActivePinia(pinia);
    projectStore().activateProject(projectFixture(), {
      mode: "readwrite",
      reason: "owner_lock",
      lockHolder: "",
    });
    const host = mountBatchComposable(pinia);
    mounted.push(host);
    axiosPost.mockRejectedValueOnce(unsafe);
    host.actions.batchGenVideo();
    await settleConfirm();

    const rendered = String(message.error.mock.calls.at(-1)?.[0] ?? "");
    expect(rendered).toBe("视频批量发起生成请求失败");
    expect(rendered).not.toMatch(/db2\.sqlite|SELECT|cookie|authorization|sk-secret/i);
  });
});
