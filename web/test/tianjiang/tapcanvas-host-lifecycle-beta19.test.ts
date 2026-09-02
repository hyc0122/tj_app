// @vitest-environment jsdom

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openCanvasProject, closeCanvasProject, routerPush, routerReplace } = vi.hoisted(() => ({
  openCanvasProject: vi.fn(),
  closeCanvasProject: vi.fn(),
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
}));

vi.mock("@/features/tianjiang/canvas/api", () => ({
  openCanvasProject,
  closeCanvasProject,
}));

vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-router")>();
  return {
    ...actual,
    useRouter: () => ({ push: routerPush, replace: routerReplace }),
  };
});

import TapCanvasHost from "@/views/infiniteCanvas/TapCanvasHost.vue";

describe("TapCanvas 宿主项目运行时生命周期", () => {
  beforeEach(() => {
    openCanvasProject.mockReset();
    closeCanvasProject.mockReset();
    routerPush.mockReset();
    routerReplace.mockReset();
    openCanvasProject.mockResolvedValue({
      projectUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19",
      runtimeGeneration: 19,
    });
    closeCanvasProject.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("编辑器只在运行时打开后装载 iframe，并在卸载时按原代次关闭", async () => {
    const wrapper = mount(TapCanvasHost, {
      props: { projectUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19" },
    });

    expect(wrapper.find("iframe").exists()).toBe(false);
    await flushPromises();

    expect(openCanvasProject).toHaveBeenCalledWith("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19");
    expect(wrapper.find("iframe").attributes("src")).toContain("tjHost=1");

    wrapper.unmount();
    await flushPromises();
    expect(closeCanvasProject).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19",
      19,
    );
  });

  it("只接受当前同源 iframe 的宿主导航消息并切换到对应个人画布路由", async () => {
    const wrapper = mount(TapCanvasHost);
    await flushPromises();
    const iframe = wrapper.find("iframe").element as HTMLIFrameElement;

    window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin,
      source: iframe.contentWindow,
      data: {
        type: "tianjiang:tapcanvas:navigate",
        destination: "studio",
        projectUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19",
        replace: false,
      },
    }));
    await flushPromises();

    expect(routerPush).toHaveBeenCalledWith(
      "/infinite-canvas/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19",
    );
    wrapper.unmount();
  });

  it("严格校验 UUID，并保留 iframe 请求的 replace 导航语义", async () => {
    const wrapper = mount(TapCanvasHost);
    await flushPromises();
    const iframe = wrapper.find("iframe").element as HTMLIFrameElement;

    window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin,
      source: iframe.contentWindow,
      data: {
        type: "tianjiang:tapcanvas:navigate",
        destination: "studio",
        projectUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19",
        replace: true,
      },
    }));
    await flushPromises();
    expect(routerReplace).toHaveBeenCalledWith(
      "/infinite-canvas/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19",
    );

    window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin,
      source: iframe.contentWindow,
      data: {
        type: "tianjiang:tapcanvas:navigate",
        destination: "studio",
        projectUuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        replace: false,
      },
    }));
    await flushPromises();
    expect(routerPush).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("快速 A→B→C 切换时，旧关闭请求不得提前显示尚未打开的 C iframe", async () => {
    const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19";
    const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb19";
    const projectC = "cccccccc-cccc-4ccc-8ccc-cccccccccc19";
    const wrapper = mount(TapCanvasHost, { props: { projectUuid: projectA } });
    await flushPromises();
    expect(wrapper.find("iframe").exists()).toBe(true);

    let resolveCloseA!: (value: unknown) => void;
    const closeA = new Promise((resolve) => { resolveCloseA = resolve; });
    closeCanvasProject.mockImplementationOnce(() => closeA);
    let resolveOpenC!: (value: unknown) => void;
    const openC = new Promise((resolve) => { resolveOpenC = resolve; });
    openCanvasProject.mockImplementation((projectUuid: string) => {
      if (projectUuid === projectC) return openC;
      return Promise.resolve({ projectUuid, runtimeGeneration: 20 });
    });

    await wrapper.setProps({ projectUuid: projectB });
    await wrapper.setProps({ projectUuid: projectC });
    await flushPromises();
    expect(wrapper.find("iframe").exists()).toBe(false);

    resolveCloseA({});
    await flushPromises();
    expect(wrapper.find("iframe").exists()).toBe(false, "旧 B 请求结束时不得清除 C 的加载状态");

    resolveOpenC({ projectUuid: projectC, runtimeGeneration: 21 });
    await flushPromises();
    expect(wrapper.find("iframe").attributes("src")).toContain(projectC);
    wrapper.unmount();
    await flushPromises();
  });

  it("关闭 A 失败时不得继续打开 B，并保留准确代次供卸载重试", async () => {
    const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19";
    const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb19";
    const wrapper = mount(TapCanvasHost, { props: { projectUuid: projectA } });
    await flushPromises();
    closeCanvasProject.mockRejectedValue(new Error("关闭运行时失败"));

    await wrapper.setProps({ projectUuid: projectB });
    await flushPromises();

    expect(openCanvasProject).not.toHaveBeenCalledWith(projectB);
    expect(wrapper.find("iframe").exists()).toBe(false);
    expect(wrapper.text()).toContain("关闭运行时失败");
    expect(closeCanvasProject).toHaveBeenCalledWith(projectA, 19);

    wrapper.unmount();
    await flushPromises();
    expect(closeCanvasProject).toHaveBeenCalledTimes(2);
  });
});
