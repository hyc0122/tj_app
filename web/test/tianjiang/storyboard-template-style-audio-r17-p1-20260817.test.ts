// @vitest-environment jsdom
/**
 * R17 RED：Axios 已解包合同下模板列表/新建 id、当前模板名、视觉手册风格。
 */
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import StoryboardVideoTemplateDialog from "@/views/storyboardProject/components/StoryboardVideoTemplateDialog.vue";
import StoryboardSettings from "@/views/storyboardProject/components/StoryboardSettings.vue";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const axiosPut = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    put: (...args: unknown[]) => axiosPut(...args),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const projectUuid = "d1717171-1717-4171-a171-171717171717";
const systemTemplate = {
  id: 1,
  name: "系统默认视频指令",
  type: "storyboardVideoSystemTemplate",
  content: "{{shot_prompt}}",
  system: true,
};
const userTemplate = {
  id: 2,
  name: "码头夜戏",
  type: "storyboardVideoUserTemplate",
  content: "风格：{{style}}。\n{{shot_prompt}}",
  system: false,
};

const tdesignStubs = {
  TButton: {
    inheritAttrs: true,
    props: ["loading", "disabled"],
    template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
  },
  TIcon: { template: "<i />" },
  TDialog: {
    inheritAttrs: true,
    props: ["visible", "header", "attach", "placement", "width", "dialogClassName"],
    template: `<section v-if="visible" role="dialog"><h2>{{ header }}</h2><div class="t-dialog__body"><slot /></div><footer class="t-dialog__footer"><slot name="footer" /></footer></section>`,
  },
};

function i18n() {
  return createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
}

function interceptorPayload<T>(data: T) {
  return { code: 0, data, message: "成功" };
}

describe("R17 模板弹窗必须按拦截器已解包形态读取列表和新建 id", () => {
  beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPut.mockReset();
  });

  it("reload 必须显示系统模板和已保存用户模板", async () => {
    axiosGet.mockResolvedValue(interceptorPayload({ templates: [systemTemplate, userTemplate] }));
    const wrapper = mount(StoryboardVideoTemplateDialog, {
      props: { open: true, projectUuid },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("系统默认视频指令");
    expect(wrapper.text()).toContain("码头夜戏");
    expect(wrapper.get('[data-template-id="2"]').text()).toContain("码头夜戏");
    wrapper.unmount();
  });

  it("新建一次只 POST 一条，并选中真实 id；保存并使用走真实 id", async () => {
    let listed = [systemTemplate];
    axiosGet.mockImplementation(() => Promise.resolve(interceptorPayload({ templates: listed })));
    axiosPost.mockImplementation((url: string) => {
      if (String(url).endsWith("/video-templates")) {
        const created = {
          id: 88,
          name: "新建指令",
          type: "storyboardVideoUserTemplate",
          content: "风格：{{style}}。",
          system: false,
        };
        listed = [systemTemplate, created];
        return Promise.resolve(interceptorPayload(created));
      }
      return Promise.resolve(interceptorPayload({ videoPromptTemplateId: 88 }));
    });
    const wrapper = mount(StoryboardVideoTemplateDialog, {
      props: { open: true, projectUuid },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    await flushPromises();
    await wrapper.get('[data-action="create-video-template"]').trigger("click");
    await wrapper.get('[name="templateName"]').setValue("新建指令");
    await wrapper.get('[data-action="save-and-use-video-template"]').trigger("click");
    await flushPromises();
    const creates = axiosPost.mock.calls.filter(([url]) => String(url).endsWith("/video-templates"));
    expect(creates).toHaveLength(1);
    expect(wrapper.get('[data-template-id="88"]').classes()).toContain("active");
    expect(axiosPost.mock.calls.some(([url]) => String(url).includes("/video-templates/88/use"))).toBe(true);
    wrapper.unmount();
  });
});

describe("R17 分镜设置必须显示当前模板名，并按模板 id 回显", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPut.mockReset();
  });

  it("设置页显示当前模板名称，并按模板真实 id 回显内容", async () => {
    axiosGet.mockImplementation((url: string) => {
      const target = String(url);
      if (target.includes("/storyboard/settings")) {
        return Promise.resolve(interceptorPayload({
          aspectRatio: "9:16",
          durationMs: 5000,
          videoPromptTemplateId: 2,
          videoPromptTemplateContent: userTemplate.content,
        }));
      }
      if (target.includes("/storyboard/video-templates")) {
        return Promise.resolve(interceptorPayload({ templates: [systemTemplate, userTemplate] }));
      }
      return Promise.resolve(interceptorPayload({}));
    });
    const wrapper = mount(StoryboardSettings, {
      props: { projectUuid, providerModel: "dreamina-cli:seedance2.0fast" },
      global: { plugins: [i18n()], stubs: tdesignStubs },
    });
    await flushPromises();
    expect(wrapper.get("[data-field=current-video-template]").text()).toContain("码头夜戏");
    const select = wrapper.get('[name="videoPromptTemplateId"]');
    expect((select.element as HTMLSelectElement).value).toBe("2");
    expect(wrapper.get("[data-field=video-template-content]").text()).toContain("{{shot_prompt}}");
    wrapper.unmount();
  });
});
