// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";

import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MandatoryStableUpdateDialog from "@/components/update/MandatoryStableUpdateDialog.vue";
import TitleBar from "@/components/titleBar.vue";
import * as authClient from "@/features/tianjiang/auth/client";
import { shouldAnnounceSessionExpired } from "@/features/tianjiang/auth/public-auth-paths";
import tianjiangUpdateStore from "@/stores/tianjiangUpdate";

describe("更新进度、个人中心与昵称标题合同", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    authClient.centralUser.value = null;
  });

  it("强制更新下载必须展示可访问进度条、字节与速度", () => {
    const store = tianjiangUpdateStore();
    store.snapshot = {
      state: "downloading",
      currentVersion: "1.1.13",
      stable: {
        status: "available",
        source: "network",
        latestVersion: "1.1.14",
        packageSizeBytes: 1024,
        required: true,
        downloadAllowed: true,
      },
      beta: { status: "idle", source: "none", required: false, downloadAllowed: false },
      stableRequired: true,
      loginAllowed: false,
      selectedChannel: "stable",
      progress: 25,
      transferredBytes: 256,
      totalBytes: 1024,
      bytesPerSecond: 128,
    } as any;
    const wrapper = mount(MandatoryStableUpdateDialog, {
      global: {
        mocks: { $t: (key: string) => key },
        stubs: {
          "t-dialog": { template: "<div><slot/><slot name='footer'/></div>" },
          "t-button": { template: "<button><slot/></button>" },
          "t-progress": false,
        },
      },
    });
    const progress = wrapper.find("[role='progressbar']");
    expect(progress.exists()).toBe(true);
    expect(progress.attributes("aria-valuenow")).toBe("25");
    expect(wrapper.text()).toContain("256 B / 1 KB");
    expect(wrapper.text()).toContain("128 B/s");
  });

  it("个人中心必须提供资料和原密码校验入口", () => {
    const settings = readFileSync(
      path.join(process.cwd(), "src/components/setting/index.vue"),
      "utf8",
    );
    const personalCenter = readFileSync(
      path.join(process.cwd(), "src/components/setting/components/logoutConfig.vue"),
      "utf8",
    );
    const locale = readFileSync(
      path.join(process.cwd(), "src/locales/language/zh-CN.json"),
      "utf8",
    );
    expect(locale).toContain('"logoutConfig": "个人中心"');
    expect(settings).toMatch(/logoutConfig.*个人中心|settings\.menu\.logoutConfig/);
    for (const label of ["用户名", "昵称", "原密码", "新密码", "确认密码"]) {
      expect(personalCenter).toContain(label);
    }
    expect(typeof (authClient as any).updateCentralProfile).toBe("function");
    expect(typeof (authClient as any).changeCentralPassword).toBe("function");
  });

  it("原密码错误不触发会话过期，并保留服务端具体文案", () => {
    expect(shouldAnnounceSessionExpired(
      401,
      "post",
      "/api/tianjiang/auth/profile/password",
    )).toBe(false);
    expect(authClient.authActionErrorMessage(
      { message: "原密码错误" },
      "密码修改失败",
    )).toBe("原密码错误");
    expect(authClient.authActionErrorMessage(
      { response: { data: { msg: "请求太过频繁，请稍后再试" } } },
      "密码修改失败",
    )).toBe("请求太过频繁，请稍后再试");
    expect(authClient.authActionErrorMessage(
      {
        message: "Request failed with status code 401",
        response: { data: { message: "原密码错误" } },
      },
      "密码修改失败",
    )).toBe("原密码错误");
  });

  it("标题栏登录后只显示天将漫创加昵称，并随资料更新", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({ maximized: false }),
    }));
    const wrapper = mount(TitleBar, { attachTo: document.body });
    expect(wrapper.find(".titleBar-text").text()).toBe("天将漫创");
    authClient.centralUser.value = { id: 7, username: "creator", nickname: "创作者" };
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".titleBar-text").text()).toBe("天将漫创 创作者");
    authClient.centralUser.value = { id: 7, username: "creator_new", nickname: "新昵称" };
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".titleBar-text").text()).toBe("天将漫创 新昵称");
    authClient.centralUser.value = { id: 7, username: "creator_new", nickname: "   " };
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".titleBar-text").text()).toBe("天将漫创");
    wrapper.unmount();
    vi.unstubAllGlobals();
  });
});
