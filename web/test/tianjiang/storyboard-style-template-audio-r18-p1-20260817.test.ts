// @vitest-environment jsdom
/**
 * R18 RED：视频风格下拉改模板、保存后回显、音频不关抽屉可播、详情布局。
 */
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import projectStore from "@/stores/project";
import StoryboardSettings from "@/views/storyboardProject/components/StoryboardSettings.vue";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";

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
  default: () => ({ activeMenu: "", showSetting: false }),
}));

vi.mock("@/utils/assetsCheck", () => ({
  default: vi.fn(async () => [{
    id: 7,
    name: "33",
    src: "/api/tianjiang/runtime/projects/e1818181-1818-4181-a181-181818181818/files/audios/r18-voice.mp3",
    type: "audio",
  }]),
}));

const projectUuid = "e1818181-1818-4181-a181-181818181818";
const safeSrc = `/api/tianjiang/runtime/projects/${projectUuid}/files/audios/r18-voice.mp3`;
const systemTemplate = {
  id: 1,
  name: "系统默认视频指令",
  type: "storyboardVideoSystemTemplate",
  content: "风格：{{style}}。\n{{shot_prompt}}",
  system: true,
};
const userTemplate = {
  id: 2,
  name: "码头夜戏",
  type: "storyboardVideoUserTemplate",
  content: "风格：{{style}}。\n镜头：近景。\n{{shot_prompt}}",
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

function roleWithoutPlayableAudio() {
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
    relepedAudio: [{ id: 7, name: "33" }],
    audioBindState: "",
  };
}

describe("R18 视频风格下拉必须来自视频指令模板", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPut.mockReset();
  });

  it("不得请求 art-styles，选项是模板名称/id，保存后回显内容", async () => {
    let settings = {
      aspectRatio: "9:16",
      durationMs: 5000,
      videoPromptTemplateId: 2,
      videoPromptTemplateContent: userTemplate.content,
    };
    let templates = [systemTemplate, userTemplate];
    axiosGet.mockImplementation((url: string) => {
      const target = String(url);
      if (target.includes("/storyboard/settings")) return Promise.resolve(interceptorPayload(settings));
      if (target.includes("/storyboard/video-templates")) return Promise.resolve(interceptorPayload({ templates }));
      if (target.includes("/storyboard/art-styles")) return Promise.reject(new Error("不得请求视觉手册"));
      return Promise.resolve(interceptorPayload({}));
    });
    axiosPut.mockImplementation((_url: string, body: any) => {
      settings = {
        ...settings,
        videoPromptTemplateId: Number(body.videoPromptTemplateId),
        videoPromptTemplateContent: String(body.videoPromptTemplateContent ?? ""),
      };
      return Promise.resolve(interceptorPayload(settings));
    });
    const wrapper = mount(StoryboardSettings, {
      props: { projectUuid, providerModel: "dreamina-cli:seedance2.0fast" },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    await flushPromises();
    expect(axiosGet.mock.calls.some(([url]) => String(url).includes("/art-styles"))).toBe(false);
    const select = wrapper.get('[name="videoPromptTemplateId"]');
    expect(select.get('[value="1"]').text()).toContain("系统默认视频指令");
    expect(select.get('[value="2"]').text()).toContain("码头夜戏");
    expect((select.element as HTMLSelectElement).value).toBe("2");
    expect(wrapper.get("[data-field=video-template-content]").text()).toContain("镜头：近景");
    expect(wrapper.get("[data-field=video-template-content]").text()).not.toContain("赛璐珞");
    axiosPost.mockImplementation((url: string) => {
      if (String(url).endsWith("/video-templates")) {
        const created = { id: 88, name: "新建指令", type: "storyboardVideoUserTemplate", content: "风格：{{style}}。", system: false };
        templates = [...templates, created];
        return Promise.resolve(interceptorPayload(created));
      }
      if (String(url).includes("/video-templates/88/use")) {
        settings = { ...settings, videoPromptTemplateId: 88, videoPromptTemplateContent: "风格：{{style}}。" };
        return Promise.resolve(interceptorPayload(settings));
      }
      return Promise.resolve(interceptorPayload({}));
    });
    await wrapper.get('[data-action="open-video-template-manager"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="create-video-template"]').trigger("click");
    await wrapper.get('[name="templateName"]').setValue("新建指令");
    await wrapper.get('[data-action="save-and-use-video-template"]').trigger("click");
    await flushPromises();
    expect((wrapper.get('[name="videoPromptTemplateId"]').element as HTMLSelectElement).value).toBe("88");
    expect(wrapper.get('[name="videoPromptTemplateId"]').text()).toContain("新建指令");
    wrapper.unmount();
  });
});

describe("R18 资产详情音频保存后不关抽屉即可播放，并按参考图排布", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPut.mockReset();
    axiosPatch.mockReset();
  });

  function mountWorkspace(initial = roleWithoutPlayableAudio()): VueWrapper {
    const createdI18n = i18n();
    (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(createdI18n.global.t(key));
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = projectStore();
    store.project = {
      id: "1818",
      projectUuid,
      name: "R18",
      describe: "audio layout",
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
        listed = [{
          ...initial,
          relepedAudio: [{ id: 7, name: "33", src: safeSrc }],
        }];
        return Promise.resolve({ code: 200, data: {}, message: "成功" });
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

  it("选择音色后不关抽屉必须出现原生播放器和下载，且共用当前 src", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const detail = await openRoleDetail(wrapper);
    expect(detail.get('[data-feedback="audio-unplayable"]').exists()).toBe(true);
    await detail.get('[data-action="select-role-audio"]').trigger("click");
    await flushPromises();
    const player = wrapper.get('[data-panel="asset-detail"]').get("[data-role-audio-player]");
    expect(player.element.tagName).toBe("AUDIO");
    expect(player.attributes("src")).toBe(safeSrc);
    expect(wrapper.get('[data-action="download-role-audio"]').attributes("href")).toBe(safeSrc);
    expect(wrapper.get('[data-panel="asset-detail"]').text()).not.toContain("音频文件不可播放");
    wrapper.unmount();
  });

  it("替换音频保存后不关抽屉必须切到受保护 src 并可播放", async () => {
    const createObjectURL = vi.fn(() => "blob:http://localhost/r18-preview");
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const wrapper = mountWorkspace();
    await flushPromises();
    const detail = await openRoleDetail(wrapper);
    expect(detail.get('[data-feedback="audio-unplayable"]').exists()).toBe(true);
    axiosPost.mockImplementation((url: string) => {
      if (String(url).includes("/cornerScape/getAllAssets")) {
        return Promise.resolve({
          code: 200,
          data: [{
            ...roleWithoutPlayableAudio(),
            relepedAudio: [{ id: 7, name: "voice.mp3", src: safeSrc }],
          }],
          message: "成功",
        });
      }
      if (String(url).includes("/storyboard/assets/") && String(url).endsWith("/audio")) {
        return Promise.resolve({ code: 0, data: {}, message: "成功" });
      }
      return Promise.resolve({ code: 0, data: {} });
    });
    const input = detail.get('[data-action="replace-role-audio"]');
    const file = new File([new Uint8Array([1, 2, 3, 4])], "voice.mp3", { type: "audio/mpeg" });
    Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
    await input.trigger("change");
    await flushPromises();
    const player = wrapper.get('[data-panel="asset-detail"]').get("[data-role-audio-player]");
    expect(player.attributes("src")).toBe(safeSrc);
    expect(wrapper.get('[data-action="download-role-audio"]').attributes("href")).toBe(safeSrc);
    expect(wrapper.get('[data-panel="asset-detail"]').text()).not.toContain("音频文件不可播放");
    expect(wrapper.get('[data-panel="asset-detail"]').text()).not.toContain("选择文件");
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalled();
    wrapper.unmount();
    if (originalCreate) URL.createObjectURL = originalCreate;
    else delete (URL as { createObjectURL?: unknown }).createObjectURL;
    if (originalRevoke) URL.revokeObjectURL = originalRevoke;
    else delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it("资产名与别名、画幅与分辨率、音频控制必须在各自一行", async () => {
    const wrapper = mountWorkspace({
      ...roleWithoutPlayableAudio(),
      relepedAudio: [{ id: 7, name: "33", src: safeSrc }],
    });
    await flushPromises();
    const detail = await openRoleDetail(wrapper);
    expect(detail.get('[data-row="asset-identity"]').exists()).toBe(true);
    expect(detail.get('[data-row="asset-identity"] [data-field="asset-name"]').exists()).toBe(true);
    expect(detail.get('[data-row="asset-identity"] [data-field="asset-alias"]').exists()).toBe(true);
    expect(detail.get('[data-row="asset-spec"]').exists()).toBe(true);
    expect(detail.get('[data-row="asset-spec"] [data-field="asset-ratio"]').exists()).toBe(true);
    expect(detail.get('[data-row="asset-spec"] [data-field="asset-resolution"]').exists()).toBe(true);
    expect(detail.get("[data-role-audio-row] [data-action=replace-role-audio]").exists()).toBe(true);
    expect(detail.get("[data-role-audio-row] [data-role-audio-player]").exists()).toBe(true);
    expect(detail.get("[data-role-audio-row] [data-action=download-role-audio]").exists()).toBe(true);
    expect(detail.text()).not.toContain("角色分类");
    expect(detail.text()).not.toContain("群演");
    wrapper.unmount();
  });
});
