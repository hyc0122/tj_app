// @vitest-environment jsdom
/**
 * R23-fix RED：可见开关必须走 setEnabled；旧 GET 不得覆盖 POST；视频必须有首帧预览。
 */
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import { buildStoryboardMediaUrl } from "@/views/storyboardProject/storyboard-media-url";
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

describe("R23-fix 启停入口与视频首帧", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("真实可见开关必须请求 setEnabled，而不是 updateSettings", async () => {
    setActivePinia(createPinia());
    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("dreaminaCli/getSettings")) {
        return Promise.resolve({ data: { executablePath: "dreamina", enabled: true, maxConcurrency: 1, pauseNewClaims: false, updatedAt: 100 } });
      }
      if (String(url).includes("dreaminaCli/getStatus")) {
        return Promise.resolve({
          data: {
            install: { state: "installed", version: "r23-fix" },
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
      data: { enabled: false, updatedAt: 200, install: { state: "installed" }, account: { state: "unknown" }, queue: { paused: true } },
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
          TSwitch: {
            props: ["modelValue"],
            emits: ["change"],
            template: `<button data-field="dreamina-enabled" type="button" @click="$emit('change', false)">{{ modelValue }}</button>`,
          },
        },
      },
    });
    await flushPromises();
    await wrapper.get('[data-field="dreamina-enabled"]').trigger("click");
    await flushPromises();
    expect(axiosPost).toHaveBeenCalledWith("/setting/dreaminaCli/setEnabled", { enabled: false });
    expect(axiosPost.mock.calls.some((call) => String(call[0]).includes("updateSettings") && Boolean((call[1] as { enabled?: unknown })?.enabled !== undefined))).toBe(false);
    wrapper.unmount();
  });

  it("POST 之后到达的同 revision 旧 GET 不得把关闭状态改回开启", async () => {
    setActivePinia(createPinia());
    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("getSettings")) {
        return Promise.resolve({ data: { executablePath: "dreamina", enabled: true, updatedAt: 300 } });
      }
      return Promise.resolve({
        data: {
          install: { state: "installed" },
          account: { state: "logged_in", verified: true },
          capability: { state: "ready" },
          queue: { paused: false },
          enabled: true,
          updatedAt: 300,
        },
      });
    });
    axiosPost.mockResolvedValue({
      data: { enabled: false, updatedAt: 300, install: { state: "installed" }, account: { state: "unknown" } },
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
          TSwitch: { template: "<button data-field=\"dreamina-enabled\" />" },
        },
      },
    });
    await flushPromises();
    await wrapper.get('[data-action="set-dreamina-enabled"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("已关闭");
    axiosGet.mockImplementation(() => Promise.resolve({
      data: {
        install: { state: "installed" },
        account: { state: "logged_in", verified: true },
        enabled: true,
        updatedAt: 300,
        queue: { paused: false },
      },
    }));
    const reloadStatus = (wrapper.vm as { reloadStatus?: () => Promise<void> }).reloadStatus
      ?? (wrapper.vm.$ as { setupState?: { reloadStatus?: () => Promise<void> } }).setupState?.reloadStatus;
    expect(typeof reloadStatus).toBe("function");
    await reloadStatus!();
    await flushPromises();
    expect(wrapper.text()).toContain("已关闭");
    expect(wrapper.text()).not.toContain("已开启");
    wrapper.unmount();
  });

  it("已采用视频必须直接显示预览画面和居中播放按钮，失败显示安全空态", async () => {
    const { default: ShotCandidateStrip } = await import(
      "@/views/storyboardProject/components/ShotCandidateStrip.vue"
    );
    const play = vi.fn(async () => undefined);
    const pause = vi.fn();
    HTMLMediaElement.prototype.play = play;
    HTMLMediaElement.prototype.pause = pause;
    const wrapper = mount(ShotCandidateStrip, {
      props: {
        projectUuid: "b0232323-2323-4323-a323-232323232323",
        mediaType: "video",
        candidates: [
          candidate({ candidateUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", selected: true }),
        ],
      },
      global: { stubs: { TIcon: { template: "<i />" } } },
    });
    await flushPromises();
    const preview = wrapper.get('[data-candidate-preview="video"]');
    expect(preview.find("[data-video-poster], [data-preview-frame]").exists()).toBe(true);
    const playButton = wrapper.get('[data-action="toggle-video-playback"]');
    await playButton.trigger("click");
    expect(play).toHaveBeenCalled();
    await playButton.trigger("click");
    expect(pause).toHaveBeenCalled();
    wrapper.get("[data-preview-video]").element.dispatchEvent(new Event("error"));
    await flushPromises();
    expect(wrapper.text()).toContain("视频无法预览");
    wrapper.unmount();
  });

  it("切换候选不得让旧视频加载结果覆盖新候选，外部路径必须拒绝", async () => {
    const { default: ShotCandidateStrip } = await import(
      "@/views/storyboardProject/components/ShotCandidateStrip.vue"
    );
    const wrapper = mount(ShotCandidateStrip, {
      props: {
        projectUuid: "b0232323-2323-4323-a323-232323232323",
        mediaType: "video",
        candidates: [
          candidate({ candidateUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", selected: true }),
        ],
      },
      global: { stubs: { TIcon: { template: "<i />" } } },
    });
    await flushPromises();
    await wrapper.setProps({
      candidates: [
        candidate({ candidateUuid: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1", selected: true, createdAt: "2026-08-18T00:00:02Z" }),
      ],
    });
    await flushPromises();
    expect(wrapper.find('[data-selected-candidate="cccccccc-cccc-4ccc-8ccc-ccccccccccc1"]').exists()).toBe(true);
    const stale = wrapper.find("[data-preview-video]");
    if (stale.exists()) {
      stale.element.dispatchEvent(new Event("loadeddata"));
    }
    expect(wrapper.find('[data-selected-candidate="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"]').exists()).toBe(false);
    wrapper.unmount();

    expect(() => buildStoryboardMediaUrl("b0232323-2323-4323-a323-232323232323", "file://C:/secret.mp4")).toThrow();
    expect(() => buildStoryboardMediaUrl("b0232323-2323-4323-a323-232323232323", "C:/secret.mp4")).toThrow();
    expect(() => buildStoryboardMediaUrl("b0232323-2323-4323-a323-232323232323", "https://evil.example/a.mp4")).toThrow();
  });
});
