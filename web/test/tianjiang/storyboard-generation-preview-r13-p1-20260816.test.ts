// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import { modelCatalogStore, setAccountScope } from "@/features/models/modelCatalogStore";
import StoryboardDetailDrawer from "@/views/storyboardProject/components/StoryboardDetailDrawer.vue";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const axiosPatch = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    patch: (...args: unknown[]) => axiosPatch(...args),
  },
}));

const projectUuid = "d1111111-1111-4111-a111-111111111111";
const roleA = "d1111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const sceneA = "d1111111-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const toolA = "d1111111-cccc-4ccc-8ccc-ccccccccccc1";

const importedPrompt = [
  "景别时长：约12秒",
  "场景：吉庆阁码头（白天）",
  "人物：黄晚棠、村民",
  "分镜：黄晚棠从人群中挤到前面。",
].join("\n");

const shot = {
  shotUuid: "d1111111-1111-4111-a111-111111111101",
  displayOrder: 1,
  sourceText: importedPrompt,
  visualDescription: "",
  videoPrompt: importedPrompt,
  durationMs: 15_000,
  aspectRatio: "9:16",
  bindings: [
    { sourceProjectUuid: projectUuid, assetUuid: roleA, assetType: "role", relationRole: "appear", voiceEnabled: true },
    { sourceProjectUuid: projectUuid, assetUuid: sceneA, assetType: "scene", relationRole: "appear" },
    { sourceProjectUuid: projectUuid, assetUuid: toolA, assetType: "tool", relationRole: "appear" },
  ],
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
  TAvatar: { template: "<span />" },
  TSelect: {
    props: ["modelValue", "disabled", "placeholder", "name"],
    emits: ["update:modelValue", "change"],
    template: '<select :name="name" :value="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /><slot name="empty" /></select>',
  },
  TOptionGroup: { props: ["label"], template: '<optgroup :label="label"><slot /></optgroup>' },
  TOption: { props: ["value", "label", "disabled"], template: '<option :value="value" :disabled="disabled">{{ label }}</option>' },
};

function installVideoCatalog() {
  setAccountScope(null);
  modelCatalogStore.invalidateAll();
  axiosGet.mockResolvedValue({ data: { data: { catalogVersion: 13 } } });
  const previous = axiosPost.getMockImplementation();
  axiosPost.mockImplementation((url: string, payload?: Record<string, unknown>) => {
    if (String(url).endsWith("/modelSelect/getModelList")) {
      return Promise.resolve({
        data: {
          data: {
            accountScopeId: "",
            catalogVersion: 13,
            items: [{
              id: "dreamina-cli",
              name: "即梦 CLI",
              label: "Seedance 2.0 Fast",
              value: "dreamina-cli:seedance2.0fast",
              type: "video",
              disabled: false,
            }],
            providers: [{ providerId: "dreamina-cli", providerName: "即梦 CLI", state: "ready" }],
          },
        },
      });
    }
    return previous?.(url, payload) ?? Promise.resolve({ data: {} });
  });
}

async function waitForCatalogReady(wrapper: VueWrapper): Promise<void> {
  await flushPromises();
  await flushPromises();
  expect(wrapper.get('[data-panel="storyboard-generation-settings"]').attributes("data-catalog-valid")).toBe("true");
}

function mountDrawer(displayOrder = 1) {
  installVideoCatalog();
  return mount(StoryboardDetailDrawer, {
    props: {
      shot: { ...shot, displayOrder },
      projectUuid,
      videoModels: [{ value: "dreamina-cli:seedance2.0fast", label: "seedance2.0fast" }],
      generationSettings: {
        mediaType: "video",
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "auto",
        durationMs: 15_000,
        aspectRatio: "9:16",
      },
    },
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
      stubs: tdesignStubs,
    },
  });
}

describe("R13 删除重复生成入口并显示分镜序号", () => {
  it("右侧生成区不得再出现生成视频按钮，只保留预览和提交当前分镜", () => {
    const wrapper = mountDrawer();
    const labels = wrapper.findAll("button").map((button) => button.text());
    expect(labels.filter((text) => text.includes("生成视频"))).toHaveLength(0);
    expect(wrapper.find(".detailLegacyActions").exists()).toBe(false);
    expect(wrapper.find('[data-action="generate-video"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="retry-video"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="preview-shot-video"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="submit-current-shot"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("提交按钮必须使用两位 shotNumber", async () => {
    const first = mountDrawer(1);
    expect(first.get('[data-action="submit-current-shot"]').text()).toBe("提交当前分镜 01");
    first.unmount();
    const second = mountDrawer(2);
    expect(second.get('[data-action="submit-current-shot"]').text()).toBe("提交当前分镜 02");
    second.unmount();
  });
});

describe("R13 预览失败不得吞掉稳定安全错误，成功后解锁提交", () => {
  it("未知内部错误仍用通用文案，不得回显路径", async () => {
    const wrapper = mountDrawer();
    axiosPost.mockImplementation((url: string) => {
      if (String(url).endsWith("/modelSelect/getModelList")) {
        return Promise.resolve({
          data: {
            data: {
              accountScopeId: "",
              catalogVersion: 13,
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
      return Promise.reject({
        code: "SQLITE_ERROR",
        message: "E:\\secret\\db.sqlite",
      });
    });
    await waitForCatalogReady(wrapper);
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();
    const status = wrapper.get("[data-preview-status]").text();
    expect(status).toBe("生成预览失败，请重试");
    expect(status).not.toContain("E:\\secret\\db.sqlite");
    expect((wrapper.get('[data-action="submit-current-shot"]').element as HTMLButtonElement).disabled).toBe(true);
    wrapper.unmount();
  });

  it("稳定服务端错误必须显示白名单中文，不得无条件覆盖", async () => {
    const wrapper = mountDrawer();
    axiosPost.mockImplementation((url: string) => {
      if (String(url).endsWith("/modelSelect/getModelList")) {
        return Promise.resolve({
          data: {
            data: {
              accountScopeId: "",
              catalogVersion: 13,
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
      return Promise.reject({
        code: "STORYBOARD_REFERENCE_MISSING",
        message: "分镜参考素材记录缺失",
      });
    });
    await waitForCatalogReady(wrapper);
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-preview-status]").text()).toBe("分镜参考素材记录缺失");
    expect(wrapper.get("[data-preview-status]").text()).not.toBe("生成预览失败，请重试");
    wrapper.unmount();
  });

  it("成功预览后解锁提交当前分镜 01", async () => {
    const wrapper = mountDrawer();
    axiosPost.mockImplementation((url: string, payload?: Record<string, unknown>) => {
      if (String(url).endsWith("/modelSelect/getModelList")) {
        return Promise.resolve({
          data: {
            data: {
              accountScopeId: "",
              catalogVersion: 13,
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
      return Promise.resolve({
        data: {
          previewDigest: "a".repeat(64),
          providerModel: payload?.providerModel ?? "dreamina-cli:seedance2.0fast",
          routeKind: "dreamina-cli",
          prompt: importedPrompt,
          options: {
            aspectRatio: "9:16",
            durationMs: 15_000,
            resolution: "720p",
            mode: "multimodal2video",
          },
        },
      });
    });
    await waitForCatalogReady(wrapper);
    expect((wrapper.get('[data-action="submit-current-shot"]').element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-preview-status]").text()).toBe("预览已就绪");
    expect((wrapper.get('[data-action="submit-current-shot"]').element as HTMLButtonElement).disabled).toBe(false);
    expect(wrapper.get('[data-action="submit-current-shot"]').text()).toBe("提交当前分镜 01");
    wrapper.unmount();
  });
});
