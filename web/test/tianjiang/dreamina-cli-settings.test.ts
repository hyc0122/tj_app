// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

vi.mock("@/utils/axios", () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: { config: { featureFlags: {} } } }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock("@/components/setting/components/uiConfig.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/languageConfig.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/vendorConfig.vue", () => ({ default: { template: "<div data-testid='vendor-config' />" } }));
vi.mock("@/components/setting/components/agentConfog.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/promptManage.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/otherConfig.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/dbConfig.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/about.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/logoutConfig.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/memoryConfig.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/fileManagement.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/skillManagement.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/devConfig.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/setting/components/modelMap.vue", () => ({ default: { template: "<div />" } }));

import SettingPanel from "@/components/setting/index.vue";
import settingStore from "@/stores/setting";

const LOCALE_FILES = [
  "en.json",
  "ja_JP.json",
  "ru_RU.json",
  "th_TH.json",
  "vi-VN.json",
  "zh-CN.json",
  "zh-TW.json",
] as const;

const REQUIRED_KEYS = [
  "settings.menu.dreaminaCli",
  "settings.dreaminaCli.installStatus",
  "settings.dreaminaCli.installed",
  "settings.dreaminaCli.notInstalled",
  "settings.dreaminaCli.version",
  "settings.dreaminaCli.loginStatus",
  "settings.dreaminaCli.loggedIn",
  "settings.dreaminaCli.notLoggedIn",
  "settings.dreaminaCli.recheck",
  "settings.dreaminaCli.logout",
  "settings.dreaminaCli.credits",
  "settings.dreaminaCli.officialDocs",
  "settings.dreaminaCli.fieldMissing",
] as const;

function lookup(source: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}

describe("即梦 CLI 设置入口", () => {
  it("旧 dreaminaCli 菜单必须迁到模型服务并激活原生供应商", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    settingStore().activeMenu = "dreaminaCli";
    const wrapper = mount(SettingPanel, {
      global: {
        plugins: [
          pinia,
          createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
        ],
        stubs: {
          TMenu: { template: "<nav><slot /></nav>" },
          TMenuItem: {
            props: ["value"],
            template: "<button :data-menu='value'><slot name='icon' /><slot /></button>",
          },
          TBadge: { template: "<span><slot /></span>" },
        },
      },
    });
    await flushPromises();
    const menuKeys = wrapper.findAll("[data-menu]").map((item) => item.attributes("data-menu"));
    expect(menuKeys).toContain("vendorConfig");
    expect(menuKeys).not.toContain("dreaminaCli");
    expect(settingStore().activeMenu).toBe("vendorConfig");
    expect(settingStore().activeWorkspaceProviderId).toBe("native:dreamina-cli");
    expect(wrapper.find("[data-testid='vendor-config']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("七种语言文件必须包含即梦 CLI 设置键", () => {
    const localeDir = path.join(process.cwd(), "src/locales/language");
    for (const file of LOCALE_FILES) {
      const parsed = JSON.parse(readFileSync(path.join(localeDir, file), "utf8")) as unknown;
      for (const key of REQUIRED_KEYS) {
        const value = lookup(parsed, key);
        expect(typeof value, `${file} 缺少 ${key}`).toBe("string");
        expect(String(value).trim().length, `${file} 的 ${key} 不能为空`).toBeGreaterThan(0);
      }
    }
  });
});
