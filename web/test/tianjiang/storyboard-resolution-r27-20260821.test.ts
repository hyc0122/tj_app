// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";

import { modelCatalogStore, type ModelCatalogResponse } from "@/features/models/modelCatalogStore";
import projectStore from "@/stores/project";
import axios from "@/utils/axios";
import StoryboardGenerationSettings from "@/views/storyboardProject/components/StoryboardGenerationSettings.vue";
import { buildGenerationPreviewBody } from "@/views/storyboardProject/storyboard-generation-preview";
import { useStoryboardWorkspace } from "@/views/storyboardProject/useStoryboardWorkspace";

const DREAMINA = "dreamina-cli:seedance2.0fast";

function catalog(): ModelCatalogResponse {
  return {
    accountScopeId: "account-r27-resolution",
    catalogVersion: 27,
    providers: [],
    items: [{
      id: "dreamina-cli",
      label: "Seedance 2.0 Fast",
      value: "seedance2.0fast",
      name: "Seedance 2.0 Fast",
      type: "video",
    }],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  modelCatalogStore.invalidateAll();
});

describe("R27 分镜视频分辨率合同", () => {
  it("旧项目空值显示 720p，并提供 480p、720p、1080p 三个选项", async () => {
    vi.spyOn(modelCatalogStore, "ensure").mockResolvedValue(catalog());
    vi.spyOn(modelCatalogStore, "failure").mockReturnValue(undefined);
    const wrapper = mount(StoryboardGenerationSettings, {
      props: {
        accountScopeId: "account-r27-resolution",
        modelValue: {
          mediaType: "video",
          providerModel: DREAMINA,
          mode: "auto",
          durationMs: 5000,
          aspectRatio: "9:16",
        } as any,
      },
      global: {
        stubs: {
          modelSelect: { template: "<div data-model-select />" },
        },
      },
    });
    await flushPromises();

    const select = wrapper.get<HTMLSelectElement>('select[name="resolution"]');
    expect(select.element.value).toBe("720p");
    expect(select.findAll("option").map((option) => option.attributes("value"))).toEqual([
      "480p",
      "720p",
      "1080p",
    ]);
    await select.setValue("1080p");
    const updates = wrapper.emitted("update:modelValue") ?? [];
    expect((updates.at(-1)?.[0] as { resolution?: string })?.resolution).toBe("1080p");
    wrapper.unmount();
  });

  it("预览必须使用用户明确选择的 1080p，不能写死为 720p", () => {
    const body = buildGenerationPreviewBody({
      shotUuid: "27272727-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      mediaType: "video",
      providerModel: DREAMINA,
      mode: "auto",
      durationMs: 5000,
      aspectRatio: "9:16",
      resolution: "1080p",
    } as any);
    expect((body.settings as { resolution?: string }).resolution).toBe("1080p");
  });

  it("正式提交必须携带与预览一致的 1080p", async () => {
    setActivePinia(createPinia());
    const projectUuid = "27272727-2727-4272-8272-272727272727";
    const shotUuid = "27272727-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const operationId = "27272727-1111-4111-8111-111111111111";
    projectStore().project = {
      projectUuid,
      name: "R27 分辨率合同",
      projectType: "storyboard",
      myRole: "owner",
      openMode: "readwrite",
      videoModel: DREAMINA,
      resolution: "1080p",
    } as any;
    const post = vi.spyOn(axios, "post").mockResolvedValue({
      status: 200,
      data: {
        code: 0,
        data: [{ taskUuid: "r27-resolution-task", status: "queued", clientOperationId: operationId }],
      },
    } as any);
    vi.spyOn(axios, "get").mockResolvedValue({ data: { data: [] } } as any);

    const workspace = useStoryboardWorkspace();
    await workspace.generateShot(shotUuid, "video", {
      providerModel: DREAMINA,
      routeKind: "dreamina-cli",
      mode: "text2video",
      durationMs: 5000,
      aspectRatio: "9:16",
      resolution: "1080p",
      expectedPreviewDigest: "ab".repeat(32),
    } as any, operationId);

    expect(post).toHaveBeenCalledWith(
      `/tianjiang/runtime/projects/${projectUuid}/storyboard/generate`,
      expect.objectContaining({ resolution: "1080p" }),
      { preserveResponse: true },
    );
  });
});
