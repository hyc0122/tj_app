// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import TitleBar from "@/components/titleBar.vue";

describe("标题栏可访问性与尺寸契约", () => {
  it("共享高度 42px，三按钮符号与 aria-label 正确，点击区至少 32px", async () => {
    const mainScss = readFileSync(
      path.join(process.cwd(), "src/assets/main.scss"),
      "utf8",
    );
    expect(mainScss).toMatch(/--app-titlebar-height:\s*42px/);

    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ maximized: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(TitleBar, { attachTo: document.body });
    const source = readFileSync(
      path.join(process.cwd(), "src/components/titleBar.vue"),
      "utf8",
    );
    expect(source).toMatch(/--app-titlebar-height/);
    expect(source).toMatch(/font-size:\s*17px/);
    expect(source).toMatch(/width:\s*32px/);
    expect(source).toMatch(/height:\s*32px/);
    expect(source).toMatch(/width:\s*22px/);

    const buttons = wrapper.findAll("button.titleBar-btn");
    expect(buttons).toHaveLength(3);
    expect(buttons[0].text()).toContain("−");
    expect(buttons[1].text()).toContain("□");
    expect(buttons[2].text()).toContain("×");
    expect(buttons[0].attributes("aria-label")).toBe("最小化");
    expect(buttons[1].attributes("aria-label")).toMatch(/最大化|还原/);
    expect(buttons[2].attributes("aria-label")).toBe("关闭");

    await buttons[0].trigger("click");
    await buttons[1].trigger("click");
    await buttons[2].trigger("click");
    expect(fetchMock).toHaveBeenCalledWith("tianjiang://windowMinimize");
    expect(fetchMock).toHaveBeenCalledWith("tianjiang://windowMaximize");
    expect(fetchMock).toHaveBeenCalledWith("tianjiang://windowClose");

    wrapper.unmount();
    vi.unstubAllGlobals();
  });
});
