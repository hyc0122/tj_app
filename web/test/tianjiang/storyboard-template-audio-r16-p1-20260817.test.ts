// @vitest-environment jsdom
/**
 * R16 RED：视频指令模板弹窗必须有桌面双栏/深色主题；
 * 资产详情每个已关联音色必须显示原生完整播放器或明确不可播放。
 */
import { defineComponent } from "vue";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zhCN from "@/locales/language/zh-CN.json";
import projectStore from "@/stores/project";
import StoryboardVideoTemplateDialog from "@/views/storyboardProject/components/StoryboardVideoTemplateDialog.vue";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";
import { useRoleAudioPreview } from "@/views/cornerScape/composables/useRoleAudioPreview";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const axiosPatch = vi.fn();
const axiosPut = vi.fn();
const axiosDelete = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    patch: (...args: unknown[]) => axiosPatch(...args),
    put: (...args: unknown[]) => axiosPut(...args),
    delete: (...args: unknown[]) => axiosDelete(...args),
  },
}));

vi.mock("@/stores/setting", () => ({
  default: () => ({ activeMenu: "", showSetting: false }),
}));

vi.mock("@/utils/assetsCheck", () => ({
  default: vi.fn(),
}));

const projectUuid = "c1616161-1616-4161-a161-161616161616";
const safeSrc = `/api/tianjiang/runtime/projects/${projectUuid}/files/attachments/1616/assets/audio/r16-voice.mp3`;
const nextSrc = `/api/tianjiang/runtime/projects/${projectUuid}/files/audios/b.mp3`;

const dialogSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../src/views/storyboardProject/components/StoryboardVideoTemplateDialog.vue"),
  "utf8",
);
const workspaceSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../src/views/cornerScape/components/CornerScapeWorkspace.vue"),
  "utf8",
);
const workspaceStyle = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../src/views/cornerScape/styles/corner-scape-workspace.scss"),
  "utf8",
);

const tdesignStubs = {
  TButton: {
    inheritAttrs: true,
    props: ["loading", "disabled"],
    template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
  },
  TIcon: { template: "<i />" },
  TAvatar: { template: "<span />" },
  TSelect: { inheritAttrs: true, template: "<select></select>" },
  TOptionGroup: { template: "<optgroup><slot /></optgroup>" },
  TOption: { template: "<option><slot /></option>" },
  TDialog: {
    inheritAttrs: true,
    props: ["visible", "header", "attach", "placement", "width", "dialogClassName"],
    template: `<section v-if="visible" role="dialog" :data-dialog-attach="attach" :data-dialog-placement="placement" :data-dialog-width="width" :data-dialog-class="dialogClassName" :class="dialogClassName"><h2>{{ header }}</h2><div class="t-dialog__body"><slot /></div><footer class="t-dialog__footer"><slot name="footer" /></footer></section>`,
  },
  TDrawer: {
    inheritAttrs: true,
    props: ["visible", "modelValue"],
    emits: ["update:visible", "update:modelValue"],
    template: `<aside v-if="visible || modelValue" v-bind="$attrs" role="dialog"><button type="button" data-action="close-asset-detail" @click="$emit('update:visible', false); $emit('update:modelValue', false)">x</button><slot /><slot name="footer" /></aside>`,
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
  TImageViewer: { template: "<div><slot name=\"trigger\" :open=\"() => {}\" /></div>" },
};

function i18n() {
  return createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
}

function roleWithAudios(relepedAudio: Array<{ id: number; name: string; src?: string }>) {
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
    relepedAudio,
    audioBindState: "",
  };
}

function mountDialog(): VueWrapper {
  axiosGet.mockResolvedValue({
    data: {
      data: {
        templates: [
          { id: 1, name: "系统模板", type: "storyboardVideoSystemTemplate", content: "{{shot_prompt}}", system: true },
          { id: 2, name: "我的指令", type: "storyboardVideoUserTemplate", content: "风格：{{style}}。\n{{shot_prompt}}" },
        ],
      },
    },
  });
  return mount(StoryboardVideoTemplateDialog, {
    props: { open: true, projectUuid },
    global: { plugins: [i18n()], stubs: tdesignStubs },
  });
}

function mountWorkspace(roles: unknown[]): VueWrapper {
  const createdI18n = i18n();
  (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(createdI18n.global.t(key));
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = projectStore();
  store.project = {
    id: "1616",
    projectUuid,
    name: "R16",
    describe: "template audio",
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
    imageModel: "",
    videoModel: "dreamina-cli:seedance2.0fast",
  } as any;
  store.access = { projectUuid, mode: "readwrite", reason: "test_open", lockHolder: "" };
  axiosGet.mockImplementation((url: string) => {
    if (String(url).endsWith("/shots")) return Promise.resolve({ data: { data: [] } });
    if (String(url).includes("/storyboard/assets")) {
      return Promise.resolve({ data: { data: { sourceProjectUuid: projectUuid, assets: [] } } });
    }
    return Promise.resolve({ data: { data: {} } });
  });
  axiosPost.mockImplementation((url: string) => {
    if (String(url).includes("/cornerScape/getAllAssets")) {
      return Promise.resolve({ data: roles });
    }
    return Promise.resolve({ data: { data: {} } });
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

describe("R16 视频指令模板弹窗必须有明确尺寸和深色主题", () => {
  it("当前 TDialog 必须带 attach/placement/宽度/专用 class，且样式覆盖 body 外壳", () => {
    expect(dialogSource).toContain('attach="body"');
    expect(dialogSource).toContain('placement="center"');
    expect(dialogSource).toContain('dialog-class-name="storyboardVideoTemplateDialog"');
    expect(dialogSource).toContain('width="min(1080px, calc(100vw - 48px))"');
    expect(dialogSource).toMatch(/<style lang="scss">/);
    expect(dialogSource).toContain(".storyboardVideoTemplateDialog");
    expect(dialogSource).toContain("max-height: 88vh");
    expect(dialogSource).toContain("overflow-x: hidden");
    expect(dialogSource).toContain("--product-text");
    expect(dialogSource).toContain("--product-text-secondary");
    expect(dialogSource).toContain("--product-surface");
    expect(dialogSource).toContain("--product-surface-soft");
    expect(dialogSource).toContain("--product-border");
    expect(dialogSource).toContain("--td-brand-color");
    expect(dialogSource).toContain("@media (max-width: 720px)");
    expect(dialogSource).toMatch(/grid-template-columns:\s*minmax\(220px,\s*240px\)\s+minmax\(0,\s*1fr\)/);
    expect(dialogSource).toMatch(/@media \(max-width: 720px\)[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("打开后桌面双栏、保存行为仍在，360 合同不得依赖默认窄弹窗", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.attributes("data-dialog-attach")).toBe("body");
    expect(dialog.attributes("data-dialog-placement")).toBe("center");
    expect(dialog.attributes("data-dialog-width")).toBe("min(1080px, calc(100vw - 48px))");
    expect(dialog.attributes("data-dialog-class")).toBe("storyboardVideoTemplateDialog");
    expect(wrapper.get(".templateManager").exists()).toBe(true);
    expect(wrapper.get('[data-action="save-video-template"]').exists()).toBe(true);
    expect(wrapper.get('[data-action="save-and-use-video-template"]').exists()).toBe(true);
    expect(wrapper.get("#storyboard-video-template-content").exists()).toBe(true);
    expect(wrapper.text()).toContain("变量来源说明");
    wrapper.unmount();
  });
});

describe("R16 资产详情音频必须显示完整原生播放器", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPatch.mockReset();
    axiosPut.mockReset();
    axiosDelete.mockReset();
  });

  it("有安全 src 时必须逐行展示 audio[controls]、进度/音量和下载", async () => {
    const wrapper = mountWorkspace([roleWithAudios([
      { id: 33, name: "33", src: safeSrc },
      { id: 44, name: "第二音色", src: nextSrc },
    ])]);
    await flushPromises();
    const detail = await openRoleDetail(wrapper);
    const rows = detail.findAll("[data-role-audio-row]");
    expect(rows).toHaveLength(2);
    const players = detail.findAll("[data-role-audio-player]");
    expect(players).toHaveLength(2);
    for (const player of players) {
      expect(player.element.tagName).toBe("AUDIO");
      expect(player.attributes("controls")).toBeDefined();
      expect(player.attributes("preload")).toBe("metadata");
    }
    expect(detail.findAll('[data-action="download-role-audio"]')).toHaveLength(2);
    expect(detail.get('[data-action="download-role-audio"]').attributes("href")).toBe(safeSrc);
    expect(detail.get('[data-action="select-role-audio"]').exists()).toBe(true);
    expect(detail.get('[data-action="remove-role-audio"]').exists()).toBe(true);
    expect(detail.text()).not.toContain("暂无音色");
    expect(detail.html()).not.toMatch(/filePath|C:\\\\Users|alice/);
    expect(workspaceStyle).toMatch(/audioList--detail/);
    expect(workspaceSource).toContain('preload="metadata"');
    wrapper.unmount();
  });

  it("无 src 时必须显示音频文件不可播放，且不泄露路径", async () => {
    const wrapper = mountWorkspace([roleWithAudios([{ id: 33, name: "33" }])]);
    await flushPromises();
    const detail = await openRoleDetail(wrapper);
    expect(detail.get("[data-role-audio-row]").exists()).toBe(true);
    expect(detail.get('[data-feedback="audio-unplayable"]').text()).toContain("音频文件不可播放");
    expect(detail.find("[data-role-audio-player]").exists()).toBe(false);
    expect(detail.find('[data-action="download-role-audio"]').exists()).toBe(false);
    expect(detail.text()).toContain("33");
    expect(detail.text()).not.toContain("暂无音色");
    expect(detail.html()).not.toMatch(/filePath|C:\\\\Users|assets\/audio|alice/);
    wrapper.unmount();
  });

  it("开始播放另一条必须停上一条；ended/关闭/卸载后清理", async () => {
    const wrapper = mountWorkspace([roleWithAudios([
      { id: 33, name: "33", src: safeSrc },
      { id: 44, name: "第二音色", src: nextSrc },
    ])]);
    await flushPromises();
    const detail = await openRoleDetail(wrapper);
    const players = detail.findAll("[data-role-audio-player]");
    const first = players[0]!.element as HTMLAudioElement;
    const second = players[1]!.element as HTMLAudioElement;
    const firstPause = vi.fn();
    const secondPause = vi.fn();
    Object.defineProperty(first, "pause", { configurable: true, value: firstPause });
    Object.defineProperty(second, "pause", { configurable: true, value: secondPause });
    Object.defineProperty(first, "currentTime", { configurable: true, writable: true, value: 12 });
    second.dispatchEvent(new Event("play"));
    await flushPromises();
    expect(firstPause).toHaveBeenCalled();
    first.dispatchEvent(new Event("ended"));
    await flushPromises();
    expect(first.currentTime).toBe(0);
    await detail.get('[data-action="close-asset-detail"]').trigger("click");
    await flushPromises();
    expect(firstPause).toHaveBeenCalled();
    expect(secondPause).toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe("R16 试听 composable 在 ended 后仍可清理", () => {
  const players: Array<{ emitEnded: () => void }> = [];

  beforeEach(() => {
    players.length = 0;
    class FakeAudio {
      src = "";
      play = vi.fn(async () => undefined);
      pause = vi.fn();
      load = vi.fn();
      removeAttribute = vi.fn();
      private listeners = new Map<string, EventListener>();
      constructor(src?: string) {
        this.src = src ?? "";
        players.push(this as never);
      }
      addEventListener(type: string, listener: EventListener) {
        this.listeners.set(type, listener);
      }
      removeEventListener(type: string, listener: EventListener) {
        if (this.listeners.get(type) === listener) this.listeners.delete(type);
      }
      emitEnded() {
        this.listeners.get("ended")?.(new Event("ended"));
      }
    }
    vi.stubGlobal("Audio", FakeAudio);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ended 后 playingId 必须清空", async () => {
    let api!: ReturnType<typeof useRoleAudioPreview>;
    const wrapper = mount(defineComponent({
      setup() {
        api = useRoleAudioPreview();
        return () => null;
      },
    }));
    await api.toggle({ id: 33, name: "33", src: safeSrc });
    expect(api.playingId.value).toBe(33);
    (players[0] as { emitEnded: () => void }).emitEnded();
    expect(api.playingId.value).toBeNull();
    wrapper.unmount();
  });
});
