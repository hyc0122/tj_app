// @vitest-environment jsdom
import { defineComponent } from "vue";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const axiosPatch = vi.fn();
const axiosDelete = vi.fn();
const openAssetsSelector = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    patch: (...args: unknown[]) => axiosPatch(...args),
    delete: (...args: unknown[]) => axiosDelete(...args),
  },
}));

vi.mock("@/utils/assetsCheck", () => ({
  default: (...args: unknown[]) => openAssetsSelector(...args),
}));

import projectStore from "@/stores/project";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";
import { useRoleAudioPreview } from "@/views/cornerScape/composables/useRoleAudioPreview";

const projectUuid = "b1111111-1111-4111-a111-111111111111";
const roleUuid = "bbbbbbbb-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const safeSrc = `/api/tianjiang/runtime/projects/${projectUuid}/files/audios/a.mp3`;
const nextSrc = `/api/tianjiang/runtime/projects/${projectUuid}/files/audios/b.mp3`;

const roleWithAudio = {
  id: 1,
  assetUuid: roleUuid,
  imageId: 11,
  type: "role",
  name: "林夏",
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
  relepedAudio: [{ id: 9, name: "音色A", src: safeSrc }],
  audioBindState: "",
};

const roleWithoutAudio = {
  ...roleWithAudio,
  relepedAudio: [] as Array<{ id: number; name: string; src?: string }>,
};

const tdesignStubs = {
  TButton: {
    inheritAttrs: true,
    props: ["loading", "disabled"],
    template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
  },
  TIcon: { template: "<i />" },
  TTag: {
    inheritAttrs: true,
    props: ["closable"],
    template: '<span v-bind="$attrs"><slot /><button v-if="closable" type="button" data-action="remove-role-audio">x</button></span>',
  },
  TCard: { inheritAttrs: true, template: '<section v-bind="$attrs"><slot name="title" /><slot /></section>' },
  TForm: { template: "<form><slot /></form>" },
  TFormItem: { inheritAttrs: true, template: '<div v-bind="$attrs"><slot /></div>' },
  TDrawer: {
    inheritAttrs: true,
    props: ["visible", "modelValue"],
    template: '<aside v-if="visible || modelValue" v-bind="$attrs" role="dialog"><slot /><slot name="footer" /></aside>',
  },
  TEmpty: { template: "<div>empty</div>" },
  TLoading: { template: "<div><slot /></div>" },
  TSelect: { inheritAttrs: true, template: "<select></select>" },
  TInput: { inheritAttrs: true, template: "<input />" },
  TTextarea: { inheritAttrs: true, template: "<textarea />" },
  TCheckbox: { template: '<input type="checkbox" />' },
  TCheckboxGroup: { template: "<div><slot /></div>" },
  TImage: { template: "<img />" },
  TImageViewer: { template: "<div><slot name=\"trigger\" :open=\"() => {}\" /></div>" },
};

const players: Array<{
  src: string;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  emitEnded: () => void;
}> = [];

function installFakeAudio() {
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
      players.push(this);
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
}

function mountPreviewApi() {
  let api!: ReturnType<typeof useRoleAudioPreview>;
  const wrapper = mount(defineComponent({
    setup() {
      api = useRoleAudioPreview();
      return () => null;
    },
  }));
  return { wrapper, api };
}

function mountWorkspace(role = roleWithAudio): VueWrapper {
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
  (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(i18n.global.t(key));
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = projectStore();
  store.project = {
    id: "941",
    projectUuid,
    name: "R11 试听",
    describe: "voice preview",
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
      return Promise.resolve({ data: [role] });
    }
    return Promise.resolve({ data: { data: {} } });
  });
  return mount(StoryboardWorkspace, {
    attachTo: document.body,
    global: {
      plugins: [pinia, i18n],
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

describe("R11 有音色时不得显示暂无音色", () => {
  it("抽屉里已有 relepedAudio 时只显示列表，不出现暂无音色", async () => {
    const wrapper = mountWorkspace(roleWithAudio);
    await flushPromises();
    const detail = await openRoleDetail(wrapper);
    expect(detail.find('[data-action="preview-role-audio"]').exists()).toBe(true);
    expect(detail.text()).not.toContain("暂无音色");
    expect(detail.text()).not.toContain("暂无音频参考");
    expect(detail.find('[data-empty="no-role-audio"]').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("R11 ended 后必须清空并允许立即重播", () => {
  beforeEach(() => {
    installFakeAudio();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("触发 ended 后状态清空，下一次单击立即重新 play", async () => {
    const { wrapper, api } = mountPreviewApi();
    await api.toggle({ id: 9, name: "音色A", src: safeSrc });
    expect(players).toHaveLength(1);
    expect(api.playingId.value).toBe(9);
    expect(players[0]!.play).toHaveBeenCalledTimes(1);

    players[0]!.emitEnded();
    expect(api.playingId.value).toBeNull();

    await api.toggle({ id: 9, name: "音色A", src: safeSrc });
    expect(players).toHaveLength(2);
    expect(players[1]!.play).toHaveBeenCalledTimes(1);
    expect(api.playingId.value).toBe(9);
    wrapper.unmount();
  });

  it("旧 Audio 的 ended 不得清掉新实例", async () => {
    const { wrapper, api } = mountPreviewApi();
    await api.toggle({ id: 9, name: "音色A", src: safeSrc });
    const first = players[0]!;
    await api.toggle({ id: 10, name: "音色B", src: nextSrc });
    expect(api.playingId.value).toBe(10);
    first.emitEnded();
    expect(api.playingId.value).toBe(10);
    expect(players[1]!.play).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});

describe("R11 选择音色后无需关抽屉即可试听", () => {
  beforeEach(() => {
    installFakeAudio();
    openAssetsSelector.mockReset();
    openAssetsSelector.mockResolvedValue([{
      id: 88,
      assetsId: null,
      name: "新音色",
      prompt: "",
      describe: "",
      remark: "",
      src: nextSrc,
      type: "audio",
      imageId: null,
      state: "已完成",
    }]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("选择音色并保存后，抽屉不关闭也能出现试听按钮", async () => {
    let listed = [roleWithoutAudio];
    axiosPost.mockImplementation((url: string) => {
      if (String(url).includes("/cornerScape/getAllAssets")) {
        return Promise.resolve({ data: listed });
      }
      if (String(url).includes("/cornerScape/updateAssetsAudio")) {
        listed = [{
          ...roleWithAudio,
          relepedAudio: [{ id: 88, name: "新音色", src: nextSrc }],
        }];
        return Promise.resolve({ data: { data: {} } });
      }
      return Promise.resolve({ data: { data: {} } });
    });
    const wrapper = mountWorkspace(roleWithoutAudio);
    await flushPromises();
    const detail = await openRoleDetail(wrapper);
    expect(detail.find('[data-action="preview-role-audio"]').exists()).toBe(false);

    await detail.get('[data-action="select-role-audio"]').trigger("click");
    await flushPromises();

    const play = wrapper.get('[data-panel="asset-detail"]').find('[data-action="preview-role-audio"]');
    expect(play.exists()).toBe(true);
    expect(wrapper.get('[data-panel="asset-detail"]').exists()).toBe(true);
    expect(JSON.stringify(wrapper.get('[data-panel="asset-detail"]').html())).not.toMatch(/filePath|C:\\\\Users/);
    expect(play.element.tagName).toBe("AUDIO");
    expect(play.attributes("controls")).toBeDefined();
    expect(play.attributes("preload")).toBe("metadata");
    expect(wrapper.get('[data-action="download-role-audio"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
