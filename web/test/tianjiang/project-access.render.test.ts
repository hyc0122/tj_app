// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import ProjectWorkspaceGate from "@/components/tianjiang/ProjectWorkspaceGate.vue";
import {
  assertLegacyProjectWriteAllowed,
  isLegacyProjectMutation,
} from "@/features/tianjiang/project/access";
import projectStore from "@/stores/project";

describe("旧工作区统一访问门", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("响应式禁用 viewer、失锁和恢复模式下的所有写入口", async () => {
    const store = projectStore();
    store.activateProject({
      id: "2", name: "团队项目", intro: "", type: "", artStyle: null,
      videoRatio: null, createTime: 0, updatedAt: 0, imageModel: "",
      videoModel: "", projectType: "script", imageQuality: "", mode: "",
      directorManual: "",
    }, {
      projectUuid: "22222222-2222-4222-a222-222222222222",
      mode: "readonly",
      reason: "viewer_role",
      lockHolder: "",
    });
    const wrapper = mount(ProjectWorkspaceGate, {
      slots: { default: "<button>旧工作区写按钮</button>" },
      global: {
        plugins: [createI18n({
          legacy: false,
          locale: "zh-CN",
          messages: { "zh-CN": zhCN },
        })],
      },
    });
    expect(wrapper.get("fieldset").attributes("disabled")).toBeDefined();
    expect(() => assertLegacyProjectWriteAllowed("POST", "/api/script/updateScript"))
      .toThrow(/只读/);

    store.setAccessMode("readwrite");
    await wrapper.vm.$nextTick();
    expect(wrapper.get("fieldset").attributes("disabled")).toBeUndefined();
    expect(() => assertLegacyProjectWriteAllowed("POST", "/api/script/updateScript"))
      .not.toThrow();

    store.setAccessMode("recovery", "lock_lost");
    await wrapper.vm.$nextTick();
    expect(wrapper.get("fieldset").attributes("disabled")).toBeDefined();
    expect(() => assertLegacyProjectWriteAllowed("POST", "/api/assets/saveAssets"))
      .toThrow(/恢复/);
  });

  it("旧 POST 读取保持可用，未审核写动作默认拒绝", () => {
    expect(isLegacyProjectMutation("POST", "/api/script/getScrptApi")).toBe(false);
    expect(isLegacyProjectMutation("POST", "/api/project/getProject")).toBe(false);
    expect(isLegacyProjectMutation("POST", "/api/script/updateScript")).toBe(true);
    expect(isLegacyProjectMutation("DELETE", "/api/assets/deleteAssets")).toBe(true);
  });

  it("项目尚未打开时允许管理账号级手册，但仍拒绝真实项目写接口", () => {
    const store = projectStore();
    expect(store.access.mode).toBe("readonly");
    expect(store.access.reason).toBe("project_not_open");

    const accountManualRoutes = [
      "/api/project/addDirectorManual",
      "/api/project/addVisualManual",
      "/api/project/deleteDirectorManual",
      "/api/project/deleteVisualManual",
      "/api/project/editDirectorlManual",
      "/api/project/editVisualManual",
      "/api/project/getVisualManual",
      "/api/project/queryDirectorManual",
      "/api/project/visualManual",
    ];
    for (const pathname of accountManualRoutes) {
      expect(isLegacyProjectMutation("POST", pathname), pathname).toBe(false);
      expect(() => assertLegacyProjectWriteAllowed("POST", pathname), pathname).not.toThrow();
    }

    expect(isLegacyProjectMutation("POST", "/api/project/editProject")).toBe(true);
    expect(() => assertLegacyProjectWriteAllowed("POST", "/api/project/editProject"))
      .toThrow(/只读/);
  });
});
