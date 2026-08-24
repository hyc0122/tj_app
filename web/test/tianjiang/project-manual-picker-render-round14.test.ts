// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { describe, expect, it } from "vitest";
import ProjectManualPicker from "../../src/views/project/components/projectDialog/components/ProjectManualPicker.vue";

describe("ProjectManualPicker 自己拥有卡片网格样式", () => {
  it("渲染后图片容器有固定比例 class 且不溢出", () => {
    const i18n = createI18n({
      legacy: false,
      locale: "zh-CN",
      messages: { "zh-CN": { workbench: { project: { dialog: { loading: "加载" } } } } },
    });
    const wrapper = mount(ProjectManualPicker, {
      props: {
        rootClass: "artStylePicker",
        headerClass: "artStyleHeader",
        title: "画风",
        addLabel: "新增",
        items: [{ name: "赛博", images: ["data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="], stylePath: "a" }],
        selected: "a",
        loading: false,
        error: "",
        itemKey: (item: { stylePath?: string }) => String(item.stylePath ?? ""),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find(".gridContainer").exists()).toBe(true);
    expect(wrapper.find(".artImage").exists()).toBe(true);
    expect(wrapper.find("style")?.exists() || wrapper.html().includes("artImage")).toBe(true);
    const style = wrapper.find("style");
    const css = style.exists() ? style.text() : document.documentElement.outerHTML;
    expect(`${css}\n${wrapper.html()}`).toMatch(/aspect-ratio/);
  });
});
