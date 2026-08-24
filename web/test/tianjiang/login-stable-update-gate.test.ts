// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { defineComponent } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  login: vi.fn(),
  captcha: vi.fn(),
  bootstrap: vi.fn(),
  push: vi.fn(),
  routePath: "/login",
}));

vi.mock("@/utils/axios", () => ({
  default: { post: mocks.post, get: mocks.get },
}));

vi.mock("@/features/tianjiang/auth/client", () => ({
  centralLogin: mocks.login,
  centralRegister: vi.fn(),
  clearSavedAccount: vi.fn(),
  fetchCaptcha: mocks.captcha,
  bootstrapAuth: mocks.bootstrap,
}));

vi.mock("@/router/index.ts", () => ({
  default: {
    push: (...args: unknown[]) => mocks.push(...args),
    get currentRoute() {
      return { value: { path: mocks.routePath } };
    },
  },
}));

import MandatoryStableUpdateDialog from "@/components/update/MandatoryStableUpdateDialog.vue";
import LoginPage from "@/pages/login/index.vue";
import settingStore from "@/stores/setting";

const channel = (overrides: Record<string, unknown> = {}) => ({
  status: "current",
  source: "network",
  required: false,
  downloadAllowed: false,
  ...overrides,
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  state: "idle",
  currentVersion: "1.1.11",
  stable: channel({ latestVersion: "1.1.11" }),
  beta: channel({ latestVersion: "1.1.11" }),
  stableRequired: false,
  loginAllowed: true,
  selectedChannel: null,
  ...overrides,
});

const stubs = {
  TInput: {
    inheritAttrs: false,
    props: ["modelValue", "type", "placeholder"],
    emits: ["update:modelValue"],
    template: '<input :type="type || \'text\'" :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  TButton: {
    props: ["loading", "disabled"],
    emits: ["click"],
    template: '<button type="button" :disabled="loading || disabled" @click="$emit(\'click\', $event)"><slot name="icon" /><slot /></button>',
  },
  TDialog: {
    props: ["visible"],
    template: '<div v-if="visible" role="dialog"><slot /><slot name="footer" /></div>',
  },
  TDropdown: { template: "<div><slot /></div>" },
  AuthAnimatedBackdrop: true,
  LegalConsentNotice: true,
  LegalDocumentDialog: true,
  ITranslate: true,
};

function mountLoginWithDialog() {
  const pinia = createPinia();
  setActivePinia(pinia);
  settingStore().isElectron = true;
  const Harness = defineComponent({
    components: { LoginPage, MandatoryStableUpdateDialog },
    template: "<LoginPage /><MandatoryStableUpdateDialog />",
  });
  return mount(Harness, {
    attachTo: document.body,
    global: {
      plugins: [
        pinia,
        createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
      ],
      stubs,
    },
  });
}

function buttonByText(wrapper: ReturnType<typeof mountLoginWithDialog>, text: string) {
  return wrapper.findAll("button").find((button) => button.text().includes(text));
}

async function fillAndSubmit(wrapper: ReturnType<typeof mountLoginWithDialog>) {
  await wrapper.find('input[placeholder="用户名"]').setValue("creator");
  await wrapper.find('input[type="password"]').setValue("SecurePass123!");
  await buttonByText(wrapper, "登录")!.trigger("click");
}

describe("登录 Stable 强制更新门禁", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mocks.post.mockReset();
    mocks.get.mockReset().mockResolvedValue({ data: {} });
    mocks.login.mockReset().mockResolvedValue({ keyServiceDegraded: false });
    mocks.captcha.mockReset().mockResolvedValue({
      data: { openCaptcha: false, captchaId: "", picPath: "" },
    });
    mocks.bootstrap.mockReset().mockResolvedValue({ mode: "none" });
    mocks.push.mockReset().mockImplementation(async () => { mocks.routePath = "/project"; });
    mocks.routePath = "/login";
    window.$message = {
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
  });

  it("提交凭据必须等待 check-login-stable，Stable required 时不发送登录请求", async () => {
    let resolveGate!: (value: unknown) => void;
    mocks.post.mockImplementation((path: string, body: Record<string, unknown>) => {
      if (path !== "/setting/about/checkUpdate") throw new Error(`unexpected path: ${path}`);
      expect(body).toEqual({ action: "check-login-stable" });
      return new Promise((resolve) => { resolveGate = resolve; });
    });
    const wrapper = mountLoginWithDialog();
    await flushPromises();
    await fillAndSubmit(wrapper);
    expect(mocks.login).not.toHaveBeenCalled();

    resolveGate({
      data: snapshot({
        state: "available",
        stable: channel({ status: "available", latestVersion: "1.1.12", required: true, downloadAllowed: true }),
        stableRequired: true,
        loginAllowed: false,
        selectedChannel: "stable",
        latestVersion: "1.1.12",
      }),
    });
    await flushPromises();

    expect(mocks.login).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("必须更新到正式版后才能登录");
    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.findAll("button").some((button) => /稍后|关闭|测试版/.test(button.text()))).toBe(false);
    expect(dialog.findAll("button").some((button) => button.text().includes("更新正式版"))).toBe(true);
  });

  it("强更弹窗下载只提交固定 action/channel，绝不提交 URL", async () => {
    mocks.post.mockResolvedValueOnce({
      data: snapshot({
        state: "available",
        stable: channel({ status: "available", latestVersion: "1.1.12", required: true, downloadAllowed: true }),
        stableRequired: true,
        loginAllowed: false,
        selectedChannel: "stable",
      }),
    }).mockResolvedValueOnce({
      data: snapshot({
        state: "downloading",
        stable: channel({ status: "available", latestVersion: "1.1.12", required: true, downloadAllowed: true }),
        stableRequired: true,
        loginAllowed: false,
        selectedChannel: "stable",
      }),
    });
    const wrapper = mountLoginWithDialog();
    await flushPromises();
    await buttonByText(wrapper, "更新正式版")!.trigger("click");
    await flushPromises();

    expect(mocks.post).toHaveBeenLastCalledWith(
      "/setting/about/downloadApp",
      { action: "download-differential", channel: "stable" },
    );
    expect(mocks.post.mock.calls.at(-1)?.[1]).not.toHaveProperty("url");
  });

  it("无缓存且远端不可用时允许登录，显示可重试警告", async () => {
    mocks.post.mockResolvedValue({
      data: snapshot({
        state: "error",
        stable: channel({ status: "error", source: "none", errorCode: "NETWORK_ERROR" }),
        beta: channel({ status: "error", source: "none", errorCode: "NETWORK_ERROR" }),
        warningMessage: "正式版检查失败，将稍后重试",
      }),
    });
    const wrapper = mountLoginWithDialog();
    await flushPromises();
    await fillAndSubmit(wrapper);
    await flushPromises();

    expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("正式版检查失败，将稍后重试");
    expect(buttonByText(wrapper, "重新检查正式版")).toBeDefined();
  });

  it("真实 503 envelope fail-closed 时显示稳定失败说明、禁用认证且保留独立重试", async () => {
    const unavailable = {
      code: 503,
      message: "正式版更新检查未完成，请稍后重试",
      data: snapshot({
        state: "error",
        stable: channel({ status: "error", source: "none", errorCode: "UPDATE_SERVICE_NOT_READY" }),
        beta: channel({ status: "error", source: "none", errorCode: "UPDATE_SERVICE_NOT_READY" }),
        loginAllowed: false,
      }),
    };
    mocks.post.mockRejectedValue(unavailable);
    const wrapper = mountLoginWithDialog();
    await flushPromises();

    expect(wrapper.text()).toContain("正式版更新检查未完成，请稍后重试");
    const loginButton = buttonByText(wrapper, "登录")!;
    const retryButton = buttonByText(wrapper, "重新检查正式版")!;
    expect(loginButton.attributes("disabled")).toBeDefined();
    expect(retryButton.attributes("disabled")).toBeUndefined();
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.login).not.toHaveBeenCalled();

    await retryButton.trigger("click");
    await flushPromises();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.login).not.toHaveBeenCalled();
  });
});
