// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "@/utils/axios";
import zhCN from "@/locales/language/zh-CN.json";
import * as createProject from "@/features/tianjiang/project/create-project";
import {
  buildCreateProjectBody,
  createScopedProject,
} from "@/features/tianjiang/project/create-project";
import { projectCatalogItem } from "@/features/tianjiang/project/catalog";
import {
  createProjectWithLocalInit,
} from "@/features/tianjiang/project/create-project-flow";
import { saveFullCatalogProject } from "@/features/tianjiang/project/project-actions";
import Router from "@/router/index";

vi.mock("@/utils/axios", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

vi.mock("@/router/index.ts", () => ({
  default: { push: vi.fn(), currentRoute: { value: { path: "/project" } } },
}));

vi.mock("@/features/tianjiang/team/client", () => ({
  listTeams: vi.fn().mockResolvedValue([]),
}));

import ProjectDialog from "@/views/project/components/projectDialog.vue";
import CentralCatalog from "@/views/project/components/centralCatalog.vue";

const SOURCE_UUID = "22222222-2222-4222-a222-222222222222";

const stubs = {
  TDialog: {
    props: ["visible", "header"],
    template:
      '<div v-if="visible !== false" role="dialog"><h2>{{ header }}</h2><slot /></div>',
  },
  TForm: { template: "<form><slot /></form>" },
  TFormItem: {
    props: ["label"],
    template: "<label><span class=\"field-label\">{{ label }}</span><slot /></label>",
  },
  TInput: {
    props: ["modelValue", "placeholder", "disabled"],
    emits: ["update:modelValue"],
    template:
      '<input :value="modelValue" :placeholder="placeholder" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  TSelect: {
    props: ["modelValue", "disabled", "placeholder"],
    emits: ["update:modelValue"],
    template:
      '<select :value="modelValue" :disabled="disabled" :placeholder="placeholder" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /></select>',
  },
  TOption: {
    props: ["label", "value"],
    template: '<option :value="value">{{ label }}</option>',
  },
  TTextarea: {
    props: ["modelValue", "placeholder", "disabled"],
    template:
      '<textarea :value="modelValue" :placeholder="placeholder" :disabled="disabled"></textarea>',
  },
  TRadioGroup: { template: "<div class=\"asset-mode\"><slot /></div>" },
  TRadio: {
    props: ["value", "label"],
    template: '<label class="asset-mode-option">{{ label }}<slot /></label>',
  },
  TRadioButton: {
    props: ["value"],
    template: "<button type=\"button\"><slot /></button>",
  },
  TButton: { template: "<button type=\"button\"><slot /></button>" },
  TImageViewer: { template: "<div />" },
  modelSelect: { template: "<div class=\"model-select\" />" },
  ProjectScopeSelector: { template: "<div class=\"scope-selector\" />" },
  VisualManualDialog: { template: "<div />" },
  DirectorManualDialog: { template: "<div />" },
};

function mountDialog(props: Record<string, unknown> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(ProjectDialog, {
    props: {
      modelValue: true,
      ...props,
    },
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
      mocks: {
        $t: (key: string) => {
          const row = key.split(".").reduce<unknown>((acc, part) => (
            acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined
          ), zhCN);
          return typeof row === "string" ? row : key;
        },
      },
    },
  });
}

describe("分镜项目类型与创建入口", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    vi.stubGlobal("$t", (key: string) => key);
    window.$message = {
      warning: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    } as any;
  });

  it("能力表必须把 storyboard 路由到 /storyboard-project，且不再用二元分支", () => {
    const capabilities = (createProject as { projectCapabilities?: (type: string) => {
      route: string;
      modules: readonly string[];
    } }).projectCapabilities;
    expect(typeof capabilities).toBe("function");
    expect(capabilities!("storyboard")).toEqual({
      route: "/storyboard-project",
      modules: ["storyboard", "assets", "settings"],
    });
    expect(capabilities!("novel").route).toBe("/novel");
    expect(capabilities!("script").route).toBe("/script");
  });

  it("创建 body 必须提交 storyboard 及完整可回读字段，独立项目不传来源", () => {
    const body = buildCreateProjectBody({
      name: " 独立分镜 ",
      scope: "personal",
      businessType: "storyboard",
      description: "连续分镜",
      artStyle: "赛博朋克",
      aspectRatio: "16:9",
      defaultLanguage: "zh-CN",
    } as any);
    expect(body).toMatchObject({
      name: "独立分镜",
      scope: "personal",
      businessType: "storyboard",
      description: "连续分镜",
      artStyle: "赛博朋克",
      aspectRatio: "16:9",
      defaultLanguage: "zh-CN",
    });
    expect(Object.hasOwn(body, "assetSourceProjectUuid")).toBe(false);
  });

  it("共享分镜必须传来源 UUID，小说/剧本携带来源必须拒绝", () => {
    const shared = buildCreateProjectBody({
      name: "共享分镜",
      scope: "personal",
      businessType: "storyboard",
      description: "共享",
      artStyle: "水墨",
      aspectRatio: "9:16",
      defaultLanguage: "zh-CN",
      assetSourceProjectUuid: SOURCE_UUID,
    } as any);
    expect(shared.businessType).toBe("storyboard");
    expect((shared as { assetSourceProjectUuid?: string }).assetSourceProjectUuid).toBe(SOURCE_UUID);

    expect(() => buildCreateProjectBody({
      name: "小说",
      scope: "personal",
      businessType: "novel",
      assetSourceProjectUuid: SOURCE_UUID,
    } as any)).toThrow(/来源|storyboard|资产/);
  });

  it("创建弹窗必须显示分镜管理，并允许填写描述、画风、画幅和默认语言", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    const optionValues = wrapper.findAll("option").map((node) => node.attributes("value"));
    expect(optionValues).toContain("storyboard");
    expect(wrapper.text()).toContain("分镜管理");
    expect(wrapper.text()).toMatch(/描述|简介/);
    expect(wrapper.text()).toMatch(/画面风格|画风/);
    expect(wrapper.text()).toMatch(/画幅|比例/);
    expect(wrapper.text()).toMatch(/默认语言/);
    wrapper.unmount();
  });

  it("编辑弹窗必须冻结业务类型和资产来源，但仍展示完整创建字段", async () => {
    const wrapper = mountDialog({
      projectData: {
        projectUuid: "11111111-1111-4111-a111-111111111111",
        kind: "personal",
        teamUuid: "",
        accessMode: "readwrite",
        id: "8",
        name: "已建分镜",
        intro: "旧简介",
        type: "",
        artStyle: "旧画风",
        directorManual: "",
        videoRatio: "16:9",
        imageModel: "img",
        videoModel: "vid",
        projectType: "storyboard",
        imageQuality: "1K",
        mode: "text",
        defaultLanguage: "zh-CN",
        assetSourceProjectUuid: SOURCE_UUID,
      },
    });
    await flushPromises();
    const typeSelect = wrapper.findAll("select").find((node) => (
      node.findAll("option").some((option) => option.attributes("value") === "storyboard")
    ));
    expect(typeSelect).toBeDefined();
    expect(typeSelect!.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("分镜管理");
    const sourceInputs = wrapper.findAll("input, select, textarea").filter((node) => {
      const value = String(node.element instanceof HTMLSelectElement || node.element instanceof HTMLInputElement || node.element instanceof HTMLTextAreaElement
        ? ("value" in node.element ? node.element.value : "")
        : "");
      return value === SOURCE_UUID || node.html().includes(SOURCE_UUID);
    });
    expect(sourceInputs.length).toBeGreaterThan(0);
    expect(sourceInputs.every((node) => node.attributes("disabled") !== undefined)).toBe(true);
    wrapper.unmount();
  });

  it("本地创建流水线必须把 storyboard 完整字段交给中央创建，不得回退成 novel", async () => {
    vi.mocked(axios.post).mockImplementation(async (url) => {
      if (url === "/tianjiang/v1/projects") {
        return { data: { projectUuid: "77777777-7777-4777-a777-777777777777" } } as any;
      }
      if (url === "/tianjiang/runtime/projects/refresh") {
        return { data: [] } as any;
      }
      if (String(url).includes("/open")) {
        return {
          data: {
            projectUuid: "77777777-7777-4777-a777-777777777777",
            project: { id: 21, name: "新分镜", projectType: "storyboard" },
            accessMode: "readwrite",
          },
        } as any;
      }
      return { data: null } as any;
    });

    await createProjectWithLocalInit({
      name: "新分镜",
      projectType: "storyboard",
      intro: "描述",
      type: "",
      artStyle: "赛博朋克",
      directorManual: "",
      videoRatio: "16:9",
      imageModel: "img",
      videoModel: "vid",
      imageQuality: "1K",
      mode: "text",
      scope: "personal",
      defaultLanguage: "zh-CN",
    } as any);

    const createCall = vi.mocked(axios.post).mock.calls.find((call) => call[0] === "/tianjiang/v1/projects");
    expect(createCall?.[1]).toMatchObject({
      name: "新分镜",
      scope: "personal",
      businessType: "storyboard",
      description: "描述",
      artStyle: "赛博朋克",
      aspectRatio: "16:9",
      defaultLanguage: "zh-CN",
    });
    expect(createCall?.[1]).not.toMatchObject({ businessType: "novel" });
  });

  it("目录投影不得把 storyboard 折成 novel，打开后进入 /storyboard-project", async () => {
    const item = projectCatalogItem({
      projectUuid: "88888888-8888-4888-a888-888888888888",
      name: "目录分镜",
      kind: "personal",
      myRole: "owner",
      currentVersion: 1,
      syncState: "synced",
      lastSyncedAt: null,
      updatedAt: "2026-08-13T00:00:00Z",
      lockStatus: "none",
      lockHolderName: "",
      openMode: "editable",
      businessType: "storyboard",
      assetSourceProjectUuid: SOURCE_UUID,
    });
    expect(item.businessType).toBe("storyboard");
    expect((item as { assetSourceProjectUuid?: string }).assetSourceProjectUuid).toBe(SOURCE_UUID);

    vi.mocked(axios.get).mockResolvedValue({
      data: { projects: [item] },
    } as any);
    vi.mocked(axios.post).mockImplementation(async (url) => {
      if (String(url).endsWith("/refresh")) return { data: [] } as any;
      if (String(url).includes("/open")) {
        return {
          data: {
            projectUuid: item.projectUuid,
            kind: "personal",
            editable: true,
            accessMode: "readwrite",
            recoveryRequired: false,
            project: {
              id: "21",
              name: "目录分镜",
              intro: "",
              type: "",
              artStyle: null,
              videoRatio: "16:9",
              createTime: 0,
              updatedAt: 0,
              imageModel: "",
              videoModel: "",
              projectType: "storyboard",
              imageQuality: "",
              mode: "",
              directorManual: "",
            },
          },
        } as any;
      }
      return { data: null } as any;
    });

    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(CentralCatalog, {
      global: {
        plugins: [
          pinia,
          createI18n({
            legacy: false,
            locale: "zh-CN",
            messages: { "zh-CN": zhCN },
          }),
        ],
        stubs: {
          ...stubs,
          TEmpty: { template: "<div />" },
          TTag: { template: "<span><slot /></span>" },
          TAlert: { template: "<div />" },
          ProjectCatalogGroups: { template: "<div />" },
          TTooltip: { template: "<div><slot /></div>" },
        },
      },
    });
    await flushPromises();
    const openButton = wrapper.findAll("button").find((button) => (
      button.text().includes("打开") || button.text().includes("open")
    ));
    expect(openButton).toBeDefined();
    await openButton!.trigger("click");
    await flushPromises();
    expect(Router.push).toHaveBeenCalledWith({ path: "/storyboard-project" });
    wrapper.unmount();
  });

  it("中央创建/更新生产入口不得把 storyboard 改写成 novel", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { projectUuid: "p-1", businessType: "storyboard" } } as any);
    await createScopedProject({
      name: "分镜",
      scope: "personal",
      businessType: "storyboard",
      description: "d",
      artStyle: "a",
      aspectRatio: "16:9",
      defaultLanguage: "zh-CN",
    } as any);
    expect(axios.post).toHaveBeenCalledWith("/tianjiang/v1/projects", expect.objectContaining({
      businessType: "storyboard",
    }));

    vi.mocked(axios.patch).mockResolvedValue({
      data: {
        projectUuid: "p-1",
        name: "分镜改名",
        kind: "personal",
        myRole: "owner",
        openMode: "editable",
        currentVersion: 1,
        syncState: "synced",
        lastSyncedAt: null,
        updatedAt: "2026-08-13T00:00:00Z",
        lockStatus: "none",
        lockHolderName: "",
        businessType: "storyboard",
        description: "新描述",
        artStyle: "新画风",
        aspectRatio: "9:16",
        defaultLanguage: "zh-CN",
      },
    } as any);
    await saveFullCatalogProject("p-1", 21, {
      name: "分镜改名",
      projectType: "storyboard",
      intro: "新描述",
      type: "",
      artStyle: "新画风",
      directorManual: "",
      videoRatio: "9:16",
      imageModel: "img",
      videoModel: "vid",
      imageQuality: "1K",
      mode: "text",
      scope: "personal",
      defaultLanguage: "zh-CN",
    } as any);
    expect(axios.patch).toHaveBeenCalledWith(
      expect.stringMatching(/projects/),
      expect.objectContaining({
        name: "分镜改名",
        businessType: "storyboard",
        description: "新描述",
        artStyle: "新画风",
        aspectRatio: "9:16",
        defaultLanguage: "zh-CN",
      }),
    );
  });
});
