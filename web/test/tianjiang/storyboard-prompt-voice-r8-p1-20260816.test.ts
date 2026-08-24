// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

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

import projectStore from "@/stores/project";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";
import StoryboardTable from "@/views/storyboardProject/components/StoryboardTable.vue";
import ShotAssetSlots from "@/views/storyboardProject/components/ShotAssetSlots.vue";
import path from "node:path";
import { compile } from "sass";
import StoryboardDetailDrawer from "@/views/storyboardProject/components/StoryboardDetailDrawer.vue";

const storyboardStyle = compile(
  path.join(process.cwd(), "src/views/storyboardProject/styles/storyboard-workspace.scss"),
  { style: "expanded" },
).css;

const projectUuid = "81111111-1111-4111-a111-111111111111";
const shotUuid = "81111111-1111-4111-a111-111111111101";
const roleA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const roleB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const sceneUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

const assets = [
  { assetUuid: roleA, name: "林夏", type: "role", assetType: "role", hasAudio: true, sourceProjectUuid: projectUuid },
  { assetUuid: roleB, name: "卫兵", type: "role", assetType: "role", hasAudio: false, sourceProjectUuid: projectUuid },
  { assetUuid: sceneUuid, name: "剧院", type: "scene", assetType: "scene", sourceProjectUuid: projectUuid },
];

const bindings = [
  { sourceProjectUuid: projectUuid, assetUuid: roleA, assetType: "role", relationRole: "appear", voiceEnabled: true },
  { sourceProjectUuid: projectUuid, assetUuid: roleB, assetType: "role", relationRole: "appear", voiceEnabled: true },
  { sourceProjectUuid: projectUuid, assetUuid: sceneUuid, assetType: "scene", relationRole: "appear", voiceEnabled: true },
];

const shot = {
  shotUuid,
  displayOrder: 1,
  sourceText: "林夏走进剧院。",
  visualDescription: "雨夜",
  videoPrompt: "缓慢跟随角色走入剧院",
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
  TTag: { template: "<span><slot /></span>" },
  TCard: { inheritAttrs: true, template: '<section v-bind="$attrs"><slot name="title" /><slot /></section>' },
  TForm: { template: "<form><slot /></form>" },
  TFormItem: { template: "<div><slot /></div>" },
  TDialog: { inheritAttrs: true, props: ["visible", "header"], template: '<section v-if="visible" v-bind="$attrs"><slot /></section>' },
  TDrawer: {
    inheritAttrs: true,
    props: ["visible", "modelValue", "header"],
    template: '<aside v-if="visible || modelValue" v-bind="$attrs" role="dialog"><slot /><slot name="footer" /></aside>',
  },
  TEmpty: { template: "<div>empty</div>" },
  TLoading: { template: "<div><slot /></div>" },
  TSelect: { template: "<select><slot /></select>" },
  TInput: { inheritAttrs: true, props: ["modelValue"], template: '<input v-bind="$attrs" :value="modelValue" />' },
  TTextarea: { inheritAttrs: true, props: ["modelValue"], template: '<textarea v-bind="$attrs" />' },
  TCheckbox: { template: '<input type="checkbox" />' },
  TCheckboxGroup: { template: "<div><slot /></div>" },
  TImage: { template: "<img />" },
  TImageViewer: { template: "<div />" },
  TPopup: { template: "<div><slot /></div>" },
};

function mountWorkspace(): VueWrapper {
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
  (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(i18n.global.t(key));
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = projectStore();
  store.project = {
    id: "801",
    projectUuid,
    name: "雨夜剧场",
    describe: "R8 音色与提示词",
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

describe("R8 角色音色喇叭开关", () => {
  it("有音色的角色默认开启喇叭，无音色禁用，场景不显示", async () => {
    const wrapper = mount(ShotAssetSlots, {
      props: { bindings, assets, singleType: "role" },
      global: { stubs: tdesignStubs },
    });
    const voices = wrapper.findAll('[data-action="toggle-binding-voice"]');
    expect(voices).toHaveLength(2);
    expect(voices[0]!.attributes("data-voice-available")).toBe("true");
    expect(voices[0]!.attributes("data-voice-enabled")).toBe("true");
    expect(voices[0]!.attributes("title")).toBe("音色已启用，点击临时关闭");
    expect((voices[0]!.element as HTMLButtonElement).disabled).toBe(false);
    expect(voices[1]!.attributes("data-voice-available")).toBe("false");
    expect((voices[1]!.element as HTMLButtonElement).disabled).toBe(true);
    expect(voices[1]!.attributes("title")).toContain("该角色尚未上传音色");
    wrapper.unmount();

    const scene = mount(ShotAssetSlots, {
      props: { bindings, assets, singleType: "scene" },
      global: { stubs: tdesignStubs },
    });
    expect(scene.find('[data-action="toggle-binding-voice"]').exists()).toBe(false);
    scene.unmount();
  });

  it("切换第1个角色喇叭只更新该绑定，且不打开选择抽屉", async () => {
    const wrapper = mount(StoryboardTable, {
      props: {
        projectUuid,
        shots: [shot],
        assets,
        selectedShotUuid: shotUuid,
        selectedShotIds: [],
      },
      global: { stubs: tdesignStubs },
    });
    const first = wrapper.get(`[data-action="toggle-binding-voice"][data-asset-id="${roleA}"]`);
    await first.trigger("click");
    expect(wrapper.emitted("pickAsset")).toBeFalsy();
    expect(wrapper.emitted("toggleBindingVoice")?.[0]).toMatchObject([{
      shotUuid,
      assetUuid: roleA,
      assetType: "role",
      sourceProjectUuid: projectUuid,
      voiceEnabled: false,
    }]);
    wrapper.unmount();
  });
});

describe("R8 删除表格内提示词编辑", () => {
  beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPatch.mockReset();
    axiosGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/shots")) return Promise.resolve({ data: { data: [shot] } });
      if (String(url).includes("/storyboard/assets")) {
        return Promise.resolve({ data: { data: { sourceProjectUuid: projectUuid, assets } } });
      }
      return Promise.resolve({ data: { data: {} } });
    });
    axiosPost.mockResolvedValue({ data: { data: {} } });
    axiosPatch.mockResolvedValue({ data: { data: {} } });
  });

  it("表格不再出现编辑提示词按钮或 textarea，右侧是唯一编辑入口", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    const row = wrapper.get(`[data-shot-id="${shotUuid}"]`);
    expect(row.text()).not.toContain("编辑提示词");
    expect(row.find("textarea").exists()).toBe(false);
    expect(row.get('[data-field="video-prompt"]').text()).toContain("缓慢跟随角色走入剧院");
    await row.trigger("click");
    await flushPromises();
    const detail = wrapper.get('[data-panel="shot-production"]');
    expect(detail.find('textarea[name="videoPrompt"]').exists()).toBe(true);
    await detail.get('textarea[name="videoPrompt"]').setValue("新的分镜提示词");
    await detail.get('[data-action="save-shot"]').trigger("click");
    await flushPromises();
    expect(axiosPatch.mock.calls.some(([url, payload]) => (
      String(url).includes(`/shots/${shotUuid}`)
      && (payload as { videoPrompt?: string }).videoPrompt === "新的分镜提示词"
    ))).toBe(true);
    wrapper.unmount();
  });
});

describe("R8 提示词高度合同", () => {
  it("表格提示词使用统一基准高度且上限为 3 倍，并保留换行", () => {
    expect(storyboardStyle).toContain("--shot-prompt-base-height");
    expect(storyboardStyle).toMatch(/max-height:\s*calc\(\s*var\(--shot-prompt-base-height\)\s*\*\s*3\s*\)/);
    expect(storyboardStyle).not.toMatch(/-webkit-line-clamp:\s*4/);
    expect(storyboardStyle).toMatch(/white-space:\s*pre-wrap/);
    expect(storyboardStyle).toMatch(/--shot-detail-prompt-base-height/);
  });

  it("右侧 textarea 聚焦至少 2 倍、输入最多 3 倍", async () => {
    const wrapper = mount(StoryboardDetailDrawer, {
      props: {
        shot,
        projectUuid,
        videoModels: [{ value: "dreamina-cli:seedance2.0fast", label: "Seedance 2.0 Fast" }],
        generationSettings: {
          mediaType: "video",
          providerModel: "dreamina-cli:seedance2.0fast",
          mode: "auto",
          durationMs: 5000,
          aspectRatio: "9:16",
        },
      },
      attachTo: document.body,
      global: {
        plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
        stubs: tdesignStubs,
      },
    });
    await flushPromises();
    const textarea = wrapper.get('textarea[name="videoPrompt"]');
    expect(textarea.attributes("data-prompt-auto-height")).toBe("true");
    await textarea.trigger("focus");
    await flushPromises();
    expect(Number(textarea.attributes("data-height-scale") || 0)).toBeGreaterThanOrEqual(2);
    await textarea.setValue(`${"很长的分镜提示词，用于撑高输入框。\n".repeat(40)}`);
    await textarea.trigger("input");
    await flushPromises();
    expect(Number(textarea.attributes("data-height-scale") || 0)).toBeLessThanOrEqual(3);
    wrapper.unmount();
  });
});
