// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

const axiosGet = vi.fn();
const axiosPost = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
  },
}));

import DreaminaProviderPanel from "@/components/setting/components/vendorConfig/components/DreaminaProviderPanel.vue";

const baseStatus = {
  enabled: true,
  preferredExecutionTarget: "windows_native",
  effectiveExecutionTarget: "windows_native",
  install: { state: "installed", version: "1.0.0", executablePath: "dreamina", managed: false, checkedAt: 1 },
  account: { state: "logged_in", verified: true },
  capability: { state: "ready", snapshot: { capabilities: [], videoModels: [] }, checkedAt: 1 },
  queue: {
    paused: true,
    pauseReason: "manual_pause",
    maxConcurrency: 3,
    queued: 2,
    active: 0,
    unknown: 0,
  },
};

function mountPanel(): VueWrapper {
  return mount(DreaminaProviderPanel, {
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
      stubs: {
        TButton: {
          inheritAttrs: true,
          props: ["loading", "disabled"],
          template: "<button v-bind=\"$attrs\" :disabled=\"disabled || loading\"><slot name=\"icon\"/><slot/></button>",
        },
        TDialog: { template: "<section><slot/><slot name='footer'/></section>" },
        TTag: { template: "<span><slot/></span>" },
        TIcon: { template: "<i/>" },
        TAlert: { template: "<div><slot/></div>" },
      },
    },
  });
}

beforeEach(() => {
  axiosGet.mockReset().mockImplementation((url: string) => {
    if (url.includes("getEnvironment")) return Promise.resolve({ data: { dependencies: [] } });
    if (url.includes("getSettings")) {
      return Promise.resolve({ data: {
        enabled: true,
        maxConcurrency: 3,
        pollSeconds: 30,
        pauseReason: "manual_pause",
      } });
    }
    return Promise.resolve({ data: structuredClone(baseStatus) });
  });
  axiosPost.mockReset();
});

describe("R26 即梦队列设置页控制", () => {
  it("显示明确暂停原因、并发输入和调度器说明", async () => {
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.get('[data-queue-pause-reason="manual_pause"]').text()).toContain("手动暂停");
    expect(wrapper.get('[data-field="max-concurrency"]').element).toHaveProperty("value", "3");
    expect(wrapper.text()).toContain("不是常驻后台服务");
    expect(wrapper.text()).toContain("本地调度器自动领取");
    expect(wrapper.get('[data-action="resume-queue"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("暂停或恢复 POST 失败时不乐观更新，成功后才采用服务端状态", async () => {
    axiosPost.mockRejectedValueOnce(new Error("offline"));
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.get('[data-action="resume-queue"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-queue-pause-reason="manual_pause"]').exists()).toBe(true);

    axiosPost.mockResolvedValueOnce({
      data: { ...baseStatus.queue, paused: false, pauseReason: "none" },
    });
    await wrapper.get('[data-action="resume-queue"]').trigger("click");
    await flushPromises();
    expect(axiosPost).toHaveBeenLastCalledWith("/task/dreaminaQueue/resume");
    expect(wrapper.get('[data-queue-pause-reason="none"]').text()).toContain("自动领取");
    wrapper.unmount();
  });

  it("并发上限只走 updateSettings，成功响应后才更新显示", async () => {
    const wrapper = mountPanel();
    await flushPromises();

    axiosPost.mockRejectedValueOnce(new Error("offline"));
    await wrapper.get('[data-field="max-concurrency"]').setValue("7");
    await wrapper.get('[data-action="save-concurrency"]').trigger("click");
    await flushPromises();
    // 中文注释：失败响应不得把草稿冒充成已保存配置，必须回退服务端确认值。
    expect(wrapper.get('[data-field="max-concurrency"]').element).toHaveProperty("value", "3");

    axiosPost.mockResolvedValueOnce({ data: { maxConcurrency: 5, pauseReason: "manual_pause" } });
    await wrapper.get('[data-field="max-concurrency"]').setValue("5");
    await wrapper.get('[data-action="save-concurrency"]').trigger("click");
    await flushPromises();

    expect(axiosPost).toHaveBeenCalledWith(
      "/setting/dreaminaCli/updateSettings",
      { maxConcurrency: 5 },
    );
    expect(axiosPost.mock.calls.some(([url]) => String(url).includes("setEnabled"))).toBe(false);
    expect(wrapper.get('[data-field="max-concurrency"]').element).toHaveProperty("value", "5");
    wrapper.unmount();
  });

  it("轮询间隔读取当前账号配置，保存失败回退、成功后采用服务端确认值", async () => {
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.get('[data-field="poll-seconds"]').element).toHaveProperty("value", "30");

    axiosPost.mockRejectedValueOnce(new Error("offline"));
    await wrapper.get('[data-field="poll-seconds"]').setValue("45");
    await wrapper.get('[data-action="save-poll-seconds"]').trigger("click");
    await flushPromises();
    // 中文注释：失败时必须回退账号库最后确认值，不能把未保存草稿冒充成有效轮询配置。
    expect(wrapper.get('[data-field="poll-seconds"]').element).toHaveProperty("value", "30");

    axiosPost.mockResolvedValueOnce({
      data: { pollSeconds: 45, maxConcurrency: 3, pauseReason: "manual_pause", updatedAt: 300 },
    });
    await wrapper.get('[data-field="poll-seconds"]').setValue("45");
    await wrapper.get('[data-action="save-poll-seconds"]').trigger("click");
    await flushPromises();

    expect(axiosPost).toHaveBeenCalledWith(
      "/setting/dreaminaCli/updateSettings",
      { pollSeconds: 45 },
    );
    expect(wrapper.get('[data-field="poll-seconds"]').element).toHaveProperty("value", "45");
    wrapper.unmount();
  });

  it("旧 getSettings 晚到时不得覆盖 pause/resume 和并发 POST 的新 revision", async () => {
    const staleSettings = deferred<{ data: Record<string, unknown> }>();
    axiosGet.mockImplementation((url: string) => {
      if (url.includes("getEnvironment")) return Promise.resolve({ data: { dependencies: [] } });
      if (url.includes("getSettings")) return staleSettings.promise;
      return Promise.resolve({ data: { ...structuredClone(baseStatus), updatedAt: 100 } });
    });
    axiosPost
      .mockResolvedValueOnce({
        data: { ...baseStatus.queue, paused: false, pauseReason: "none", updatedAt: 200 },
      })
      .mockResolvedValueOnce({
        data: { maxConcurrency: 5, pauseReason: "none", updatedAt: 201 },
      });
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.get('[data-action="resume-queue"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-field="max-concurrency"]').setValue("5");
    await wrapper.get('[data-action="save-concurrency"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-queue-pause-reason="none"]').exists()).toBe(true);
    expect(wrapper.get('[data-field="max-concurrency"]').element).toHaveProperty("value", "5");

    staleSettings.resolve({
      data: {
        enabled: true,
        maxConcurrency: 3,
        pauseReason: "manual_pause",
        updatedAt: 100,
      },
    });
    await flushPromises();
    // 中文注释：请求开始更早的 GET 即使最后返回，也不能撕裂已经确认的两个 POST 状态。
    expect(wrapper.get('[data-queue-pause-reason="none"]').exists()).toBe(true);
    expect(wrapper.get('[data-field="max-concurrency"]').element).toHaveProperty("value", "5");
    wrapper.unmount();
  });
});
