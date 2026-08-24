// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { describe, expect, it } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import SyncProgressOverlay from "@/components/tianjiang/SyncProgressOverlay.vue";

const phases = [
  ["pause_generation", /暂停新生成任务/],
  ["save_task", /保存任务状态/],
  ["snapshot", /快照/],
  ["upload", /上传/],
  ["commit", /提交/],
  ["finalize", /完成本地确认/],
] as const;

describe("分镜退出同步进度", () => {
  it.each(phases)("必须展示 %s 阶段", (phase, pattern) => {
    const wrapper = mount(SyncProgressOverlay, {
      props: {
        progress: {
          operationId: "exit-1",
          intent: "logout",
          state: "running",
          phase,
          projectName: "雨巷",
          projectKind: "personal",
          completedProjects: 0,
          totalProjects: 1,
          completedObjects: 0,
          totalObjects: 1,
          uploadedBytes: 0,
          totalBytes: 1,
          counts: { database: 1, image: 0, video: 0, audio: 0, other: 0 },
        },
      },
      global: {
        plugins: [
          createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }),
        ],
      },
    });
    expect(wrapper.text()).toMatch(pattern);
    wrapper.unmount();
  });
});
