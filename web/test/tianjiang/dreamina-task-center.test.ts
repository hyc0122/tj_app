// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import axios from "@/utils/axios";

vi.mock("@/utils/axios", () => ({
  default: {
    post: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    get: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

function lookup(source: unknown, dotted: string): string {
  const value = dotted.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
  return typeof value === "string" ? value : dotted;
}

(globalThis as any).$t = (key: string) => lookup(zhCN, key);

import TaskCenter from "@/views/task/index.vue";

describe("即梦任务中心", () => {
  it("必须展示排队中/生成中，并提供暂停队列入口", async () => {
    const wrapper = mount(TaskCenter, {
      global: {
        plugins: [
          createI18n({
            legacy: false,
            locale: "zh-CN",
            messages: { "zh-CN": zhCN },
            missingWarn: false,
            fallbackWarn: false,
          }),
        ],
        stubs: {
          TButton: { template: "<button><slot /></button>" },
          TSelect: {
            props: ["options"],
            template: "<select><option v-for='item in options' :key='item.value'>{{ item.label }}</option></select>",
          },
          TTable: { template: "<table><slot /></table>" },
          TPagination: { template: "<div />" },
          TTooltip: { template: "<span><slot /></span>" },
        },
      },
    });
    await flushPromises();
    const text = wrapper.text();
    expect(text).toMatch(/排队中/);
    expect(text).toMatch(/生成中/);
    expect(text).toMatch(/暂停队列|恢复队列/);
    wrapper.unmount();
  });

  it("供应商失败原因过长时列表可点击并完整放大显示", async () => {
    const providerMessage = `模型返回：${"参考素材格式不受支持。".repeat(300)}`;
    vi.mocked(axios.post).mockImplementation(async (url) => {
      if (url === "/task/getTaskApi") {
        return {
          data: {
            data: [{
              id: 33,
              rowKey: "project-r33:storyboard:task-r33",
              projectUuid: "project-r33",
              projectName: "测试分镜",
              taskClass: "storyboard",
              relatedObjects: "task-r33",
              model: "tianjiang:doubao-seedance-1-0-pro-fast",
              describe: "shot-r33",
              state: "生成失败",
              startTime: Date.parse("2026-08-24T03:00:00Z"),
              reason: providerMessage,
            }],
            total: 1,
          },
        } as never;
      }
      return { data: [] } as never;
    });

    const wrapper = mount(TaskCenter, {
      global: {
        plugins: [
          createI18n({
            legacy: false,
            locale: "zh-CN",
            messages: { "zh-CN": zhCN },
            missingWarn: false,
            fallbackWarn: false,
          }),
        ],
        stubs: {
          TButton: { template: "<button><slot /></button>" },
          TSelect: { props: ["options"], template: "<select />" },
          TTable: {
            props: ["data"],
            template: "<div><slot v-if='data[0]' name='reason' :row='data[0]' /></div>",
          },
          TPagination: { template: "<div />" },
          TTooltip: { template: "<span><slot /></span>" },
          TDialog: {
            props: ["visible"],
            template: "<div v-if='visible' class='dialog-stub'><slot /></div>",
          },
        },
      },
    });

    await flushPromises();
    const reason = wrapper.get(".reasonText");
    expect(reason.text()).toBe(providerMessage);
    await reason.trigger("click");
    expect(wrapper.get(".reasonDialogContent").text()).toBe(providerMessage);
    wrapper.unmount();
  });
});
