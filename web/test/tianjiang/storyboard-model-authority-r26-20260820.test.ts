// @vitest-environment jsdom
/**
 * R26 RED：项目默认只负责首次初始化，用户当前明确选择必须贯穿目录刷新、换镜头与预览提交。
 */
import { flushPromises, mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import axios from "@/utils/axios";
import { modelCatalogStore, type ModelCatalogResponse } from "@/features/models/modelCatalogStore";
import projectStore from "@/stores/project";
import {
  requestStoryboardGenerationPreview,
} from "@/views/storyboardProject/storyboard-generation-preview";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";
import { useStoryboardWorkspace } from "@/views/storyboardProject/useStoryboardWorkspace";

const VENDOR = "volcengine:doubao-seedance-2-0-260128";
const DREAMINA = "dreamina-cli:seedance2.0fast";

function catalog(values: string[]): ModelCatalogResponse {
  return {
    accountScopeId: "account-r26",
    catalogVersion: 26,
    providers: [],
    items: values.map((value) => {
      const separator = value.indexOf(":");
      return {
        id: value.slice(0, separator),
        label: value,
        value: value.slice(separator + 1),
        name: value.slice(separator + 1),
        type: "video",
      };
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  modelCatalogStore.invalidateAll();
});

describe("R26 当前视频模型唯一真源", () => {
  it("项目默认 A 不得覆盖当前明确选择 B，目录刷新后仍保持 B", async () => {
    vi.spyOn(modelCatalogStore, "ensure").mockResolvedValue(catalog([VENDOR, DREAMINA]));
    vi.spyOn(modelCatalogStore, "failure").mockReturnValue(undefined);
    const { default: StoryboardGenerationSettings } = await import(
      "@/views/storyboardProject/components/StoryboardGenerationSettings.vue"
    );
    const wrapper = mount(StoryboardGenerationSettings, {
      props: {
        accountScopeId: "account-r26",
        preferredProviderModel: VENDOR,
        modelValue: {
          mediaType: "video",
          providerModel: DREAMINA,
          mode: "auto",
          durationMs: 5000,
          aspectRatio: "9:16",
        },
      },
      global: {
        stubs: {
          modelSelect: {
            props: ["modelValue", "type", "size", "disabled", "placeholder"],
            emits: ["update:modelValue"],
            template: "<div data-model-select />",
          },
        },
      },
    });
    await flushPromises();
    const updates = wrapper.emitted("update:modelValue") ?? [];
    expect(updates.some(([value]) => (value as { providerModel?: string }).providerModel !== DREAMINA)).toBe(false);
    wrapper.unmount();
  });

  it("当前明确选择 B 从目录消失时必须清空并提示重选，不得回填项目默认 A", async () => {
    vi.spyOn(modelCatalogStore, "ensure").mockResolvedValue(catalog([VENDOR]));
    vi.spyOn(modelCatalogStore, "failure").mockReturnValue(undefined);
    const { default: StoryboardGenerationSettings } = await import(
      "@/views/storyboardProject/components/StoryboardGenerationSettings.vue"
    );
    const wrapper = mount(StoryboardGenerationSettings, {
      props: {
        accountScopeId: "account-r26",
        preferredProviderModel: VENDOR,
        modelValue: {
          mediaType: "video",
          providerModel: DREAMINA,
          mode: "auto",
          durationMs: 5000,
          aspectRatio: "9:16",
        },
      },
      global: {
        stubs: {
          modelSelect: {
            props: ["modelValue", "type", "size", "disabled", "placeholder"],
            emits: ["update:modelValue"],
            template: "<div data-model-select />",
          },
        },
      },
    });
    await flushPromises();
    const updates = wrapper.emitted("update:modelValue") ?? [];
    expect((updates.at(-1)?.[0] as { providerModel?: string })?.providerModel).toBe("");
    expect(wrapper.get("[data-selection-required]").text()).toContain("请重新选择");
    wrapper.unmount();
  });

  it("视频目录刷新为空时也必须清空失效的明确选择", async () => {
    vi.spyOn(modelCatalogStore, "ensure").mockResolvedValue(catalog([]));
    vi.spyOn(modelCatalogStore, "failure").mockReturnValue(undefined);
    const { default: StoryboardGenerationSettings } = await import(
      "@/views/storyboardProject/components/StoryboardGenerationSettings.vue"
    );
    const wrapper = mount(StoryboardGenerationSettings, {
      props: {
        accountScopeId: "account-r26",
        preferredProviderModel: VENDOR,
        modelValue: {
          mediaType: "video",
          providerModel: DREAMINA,
          mode: "auto",
          durationMs: 5000,
          aspectRatio: "9:16",
        },
      },
      global: {
        stubs: {
          modelSelect: { template: "<div data-model-select />" },
        },
      },
    });
    await flushPromises();
    const updates = wrapper.emitted("update:modelValue") ?? [];
    expect((updates.at(-1)?.[0] as { providerModel?: string })?.providerModel).toBe("");
    expect(wrapper.get("[data-selection-required]").text()).toContain("请重新选择");
    wrapper.unmount();
  });

  it("父 DTO 刷新与换镜头不得把用户选择 B 静默改回项目默认 A", async () => {
    const { default: StoryboardDetailDrawer } = await import(
      "@/views/storyboardProject/components/StoryboardDetailDrawer.vue"
    );
    const shot = (shotUuid: string, order: number) => ({
      shotUuid,
      displayOrder: order,
      sourceText: `镜头${order}`,
      visualDescription: "码头",
      videoPrompt: "跟拍",
      durationMs: 5000,
      aspectRatio: "9:16",
      bindings: [],
      candidates: [],
      generationTasks: [],
    });
    const wrapper = mount(StoryboardDetailDrawer, {
      props: {
        projectUuid: "26262626-2626-4262-8262-262626262626",
        shot: shot("26262626-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1),
        generationSettings: {
          mediaType: "video",
          providerModel: VENDOR,
          mode: "auto",
          durationMs: 5000,
          aspectRatio: "9:16",
        },
      },
      global: {
        stubs: {
          TButton: { template: "<button><slot /></button>" },
          TIcon: { template: "<i />" },
          ShotCandidateStrip: { template: "<div />" },
          FinalRequestPreview: { template: "<div />" },
          StoryboardGenerationSettings: {
            props: ["modelValue"],
            emits: ["update:modelValue", "update:catalogValid"],
            template: `<button data-choose-dreamina @click="$emit('update:modelValue', { ...modelValue, providerModel: '${DREAMINA}' })">选择即梦</button>`,
          },
        },
      },
    });
    await wrapper.get("[data-choose-dreamina]").trigger("click");
    await nextTick();
    await wrapper.setProps({
      generationSettings: {
        mediaType: "video",
        providerModel: VENDOR,
        mode: "auto",
        durationMs: 5000,
        aspectRatio: "9:16",
      },
      shot: shot("26262626-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 2),
    });
    await nextTick();
    expect((wrapper.vm as { generationDraft: { providerModel: string } }).generationDraft.providerModel).toBe(DREAMINA);
    const changes = wrapper.emitted("generationSettingsChange") ?? [];
    expect((changes.at(-1)?.[0] as { providerModel?: string })?.providerModel).toBe(DREAMINA);
    wrapper.unmount();
  });

  it("预览必须保留 routeKind，并拒绝 providerModel 与 routeKind 不一致的响应", async () => {
    const post = vi.spyOn(axios, "post");
    post.mockResolvedValueOnce({
      data: {
        previewDigest: "ab".repeat(32),
        providerModel: DREAMINA,
        routeKind: "dreamina-cli",
        prompt: "码头跟拍",
        options: { mode: "text2video", aspectRatio: "9:16", durationMs: 5000, resolution: "720p" },
      },
    });
    const preview = await requestStoryboardGenerationPreview("26262626-2626-4262-8262-262626262626", {
      shotUuid: "26262626-ffff-4fff-8fff-ffffffffffff",
      mediaType: "video",
      providerModel: DREAMINA,
      mode: "auto",
      durationMs: 5000,
      aspectRatio: "9:16",
    });
    expect((preview as typeof preview & { routeKind?: unknown }).routeKind).toBe("dreamina-cli");

    post.mockResolvedValueOnce({
      data: {
        previewDigest: "cd".repeat(32),
        providerModel: DREAMINA,
        routeKind: "vendor",
        prompt: "码头跟拍",
        options: { mode: "text2video", aspectRatio: "9:16", durationMs: 5000, resolution: "720p" },
      },
    });
    await expect(requestStoryboardGenerationPreview("26262626-2626-4262-8262-262626262626", {
      shotUuid: "26262626-ffff-4fff-8fff-ffffffffffff",
      mediaType: "video",
      providerModel: DREAMINA,
      mode: "auto",
      durationMs: 5000,
      aspectRatio: "9:16",
    })).rejects.toThrow("生成预览与当前参数不一致");
  });

  it("行级、批量与项目设置必须只读取当前选择，正式提交项必须保留 routeKind", () => {
    const source = readFileSync(path.join(
      process.cwd(),
      "src/views/storyboardProject/index.vue",
    ), "utf8");
    // 中文注释：项目创建时的 videoModel 只能初始化一次，不能在任一收费入口重新夺回优先级。
    expect(source).not.toContain("store.project?.videoModel || detailGenerationSettings.providerModel");
    expect(source).toContain("@generation-settings-change");
    // 中文注释：确认阶段不再重复请求预览，但单项和批量都必须把用户已核对的路由种类交给服务端摘要复核。
    expect(source).toContain("routeKind: confirmation.preview.routeKind");
    expect(source).toContain("routeKind: previews[index].routeKind");
  });

  it("行级与批量提交必须把当前明确选择 B 及其 routeKind 原样写入真实请求体", async () => {
    setActivePinia(createPinia());
    const projectUuid = "26262626-2626-4262-8262-262626262626";
    const shotA = "26262626-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const shotB = "26262626-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    projectStore().project = {
      projectUuid,
      name: "R26 模型真源",
      projectType: "storyboard",
      myRole: "owner",
      openMode: "readwrite",
      videoModel: VENDOR,
    } as any;
    const base = `/tianjiang/runtime/projects/${projectUuid}/storyboard`;
    const post = vi.spyOn(axios, "post").mockImplementation(async (_url, payload) => {
      const body = payload as { clientOperationId?: string; items?: unknown[] };
      const size = Array.isArray(body.items) ? body.items.length : 1;
      return {
        status: 200,
        data: {
          code: 0,
          data: Array.from({ length: size }, (_, index) => ({
            taskUuid: `r26-task-${index + 1}`,
            status: "queued",
            clientOperationId: body.clientOperationId,
          })),
        },
      } as any;
    });
    vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        data: [
          { shotUuid: shotA, displayOrder: 1, sourceText: "A", durationMs: 5000, aspectRatio: "9:16", bindings: [], candidates: [], generationTasks: [] },
          { shotUuid: shotB, displayOrder: 2, sourceText: "B", durationMs: 5000, aspectRatio: "9:16", bindings: [], candidates: [], generationTasks: [] },
        ],
      },
    } as any);
    const workspace = useStoryboardWorkspace();
    const digest = "ab".repeat(32);
    const singleOperationId = "26262626-1111-4111-8111-111111111111";
    const batchOperationId = "26262626-2222-4222-8222-222222222222";

    await workspace.generateShot(shotA, "video", {
      providerModel: DREAMINA,
      routeKind: "dreamina-cli",
      mode: "text2video",
      resolution: "720p",
      expectedPreviewDigest: digest,
    }, singleOperationId);
    expect(post).toHaveBeenCalledWith(`${base}/generate`, {
      clientOperationId: singleOperationId,
      shotUuid: shotA,
      mediaType: "video",
      providerModel: DREAMINA,
      routeKind: "dreamina-cli",
      mode: "text2video",
      resolution: "720p",
      expectedPreviewDigest: digest,
      paidBatchConfirmed: false,
    }, { preserveResponse: true });

    const selectedItems = [shotA, shotB].map((shotUuid) => ({
      shotUuid,
      mediaType: "video" as const,
      providerModel: DREAMINA,
      routeKind: "dreamina-cli" as const,
      mode: "text2video" as const,
      resolution: "720p",
      expectedPreviewDigest: digest,
    }));
    await workspace.generateBatch(selectedItems, true, batchOperationId);
    expect(post).toHaveBeenCalledWith(`${base}/generate`, {
      clientOperationId: batchOperationId,
      items: selectedItems,
      paidBatchConfirmed: true,
    }, { preserveResponse: true });

    // 中文注释：项目默认 A 只负责首次初始化，收费请求必须以用户当前明确选择 B 为准。
    for (const [, body] of post.mock.calls) {
      const payload = body as { providerModel?: string; routeKind?: string; items?: Array<{ providerModel: string; routeKind: string }> };
      if (payload.items) {
        expect(payload.items.every((item) => item.providerModel === DREAMINA && item.routeKind === "dreamina-cli")).toBe(true);
      } else {
        expect(payload.providerModel).toBe(DREAMINA);
        expect(payload.routeKind).toBe("dreamina-cli");
      }
    }
  });

  it("当前镜头正式提交必须把预览确认的 B、mode 与 routeKind 一起写入真实请求体", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const projectUuid = "26262626-2626-4262-8262-262626262626";
    const shotUuid = "26262626-cccc-4ccc-8ccc-cccccccccccc";
    const digest = "ef".repeat(32);
    const store = projectStore();
    store.project = {
      projectUuid,
      name: "R26 当前镜头模型真源",
      projectType: "storyboard",
      myRole: "owner",
      openMode: "readwrite",
      videoModel: VENDOR,
    } as any;
    store.access = { projectUuid, mode: "readwrite", reason: "test_open", lockHolder: "" } as any;
    vi.spyOn(modelCatalogStore, "ensure").mockResolvedValue(catalog([VENDOR, DREAMINA]));
    vi.spyOn(modelCatalogStore, "failure").mockReturnValue(undefined);
    vi.spyOn(axios, "get").mockImplementation(async (url) => {
      if (String(url).endsWith("/shots")) {
        return {
          data: {
            data: [{
              shotUuid,
              displayOrder: 1,
              sourceText: "码头跟拍",
              visualDescription: "码头跟拍",
              videoPrompt: "码头跟拍",
              durationMs: 5000,
              aspectRatio: "9:16",
              bindings: [],
              candidates: [],
              generationTasks: [],
            }],
          },
        } as any;
      }
      if (String(url).endsWith("/assets")) {
        return { data: { data: { sourceProjectUuid: projectUuid, assets: [] } } } as any;
      }
      if (String(url) === "/setting/dreaminaCli/getStatus") {
        return { data: { data: { queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 } } } } as any;
      }
      return { data: { data: {} } } as any;
    });
    const put = vi.spyOn(axios, "put")
      .mockRejectedValueOnce(new Error("C:\\runtime\\db2.sqlite SELECT cookie=sk-secret"))
      .mockResolvedValueOnce({ data: { videoModel: DREAMINA } } as any);
    const post = vi.spyOn(axios, "post").mockImplementation(async (url, payload) => {
      if (String(url).endsWith("/generate/preview")) {
        return {
          data: {
            previewDigest: digest,
            providerModel: DREAMINA,
            routeKind: "dreamina-cli",
            prompt: "码头跟拍",
            options: {
              mode: "text2video",
              aspectRatio: "9:16",
              durationMs: 5000,
              resolution: "720p",
            },
          },
        } as any;
      }
      if (String(url).endsWith("/storyboard/generate")) {
        const body = payload as { clientOperationId?: string };
        return {
          status: 200,
          data: {
            code: 0,
            data: [{
              taskUuid: "r26-current-shot-task",
              status: "queued",
              clientOperationId: body.clientOperationId,
            }],
          },
        } as any;
      }
      return { data: { code: 0, data: {} } } as any;
    });
    const wrapper = mount(StoryboardWorkspace, {
      global: {
        plugins: [pinia],
        stubs: {
          TButton: {
            inheritAttrs: true,
            props: ["loading", "disabled"],
            template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
          },
          TIcon: { template: "<i />" },
          StoryboardTable: { template: "<div />" },
          StoryboardCornerScapeAssets: { template: "<div />" },
          StoryboardSettings: { template: "<div />" },
          StoryboardImportDialog: { template: "<div />" },
          StoryboardExportDialog: { template: "<div />" },
          StoryboardAssetPickerDrawer: { template: "<div />" },
          StoryboardBatchGenerationDialog: { template: "<div />" },
          StoryboardGenerationConfirmDialog: { template: "<div />" },
          ShotCandidateStrip: { template: "<div />" },
          FinalRequestPreview: { template: "<div />" },
          StoryboardGenerationSettings: {
            props: ["modelValue"],
            emits: ["update:modelValue", "update:catalogValid"],
            // 中文注释：点击代表用户在真实抽屉中把项目初始 A 明确改选为即梦 B。
            template: `<button type="button" data-action="choose-dreamina" @click="$emit('update:catalogValid', true); $emit('update:modelValue', { ...modelValue, providerModel: '${DREAMINA}' })">选择即梦</button>`,
          },
        },
      },
    });
    await flushPromises();
    await wrapper.get('[data-action="choose-dreamina"]').trigger("click");
    await flushPromises();
    expect(put).toHaveBeenLastCalledWith(
      `/tianjiang/runtime/projects/${projectUuid}/storyboard/settings`,
      { videoModel: DREAMINA, resolution: "720p" },
    );
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();
    // 中文注释：模型保存失败时保留用户当前选择，但必须阻止预览和收费提交，并只显示脱敏中文错误。
    expect(post.mock.calls.some(([url]) => String(url).endsWith("/generate/preview"))).toBe(false);
    expect(wrapper.text()).toContain("视频模型保存失败，请重试");
    expect(wrapper.text()).not.toContain("db2.sqlite");

    await wrapper.get('[data-action="choose-dreamina"]').trigger("click");
    await flushPromises();
    expect(put).toHaveBeenCalledTimes(2);
    expect(store.project?.videoModel).toBe(DREAMINA);
    await wrapper.get('[data-action="preview-shot-video"]').trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-preview-status]").text()).toContain("预览已就绪");
    await wrapper.get('[data-action="submit-current-shot"]').trigger("click");
    await flushPromises();

    const generateCall = post.mock.calls.find(([url]) => String(url).endsWith("/storyboard/generate"));
    expect(generateCall).toBeDefined();
    // 中文注释：正式收费提交必须原样携带刚才预览确认的完整路由身份，不能只保留模型与模式。
    expect(generateCall?.[1]).toMatchObject({
      shotUuid,
      providerModel: DREAMINA,
      mode: "text2video",
      routeKind: "dreamina-cli",
      expectedPreviewDigest: digest,
    });
    wrapper.unmount();
  });
});
