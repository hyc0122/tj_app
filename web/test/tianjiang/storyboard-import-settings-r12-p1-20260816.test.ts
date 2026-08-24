// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import StoryboardImportDialog from "@/views/storyboardProject/components/StoryboardImportDialog.vue";
import StoryboardSettings from "@/views/storyboardProject/components/StoryboardSettings.vue";
import ShotAssetSlots from "@/views/storyboardProject/components/ShotAssetSlots.vue";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const axiosPut = vi.fn();
const axiosPatch = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    put: (...args: unknown[]) => axiosPut(...args),
    patch: (...args: unknown[]) => axiosPatch(...args),
  },
}));

const projectUuid = "c1111111-1111-4111-a111-111111111111";
const roleA = "cccccccc-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

const tdesignStubs = {
  TButton: {
    inheritAttrs: true,
    props: ["loading", "disabled"],
    template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
  },
  TIcon: {
    inheritAttrs: true,
    props: ["name"],
    template: '<i class="t-icon" :class="`t-icon-${name}`" :data-icon-name="name"></i>',
  },
};

describe("R12 导入失败展示服务端安全错误", () => {
  it("commit 失败优先显示服务端 message，不再无条件覆盖", async () => {
    axiosPost.mockImplementation((url: string) => {
      if (String(url).endsWith("/import/preview")) {
        return Promise.resolve({ data: { digest: "a".repeat(64), rows: [{ sourceText: "a" }] } });
      }
      if (String(url).endsWith("/import/commit")) {
        return Promise.reject({
          code: "STORYBOARD_IMPORT_CONTENT_CHANGED",
          message: "导入内容已变化，请重新预览",
        });
      }
      return Promise.resolve({ data: {} });
    });
    const wrapper = mount(StoryboardImportDialog, {
      props: { projectUuid },
      global: { stubs: tdesignStubs },
    });
    await wrapper.get("textarea").setValue("小节1：\n镜头");
    await wrapper.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="commit-import"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("导入内容已变化，请重新预览");
    expect(wrapper.get('[role="alert"]').text()).not.toBe("导入提交失败，项目未被修改");
    wrapper.unmount();
  });

  it("路径、SQL、堆栈和未知内部错误不得显示原文", async () => {
    const leaks = [
      "E:\\secret\\db.sqlite",
      "E:/secret/db.sqlite",
      "\\\\fileserver\\share\\db.sqlite",
      "/home/user/db.sqlite",
      "SELECT * FROM o_storyboardShot WHERE id = 1",
      "SQLITE_ERROR: no such column: evilColumn",
      "boom\n    at commitImportRows (storyboard-service.ts:339:17)",
      "unexpected pool timeout while opening project.sqlite",
    ];
    axiosPost.mockImplementation((url: string) => {
      if (String(url).endsWith("/import/preview")) {
        return Promise.resolve({ data: { digest: "a".repeat(64), rows: [{ sourceText: "a" }] } });
      }
      return Promise.resolve({ data: {} });
    });
    const wrapper = mount(StoryboardImportDialog, {
      props: { projectUuid },
      global: { stubs: tdesignStubs },
    });
    await wrapper.get("textarea").setValue("小节1：\n镜头");
    await wrapper.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();
    for (const leak of leaks) {
      axiosPost.mockImplementation((url: string) => {
        if (String(url).endsWith("/import/preview")) {
          return Promise.resolve({ data: { digest: "a".repeat(64), rows: [{ sourceText: "a" }] } });
        }
        if (String(url).endsWith("/import/commit")) {
          return Promise.reject({ code: "SQLITE_BUSY", message: leak });
        }
        return Promise.resolve({ data: {} });
      });
      await wrapper.get('[data-action="commit-import"]').trigger("click");
      await flushPromises();
      const alert = wrapper.get('[role="alert"]').text();
      expect(alert, leak).not.toContain(leak);
      expect(alert).toBe("导入提交失败，项目未被修改");
    }
    wrapper.unmount();
  });
});

describe("R12 关闭音色后喇叭图标必须仍存在且为 sound-mute", () => {
  it("真实图标名/类必须是 sound 与 sound-mute，sound-off 不得出现", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/views/storyboardProject/components/ShotAssetSlots.vue"),
      "utf8",
    );
    expect(source).toContain("sound-mute");
    expect(source).not.toContain("sound-off");
    const manifest = readFileSync(
      path.join(process.cwd(), "node_modules/tdesign-icons-vue-next/esm/manifest.js"),
      "utf8",
    );
    expect(manifest).toContain('stem: "sound-mute"');
    expect(manifest).toContain('stem: "sound"');
    expect(manifest).not.toContain('stem: "sound-off"');
  });

  it("有音色关闭后按钮仍在，图标类为 t-icon-sound-mute，不发 DELETE", async () => {
    const wrapper = mount(ShotAssetSlots, {
      props: {
        bindings: [
          { sourceProjectUuid: projectUuid, assetUuid: roleA, assetType: "role", relationRole: "appear", voiceEnabled: false },
        ],
        assets: [{ assetUuid: roleA, name: "林夏", assetType: "role", sourceProjectUuid: projectUuid, hasAudio: true }],
        singleType: "role",
      },
      global: { stubs: tdesignStubs },
    });
    const horn = wrapper.get(`[data-action="toggle-binding-voice"][data-asset-id="${roleA}"]`);
    expect(horn.exists()).toBe(true);
    expect((horn.element as HTMLButtonElement).disabled).toBe(false);
    const icon = horn.get("svg.t-icon");
    expect(icon.classes()).toContain("t-icon-sound-mute");
    expect(icon.classes()).not.toContain("t-icon-sound-off");
    expect(icon.html()).toContain("#t-icon-sound-mute");
    await horn.trigger("click");
    expect(wrapper.emitted("toggleVoice")?.[0]?.[1]).toBe(true);
    expect(wrapper.emitted("unbind")).toBeFalsy();
    wrapper.unmount();
  });
});

describe("R12 自动分镜规则进入 preview/commit", () => {
  it("自动规则变化清空摘要，preview 与 commit 发送同一份归一化配置", async () => {
    axiosPost.mockImplementation((url: string) => {
      if (String(url).endsWith("/import/preview")) {
        return Promise.resolve({ data: { digest: "b".repeat(64), rows: [{ sourceText: "a" }, { sourceText: "b" }] } });
      }
      return Promise.resolve({ data: {} });
    });
    const wrapper = mount(StoryboardImportDialog, {
      props: { projectUuid },
      attachTo: document.body,
      global: { stubs: tdesignStubs },
    });
    await wrapper.get('select[name="import-format"]').setValue("txt");
    await flushPromises();
    expect(wrapper.find('[data-auto-rule="section"]').exists()).toBe(true);
    expect(wrapper.find('[data-auto-rule="hash"]').exists()).toBe(true);
    expect(wrapper.find('[data-auto-rule="shot"]').exists()).toBe(true);
    await wrapper.get("textarea").setValue("分镜1：\n甲\n分镜2：\n乙\n");
    await wrapper.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();
    expect((wrapper.get('[data-action="commit-import"]').element as HTMLButtonElement).disabled).toBe(false);

    await wrapper.get('[data-auto-rule="section"]').setValue(false);
    await flushPromises();
    expect((wrapper.get('[data-action="commit-import"]').element as HTMLButtonElement).disabled).toBe(true);

    axiosPost.mockClear();
    await wrapper.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="commit-import"]').trigger("click");
    await flushPromises();
    const preview = axiosPost.mock.calls.find(([url]) => String(url).endsWith("/import/preview"))?.[1] as {
      txtDelimiter?: { mode?: string; autoRules?: string[] };
    };
    const commit = axiosPost.mock.calls.find(([url]) => String(url).endsWith("/import/commit"))?.[1] as {
      txtDelimiter?: { mode?: string; autoRules?: string[] };
    };
    expect(preview?.txtDelimiter?.mode).toBe("auto");
    expect(commit?.txtDelimiter).toEqual(preview?.txtDelimiter);
    expect(preview?.txtDelimiter?.autoRules).not.toContain("section");
    expect(preview?.txtDelimiter?.autoRules).toContain("shot");
    wrapper.unmount();
  });
});

describe("R12 分镜设置保存 durationMs", () => {
  it("保存请求发送 durationMs，不得再发送 defaultDurationMs", async () => {
    axiosGet.mockResolvedValue({
      data: {
        aspectRatio: "9:16",
        durationMs: 5000,
        globalImagePrompt: "旧图",
        globalVideoPrompt: "旧视频",
      },
    });
    axiosPut.mockResolvedValue({ data: { durationMs: 7000 } });
    const wrapper = mount(StoryboardSettings, {
      props: { projectUuid },
      global: { stubs: tdesignStubs },
    });
    await flushPromises();
    const duration = wrapper.get('input[type="number"]');
    await duration.setValue(7);
    await wrapper.get("textarea[name=\"globalImagePrompt\"]").setValue("胶片颗粒");
    await wrapper.get("textarea[name=\"globalVideoPrompt\"]").setValue("缓慢推进");
    await wrapper.get('[data-action="save-storyboard-settings"]').trigger("click");
    await flushPromises();
    expect(axiosPut).toHaveBeenCalled();
    const body = axiosPut.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.durationMs).toBe(7000);
    expect(body.aspectRatio).toBe("9:16");
    expect(body.globalImagePrompt).toBe("胶片颗粒");
    expect(body.globalVideoPrompt).toBe("缓慢推进");
    expect(body).not.toHaveProperty("defaultDurationMs");
    wrapper.unmount();
  });
});
