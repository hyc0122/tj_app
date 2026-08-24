// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { nextTick, ref } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import { projectDialogKey } from "@/views/project/components/projectDialog/projectDialogContext";

describe("ProjectFormDialog 布局合同", () => {
  it("弹窗宽度和双栏滚动由父组件样式文件拥有", () => {
    const css = readFileSync(
      path.join(process.cwd(), "src/views/project/components/projectDialog/styles/project-form-dialog.scss"),
      "utf8",
    );
    expect(css).toMatch(/width:\s*min\(1180px,\s*calc\(100vw - 48px\)\)/);
    expect(css).toMatch(/grid-template-columns:\s*minmax\(420px,\s*1fr\)\s+minmax\(420px,\s*1fr\)/);
    expect(css).toMatch(/max-height:\s*calc\(100vh - 180px\)/);
    expect(css).not.toMatch(/\.gridItem/);
  });

  it("1366x768 与 1920x1080 必须挂载真实 ProjectFormDialog", async () => {
    vi.stubGlobal("$t", (key: string) => key);
    const i18n = createI18n({
      legacy: false,
      locale: "zh-CN",
      messages: { "zh-CN": zhCN },
    });
    const style = document.createElement("style");
    style.textContent = readFileSync(
      path.join(process.cwd(), "src/views/project/components/projectDialog/styles/project-form-dialog.scss"),
      "utf8",
    );
    document.head.appendChild(style);
    const { default: ProjectFormDialog } = await import(
      "../../src/views/project/components/projectDialog/components/ProjectFormDialog.vue"
    );
    const formState = ref({
      projectType: "novel",
      assetMode: "independent",
      assetSourceProjectUuid: "",
      defaultLanguage: "zh-CN",
      artStyle: "手册A",
      directorManual: "手册B",
      name: "布局项目",
      type: "",
      imageModel: "v1:img",
      imageQuality: "1K",
      videoModel: "v1:vid",
      mode: "text",
      videoRatio: "16:9",
      intro: "",
      scope: "personal",
      teamUuid: "",
    });
    const context = {
      RATIO_OPTIONS: [{ value: "16:9", label: "16:9" }],
      addProjectShow: ref(true),
      changeFn: vi.fn(),
      creatableTeams: ref([]),
      deleteDirectorManual: vi.fn(),
      deleteVisualManual: vi.fn(),
      directorManualError: ref(""),
      directorManualLoading: ref(false),
      directorManualOptions: ref([{ name: "手册B", directorManual: "手册B", images: ["b.png"] }]),
      fetchVisualManuals: vi.fn(),
      formState,
      handleCancel: vi.fn(),
      handleOk: vi.fn(),
      handlePreview: vi.fn(),
      isEdit: ref(false),
      mode: ref([{ label: "文生", value: "text" }]),
      openDirectorManualDialog: vi.fn(),
      openVisualManualDialog: vi.fn(),
      queryDirectorManual: vi.fn(),
      sourceProjects: ref([]),
      submitting: ref(false),
      visualManualError: ref(""),
      visualManualLoading: ref(false),
      visualManualOptions: ref([{ name: "手册A", stylePath: "手册A", images: ["a.png"] }]),
    };
    const stubs = {
      TDialog: {
        props: ["visible", "header"],
        template: '<div class="projectFormDialog" role="dialog"><slot /></div>',
      },
      TForm: { template: "<form><slot /></form>" },
      TFormItem: { template: "<div class='form-item'><slot /></div>" },
      TSelect: { template: "<select class='modelSelect'><slot /></select>" },
      TOption: { template: "<option><slot /></option>" },
      TInput: { template: "<input />" },
      TTextarea: { template: "<textarea></textarea>" },
      TRadioGroup: { template: "<div><slot /></div>" },
      TRadio: { template: "<label><slot /></label>" },
      TButton: { template: "<button type='button'><slot /></button>" },
      TLoading: { template: "<div><slot /></div>" },
      modelSelect: { template: "<div class='modelSelect'></div>" },
      ProjectScopeSelector: { template: "<div class='scope-selector'></div>" },
      IPlus: { template: "<span />" },
      IEdit: { template: "<span />" },
      IDelete: { template: "<span />" },
      IPreviewOpen: { template: "<span />" },
    };

    for (const [width, height] of [[1366, 768], [1920, 1080]] as const) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
      const wrapper = mount(ProjectFormDialog, {
        attachTo: document.body,
        global: {
          plugins: [i18n],
          provide: { [projectDialogKey as symbol]: context },
          stubs,
        },
      });
      await flushPromises();
      await nextTick();
      expect(wrapper.find(".formColumns").exists()).toBe(true);
      expect(wrapper.find(".formLeft").exists()).toBe(true);
      expect(wrapper.find(".formRight").exists()).toBe(true);
      expect(wrapper.find(".artStylePicker").exists()).toBe(true);
      expect(wrapper.find(".directorManual").exists()).toBe(true);
      const columns = wrapper.find(".formColumns").element as HTMLElement;
      const overflowX = getComputedStyle(columns).overflowX || getComputedStyle(columns).overflow;
      expect(["hidden", "clip", "auto", ""]).toContain(overflowX);
      expect(columns.scrollWidth).toBeLessThanOrEqual(Math.max(columns.clientWidth, 1) + 1);
      formState.value.projectType = "storyboard";
      await nextTick();
      expect(wrapper.find(".formColumns").exists()).toBe(true);
      wrapper.unmount();
      const reopened = mount(ProjectFormDialog, {
        attachTo: document.body,
        global: {
          plugins: [i18n],
          provide: { [projectDialogKey as symbol]: context },
          stubs,
        },
      });
      await flushPromises();
      expect(reopened.find(".formColumns").exists()).toBe(true);
      expect(reopened.find(".formRight").exists()).toBe(true);
      reopened.unmount();
    }
    style.remove();
  });
});
