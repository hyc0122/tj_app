// @vitest-environment jsdom
/**
 * R21 RED：Web 必须展示参考素材不支持与即梦 CLI 不可用的固定安全文案。
 */
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";
import { nextTick } from "vue";
import {
  readSafeGenerationSubmitError,
} from "@/views/storyboardProject/storyboard-generation-preview";

describe("R21 安全提交错误白名单与模型切换", () => {
  it("新错误码必须映射固定文案，未知错误不得回显内部信息", () => {
    expect(readSafeGenerationSubmitError(
      { code: "VENDOR_REFERENCE_UNSUPPORTED", message: "当前视频模型不支持参考素材输入" },
      "提交生成失败，请重试",
    )).toBe("当前视频模型不支持参考素材输入");
    expect(readSafeGenerationSubmitError(
      { code: "STORYBOARD_DREAMINA_CLI_UNAVAILABLE", message: "即梦 CLI 不可用" },
      "提交生成失败，请重试",
    )).toBe("即梦 CLI 不可用");
    expect(readSafeGenerationSubmitError(
      { code: "VENDOR_UNKNOWN", message: "ENOENT C:\\\\cli\\\\dreamina.exe cookie=abc" },
      "提交生成失败，请重试",
    )).toBe("提交生成失败，请重试");
  });

  it("切换视频模型后旧预览必须立即失效", async () => {
    const { default: StoryboardDetailDrawer } = await import(
      "@/views/storyboardProject/components/StoryboardDetailDrawer.vue"
    );
    setActivePinia(createPinia());
    const wrapper = mount(StoryboardDetailDrawer, {
      props: {
        projectUuid: "b0212121-2121-4121-a021-212121212121",
        readonly: false,
        generationBusy: false,
        generationSettings: {
          providerModel: "tianjiang:doubao-seedance-1-0-pro-fast",
          mode: "auto",
          aspectRatio: "9:16",
          durationMs: 5000,
        },
        shot: {
          shotUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          displayOrder: 1,
          sourceText: "夜戏",
          visualDescription: "近景",
          videoPrompt: "跟拍",
          durationMs: 5000,
          aspectRatio: "9:16",
          bindings: [],
          candidates: [],
          generationTasks: [],
        },
      },
      global: {
        stubs: {
          TButton: { template: "<button><slot /></button>" },
          TIcon: { template: "<i />" },
          StoryboardGenerationSettings: {
            props: ["modelValue"],
            template: `<select data-field="video-provider-model" @change="$emit('update:modelValue', { ...modelValue, providerModel: $event.target.value })">
              <option>tianjiang:doubao-seedance-1-0-pro-fast</option>
              <option>dreamina-cli:seedance2.0fast</option>
            </select>`,
          },
          FinalRequestPreview: { template: `<div data-panel="request-preview">{{ $attrs.request ? "ready" : "等待服务端预览" }}</div>` },
        },
      },
    });
    await flushPromises();
    (wrapper.vm as { generationPreview?: unknown; previewFingerprint?: string; previewStatus?: string }).generationPreview = {
      previewDigest: "ab".repeat(32),
      providerModel: "tianjiang:doubao-seedance-1-0-pro-fast",
      prompt: "旧预览",
      options: { mode: "text2video", aspectRatio: "9:16", durationMs: 5000, resolution: "720p" },
    };
    (wrapper.vm as { previewFingerprint?: string }).previewFingerprint = JSON.stringify({
      projectUuid: "b0212121-2121-4121-a021-212121212121",
      shotUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      providerModel: "tianjiang:doubao-seedance-1-0-pro-fast",
      mode: "auto",
      aspectRatio: "9:16",
      durationMs: 5000,
      visualDescription: "近景",
      videoPrompt: "跟拍",
      negativePrompt: "",
      bindings: [],
    });
    await nextTick();
    await wrapper.get('[data-field="video-provider-model"]').setValue("dreamina-cli:seedance2.0fast");
    await nextTick();
    expect((wrapper.vm as { generationPreview?: unknown }).generationPreview).toBeNull();
    expect(String((wrapper.vm as { previewStatus?: string }).previewStatus ?? "")).toContain("请重新预览");
    wrapper.unmount();
  });
});
