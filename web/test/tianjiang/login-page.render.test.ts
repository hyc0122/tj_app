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

async function fillRegistrationForm(wrapper: ReturnType<typeof mountLogin>) {
  await buttonByText(wrapper, "立即注册")!.trigger("click");
  await flushPromises();
  await wrapper.find('input[placeholder="用户名"]').setValue("creator");
  await wrapper.find('input[placeholder="昵称"]').setValue("创作者");
  const passwords = wrapper.findAll('input[type="password"]');
  await passwords[0].setValue("SecurePass123!");
  await passwords[1].setValue("SecurePass123!");
}

describe("中央业务账号登录与注册页", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.login.mockReset().mockResolvedValue({ keyServiceDegraded: false });
    mocks.register.mockReset().mockResolvedValue(undefined);
    mocks.captcha.mockReset().mockResolvedValue({
      data: { openCaptcha: false, captchaId: "", picPath: "" },
    });
    mocks.bootstrap.mockReset().mockResolvedValue({ mode: "none" });
    mocks.clearSaved.mockReset().mockResolvedValue(undefined);
    mocks.push.mockReset().mockImplementation(async () => {
      mocks.routePath = "/project";
    });
    mocks.routePath = "/login";
    globalThis.$t = (key: string) => key;
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

  it("不显示高级连接或地址输入，并提供注册入口", () => {
    const wrapper = mountLogin();
    expect(wrapper.text()).toContain("天将漫创");
    expect(wrapper.text()).not.toContain("请使用天将业务账号登录");
    expect(wrapper.text()).not.toContain("中央 API 已由应用安全固定");
    expect(wrapper.text()).not.toContain("高级连接设置");
    expect(wrapper.find('input[autocomplete="url"]').exists()).toBe(false);
    expect(wrapper.html()).not.toContain("api.j11.com.cn");
    expect(buttonByText(wrapper, "立即注册")).toBeDefined();
  });

  it("登录页直接使用与根品牌源字节一致的正式 PNG，不再使用 SVG mask", () => {
    const wrapper = mountLogin();
    const logo = wrapper.find('img.logoImg[src="/src/assets/logo.png"]');
    expect(logo.exists()).toBe(true);
    expect(logo.attributes("alt")).toBe("天将漫创 Logo");

    const workspaceRoot = path.resolve(process.cwd(), "..");
    const loginSource = readFileSync(
      path.join(process.cwd(), "src/pages/login/index.vue"),
      "utf8",
    );
    expect(loginSource).not.toContain("logo.svg");
    expect(
      readFileSync(path.join(process.cwd(), "src/assets/logo.png")).equals(
        readFileSync(path.join(workspaceRoot, "logo.png")),
      ),
    ).toBe(true);
  });

  it("验证码初始加载时禁用登录，成功且无需验证码后恢复提交", async () => {
    let resolveCaptcha: ((value: unknown) => void) | undefined;
    mocks.captcha.mockImplementation(
      () => new Promise((resolve) => {
        resolveCaptcha = resolve;
      }),
    );
    const wrapper = mountLogin();
    const loginButton = buttonByText(wrapper, "登录")!;
    expect(loginButton.attributes("disabled")).toBeDefined();

    resolveCaptcha?.({
      data: { openCaptcha: false, captchaId: "", picPath: "" },
    });
    await flushPromises();
    expect(loginButton.attributes("disabled")).toBeUndefined();
  });

  it("暗色登录卡片中的验证码必须有固定浅色底以保持可读", async () => {
    mocks.captcha.mockResolvedValue({
      data: { openCaptcha: true, captchaId: "captcha-dark", picPath: "captcha-dark.png" },
    });
    const wrapper = mountLogin();
    await flushPromises();

    const captcha = wrapper.get("img.captcha-image");
    expect(captcha.attributes("src")).toBe("captcha-dark.png");
    // 中文注释：验证码图片自身可能透明，必须由页面提供不随暗色主题变化的浅色画布。
    expect(getComputedStyle(captcha.element).backgroundColor).toBe("rgb(255, 255, 255)");
  });

  it("验证码加载失败时显示中央服务不可用，并禁用登录和注册", async () => {
    mocks.captcha.mockRejectedValue(new Error("fetch failed"));
    const wrapper = mountLogin();
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain("中央认证服务不可用");
    expect(buttonByText(wrapper, "登录")!.attributes("disabled")).toBeDefined();

    await buttonByText(wrapper, "立即注册")!.trigger("click");
    await flushPromises();
    expect(buttonByText(wrapper, "创建账号")!.attributes("disabled")).toBeDefined();
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("普通用户生产设置面板移除高级连接菜单和组件", () => {
    const settingSource = readFileSync(
      path.join(process.cwd(), "src/components/setting/index.vue"),
      "utf8",
    );
    expect(settingSource).not.toContain('key: "requestConfig"');
    expect(settingSource).not.toContain("<requestConfig");
    expect(settingSource).not.toContain('import requestConfig from');

    const settingStoreSource = readFileSync(
      path.join(process.cwd(), "src/stores/setting.ts"),
      "utf8",
    );
    expect(settingStoreSource).not.toMatch(
      /persist:\s*\{\s*pick:\s*\[[^\]]*["']baseUrl["']/,
    );

    const authClientSource = readFileSync(
      path.join(process.cwd(), "src/features/tianjiang/auth/client.ts"),
      "utf8",
    );
    expect(authClientSource).toContain('axios.post("/tianjiang/auth/captcha")');
    expect(authClientSource).toContain('axios.post("/tianjiang/auth/login", input)');
    expect(authClientSource).toContain('axios.post("/tianjiang/auth/register", input)');
  });

  it("注册表单提交独立业务账号字段，成功后返回登录", async () => {
    const wrapper = mountLogin();
    await buttonByText(wrapper, "立即注册")!.trigger("click");

    const username = wrapper.find('input[placeholder="用户名"]');
    const nickname = wrapper.find('input[placeholder="昵称"]');
    const passwords = wrapper.findAll('input[type="password"]');
    expect(username.exists()).toBe(true);
    expect(nickname.exists()).toBe(true);
    expect(passwords).toHaveLength(2);

    await username.setValue("creator");
    await nickname.setValue("创作者");
    await passwords[0].setValue("SecurePass123!");
    await passwords[1].setValue("SecurePass123!");
    await buttonByText(wrapper, "创建账号")!.trigger("click");

    expect(mocks.register).toHaveBeenCalledWith({
      username: "creator",
      nickname: "创作者",
      password: "SecurePass123!",
      captcha: "",
      captchaId: "",
    });
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(1);
    // 注册成功保留密码，便于立即登录。
    expect((wrapper.find('input[type="password"]').element as HTMLInputElement).value).toBe(
      "SecurePass123!",
    );
  });

  it("注册失败显示中央安全业务提示并刷新验证码", async () => {
    mocks.register
      .mockRejectedValueOnce({
        code: "CAPTCHA_INVALID",
        message: "验证码错误",
      })
      .mockResolvedValueOnce(undefined);
    mocks.captcha
      .mockReset()
      .mockResolvedValue({
        data: { openCaptcha: true, captchaId: "captcha-new", picPath: "new.png" },
      })
      .mockResolvedValueOnce({
        data: { openCaptcha: true, captchaId: "captcha-old", picPath: "old.png" },
      })
      .mockResolvedValueOnce({
        data: { openCaptcha: true, captchaId: "captcha-old", picPath: "old.png" },
      });
    const wrapper = mountLogin();
    await fillRegistrationForm(wrapper);
    await wrapper.find('input[placeholder="请输入验证码"]').setValue("old-answer");
    const captchaCallsBeforeSubmit = mocks.captcha.mock.calls.length;

    await buttonByText(wrapper, "创建账号")!.trigger("click");
    await flushPromises();

    expect(window.$message.error).toHaveBeenCalledWith("验证码错误");
    expect(mocks.captcha).toHaveBeenCalledTimes(captchaCallsBeforeSubmit + 1);
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(2);
    expect(
      (wrapper.find('input[placeholder="请输入验证码"]').element as HTMLInputElement).value,
    ).toBe("");
    expect(wrapper.get("img.captcha-image").attributes("src")).toBe("new.png");

    // 刷新后再次提交必须使用新验证码答案与新 captchaId。
    await wrapper.find('input[placeholder="请输入验证码"]').setValue("new-answer");
    const passwords = wrapper.findAll('input[type="password"]');
    await passwords[0].setValue("SecurePass123!");
    await passwords[1].setValue("SecurePass123!");
    await buttonByText(wrapper, "创建账号")!.trigger("click");
    await flushPromises();
    expect(mocks.register).toHaveBeenNthCalledWith(2, expect.objectContaining({
      captcha: "new-answer",
      captchaId: "captcha-new",
    }));
  });

  it("注册网络错误保留清晰提示并刷新验证码", async () => {
    mocks.register.mockRejectedValue({
      code: "CENTRAL_API_UNREACHABLE",
      message: "中央 API 不可达，请检查网络连接或稍后重试。",
    });
    const wrapper = mountLogin();
    await fillRegistrationForm(wrapper);
    const captchaCallsBeforeSubmit = mocks.captcha.mock.calls.length;

    await buttonByText(wrapper, "创建账号")!.trigger("click");
    await flushPromises();

    expect(window.$message.error).toHaveBeenCalledWith(
      "中央 API 不可达，请检查网络连接或稍后重试。",
    );
    expect(mocks.captcha).toHaveBeenCalledTimes(captchaCallsBeforeSubmit + 1);
  });

  it("登录成功后清空密码并进入项目", async () => {
    const wrapper = mountLogin();
    await flushPromises();
    const username = wrapper.find('input[placeholder="用户名"]');
    const password = wrapper.find('input[type="password"]');
    await username.setValue("creator");
    await password.setValue("SecurePass123!");
    await buttonByText(wrapper, "登录")!.trigger("click");
    await flushPromises();

    expect(mocks.login).toHaveBeenCalledWith({
      username: "creator",
      password: "SecurePass123!",
      captcha: "",
      captchaId: "",
    });
    expect((password.element as HTMLInputElement).value).toBe("");
    expect(mocks.push).toHaveBeenCalledWith("/project");
    expect(window.$message.success).toHaveBeenCalledWith("登录成功");
  });
});
