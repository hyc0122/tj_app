// @vitest-environment jsdom
/**
 * R23 RED：启停按钮、已采用视频自动预览、播放控件。
 */
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import { readSafeGenerationSubmitError } from "@/views/storyboardProject/storyboard-generation-preview";
import type { WorkspaceCandidate } from "@/views/storyboardProject/storyboard-workbench-types";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
  },
}));

function candidate(partial: Partial<WorkspaceCandidate> & Pick<WorkspaceCandidate, "candidateUuid" | "selected">): WorkspaceCandidate {
  return {
    mediaType: "video",
    relativePath: `files/videos/storyboard/shot/${partial.candidateUuid}.mp4`,
    createdAt: "2026-08-18T00:00:00Z",
    ...partial,
  };
}

describe("R23 即梦启停与视频预览", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("稳定错误必须分码，未知错误才兜底", () => {
    expect(readSafeGenerationSubmitError(
      { code: "DREAMINA_CLI_DISABLED", message: "即梦 CLI 已关闭" },
      "提交生成失败，请重试",
    )).toBe("即梦 CLI 已关闭");
    expect(readSafeGenerationSubmitError(
      { code: "DREAMINA_CLI_START_FAILED", message: "即梦 CLI 启动失败" },
      "提交生成失败，请重试",
    )).toBe("即梦 CLI 启动失败");
    expect(readSafeGenerationSubmitError(
      { code: "DREAMINA_CLI_INVALID_ARGUMENT", message: "即梦 CLI 请求参数不合法" },
      "提交生成失败，请重试",
    )).toBe("即梦 CLI 请求参数不合法");
    expect(readSafeGenerationSubmitError(
      { code: "DREAMINA_BATCH_PERSIST_FAILED", message: "生成任务入队失败，请重试" },
      "提交生成失败，请重试",
    )).toBe("生成任务入队失败，请重试");
    expect(readSafeGenerationSubmitError(
      { code: "RAW", message: "E:\\\\cli\\\\dreamina.exe SELECT cookie" },
      "提交生成失败，请重试",
    )).toBe("提交生成失败，请重试");
  });

  it("模型服务页必须显示打开/关闭即梦 CLI 按钮和当前状态", async () => {
    setActivePinia(createPinia());
    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("dreaminaCli/getSettings")) {
        return Promise.resolve({ data: { executablePath: "dreamina", enabled: true, maxConcurrency: 1, pauseNewClaims: false } });
      }
      if (String(url).includes("dreaminaCli/getStatus")) {
        return Promise.resolve({
          data: {
            install: { state: "installed", version: "r23" },
            account: { state: "logged_in", verified: true },
            capability: { state: "ready" },
            queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 },
            enabled: true,
            updatedAt: 100,
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    axiosPost.mockResolvedValue({
      data: { enabled: false, updatedAt: 200, install: { state: "installed" }, account: { state: "unknown" } },
    });
    const { default: DreaminaProviderPanel } = await import(
      "@/components/setting/components/vendorConfig/components/DreaminaProviderPanel.vue"
    );
    const wrapper = mount(DreaminaProviderPanel, {
      global: {
        plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
        stubs: {
          TButton: { template: "<button><slot /></button>" },
          TIcon: { template: "<i />" },
          TSwitch: { template: "<button data-legacy-switch />" },
        },
      },
    });
    await flushPromises();
    const toggle = wrapper.find('[data-action="set-dreamina-enabled"]');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain("关闭即梦 CLI");
    expect(wrapper.text()).toContain("已开启");
    await toggle.trigger("click");
    await flushPromises();
    expect(axiosPost).toHaveBeenCalledWith("/setting/dreaminaCli/setEnabled", { enabled: false });
    wrapper.unmount();
  });

  it("进入镜头必须自动选择已采用视频并显示播放按钮", async () => {
    const { default: ShotCandidateStrip } = await import(
      "@/views/storyboardProject/components/ShotCandidateStrip.vue"
    );
    const play = vi.fn(async () => undefined);
    const pause = vi.fn();
    HTMLMediaElement.prototype.play = play;
    HTMLMediaElement.prototype.pause = pause;
    const wrapper = mount(ShotCandidateStrip, {
      props: {
        projectUuid: "b0232301-2301-4301-a301-230123012301",
        mediaType: "video",
        candidates: [
          candidate({ candidateUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", selected: false, createdAt: "2026-08-18T00:00:01Z" }),
          candidate({ candidateUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", selected: true, createdAt: "2026-08-18T00:00:00Z" }),
        ],
      },
      global: {
        stubs: { TIcon: { template: "<i />" } },
      },
    });
    await flushPromises();
    const preview = wrapper.find('[data-candidate-preview="video"]');
    expect(preview.exists()).toBe(true);
    expect(wrapper.find('[data-selected-candidate="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"]').exists()).toBe(true);
    const video = wrapper.find("video");
    expect(video.exists()).toBe(true);
    const playButton = wrapper.find('[data-action="toggle-video-playback"]');
    expect(playButton.exists()).toBe(true);
    await playButton.trigger("click");
    expect(play).toHaveBeenCalled();
    await playButton.trigger("click");
    expect(pause).toHaveBeenCalled();
    wrapper.unmount();
  });

  it("切换镜头必须停止旧视频，加载失败显示安全空态", async () => {
    const { default: ShotCandidateStrip } = await import(
      "@/views/storyboardProject/components/ShotCandidateStrip.vue"
    );
    const play = vi.fn(async () => undefined);
    const pause = vi.fn();
    HTMLMediaElement.prototype.play = play;
    HTMLMediaElement.prototype.pause = pause;
    const wrapper = mount(ShotCandidateStrip, {
      props: {
        projectUuid: "b0232301-2301-4301-a301-230123012301",
        mediaType: "video",
        candidates: [
          candidate({ candidateUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", selected: true }),
        ],
      },
      global: {
        stubs: { TIcon: { template: "<i />" } },
      },
    });
    await flushPromises();
    await wrapper.find('[data-action="toggle-video-playback"]').trigger("click");
    await wrapper.setProps({
      candidates: [
        candidate({ candidateUuid: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1", selected: true, createdAt: "2026-08-18T00:00:02Z" }),
      ],
    });
    await flushPromises();
    expect(pause).toHaveBeenCalled();
    expect(wrapper.find('[data-selected-candidate="cccccccc-cccc-4ccc-8ccc-ccccccccccc1"]').exists()).toBe(true);
    wrapper.get("[data-preview-video]").element.dispatchEvent(new Event("error"));
    await flushPromises();
    expect(wrapper.text()).toContain("视频暂时无法播放");
    wrapper.unmount();
  });
});
