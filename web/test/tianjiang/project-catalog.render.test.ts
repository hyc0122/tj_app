// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";
import projectStore from "@/stores/project";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  open: vi.fn(),
  push: vi.fn(),
  legacyPost: vi.fn(),
}));

vi.mock("@/utils/axios", () => ({
  default: {
    get: vi.fn(),
    post: mocks.legacyPost,
    patch: vi.fn(),
  },
}));

vi.mock("@/features/tianjiang/project/catalog", () => ({
  fetchProjectCatalog: mocks.fetch,
  openCatalogProject: mocks.open,
  refreshRuntimeProjectCatalog: vi.fn().mockResolvedValue([]),
  projectCatalogItem: (row: any) => row,
}));

vi.mock("@/features/tianjiang/team/client", () => ({
  listTeams: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/router/index.ts", () => ({
  default: { push: mocks.push },
}));

import CentralCatalog from "@/views/project/components/centralCatalog.vue";
import ProjectPage from "@/views/project/index.vue";

const stubs = {
  TButton: {
    props: ["loading", "disabled"],
    emits: ["click"],
    template:
      '<button type="button" :disabled="loading || disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  TTag: { template: "<span><slot /></span>" },
  TEmpty: { props: ["description"], template: "<div>{{ description }}</div>" },
  TAlert: { template: "<div role=\"alert\"><slot /></div>" },
  TInput: { template: "<input />" },
  TSelect: {
    props: ["value", "options"],
    emits: ["change"],
    template:
      '<select :value="value" @change="$emit(\'change\', $event.target.value)"><option v-for="item in options" :key="item.value" :value="item.value">{{ item.label }}</option></select>',
  },
  TRadioGroup: { template: "<div><slot /></div>" },
  TRadioButton: { template: "<button><slot /></button>" },
  "i-plus": { template: "<span />" },
  "i-edit": { template: "<span />" },
  "i-delete": { template: "<span />" },
};

function mountCatalog(pinia: Pinia) {
  return mount(CentralCatalog, {
    global: {
      plugins: [
        pinia,
        createI18n({
          legacy: false,
          locale: "zh-CN",
          messages: { "zh-CN": zhCN },
        }),
      ],
      stubs,
    },
  });
}

/** 使用真实项目页验证本地遗留入口，不以源码文本或 helper 替代页面行为。 */
function mountProjectPage(pinia: Pinia) {
  const pageRouter = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { template: "<div />" } }],
  });
  return mount(ProjectPage, {
    global: {
      plugins: [
        pinia,
        pageRouter,
        createI18n({
          legacy: false,
          locale: "zh-CN",
          messages: { "zh-CN": zhCN },
        }),
      ],
      stubs: {
        ...stubs,
        // 中央目录与本地遗留入口无关，隔离其网络刷新以聚焦真实页面的可见行为。
        centralCatalog: { template: "<div />" },
        TCard: { template: '<article class="legacy-project-card"><slot /></article>' },
        projectDialog: { template: "<div />" },
      },
    },
  });
}

describe("中央项目目录", () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    mocks.fetch.mockReset().mockResolvedValue([
      {
        projectUuid: "11111111-1111-4111-a111-111111111111",
        name: "个人长篇",
        kind: "personal",
        myRole: "owner",
        syncState: "synced",
        currentVersion: 3,
        updatedAt: "2026-07-30T00:00:00Z",
        lockStatus: "none",
        lockHolderName: "",
        openMode: "editable",
        businessType: "novel",
      },
      {
        projectUuid: "22222222-2222-4222-a222-222222222222",
        name: "团队短剧",
        kind: "team",
        teamUuid: "team-review",
        teamName: "审阅团队",
        myRole: "viewer",
        syncState: "readonly",
        currentVersion: 9,
        updatedAt: "2026-07-30T00:10:00Z",
        lockStatus: "active",
        lockHolderName: "林编辑",
        openMode: "readonly",
      },
    ]);
    mocks.open.mockReset().mockResolvedValue({
      projectUuid: "11111111-1111-4111-a111-111111111111",
      kind: "personal",
      editable: true,
      accessMode: "readwrite",
      recoveryRequired: false,
      project: {
        id: "1",
        name: "个人长篇",
        intro: "",
        type: "",
        artStyle: null,
        videoRatio: null,
        createTime: 0,
        updatedAt: 0,
        imageModel: "",
        videoModel: "",
        projectType: "novel",
        imageQuality: "",
        mode: "",
        directorManual: "",
      },
    });
    mocks.push.mockReset();
    mocks.legacyPost.mockReset().mockResolvedValue({ data: [] });
  });

  it("项目页新建按钮打开完整 projectDialog，不再使用内联 create-box", async () => {
    const pageRouter = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: { template: "<div />" } }],
    });
    const wrapper = mount(ProjectPage, {
      global: {
        plugins: [
          pinia,
          pageRouter,
          createI18n({
            legacy: false,
            locale: "zh-CN",
            messages: { "zh-CN": zhCN },
          }),
        ],
        stubs: {
          ...stubs,
          // 与 project/index.vue 中的 projectDialog 组件名对齐
          projectDialog: {
            props: ["modelValue", "projectData"],
            template: '<div class="full-project-dialog" v-if="modelValue">dialog</div>',
          },
        },
      },
    });
    await flushPromises();

    expect(wrapper.find(".create-box").exists()).toBe(false);
    // 新建入口位于始终可见的中央目录，空遗留列表不再渲染旧的 .addBtn。
    const createButton = wrapper
      .findAll("button")
      .find((button) => button.text() === "新建项目");
    expect(createButton).toBeDefined();
    await createButton!.trigger("click");
    await flushPromises();

    expect(wrapper.find(".create-box").exists()).toBe(false);
    expect(wrapper.find(".full-project-dialog").exists()).toBe(true);
  });

  it("没有本地遗留项目时不显示我的项目入口", async () => {
    // 空列表不应留下无内容的本地遗留区块标题。
    mocks.legacyPost.mockResolvedValueOnce({ data: [] });
    const wrapper = mountProjectPage(pinia);
    await flushPromises();

    expect(wrapper.find(".header .title").exists()).toBe(false);
  });

  it("未绑定中央 UUID 的本地项目仍显示我的项目标题和项目卡", async () => {
    mocks.legacyPost.mockResolvedValueOnce({
      data: [
        {
          id: 7,
          name: "本地遗留项目",
          intro: "仅保存在本地",
          type: "",
          artStyle: null,
          videoRatio: null,
          createTime: 0,
          updatedAt: 0,
          imageModel: "image-model",
          videoModel: "video-model",
          projectType: "novel",
          imageQuality: "",
          mode: "",
          directorManual: "",
        },
      ],
    });
    const wrapper = mountProjectPage(pinia);
    await flushPromises();

    expect(wrapper.find(".header .title").text()).toBe("我的项目");
    expect(wrapper.find(".legacy-project-card").text()).toContain("本地遗留项目");
  });

  it("渲染本人角色、锁持有人、打开模式，正文只在点击打开后下载", async () => {
    const wrapper = mountCatalog(pinia);
    await flushPromises();

    expect(wrapper.text()).toContain("所有者");
    expect(wrapper.text()).toContain("查看者");
    expect(wrapper.text()).toContain("林编辑");
    expect(wrapper.text()).toContain("只读");
    expect(mocks.open).not.toHaveBeenCalled();

    const openButtons = wrapper.findAll("button").filter((button) =>
      button.text().includes("打开"));
    expect(openButtons).toHaveLength(2);
    await openButtons[0].trigger("click");
    await flushPromises();

    expect(mocks.open).toHaveBeenCalledWith("11111111-1111-4111-a111-111111111111");
    expect(projectStore(pinia).project?.id).toBe("1");
    expect(projectStore(pinia).project?.projectType).toBe("novel");
    expect(projectStore(pinia).access.mode).toBe("readwrite");
    expect(mocks.push).toHaveBeenCalledWith({
      path: "/novel",
    });
  });

  it("团队查看者和抢锁失败结果均以只读模式进入工作区", async () => {
    mocks.open.mockResolvedValueOnce({
      projectUuid: "22222222-2222-4222-a222-222222222222",
      kind: "team",
      editable: false,
      accessMode: "readonly",
      readonlyReason: "lock_held",
      lockHolder: "林编辑",
      recoveryRequired: false,
      project: {
        id: "2",
        name: "团队短剧",
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
      },
    });
    const wrapper = mountCatalog(pinia);
    await flushPromises();

    const openButtons = wrapper.findAll("button").filter((button) =>
      button.text().includes("打开"));
    await openButtons[1].trigger("click");
    await flushPromises();

    expect(projectStore(pinia).access.mode).toBe("readonly");
    expect(mocks.push).toHaveBeenCalledWith({
      path: "/script",
    });
  });

  it("打开结果含恢复副本时显示可操作提示", async () => {
    mocks.open.mockResolvedValueOnce({
      projectUuid: "11111111-1111-4111-a111-111111111111",
      kind: "personal",
      editable: true,
      accessMode: "recovery",
      recoveryRequired: true,
      project: {
        id: "1",
        name: "个人长篇",
        intro: "",
        type: "",
        artStyle: null,
        videoRatio: null,
        createTime: 0,
        updatedAt: 0,
        imageModel: "",
        videoModel: "",
        projectType: "novel",
        imageQuality: "",
        mode: "",
        directorManual: "",
      },
    });
    const wrapper = mountCatalog(pinia);
    await flushPromises();

    const open = wrapper.findAll("button").find((button) => button.text() === "打开");
    await open!.trigger("click");
    await flushPromises();

    expect(wrapper.find('[role="alert"]').text()).toContain("恢复副本");
    const recoveryAction = wrapper.findAll("button").find((button) =>
      button.text().includes("处理恢复副本"));
    await recoveryAction!.trigger("click");
    expect(projectStore(pinia).access.mode).toBe("recovery");
    expect(mocks.push).toHaveBeenCalledWith({
      path: "/project-recovery",
    });
  });

  it("scope 筛选会隐藏其他归属项目", async () => {
    const wrapper = mountCatalog(pinia);
    await flushPromises();

    const filter = wrapper.find("select.scope-filter");
    expect(filter.exists()).toBe(true);
    await filter.setValue("team-review");
    await flushPromises();

    expect(wrapper.text()).toContain("团队短剧");
    expect(wrapper.text()).not.toContain("个人长篇");
  });
});
