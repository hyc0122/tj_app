// @vitest-environment jsdom
/**
 * R25 RED：分镜预览 URL 未走 /api；工作台即梦详情/提交静默失败；新手引导只在 finish 时落盘。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { computed, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import { buildStoryboardMediaUrl, safeStoryboardAssetMediaUrl } from "@/views/storyboardProject/storyboard-media-url";
import { parseVideoModelDetail } from "@/views/production/components/workbench/generate/composables/generateLogic";

const axiosPost = vi.fn(async (_url: string, _body?: unknown) => ({ data: {} }));
vi.mock("@/utils/axios", () => ({
  default: {
    post: (...args: unknown[]) => axiosPost(...(args as [string, unknown?])),
    get: vi.fn(async () => ({ data: {} })),
  },
}));

vi.mock("tdesign-vue-next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tdesign-vue-next")>();
  return {
    ...actual,
    DialogPlugin: {
      confirm: (options: { onConfirm?: () => void | Promise<void> }) => {
        void options.onConfirm?.();
        return { destroy() {} };
      },
    },
  };
});

const messageError = vi.fn();
beforeEach(() => {
  (window as { $message?: { error: typeof messageError; success: typeof messageError; warning: typeof messageError }; $t?: (key: string) => string }).$message = {
    error: messageError,
    success: vi.fn(),
    warning: vi.fn(),
  };
  (window as { $t?: (key: string) => string }).$t = (key: string) => key;
  (globalThis as { $t?: (key: string) => string }).$t = (key: string) => key;
  messageError.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("R25 P1-1 分镜视频预览必须走受保护 /api 路径", () => {
  const projectUuid = "b0252501-2501-4501-a501-250125012501";

  it("buildStoryboardMediaUrl 必须生成 /api/tianjiang/runtime 同源路径", () => {
    const url = buildStoryboardMediaUrl(projectUuid, "files/videos/storyboard/shot/a.mp4");
    expect(url.startsWith(`/api/tianjiang/runtime/projects/${projectUuid}/files/`)).toBe(true);
    expect(url.includes("/tianjiang/runtime/projects/") && !url.includes("/api/tianjiang/")).toBe(false);
  });

  it("安全校验只接受当前同源受保护路径，拒绝外部/file/data/盘符/穿越", () => {
    const safe = `/api/tianjiang/runtime/projects/${projectUuid}/files/videos/storyboard/shot/a.mp4`;
    expect(safeStoryboardAssetMediaUrl(safe)).toBe(safe);
    expect(safeStoryboardAssetMediaUrl(`/tianjiang/runtime/projects/${projectUuid}/files/videos/a.mp4`)).toBe("");
    expect(safeStoryboardAssetMediaUrl("https://evil.example/a.mp4")).toBe("");
    expect(safeStoryboardAssetMediaUrl("file:///C:/secret.mp4")).toBe("");
    expect(safeStoryboardAssetMediaUrl("data:video/mp4;base64,aaa")).toBe("");
    expect(safeStoryboardAssetMediaUrl("C:/secret.mp4")).toBe("");
    expect(() => buildStoryboardMediaUrl(projectUuid, "files/../project.sqlite")).toThrow();
    expect(() => buildStoryboardMediaUrl(projectUuid, "https://evil.example/a.mp4")).toThrow();
  });

  it("play() 被拒绝时显示稳定中文错误且无未处理 Promise", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    HTMLMediaElement.prototype.play = vi.fn(() => Promise.reject(new DOMException("play blocked", "NotAllowedError")));
    HTMLMediaElement.prototype.pause = vi.fn();
    const { default: ShotCandidateStrip } = await import(
      "@/views/storyboardProject/components/ShotCandidateStrip.vue"
    );
    const wrapper = mount(ShotCandidateStrip, {
      props: {
        projectUuid,
        mediaType: "video",
        candidates: [{
          candidateUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
          mediaType: "video",
          relativePath: "files/videos/storyboard/shot/a.mp4",
          selected: true,
          createdAt: "2026-08-19T00:00:00Z",
        }],
      },
      global: { stubs: { TIcon: { template: "<i />" } } },
    });
    await flushPromises();
    const playButton = wrapper.find('[data-action="toggle-video-playback"]');
    expect(playButton.exists()).toBe(true);
    await playButton.trigger("click");
    await flushPromises();
    await nextTick();
    expect(wrapper.text()).toMatch(/无法预览|无法播放/);
    expect(unhandled).toEqual([]);
    process.off("unhandledRejection", onUnhandled);
    wrapper.unmount();
  });
});

describe("R25 P1-2 工作台即梦详情必须是 VideoModel 结构", () => {
  it("CLI 原生目录条目不得被当成工作台详情", () => {
    const parsed = parseVideoModelDetail({
      id: "dreamina-cli",
      label: "Seedance 2.0 Fast",
      value: "dreamina-cli:seedance2.0fast",
      type: "video",
      name: "即梦 CLI",
      modes: ["text2video", "image2video"],
      aspectRatios: ["16:9"],
      resolutions: ["720p"],
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("R25 P1-3 缺轨道/模型时前端不得静默返回", () => {
  it("未选择轨道时必须弹出中文错误", async () => {
    const { useGenerateActions } = await import(
      "@/views/production/components/workbench/generate/composables/useGenerateActions"
    );
    const empty = {
      currentTrack: computed(() => undefined as never),
      project: ref({ id: "12", videoModel: "dreamina-cli:seedance2.0fast", mode: "text" }),
      modelParmas: ref({
        mode: "text",
        model: "dreamina-cli:seedance2.0fast",
        resolution: "720p",
        duration: 5,
        audio: false,
      }),
      modelStatus: ref(""),
      imageList: ref([]),
      modeOptions: ref({ name: "", modelName: "", type: "video", mode: [], audio: false, durationResolutionMap: [] }),
    };
    const actions = useGenerateActions(empty as never, ref(9));
    actions.generateVideo();
    await flushPromises();
    expect(messageError).toHaveBeenCalled();
    expect(String(messageError.mock.calls[0]?.[0] ?? "")).toMatch(/轨道|模型|详情/);
    expect(axiosPost).not.toHaveBeenCalled();
  });
});

describe("R25 P1-4 新手引导必须按账号和版本持久化", () => {
  it("index.vue 必须把关闭、跳过、完成统一交给应用自有持久化控件，且不得使用全局 productionCurrent", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/views/production/index.vue"),
      "utf8",
    );
    expect(source).toMatch(/<ProductionGuideControls/);
    expect(source).toMatch(/:complete="completeProductionGuide"/);
    expect(source).not.toMatch(/@skip=/);
    expect(source).not.toMatch(/@close="completeProductionGuide"/);
    expect(source).not.toMatch(/useLocalStorage\(\s*["']productionCurrent["']/);
  });

  it("服务端已完成当前版本时不再显示，旧版本记录仍会显示", async () => {
    const {
      PRODUCTION_GUIDE_VERSION,
      createProductionGuideController,
    } = await import("@/views/production/production-guide");
    const completed = createProductionGuideController({
      get: vi.fn().mockResolvedValue({
        data: { completedRevision: PRODUCTION_GUIDE_VERSION },
      }),
      put: vi.fn(),
    });
    await completed.initialize();
    expect(completed.current.value).toBe(-1);

    const stale = createProductionGuideController({
      get: vi.fn().mockResolvedValue({ data: { completedRevision: 0 } }),
      put: vi.fn(),
    });
    await stale.initialize();
    expect(stale.current.value).toBe(0);
  });
});
