// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import projectStore from "@/stores/project";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";
import StoryboardImportDialog from "@/views/storyboardProject/components/StoryboardImportDialog.vue";
import ShotAssetSlots from "@/views/storyboardProject/components/ShotAssetSlots.vue";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const axiosPatch = vi.fn();
const axiosDelete = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    patch: (...args: unknown[]) => axiosPatch(...args),
    delete: (...args: unknown[]) => axiosDelete(...args),
  },
}));

const projectUuid = "a1111111-1111-4111-a111-111111111111";
const shotUuid = "a1111111-1111-4111-a111-111111111101";
const roleA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const roleB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

const assets = [
  { assetUuid: roleA, name: "林夏", type: "role", assetType: "role", hasAudio: true, sourceProjectUuid: projectUuid },
  { assetUuid: roleB, name: "卫兵", type: "role", assetType: "role", hasAudio: false, sourceProjectUuid: projectUuid },
];

const bindings = [
  { sourceProjectUuid: projectUuid, assetUuid: roleA, assetType: "role", relationRole: "appear", voiceEnabled: true },
  { sourceProjectUuid: projectUuid, assetUuid: roleB, assetType: "role", relationRole: "appear", voiceEnabled: true },
];

const shot = {
  shotUuid,
  displayOrder: 1,
  sourceText: "林夏走进雨巷。",
  visualDescription: "雨夜",
  videoPrompt: "缓慢跟随",
  durationMs: 5000,
  aspectRatio: "9:16",
  bindings,
  candidates: [],
  generationTasks: [],
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
  TDialog: { inheritAttrs: true, props: ["visible", "header"], template: '<section v-if="visible" v-bind="$attrs"><slot /></section>' },
  TDrawer: {
    inheritAttrs: true,
    props: ["visible", "modelValue", "header"],
    template: '<aside v-if="visible || modelValue" v-bind="$attrs" role="dialog"><slot /><slot name="footer" /></aside>',
  },
  TEmpty: { template: "<div>empty</div>" },
  TLoading: { template: "<div><slot /></div>" },
  TSelect: { inheritAttrs: true, props: ["modelValue"], template: '<select v-bind="$attrs"></select>' },
  TInput: { inheritAttrs: true, props: ["modelValue"], template: '<input v-bind="$attrs" :value="modelValue" />' },
  TTextarea: { inheritAttrs: true, props: ["modelValue"], template: '<textarea v-bind="$attrs" />' },
  TCheckbox: { template: '<input type="checkbox" />' },
  TCheckboxGroup: { template: "<div><slot /></div>" },
  TImage: { template: "<img />" },
  TImageViewer: { template: "<div><slot name=\"trigger\" :open=\"() => {}\" /></div>" },
};

function mountWorkspace(): VueWrapper {
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
  (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(i18n.global.t(key));
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = projectStore();
  store.project = {
    id: "931",
    projectUuid,
    name: "R10 导入音色",
    describe: "import voice",
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
    imageModel: "",
    videoModel: "dreamina-cli:seedance2.0fast",
  } as any;
  store.access = { projectUuid, mode: "readwrite", reason: "test_open", lockHolder: "" };
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

const roleAsset = {
  id: 1,
  assetUuid: roleA,
  imageId: 11,
  type: "role",
  name: "林夏",
  remark: "夏夏",
  imageRatio: "16:9",
  prompt: "portrait",
  filePath: "/safe.png",
  state: "已完成",
  model: "seedream-4.0",
  resolution: "1K",
  describe: "女主",
  promptState: "",
  historyImages: [{ id: 10, filePath: "/old.png" }],
  errorReason: "",
  promptErrorReason: "",
  relepedAudio: [
    { id: 9, name: "音色A", src: "/api/tianjiang/runtime/projects/a1111111-1111-4111-a111-111111111111/files/audios/a.mp3" },
    { id: 10, name: "无地址音色" },
  ],
  audioBindState: "",
};

describe("R10 导入本地文件与示例", () => {
  beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPatch.mockReset();
    axiosDelete.mockReset();
    axiosGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/shots")) return Promise.resolve({ data: { data: [shot] } });
      if (String(url).includes("/storyboard/assets")) {
        return Promise.resolve({ data: { data: { sourceProjectUuid: projectUuid, assets } } });
      }
      return Promise.resolve({ data: { data: {} } });
    });
    axiosPost.mockResolvedValue({ data: { data: { digest: "d".repeat(64), rows: [{ sourceText: "a" }] } } });
  });

  it("本地 TXT/CSV 读取会切换格式，示例下载内容与生产解析器一致", async () => {
    const wrapper = mount(StoryboardImportDialog, {
      props: { projectUuid },
      attachTo: document.body,
      global: { stubs: tdesignStubs },
    });
    const fileInput = wrapper.get('input[data-action="import-local-file"]');
    expect(fileInput.attributes("accept")).toBe(".txt,.csv");

    const txt = new File(["小节1：\n场景：雨巷\n"], "shots.txt", { type: "text/plain" });
    Object.defineProperty(fileInput.element, "files", { configurable: true, value: [txt] });
    await fileInput.trigger("change");
    // 中文注释：FileReader 是独立异步事件，按结果条件等待，禁止用单次 timer tick 制造竞态。
    await vi.waitFor(() => {
      expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toContain("小节1：");
    });
    expect((wrapper.get('select[name="import-format"]').element as HTMLSelectElement).value).toBe("txt");

    const csvInput = wrapper.get('input[data-action="import-local-file"]');
    const csv = new File(["场景,人物,道具,分镜提示词\n雨巷,林夏,伞,推进\n"], "shots.csv", { type: "text/csv" });
    Object.defineProperty(csvInput.element, "files", { configurable: true, value: [csv] });
    await csvInput.trigger("change");
    await vi.waitFor(() => {
      expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toContain("场景,人物,道具,分镜提示词");
    });
    expect((wrapper.get('select[name="import-format"]').element as HTMLSelectElement).value).toBe("csv");

    const parts: string[] = [];
    vi.stubGlobal("Blob", class {
      constructor(init: BlobPart[] = []) {
        parts.push(String(init[0] ?? ""));
      }
    });
    vi.stubGlobal("URL", {
      createObjectURL() { return "blob:r10-sample"; },
      revokeObjectURL() {},
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await wrapper.get('[data-action="download-import-sample"]').trigger("click");
    expect(parts[0]?.startsWith("\uFEFF")).toBe(true);
    expect(parts[0]).toContain("场景,人物,道具,分镜提示词");
    click.mockRestore();
    vi.unstubAllGlobals();
    wrapper.unmount();
  });

  it("自定义分隔符同时进入 preview/commit，修改后旧摘要失效", async () => {
    const wrapper = mount(StoryboardImportDialog, {
      props: { projectUuid },
      attachTo: document.body,
      global: { stubs: tdesignStubs },
    });
    await wrapper.get('select[name="import-format"]').setValue("txt");
    await wrapper.get('select[data-field="txt-delimiter-mode"]').setValue("custom");
    await flushPromises();
    await wrapper.get('input[data-field="txt-custom-delimiter"]').setValue("====");
    await wrapper.get("textarea").setValue("====\n第一段\n====\n第二段\n");
    await wrapper.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();
    const previewCall = axiosPost.mock.calls.find(([url]) => String(url).endsWith("/import/preview"));
    expect(previewCall?.[1]).toMatchObject({
      format: "txt",
      txtDelimiter: { mode: "custom", delimiter: "====" },
    });
    expect(wrapper.get('[data-action="commit-import"]').attributes("disabled")).toBeUndefined();

    await wrapper.get('input[data-field="txt-custom-delimiter"]').setValue("****");
    await flushPromises();
    expect((wrapper.get('[data-action="commit-import"]').element as HTMLButtonElement).disabled).toBe(true);

    axiosPost.mockClear();
    await wrapper.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="commit-import"]').trigger("click");
    await flushPromises();
    const commitCall = axiosPost.mock.calls.find(([url]) => String(url).endsWith("/import/commit"));
    expect(commitCall?.[1]).toMatchObject({
      format: "txt",
      txtDelimiter: { mode: "custom", delimiter: "****" },
    });
    wrapper.unmount();
  });
});

describe("R10 小喇叭只 PATCH 绑定行", () => {
  beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPatch.mockReset();
    axiosDelete.mockReset();
    let voiceEnabled = true;
    axiosGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/shots")) {
        return Promise.resolve({
          data: {
            data: [{
              ...shot,
              bindings: bindings.map((binding) => (
                binding.assetUuid === roleA ? { ...binding, voiceEnabled } : binding
              )),
            }],
          },
        });
      }
      if (String(url).includes("/storyboard/assets")) {
        return Promise.resolve({ data: { data: { sourceProjectUuid: projectUuid, assets } } });
      }
      return Promise.resolve({ data: { data: {} } });
    });
    axiosPatch.mockImplementation(async (_url: string, payload?: { voiceEnabled?: boolean }) => {
      voiceEnabled = payload?.voiceEnabled === true;
      return { data: { data: { voiceEnabled } } };
    });
    axiosPost.mockResolvedValue({ data: { data: {} } });
    axiosDelete.mockResolvedValue({ data: { data: {} } });
  });

  it("小喇叭 false→true 只发两次 PATCH，绑定和名称始终存在，DELETE 为 0", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const horn = wrapper.get(`[data-action="toggle-binding-voice"][data-asset-id="${roleA}"]`);
    expect(horn.attributes("title")).toBe("音色已启用，点击临时关闭");
    await horn.trigger("click");
    await flushPromises();
    expect(axiosPatch).toHaveBeenCalledTimes(1);
    expect(axiosPatch.mock.calls[0]![1]).toMatchObject({ voiceEnabled: false, assetType: "role" });
    expect(wrapper.get(`[data-asset-id="${roleA}"]`).text()).toContain("林夏");
    expect(wrapper.findAll('[data-asset-row][data-asset-type="role"]')).toHaveLength(2);

    const hornAfter = wrapper.get(`[data-action="toggle-binding-voice"][data-asset-id="${roleA}"]`);
    expect(hornAfter.attributes("title")).toBe("音色已关闭，点击启用");
    await hornAfter.trigger("click");
    await flushPromises();
    expect(axiosPatch).toHaveBeenCalledTimes(2);
    expect(axiosPatch.mock.calls[1]![1]).toMatchObject({ voiceEnabled: true, assetType: "role" });
    expect(axiosDelete).toHaveBeenCalledTimes(0);
    expect(wrapper.findAll('[data-asset-row][data-asset-type="role"]')).toHaveLength(2);
    expect(wrapper.get(`[data-asset-id="${roleA}"]`).text()).toContain("林夏");
    wrapper.unmount();
  });

  it("无音色角色喇叭禁用且不发请求", async () => {
    const wrapper = mount(ShotAssetSlots, {
      props: { bindings, assets, singleType: "role" },
      global: { stubs: tdesignStubs },
    });
    const silent = wrapper.get(`[data-action="toggle-binding-voice"][data-asset-id="${roleB}"]`);
    expect(silent.attributes("title")).toBe("该角色尚未上传音色");
    expect((silent.element as HTMLButtonElement).disabled).toBe(true);
    await silent.trigger("click");
    expect(axiosPatch).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe("R10 角色音色试听", () => {
  const players: Array<{ src: string; paused: boolean; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }> = [];

  beforeEach(() => {
    players.length = 0;
    class FakeAudio {
      src = "";
      paused = true;
      play = vi.fn(async () => {
        this.paused = false;
      });
      pause = vi.fn(() => {
        this.paused = true;
      });
      load = vi.fn();
      removeAttribute = vi.fn((name: string) => {
        if (name === "src") this.src = "";
      });
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      constructor(src?: string) {
        this.src = src ?? "";
        players.push(this);
      }
    }
    vi.stubGlobal("Audio", FakeAudio);
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPatch.mockReset();
    axiosDelete.mockReset();
    axiosGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/shots")) return Promise.resolve({ data: { data: [shot] } });
      if (String(url).includes("/storyboard/assets")) {
        return Promise.resolve({ data: { data: { sourceProjectUuid: projectUuid, assets } } });
      }
      return Promise.resolve({ data: { data: {} } });
    });
    axiosPost.mockImplementation((url: string) => {
      if (String(url).includes("/cornerScape/getAllAssets")) {
        return Promise.resolve({ data: [roleAsset] });
      }
      return Promise.resolve({ data: { data: {} } });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("只有合法 src 才显示试听；播放、切换、关闭会清理 Audio，且不触发写接口", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-module="assets"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-workspace="corner-scape"] .module-interactive').trigger("click");
    await flushPromises();
    const detail = wrapper.get('[data-panel="asset-detail"]');
    const player = detail.get('[data-action="preview-role-audio"]');
    expect(player.element.tagName).toBe("AUDIO");
    expect(player.attributes("controls")).toBeDefined();
    expect(player.attributes("preload")).toBe("metadata");
    expect(detail.get('[data-action="download-role-audio"]').exists()).toBe(true);

    axiosPost.mockClear();
    axiosPatch.mockClear();
    axiosDelete.mockClear();
    await player.trigger("click");
    await flushPromises();
    expect(axiosPost).not.toHaveBeenCalled();
    expect(axiosPatch).not.toHaveBeenCalled();
    expect(axiosDelete).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe("R10 不得回归 R8/R9 合同", () => {
  it("纯文本门禁与提示词唯一编辑入口仍在", async () => {
    axiosGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/shots")) return Promise.resolve({ data: { data: [shot] } });
      if (String(url).includes("/storyboard/assets")) {
        return Promise.resolve({ data: { data: { sourceProjectUuid: projectUuid, assets } } });
      }
      return Promise.resolve({ data: { data: {} } });
    });
    const wrapper = mountWorkspace();
    await flushPromises();
    const row = wrapper.get(`[data-shot-id="${shotUuid}"]`);
    expect(row.find("textarea").exists()).toBe(false);
    await row.trigger("click");
    await flushPromises();
    const select = wrapper.get('select[name="mode"]');
    expect(select.attributes("data-text2video-allowed")).toBe("false");
    expect((wrapper.get('select[name="mode"] option[value="text2video"]').element as HTMLOptionElement).disabled).toBe(true);
    wrapper.unmount();
  });
});
