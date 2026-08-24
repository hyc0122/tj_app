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
    get: vi.fn().mockResolvedValue({
      code: 0,
      data: { documents: [], source: "packaged", stale: true },
      message: "协议内容已就绪",
    }),
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

function buttonByText(wrapper: ReturnType<typeof mountLogin>, text: string) {
  return wrapper.findAll("button").find((button) => button.text().includes(text));
}

describe("登录成功提示依赖真实路由进入 /project", () => {
  beforeEach(() => {
    mocks.login.mockReset().mockResolvedValue({ keyServiceDegraded: false });
    mocks.register.mockReset().mockResolvedValue(undefined);
    mocks.captcha.mockReset().mockResolvedValue({
      data: { openCaptcha: false, captchaId: "", picPath: "" },
    });
    mocks.bootstrap.mockReset().mockResolvedValue({ mode: "none" });
    mocks.clearSaved.mockReset().mockResolvedValue(undefined);
    mocks.push.mockReset();
    mocks.routePath = "/login";
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

  it("手工登录：路由成功后才提示登录成功", async () => {
    mocks.push.mockImplementation(async () => {
      mocks.routePath = "/project";
    });
    const wrapper = mountLogin();
    await flushPromises();
    await wrapper.find('input[placeholder="用户名"]').setValue("creator");
    await wrapper.find('input[type="password"]').setValue("SecurePass123!");
    await buttonByText(wrapper, "登录")!.trigger("click");
    await flushPromises();

    expect(mocks.push).toHaveBeenCalledWith("/project");
    expect(window.$message.success).toHaveBeenCalledWith("登录成功");
    expect(window.$message.error).not.toHaveBeenCalled();
  });

  it("手工登录：导航被重定向回登录时不得提示成功", async () => {
    mocks.push.mockImplementation(async () => {
      mocks.routePath = "/login";
    });
    const wrapper = mountLogin();
    await flushPromises();
    await wrapper.find('input[placeholder="用户名"]').setValue("creator");
    await wrapper.find('input[type="password"]').setValue("SecurePass123!");
    await buttonByText(wrapper, "登录")!.trigger("click");
    await flushPromises();

    expect(mocks.push).toHaveBeenCalledWith("/project");
    expect(window.$message.success).not.toHaveBeenCalled();
    expect(window.$message.error).toHaveBeenCalledTimes(1);
  });

  it("bootstrap 自动登录：路由成功后才提示登录成功", async () => {
    mocks.bootstrap.mockResolvedValue({
      mode: "auto_login",
      user: { id: 1, username: "creator", nickname: "创作者" },
      keyServiceDegraded: false,
    });
    mocks.push.mockImplementation(async () => {
      mocks.routePath = "/project";
    });
    mountLogin();
    await flushPromises();

    expect(mocks.push).toHaveBeenCalledWith("/project");
    expect(window.$message.success).toHaveBeenCalledWith("登录成功");
  });

  it("bootstrap 自动登录：导航失败时不得提示成功", async () => {
    mocks.bootstrap.mockResolvedValue({
      mode: "auto_login",
      user: { id: 1, username: "creator", nickname: "创作者" },
      keyServiceDegraded: false,
    });
    mocks.push.mockImplementation(async () => {
      mocks.routePath = "/login";
    });
    mountLogin();
    await flushPromises();

    expect(mocks.push).toHaveBeenCalledWith("/project");
    expect(window.$message.success).not.toHaveBeenCalled();
    expect(window.$message.error).toHaveBeenCalledTimes(1);
  });
});
