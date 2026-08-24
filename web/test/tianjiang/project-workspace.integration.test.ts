// @vitest-environment jsdom
import { flushPromises, shallowMount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import projectStore from "@/stores/project";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock("@/utils/axios", () => ({
  default: {
    post: mocks.post,
  },
}));

import ScriptWorkspace from "@/views/script/index.vue";

describe("目录到旧工作区的真实 Store 链路", () => {
  beforeEach(() => {
    const pinia = createPinia();
    setActivePinia(pinia);
    projectStore().activateProject({
      id: "17",
      name: "已打开剧本项目",
      intro: "",
      type: "",
      artStyle: null,
      videoRatio: null,
      createTime: 0,
      updatedAt: 0,
      imageModel: "",
      videoModel: "",
      projectType: "script",
      imageQuality: "",
      mode: "",
      directorManual: "",
    }, {
      projectUuid: "17171717-1717-4171-a171-171717171717",
      mode: "readwrite",
      reason: "",
      lockHolder: "",
    });
    mocks.post.mockReset().mockResolvedValue({ data: [] });
  });

  it("实际剧本工作区挂载后读取活动项目 ID 并发起首个业务请求", async () => {
    shallowMount(ScriptWorkspace, {
      global: {
        plugins: [
          createI18n({
            legacy: false,
            locale: "zh-CN",
            messages: { "zh-CN": zhCN },
          }),
        ],
        stubs: {
          "i-search": true,
          "i-plus": true,
          "i-export": true,
          "i-delete": true,
        },
      },
    });
    await flushPromises();
    expect(mocks.post).toHaveBeenCalledWith("/script/getScrptApi", {
      projectId: 17,
      name: "",
    });
  });

  it("完整创建流水线源码强制 refresh→open→editProject 顺序且编辑不走中央创建", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "src/features/tianjiang/project/create-project-flow.ts"),
      "utf8",
    );
    const refreshCall = source.indexOf("await refreshRuntimeProjectCatalog()");
    const openCall = source.indexOf("await openCatalogProject(");
    const editCall = source.indexOf('"/project/editProject"');
    expect(refreshCall).toBeGreaterThan(-1);
    expect(openCall).toBeGreaterThan(refreshCall);
    expect(editCall).toBeGreaterThan(openCall);
    expect(source).toContain("existingProjectUuid");
    const form = readFileSync(
      join(process.cwd(), "src/views/project/components/projectDialog/useProjectForm.ts"),
      "utf8",
    );
    expect(form).toContain("createProjectWithLocalInit");
    expect(form).toContain("pendingProjectUuid");
    // 编辑路径仍只 emit edit
    expect(form).toMatch(/emit\("edit"/);
  });
});
