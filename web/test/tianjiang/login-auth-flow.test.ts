// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
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

describe("注册成功与登录体验", () => {
  beforeEach(() => {
    mocks.login.mockReset().mockResolvedValue({ keyServiceDegraded: false });
    mocks.register.mockReset().mockResolvedValue(undefined);
    mocks.captcha.mockReset().mockResolvedValue({
      data: { openCaptcha: false, captchaId: "", picPath: "" },
    });
    mocks.bootstrap.mockReset().mockResolvedValue({
      mode: "none",
    });
    mocks.clearSaved.mockReset().mockResolvedValue(undefined);
    mocks.push.mockReset().mockImplementation(async () => {
      mocks.routePath = "/project";
    });
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

  it("注册成功保留用户名与密码，刷新验证码，不调用受保护会话", async () => {
    const wrapper = mountLogin();
    await flushPromises();
    await buttonByText(wrapper, "立即注册")!.trigger("click");
    await flushPromises();

    await wrapper.find('input[placeholder="用户名"]').setValue("creator");
    await wrapper.find('input[placeholder="昵称"]').setValue("创作者");
    const passwords = wrapper.findAll('input[type="password"]');
    await passwords[0].setValue("SecurePass123!");
    await passwords[1].setValue("SecurePass123!");

    const captchaBefore = mocks.captcha.mock.calls.length;
    await buttonByText(wrapper, "创建账号")!.trigger("click");
    await flushPromises();

    expect(mocks.register).toHaveBeenCalled();
    expect((wrapper.find('input[placeholder="用户名"]').element as HTMLInputElement).value).toBe("creator");
    expect((wrapper.find('input[type="password"]').element as HTMLInputElement).value).toBe("SecurePass123!");
    expect(mocks.captcha.mock.calls.length).toBeGreaterThan(captchaBefore);
    // 注册成功不得去探测尚未建立的登录会话。
    expect(wrapper.vm).toBeTruthy();
    const clientSource = readFileSync(
      path.join(process.cwd(), "src/features/tianjiang/auth/client.ts"),
      "utf8",
    );
    // 注册函数本身不得访问 session。
    expect(clientSource).toMatch(/centralRegister[\s\S]*?axios\.post\("\/tianjiang\/auth\/register"/);
  });

  it("注册页持续显示密码规则，确认密码不一致时明确提示", async () => {
    const wrapper = mountLogin();
    await flushPromises();
    await buttonByText(wrapper, "立即注册")!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toMatch(/至少 8|字母和数字|72/);
    await wrapper.find('input[placeholder="用户名"]').setValue("creator");
    await wrapper.find('input[placeholder="昵称"]').setValue("创作者");
    const passwords = wrapper.findAll('input[type="password"]');
    await passwords[0].setValue("short");
    await flushPromises();
    expect(wrapper.text()).toMatch(/8/);

    await passwords[0].setValue("SecurePass123!");
    await passwords[1].setValue("Different1");
    await buttonByText(wrapper, "创建账号")!.trigger("click");
    expect(window.$message.warning).toHaveBeenCalledWith("两次输入的密码不一致");
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("登录 401 只显示业务错误，不重复弹会话过期", async () => {
    mocks.login.mockRejectedValue({ code: 7, message: "账号或密码错误" });
    const wrapper = mountLogin();
    await flushPromises();
    await wrapper.find('input[placeholder="用户名"]').setValue("creator");
    await wrapper.find('input[type="password"]').setValue("SecurePass123!");
    await buttonByText(wrapper, "登录")!.trigger("click");
    await flushPromises();

    expect(window.$message.error).toHaveBeenCalledTimes(1);
    expect(window.$message.error).toHaveBeenCalledWith("账号或密码错误");
    expect(window.$message.error).not.toHaveBeenCalledWith(
      expect.stringMatching(/登录已过期/),
    );
  });

  it("提供清除已保存账号操作", async () => {
    mocks.bootstrap.mockResolvedValue({
      mode: "fill",
      username: "creator",
      password: "SecurePass123!",
    });
    const wrapper = mountLogin();
    await flushPromises();
    const clearBtn = buttonByText(wrapper, "清除已保存账号");
    expect(clearBtn).toBeDefined();
    await clearBtn!.trigger("click");
    await flushPromises();
    expect(mocks.clearSaved).toHaveBeenCalled();
  });
});
