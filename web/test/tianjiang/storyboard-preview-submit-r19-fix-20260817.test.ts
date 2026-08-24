// @vitest-environment jsdom
/**
 * R19-fix RED：设置页预览必须使用当前分镜和已保存设置；音频 URL 必须绑定当前 origin。
 */
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import StoryboardSettings from "@/views/storyboardProject/components/StoryboardSettings.vue";
import { pickSafeProjectRuntimeFileUrl } from "@/views/cornerScape/composables/safeProjectRuntimeUrl";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const axiosPut = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    put: (...args: unknown[]) => axiosPut(...args),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/stores/setting", () => ({
  default: () => ({
    activeMenu: "",
    showSetting: false,
    isElectron: true,
    baseUrl: "http://127.0.0.1:18765/api",
  }),
}));

const projectUuid = "f1919191-1919-4191-a191-191919191919";
const shotUuid = "f1919191-ffff-4fff-8fff-ffffffffffff";
const relativeSrc = `/api/tianjiang/runtime/projects/${projectUuid}/files/audios/r19-voice.mp3`;
const currentOriginSrc = `http://127.0.0.1:18765${relativeSrc}`;

const savedSettings = {
  aspectRatio: "9:16",
  durationMs: 5000,
  globalImagePrompt: "",
  globalVideoPrompt: "统一夜戏光影，禁止现代招牌。",
  videoPromptTemplateId: 1,
  videoPromptTemplateContent: "风格：{{style}}。\n{{shot_prompt}}",
};

const tdesignStubs = {
  TButton: {
    inheritAttrs: true,
    props: ["loading", "disabled"],
    template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
  },
  TIcon: { template: "<i />" },
  TDialog: {
    inheritAttrs: true,
    props: ["visible", "header"],
    template: `<section v-if="visible" role="dialog"><slot /><slot name="footer" /></section>`,
  },
};

function i18n() {
  return createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
}

function interceptorPayload<T>(data: T) {
  return { code: 0, data, message: "成功" };
}

describe("R19-fix 设置页最终预览必须绑定当前分镜且只用已保存设置", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPut.mockReset();
    axiosGet.mockImplementation((url: string) => {
      if (String(url).includes("/storyboard/settings")) return Promise.resolve(interceptorPayload(savedSettings));
      if (String(url).includes("/storyboard/video-templates")) {
        return Promise.resolve(interceptorPayload({
          templates: [{ id: 1, name: "系统默认视频指令", content: savedSettings.videoPromptTemplateContent, system: true }],
        }));
      }
      return Promise.resolve(interceptorPayload({}));
    });
    axiosPost.mockResolvedValue(interceptorPayload({
      previewDigest: "ab".repeat(32),
      providerModel: "dreamina-cli:seedance2.0fast",
      prompt: "统一夜戏光影，禁止现代招牌。\n\n风格：玄幻。\n稳定跟拍。",
      options: { aspectRatio: "9:16", durationMs: 5000, mode: "text2video", resolution: "720p" },
      referenceSummary: { image: { count: 0, labels: [] }, video: { count: 0, labels: [] }, audio: { count: 0, labels: [] } },
    }));
  });

  it("无分镜时必须禁用预览且零请求", async () => {
    const wrapper = mount(StoryboardSettings, {
      props: { projectUuid, providerModel: "dreamina-cli:seedance2.0fast", selectedShotUuid: "" },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    await flushPromises();
    const button = wrapper.get('[data-action="preview-storyboard-settings"]');
    expect((button.element as HTMLButtonElement).disabled).toBe(true);
    await button.trigger("click");
    await flushPromises();
    expect(axiosPost.mock.calls.some(([url]) => String(url).includes("/generate/preview"))).toBe(false);
    expect(wrapper.get("[data-preview-status=settings]").text()).toContain("当前没有可预览的分镜");
    wrapper.unmount();
  });

  it("未保存 globalVideoPrompt 变化时不得发预览，且不得把未保存值纳入请求", async () => {
    const wrapper = mount(StoryboardSettings, {
      props: { projectUuid, providerModel: "dreamina-cli:seedance2.0fast", selectedShotUuid: shotUuid },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    await flushPromises();
    await wrapper.get('[name="globalVideoPrompt"]').setValue("未保存的伪造全局提示词");
    await wrapper.get('[data-action="preview-storyboard-settings"]').trigger("click");
    await flushPromises();
    expect(axiosPost.mock.calls.some(([url]) => String(url).includes("/generate/preview"))).toBe(false);
    expect(wrapper.get("[data-preview-status=settings]").text()).toBe("请先保存设置再预览");
    expect(JSON.stringify(axiosPost.mock.calls)).not.toContain("未保存的伪造全局提示词");
    wrapper.unmount();
  });

  it("已保存设置且有当前分镜时，预览请求必须携带真实 shotUuid", async () => {
    const wrapper = mount(StoryboardSettings, {
      props: { projectUuid, providerModel: "dreamina-cli:seedance2.0fast", selectedShotUuid: shotUuid },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    await flushPromises();
    await wrapper.get('[data-action="preview-storyboard-settings"]').trigger("click");
    await flushPromises();
    const previewCalls = axiosPost.mock.calls.filter(([url]) => String(url).includes("/generate/preview"));
    expect(previewCalls).toHaveLength(1);
    expect(previewCalls[0]![1]).toMatchObject({ shotUuid });
    expect(JSON.stringify(previewCalls[0]![1])).not.toContain("未保存的伪造全局提示词");
    wrapper.unmount();
  });
});

describe("R19-fix 音频 URL 必须绑定当前本地服务 origin", () => {
  const origin = "http://127.0.0.1:18765";

  it("相对受保护路径和当前 origin 绝对 URL 可通过；错误端口/主机切换/凭据/外部/file/盘符必须拒绝", () => {
    expect(pickSafeProjectRuntimeFileUrl(relativeSrc, false, origin)).toBe(relativeSrc);
    expect(pickSafeProjectRuntimeFileUrl(currentOriginSrc, false, origin)).toBeTruthy();
    expect(pickSafeProjectRuntimeFileUrl(`http://127.0.0.1:10588${relativeSrc}`, false, origin)).toBeUndefined();
    expect(pickSafeProjectRuntimeFileUrl(`http://localhost:18765${relativeSrc}`, false, origin)).toBeUndefined();
    expect(pickSafeProjectRuntimeFileUrl(`http://user:pass@127.0.0.1:18765${relativeSrc}`, false, origin)).toBeUndefined();
    expect(pickSafeProjectRuntimeFileUrl("https://cdn.evil.test/a.mp3", false, origin)).toBeUndefined();
    expect(pickSafeProjectRuntimeFileUrl("http://example.com" + relativeSrc, false, origin)).toBeUndefined();
    expect(pickSafeProjectRuntimeFileUrl("file:///C:/Users/alice/a.mp3", false, origin)).toBeUndefined();
    expect(pickSafeProjectRuntimeFileUrl("C:\\Users\\alice\\a.mp3", false, origin)).toBeUndefined();
  });
});
