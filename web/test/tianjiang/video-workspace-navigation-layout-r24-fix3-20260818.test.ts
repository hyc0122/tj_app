// @vitest-environment jsdom
/**
 * R24-fix3 RED：保存路径必须显式发送 executablePath，即使值未改变。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import DreaminaProviderPanel from "@/components/setting/components/vendorConfig/components/DreaminaProviderPanel.vue";

const axiosGet = vi.fn();
const axiosPost = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
  },
}));

const UNCHANGED_PATH = "E:\\cli\\dreamina.exe";

const cachedStatus = {
  preferredExecutionTarget: "windows_native",
  effectiveExecutionTarget: null,
  install: {
    state: "installed",
    version: "1.0.0",
    executablePath: UNCHANGED_PATH,
    managed: false,
    checkedAt: 1,
    reason: "已安装",
  },
  account: { state: "logged_out", reason: "未登录即梦账号" },
  capability: { state: "not_checked", snapshot: null, checkedAt: null },
  queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 },
};

const environment = {
  target: "windows_native",
  dependencies: [],
  suggestWsl: false,
  linuxReleaseAvailable: false,
};

function mountPanel(): VueWrapper {
  return mount(DreaminaProviderPanel, {
    global: {
      plugins: [
        createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
      ],
      stubs: {
        TButton: {
          inheritAttrs: true,
          props: ["loading", "disabled"],
          template: "<button v-bind=\"$attrs\" :disabled=\"disabled || loading\"><slot name=\"icon\"/><slot/></button>",
        },
        TDialog: { template: "<div />" },
        TTag: { template: "<span><slot /></span>" },
        TIcon: { template: "<i />" },
        TAlert: { template: "<div role=\"alert\"><slot /></div>" },
      },
    },
  });
}

beforeEach(() => {
  axiosGet.mockReset();
  axiosPost.mockReset();
  axiosGet.mockImplementation((url: string) => {
    if (String(url).includes("getSettings")) {
      return Promise.resolve({ data: { executablePath: UNCHANGED_PATH, enabled: true } });
    }
    if (String(url).includes("getEnvironment")) {
      return Promise.resolve({ data: environment });
    }
    return Promise.resolve({ data: cachedStatus });
  });
  axiosPost.mockResolvedValue({ data: { executablePath: UNCHANGED_PATH } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("R24-fix3 保存路径真实合同", () => {
  it("源码在 savePath 时必须无条件发送 executablePath", () => {
    const source = readFileSync(
      path.resolve(
        __dirname,
        "../../src/components/setting/components/vendorConfig/components/useDreaminaProviderPanel.ts",
      ),
      "utf8",
    );
    const savePathBlock = source.match(/if \(action === "savePath"\) \{[\s\S]*?return;\s*\}/);
    expect(savePathBlock, "必须存在 savePath 分支").toBeTruthy();
    expect(savePathBlock?.[0]).toMatch(
      /axios\.post\(\s*"\/setting\/dreaminaCli\/updateSettings",\s*\{\s*executablePath: executablePathDraft\.value\.trim\(\) \|\| null\s*\}/,
    );
    expect(savePathBlock?.[0]).not.toMatch(/if\s*\([^)]*executablePath[^)]*!==/);
    expect(savePathBlock?.[0]).not.toMatch(/pathChanged|pathWouldChange|unchanged/);
  });

  it("路径未改动时点击保存仍必须把 executablePath 发给 updateSettings", async () => {
    const wrapper = mountPanel();
    await flushPromises();
    const input = wrapper.get('[data-field="executable-path"]').element as HTMLInputElement;
    expect(input.value).toBe(UNCHANGED_PATH);

    await wrapper.get('[data-action="save-path"]').trigger("click");
    await flushPromises();

    const updateCalls = axiosPost.mock.calls.filter(([url]) =>
      String(url).includes("/setting/dreaminaCli/updateSettings"));
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.[1]).toEqual({ executablePath: UNCHANGED_PATH });
    wrapper.unmount();
  });
});
