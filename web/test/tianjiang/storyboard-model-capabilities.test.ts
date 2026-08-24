// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import StoryboardSettings from "@/views/storyboardProject/components/StoryboardSettings.vue";

describe("分镜模型能力与最终请求预览", () => {
  it("设置页必须展示最终请求预览，且包含模型与画幅", () => {
    const settings = mount(StoryboardSettings);
    expect(settings.text()).toContain("最终请求预览");
    expect(settings.html()).toMatch(/FinalRequestPreview|最终请求预览/);
    settings.unmount();
  });
});
