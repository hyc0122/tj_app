// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  register: vi.fn(),
  captcha: vi.fn(),
  bootstrap: vi.fn(),
  clearSaved: vi.fn(),
  push: vi.fn(),
  routePath: "/login",
  legalGet: vi.fn(),
}));

vi.mock("@/features/tianjiang/auth/client", () => ({
  CENTRAL_API_URL: "https://api.j11.com.cn",
  centralLogin: mocks.login,
  centralRegister: mocks.register,
  fetchCaptcha: mocks.captcha,
  bootstrapAuth: mocks.bootstrap,
  clearSavedAccount: mocks.clearSaved,
}));

vi.mock("@/router/index.ts", () => ({
  default: {
    push: (...args: unknown[]) => mocks.push(...args),
    get currentRoute() {
      return { value: { path: mocks.routePath } };
    },
  },
}));

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => mocks.legalGet(...args),
    post: vi.fn(),
  },
}));

import LoginPage from "@/pages/login/index.vue";

const tdesignStubs = {
  TInput: {
    props: ["modelValue", "type", "placeholder", "size"],
    emits: ["update:modelValue"],
    template:
      '<input :type="type || \'text\'" :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  TButton: {
    props: ["loading", "disabled"],
    emits: ["click"],
    template:
      '<button type="button" :disabled="loading || disabled" @click="$emit(\'click\', $event)"><slot name="icon" /><slot /></button>',
  },
  TDropdown: { template: "<div><slot /></div>" },
  ITranslate: true,
};

function mountLogin() {
  const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    messages: { "zh-CN": zhCN },
  });
  return mount(LoginPage, {
    attachTo: document.body,
    global: {
      plugins: [createPinia(), i18n],
      stubs: tdesignStubs,
    },
  });
}

describe("协议同步与纯文本展示", () => {
  beforeEach(() => {
    mocks.login.mockReset().mockResolvedValue({ keyServiceDegraded: false });
    mocks.register.mockReset().mockResolvedValue(undefined);
    mocks.captcha.mockReset().mockResolvedValue({
      data: { openCaptcha: false, captchaId: "", picPath: "" },
    });
    mocks.bootstrap.mockReset().mockResolvedValue({ mode: "none" });
    mocks.clearSaved.mockReset();
    mocks.push.mockReset().mockImplementation(async () => {
      mocks.routePath = "/project";
    });
    mocks.routePath = "/login";
    mocks.legalGet.mockReset().mockResolvedValue({
      code: 0,
      data: {
        source: "network",
        stale: false,
        documents: [
          {
            documentType: "user_agreement",
            title: "用户协议（初始示例）",
            content: "此为初始示例内容，正式发布前需完成法务审核\n正文",
            version: "initial-2026-08-01",
            updatedAt: "2026-08-01T00:00:00Z",
          },
          {
            documentType: "privacy_policy",
            title: "隐私政策（初始示例）",
            content: "此为初始示例内容，正式发布前需完成法务审核\n<img src=x onerror=alert(1)><script>bad()</script>",
            version: "initial-2026-08-01",
            updatedAt: "2026-08-01T00:00:00Z",
          },
        ],
      },
      message: "协议内容已就绪",
    });
    window.$message = {
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("登录与注册共用协议文案，本地固定路径，正文纯文本无 HTML 元素", async () => {
    const wrapper = mountLogin();
    await flushPromises();

    expect(mocks.legalGet).toHaveBeenCalledWith("/tianjiang/public/legal-documents");
    expect(wrapper.find('[data-testid="legal-consent-notice"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("登录即代表您已阅读并同意");

    const links = wrapper.findAll(".legal-consent__link");
    expect(links).toHaveLength(2);
    await links[1].trigger("click");
    await flushPromises();

    const dialog = wrapper.find('[data-testid="legal-document-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.find("img").exists()).toBe(false);
    expect(dialog.find("script").exists()).toBe(false);
    expect(dialog.text()).toContain("<img src=x onerror=alert(1)>");
    expect(dialog.find("pre.legal-dialog__body").exists()).toBe(true);

    await wrapper.findAll("button").find((b) => b.text().includes("立即注册"))!.trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="legal-consent-notice"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("注册或登录即代表您已阅读并同意");
    // 切换模式不重复并发拉取
    expect(mocks.legalGet).toHaveBeenCalledTimes(1);
  });
});
