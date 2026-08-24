// @vitest-environment jsdom
/**
 * R19 RED：指令模板标签、loopback 音频、空模板清空、blob 代际、安全提交错误。
 */
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import projectStore from "@/stores/project";
import StoryboardSettings from "@/views/storyboardProject/components/StoryboardSettings.vue";
import FinalRequestPreview from "@/views/storyboardProject/components/FinalRequestPreview.vue";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";
import { useStoryboardWorkspace } from "@/views/storyboardProject/useStoryboardWorkspace";
import { pickSafeProjectRuntimeFileUrl } from "@/views/cornerScape/composables/safeProjectRuntimeUrl";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const axiosPut = vi.fn();
const axiosPatch = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    put: (...args: unknown[]) => axiosPut(...args),
    patch: (...args: unknown[]) => axiosPatch(...args),
    delete: vi.fn(),
  },
}));

vi.mock("@/stores/setting", () => ({
  default: () => ({ activeMenu: "", showSetting: false, isElectron: true, baseUrl: "http://127.0.0.1:18765/api" }),
}));

vi.mock("@/utils/assetsCheck", () => ({
  default: vi.fn(async () => [{
    id: 7,
    name: "33",
    src: "http://127.0.0.1:18765/api/tianjiang/runtime/projects/f1919191-1919-4191-a191-191919191919/files/audios/r19-voice.mp3",
    type: "audio",
  }]),
}));

const projectUuid = "f1919191-1919-4191-a191-191919191919";
const loopbackSrc = `http://127.0.0.1:18765/api/tianjiang/runtime/projects/${projectUuid}/files/audios/r19-voice.mp3`;
const relativeSrc = `/api/tianjiang/runtime/projects/${projectUuid}/files/audios/r19-voice.mp3`;
const previewDigest = "ab".repeat(32);
const operationId = "a1919191-1919-4191-8191-191919191919";

const systemTemplate = {
  id: 1,
  name: "系统默认视频指令",
  type: "storyboardVideoSystemTemplate",
  content: "风格：{{style}}。\n{{shot_prompt}}",
  system: true,
};
const emptyTemplate = {
  id: 3,
  name: "空指令",
  type: "storyboardVideoUserTemplate",
  content: "",
  system: false,
};

const tdesignStubs = {
  TButton: {
    inheritAttrs: true,
    props: ["loading", "disabled"],
    template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
  },
  TIcon: { template: "<i />" },
  TAvatar: { template: "<span />" },
  TSelect: { inheritAttrs: true, template: "<select></select>" },
  TDialog: {
    inheritAttrs: true,
    props: ["visible", "header"],
    template: `<section v-if="visible" role="dialog"><h2>{{ header }}</h2><div class="t-dialog__body"><slot /></div><footer class="t-dialog__footer"><slot name="footer" /></footer></section>`,
  },
  TDrawer: {
    inheritAttrs: true,
    props: ["visible", "modelValue"],
    emits: ["update:visible", "update:modelValue"],
    template: `<aside v-if="visible || modelValue" v-bind="$attrs" role="dialog"><slot /><slot name="footer" /></aside>`,
  },
  TTag: {
    inheritAttrs: true,
    props: ["closable"],
    template: '<span v-bind="$attrs"><slot /><button v-if="closable" type="button" data-action="remove-role-audio">x</button></span>',
  },
  TCard: { inheritAttrs: true, template: '<section v-bind="$attrs"><slot name="title" /><slot /></section>' },
  TForm: { template: "<form><slot /></form>" },
  TFormItem: { inheritAttrs: true, template: '<div v-bind="$attrs"><slot /></div>' },
  TEmpty: { template: "<div>empty</div>" },
  TLoading: { template: "<div><slot /></div>" },
  TInput: { inheritAttrs: true, template: "<input />" },
  TTextarea: { inheritAttrs: true, template: "<textarea />" },
  TCheckbox: { template: '<input type="checkbox" />' },
  TCheckboxGroup: { template: "<div><slot /></div>" },
  TImage: { template: "<img />" },
};

function i18n() {
  return createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
}

function interceptorPayload<T>(data: T) {
  return { code: 0, data, message: "成功" };
}

function roleWithAudio(src?: string) {
  return {
    id: 1,
    assetUuid: "bbbbbbbb-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    imageId: 11,
    type: "role",
    name: "姜晓棠",
    remark: "",
    imageRatio: "16:9",
    prompt: "portrait",
    filePath: "/safe.png",
    state: "已完成",
    model: "seedream-4.0",
    resolution: "1K",
    describe: "女主",
    promptState: "",
    historyImages: [],
    errorReason: "",
    promptErrorReason: "",
    relepedAudio: [{ id: 7, name: "33", ...(src ? { src } : {}) }],
    audioBindState: "",
  };
}

describe("R19 指令模板标签与空内容回显", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPut.mockReset();
  });

  it("可见标签必须是指令模板，且空模板必须清空旧内容", async () => {
    axiosGet.mockImplementation((url: string) => {
      const target = String(url);
      if (target.includes("/storyboard/settings")) {
        return Promise.resolve(interceptorPayload({
          aspectRatio: "9:16",
          durationMs: 5000,
          videoPromptTemplateId: 3,
          videoPromptTemplateContent: "旧模板残留不得保留",
        }));
      }
      if (target.includes("/storyboard/video-templates")) {
        return Promise.resolve(interceptorPayload({ templates: [systemTemplate, emptyTemplate] }));
      }
      return Promise.resolve(interceptorPayload({}));
    });
    const wrapper = mount(StoryboardSettings, {
      props: { projectUuid, providerModel: "dreamina-cli:seedance2.0fast" },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    await flushPromises();
    const label = wrapper.get('[name="videoPromptTemplateId"]').element.closest("label");
    expect(String(label?.textContent ?? "")).toContain("指令模板");
    expect(String(label?.textContent ?? "")).not.toContain("视频风格");
    expect(wrapper.get("[data-field=video-template-content]").text()).toBe("未选择模板内容");
    expect(wrapper.get("[data-field=video-template-content]").text()).not.toContain("旧模板残留不得保留");
    wrapper.unmount();
  });
});

describe("R19 最终请求预览必须显示合成提示词和安全引用摘要", () => {
  it("有音频时显示音频，无音频时不虚构", () => {
    const withAudio = mount(FinalRequestPreview, {
      props: {
        request: {
          providerModel: "dreamina-cli:seedance2.0fast",
          prompt: "统一夜戏光影，禁止现代招牌。\n\n【参考素材对应关系】\n音频1：角色“姜晓棠”的音色\n\n风格：玄幻。",
          options: { mode: "multimodal2video", aspectRatio: "9:16", durationMs: 5000, resolution: "720p" },
          referenceSummary: {
            image: { count: 3, labels: ["角色姜晓棠"] },
            video: { count: 0, labels: [] },
            audio: { count: 1, labels: ["角色姜晓棠的音色"] },
          },
        },
      },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    expect(withAudio.text()).toContain("统一夜戏光影，禁止现代招牌。");
    expect(withAudio.text()).toContain("风格：玄幻。");
    expect(withAudio.get("[data-field=reference-summary]").text()).toContain("音频");
    expect(withAudio.get("[data-field=reference-summary]").text()).toContain("姜晓棠");
    expect(withAudio.html()).not.toMatch(/relativePath|md5|assetUuid|C:\\\\Users/);
    withAudio.unmount();

    const withoutAudio = mount(FinalRequestPreview, {
      props: {
        request: {
          providerModel: "dreamina-cli:seedance2.0fast",
          prompt: "风格：玄幻。",
          options: { mode: "multiframe2video" },
          referenceSummary: {
            image: { count: 3, labels: ["角色姜晓棠"] },
            video: { count: 0, labels: [] },
            audio: { count: 0, labels: [] },
          },
        },
      },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    expect(withoutAudio.get("[data-field=reference-summary]").text()).not.toContain("姜晓棠的音色");
    withoutAudio.unmount();
  });
});

describe("R19 受保护音频 URL 与提交错误白名单", () => {
  it("允许相对路径和当前 loopback 受保护 URL，拒绝外部与磁盘路径", () => {
    expect(pickSafeProjectRuntimeFileUrl(relativeSrc)).toBe(relativeSrc);
    expect(pickSafeProjectRuntimeFileUrl(loopbackSrc)).toBe(loopbackSrc);
    expect(pickSafeProjectRuntimeFileUrl(`http://localhost:18765${relativeSrc}`)).toBeUndefined();
    expect(pickSafeProjectRuntimeFileUrl("https://cdn.evil.test/audio.mp3")).toBeUndefined();
    expect(pickSafeProjectRuntimeFileUrl("http://example.com/api/tianjiang/runtime/projects/x/files/audios/a.mp3")).toBeUndefined();
    expect(pickSafeProjectRuntimeFileUrl(`http://user:pass@127.0.0.1:18765${relativeSrc}`)).toBeUndefined();
    expect(pickSafeProjectRuntimeFileUrl("file:///C:/Users/alice/a.mp3")).toBeUndefined();
    expect(pickSafeProjectRuntimeFileUrl("C:\\Users\\alice\\a.mp3")).toBeUndefined();
    expect(pickSafeProjectRuntimeFileUrl("http://127.0.0.1:18765/api/other/files/a.mp3")).toBeUndefined();
  });

  it("白名单提交错误显示具体安全文案，未知错误仍兜底", async () => {
    setActivePinia(createPinia());
    projectStore().project = {
      projectUuid,
      name: "R19",
      projectType: "storyboard",
      myRole: "owner",
      openMode: "readwrite",
    } as any;
    const workspace = useStoryboardWorkspace();
    axiosGet.mockResolvedValue({ data: { data: [] } });
    await workspace.refreshProductionState?.().catch(() => undefined);
    axiosPost.mockRejectedValueOnce({
      code: "STORYBOARD_DREAMINA_MODE_UNSUPPORTED",
      message: "当前即梦 CLI 不支持 multimodal2video",
    });
    const failed = await workspace.generateShot(operationId.replace("a191", "b191"), "video", {
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "auto",
      expectedPreviewDigest: previewDigest,
    }, operationId);
    expect(failed).toBe(false);
    expect(workspace.errorMessage.value).toBe("当前即梦 CLI 不支持 multimodal2video");

    axiosPost.mockRejectedValueOnce({
      code: "UNKNOWN_VENDOR_TRACE",
      message: `ENOENT ${"C:\\Users\\alice\\secret.sqlite"}`,
    });
    await workspace.generateShot(operationId.replace("a191", "c191"), "video", {
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "auto",
      expectedPreviewDigest: previewDigest,
    }, operationId);
    expect(workspace.errorMessage.value).toBe("提交生成失败，请重试");
    expect(workspace.errorMessage.value).not.toMatch(/C:\\\\Users|secret\.sqlite|ENOENT/);
  });
});

describe("R19 资产详情 loopback 音频与 blob 代际", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPut.mockReset();
    axiosPatch.mockReset();
  });

  function mountWorkspace(initial = roleWithAudio()): VueWrapper {
    const createdI18n = i18n();
    (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(createdI18n.global.t(key));
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = projectStore();
    store.project = {
      id: "1919",
      projectUuid,
      name: "R19",
      describe: "audio",
      projectType: "storyboard",
      myRole: "owner",
      openMode: "readwrite",
      imageModel: "",
      videoModel: "dreamina-cli:seedance2.0fast",
    } as any;
    store.access = { projectUuid, mode: "readwrite", reason: "test_open", lockHolder: "" };
    let listed = [initial];
    axiosGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/shots")) return Promise.resolve({ data: { data: [] } });
      return Promise.resolve({ data: { data: {} } });
    });
    axiosPost.mockImplementation((url: string) => {
      if (String(url).includes("/cornerScape/getAllAssets")) {
        return Promise.resolve({ code: 200, data: listed, message: "成功" });
      }
      if (String(url).includes("/cornerScape/updateAssetsAudio")) {
        listed = [{ ...initial, relepedAudio: [{ id: 7, name: "33", src: loopbackSrc }] }];
        return Promise.resolve({ code: 200, data: {}, message: "成功" });
      }
      if (String(url).includes("/storyboard/assets/") && String(url).endsWith("/audio")) {
        listed = [{ ...initial, relepedAudio: [{ id: 7, name: "voice.mp3", src: loopbackSrc }] }];
        return Promise.resolve({ code: 0, data: {}, message: "成功" });
      }
      return Promise.resolve({ code: 0, data: {} });
    });
    return mount(StoryboardWorkspace, {
      attachTo: document.body,
      global: {
        plugins: [pinia, createdI18n],
        stubs: {
          ...tdesignStubs,
          modelSelect: { template: "<div />" },
          ImageTools: { template: "<div />" },
          "i-plus": { template: "<i />" },
        },
      },
    });
  }

  async function openRoleDetail(wrapper: VueWrapper) {
    await wrapper.get('[data-module="assets"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-workspace="corner-scape"] .module-interactive').trigger("click");
    await flushPromises();
    return wrapper.get('[data-panel="asset-detail"]');
  }

  it("当前 Electron loopback 受保护音频必须可播放和下载", async () => {
    const wrapper = mountWorkspace(roleWithAudio(loopbackSrc));
    await flushPromises();
    const detail = await openRoleDetail(wrapper);
    expect(detail.get("[data-role-audio-player]").attributes("src")).toBe(loopbackSrc);
    expect(detail.get('[data-action="download-role-audio"]').attributes("href")).toBe(loopbackSrc);
    expect(detail.text()).not.toContain("音频文件不可播放");
    wrapper.unmount();
  });

  it("新上传音频无需关闭抽屉即可播放，且只撤销本组件 blob", async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    let seq = 0;
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:http://localhost/r19-${++seq}`;
      created.push(url);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); }) as typeof URL.revokeObjectURL;
    const wrapper = mountWorkspace(roleWithAudio());
    await flushPromises();
    const detail = await openRoleDetail(wrapper);
    const input = detail.get('[data-action="replace-role-audio"]');
    const file = new File([new Uint8Array([1, 2, 3, 4])], "voice.mp3", { type: "audio/mpeg" });
    Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
    await input.trigger("change");
    await flushPromises();
    expect(wrapper.get("[data-role-audio-player]").attributes("src")).toBe(loopbackSrc);
    expect(created.length).toBeGreaterThan(0);
    expect(revoked).toEqual(created);
    expect(revoked.every((item) => item.startsWith("blob:"))).toBe(true);
    wrapper.unmount();
  });
});
