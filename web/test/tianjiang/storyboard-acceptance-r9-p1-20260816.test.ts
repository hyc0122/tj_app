// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import { modelCatalogStore, setAccountScope } from "@/features/models/modelCatalogStore";
import projectStore from "@/stores/project";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";
import StoryboardDetailDrawer from "@/views/storyboardProject/components/StoryboardDetailDrawer.vue";

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

const projectUuid = "91111111-1111-4111-a111-111111111111";
const shotUuid = "91111111-1111-4111-a111-111111111101";
const roleUuid = "9aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

const videoModels = [{ value: "dreamina-cli:seedance2.0fast", label: "Seedance 2.0 Fast" }];
const generationSettings = {
  mediaType: "video" as const,
  providerModel: "dreamina-cli:seedance2.0fast",
  mode: "text2video" as const,
  durationMs: 5000,
  aspectRatio: "9:16",
};

const tdesignStubs = {
  TButton: {
    inheritAttrs: true,
    props: ["loading", "disabled"],
    template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
  },
  TIcon: { template: "<i />" },
  TAvatar: { template: "<span />" },
  TSelect: {
    props: ["modelValue", "disabled", "placeholder", "name"],
    emits: ["update:modelValue", "change"],
    template: '<select :name="name" :value="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /><slot name="empty" /></select>',
  },
  TOptionGroup: { props: ["label"], template: '<optgroup :label="label"><slot /></optgroup>' },
  TOption: { props: ["value", "label", "disabled"], template: '<option :value="value" :disabled="disabled">{{ label }}</option>' },
  TDialog: {
    inheritAttrs: true,
    props: ["visible", "header"],
    template: '<section v-if="visible" v-bind="$attrs"><slot /></section>',
  },
  TDrawer: {
    inheritAttrs: true,
    props: ["visible", "modelValue", "header"],
    template: '<aside v-if="visible || modelValue" v-bind="$attrs" role="dialog"><slot /><slot name="footer" /></aside>',
  },
};

function unboundShot() {
  return {
    shotUuid,
    displayOrder: 1,
    sourceText: "空镜。",
    visualDescription: "雨夜",
    videoPrompt: "缓慢推进",
    durationMs: 5000,
    aspectRatio: "9:16",
    bindings: [],
    candidates: [],
    generationTasks: [],
  };
}

function boundShot() {
  return {
    ...unboundShot(),
    bindings: [{
      sourceProjectUuid: projectUuid,
      assetUuid: roleUuid,
      assetType: "role",
      relationRole: "appear",
      voiceEnabled: true,
    }],
  };
}

function mountDrawer(shot: ReturnType<typeof boundShot>, mode: "auto" | "text2video" = "text2video") {
  setAccountScope(null);
  modelCatalogStore.invalidateAll();
  axiosGet.mockResolvedValue({ data: { data: { catalogVersion: 9 } } });
  const previous = axiosPost.getMockImplementation();
  axiosPost.mockImplementation((url: string, payload?: Record<string, unknown>) => {
    if (String(url).endsWith("/modelSelect/getModelList")) {
      return Promise.resolve({
        data: {
          data: {
            accountScopeId: "",
            catalogVersion: 9,
            items: [{
              id: "dreamina-cli",
              name: "即梦 CLI",
              label: "Seedance 2.0 Fast",
              value: "dreamina-cli:seedance2.0fast",
              type: "video",
            }],
            providers: [],
          },
        },
      });
    }
    return previous?.(url, payload) ?? Promise.resolve({ data: {} });
  });
  return mount(StoryboardDetailDrawer, {
    props: {
      shot,
      projectUuid,
      videoModels,
      generationSettings: { ...generationSettings, mode },
    },
    attachTo: document.body,
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
      stubs: tdesignStubs,
    },
  });
}

function mountWorkspace(shot: ReturnType<typeof boundShot>) {
  setAccountScope(null);
  modelCatalogStore.invalidateAll();
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
  (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(i18n.global.t(key));
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = projectStore();
  store.project = {
    id: "901",
    projectUuid,
    name: "R9 验收",
    describe: "text2video",
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
    imageModel: "",
    videoModel: "dreamina-cli:seedance2.0fast",
  } as any;
  store.access = { projectUuid, mode: "readwrite", reason: "test_open", lockHolder: "" };
  axiosGet.mockImplementation((url: string) => {
    if (String(url).endsWith("/shots")) return Promise.resolve({ data: { data: [shot] } });
    if (String(url).includes("/storyboard/assets")) {
      return Promise.resolve({
        data: {
          data: {
            sourceProjectUuid: projectUuid,
            assets: [{
              assetUuid: roleUuid,
              name: "林夏",
              type: "role",
              hasAudio: true,
              sourceProjectUuid: projectUuid,
            }],
          },
        },
      });
    }
    if (String(url).includes("/modelSelect/getCatalogVersion")) {
      return Promise.resolve({ data: { data: { catalogVersion: 9 } } });
    }
    return Promise.resolve({ data: { data: {} } });
  });
  axiosPost.mockImplementation((url: string, payload?: Record<string, unknown>) => {
    if (String(url).endsWith("/modelSelect/getModelList")) {
      return Promise.resolve({
        data: {
          data: {
            accountScopeId: "",
            catalogVersion: 9,
            items: [{
              id: "dreamina-cli",
              name: "即梦 CLI",
              label: "Seedance 2.0 Fast",
              value: "dreamina-cli:seedance2.0fast",
              type: "video",
            }],
            providers: [],
          },
        },
      });
    }
    if (String(url).endsWith("/generate/preview")) {
      return Promise.resolve({
        data: {
          data: {
            previewDigest: "a".repeat(64),
            providerModel: "dreamina-cli:seedance2.0fast",
            routeKind: "dreamina-cli",
            prompt: "缓慢推进",
            options: {
              aspectRatio: "9:16",
              durationMs: 5000,
              resolution: "720p",
              mode: payload?.mode === "text2video" ? "text2video" : "image2video",
            },
          },
        },
      });
    }
    return Promise.resolve({ data: { data: {} } });
  });
  return mount(StoryboardWorkspace, {
    attachTo: document.body,
    global: {
      plugins: [pinia, i18n],
      stubs: {
        ...tdesignStubs,
        ImageTools: { template: "<div />" },
        "i-plus": { template: "<i />" },
      },
    },
  });
}

describe("R9 有绑定禁用纯文本生成", () => {
  it("有角色绑定的详情不得选择 text2video，已有选择必须回落 auto", async () => {
    const wrapper = mountDrawer(boundShot(), "text2video");
    await flushPromises();
    const select = wrapper.get('select[name="mode"]');
    const textOption = wrapper.get('select[name="mode"] option[value="text2video"]');
    expect(select.attributes("data-text2video-allowed")).toBe("false");
    expect((textOption.element as HTMLOptionElement).disabled).toBe(true);
    expect((select.element as HTMLSelectElement).value).toBe("auto");
    await select.setValue("text2video");
    await flushPromises();
    expect((select.element as HTMLSelectElement).value).toBe("auto");
    wrapper.unmount();
  });

  it("无绑定镜头仍可选择 text2video", async () => {
    const wrapper = mountDrawer(unboundShot(), "auto");
    await flushPromises();
    const select = wrapper.get('select[name="mode"]');
    expect(select.attributes("data-text2video-allowed")).toBe("true");
    expect((wrapper.get('select[name="mode"] option[value="text2video"]').element as HTMLOptionElement).disabled).toBe(false);
    await select.setValue("text2video");
    await flushPromises();
    expect((select.element as HTMLSelectElement).value).toBe("text2video");
    wrapper.unmount();
  });

  it("有绑定预览不得提交 text2video，无绑定预览与正式生成模式一致", async () => {
    const bound = mountWorkspace(boundShot());
    await flushPromises();
    await bound.get(`[data-shot-id="${shotUuid}"]`).trigger("click");
    await flushPromises();
    await bound.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();
    const boundPreview = axiosPost.mock.calls.find(([url]) => String(url).endsWith("/generate/preview"));
    expect(boundPreview?.[1]).toMatchObject({ mode: "auto" });
    expect(boundPreview?.[1]).not.toMatchObject({ mode: "text2video" });
    bound.unmount();

    axiosPost.mockClear();
    const free = mountWorkspace(unboundShot());
    await flushPromises();
    await free.get(`[data-shot-id="${shotUuid}"]`).trigger("click");
    await flushPromises();
    await free.get('select[name="mode"]').setValue("text2video");
    await flushPromises();
    await free.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();
    const freePreview = axiosPost.mock.calls.find(([url]) => String(url).endsWith("/generate/preview"));
    expect(freePreview?.[1]).toMatchObject({ mode: "text2video" });
    await free.get('[data-action="submit-current-shot"]').trigger("click");
    await flushPromises();
    const formal = axiosPost.mock.calls.find(([url]) => String(url).endsWith("/generate"));
    expect(formal?.[1]).toMatchObject({ mode: "text2video" });
    free.unmount();
  });
});

describe("R9 右侧长提示词失焦恢复基础高度", () => {
  it("长文本聚焦至少 2 倍，输入最多 3 倍，失焦精确回到基础高度", async () => {
    const wrapper = mountDrawer(unboundShot(), "auto");
    await flushPromises();
    const textarea = wrapper.get('textarea[name="videoPrompt"]');
    const element = textarea.element as HTMLTextAreaElement;
    Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => 400 });
    await textarea.trigger("focus");
    await flushPromises();
    expect(Number(textarea.attributes("data-height-scale") || 0)).toBeGreaterThanOrEqual(2);
    await textarea.setValue(`${"很长的分镜提示词，用于撑高输入框。\n".repeat(40)}`);
    await textarea.trigger("input");
    await flushPromises();
    expect(Number(textarea.attributes("data-height-scale") || 0)).toBeLessThanOrEqual(3);
    await textarea.trigger("blur");
    await flushPromises();
    expect(Number(textarea.attributes("data-height-scale") || 0)).toBe(1);
    expect(element.style.height).toBe("96px");
    wrapper.unmount();
  });
});
