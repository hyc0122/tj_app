// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/locales/language/zh-CN.json";

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const axiosPatch = vi.fn();
const axiosDelete = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    patch: (...args: unknown[]) => axiosPatch(...args),
    delete: (...args: unknown[]) => axiosDelete(...args),
  },
}));

import projectStore from "@/stores/project";
import StoryboardWorkspace from "@/views/storyboardProject/index.vue";
import StoryboardTable from "@/views/storyboardProject/components/StoryboardTable.vue";
import ShotAssetSlots from "@/views/storyboardProject/components/ShotAssetSlots.vue";

const projectUuid = "71111111-1111-4111-a111-111111111111";
const shotUuid = "71111111-1111-4111-a111-111111111101";
const roleA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const roleB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const roleC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

const assets = [
  { assetUuid: roleA, name: "林夏", type: "role", assetType: "role", sourceProjectUuid: projectUuid },
  { assetUuid: roleB, name: "卫兵", type: "role", assetType: "role", sourceProjectUuid: projectUuid },
  { assetUuid: roleC, name: "导演", type: "role", assetType: "role", sourceProjectUuid: projectUuid },
];

const bindings = [
  { sourceProjectUuid: projectUuid, assetUuid: roleA, assetType: "role", relationRole: "appear" },
  { sourceProjectUuid: projectUuid, assetUuid: roleB, assetType: "role", relationRole: "appear" },
  { sourceProjectUuid: projectUuid, assetUuid: roleC, assetType: "role", relationRole: "appear" },
];

const shot = {
  shotUuid,
  displayOrder: 1,
  sourceText: "三人同框。",
  visualDescription: "林夏、卫兵与导演同时出现。",
  videoPrompt: "缓慢推进",
  durationMs: 5000,
  aspectRatio: "9:16",
  bindings,
  candidates: [],
  generationTasks: [],
};

const tdesignStubs = {
  TButton: {
    inheritAttrs: true,
    props: ["loading", "disabled"],
    template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
  },
  TIcon: { template: "<i />" },
  TTag: { template: "<span><slot /></span>" },
  TCard: { inheritAttrs: true, template: '<section v-bind="$attrs"><slot name="title" /><slot /></section>' },
  TForm: { template: "<form><slot /></form>" },
  TFormItem: { template: "<div><slot /></div>" },
  TDialog: {
    inheritAttrs: true,
    props: ["visible", "header", "attach", "placement", "width"],
    template: `
      <teleport to="body" :disabled="attach !== 'body'">
        <section
          v-if="visible"
          v-bind="$attrs"
          role="dialog"
          data-overlay="true"
          :data-dialog-attach="attach || 'parent'"
          :data-dialog-width="width || ''"
        >
          <h2>{{ header }}</h2>
          <slot />
          <slot name="footer" />
        </section>
      </teleport>
    `,
  },
  TDrawer: {
    inheritAttrs: true,
    props: ["visible", "modelValue", "header"],
    template: '<aside v-if="visible || modelValue" v-bind="$attrs" role="dialog"><slot /><slot name="footer" /></aside>',
  },
  TEmpty: { template: "<div>empty</div>" },
  TLoading: { template: "<div><slot /></div>" },
  TSelect: { template: "<select><slot /></select>" },
  TInput: { inheritAttrs: true, props: ["modelValue"], template: '<input v-bind="$attrs" :value="modelValue" />' },
  TTextarea: { inheritAttrs: true, props: ["modelValue"], template: '<textarea v-bind="$attrs" />' },
  TCheckbox: { template: '<input type="checkbox" />' },
  TCheckboxGroup: { template: "<div><slot /></div>" },
  TImage: { template: "<img />" },
  TImageViewer: { template: '<div><slot name="trigger" :open="() => {}" /></div>' },
  TPopup: { template: "<div><slot /></div>" },
};

function mountWorkspace(readonly = false): VueWrapper {
  const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
  (window as unknown as { $t: (key: string) => string }).$t = (key: string) => String(i18n.global.t(key));
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = projectStore();
  store.project = {
    id: "701",
    projectUuid,
    name: "雨夜剧场",
    describe: "R7 多资产与全局弹窗",
    projectType: "storyboard",
    myRole: readonly ? "viewer" : "owner",
    openMode: readonly ? "readonly" : "readwrite",
    imageModel: "",
    videoModel: "dreamina-cli:seedance2.0fast",
  } as any;
  store.access = {
    projectUuid,
    mode: readonly ? "readonly" : "readwrite",
    reason: "test_open",
    lockHolder: "",
  };
  return mount(StoryboardWorkspace, {
    attachTo: document.body,
    global: {
      plugins: [pinia, i18n],
      stubs: {
        ...tdesignStubs,
        modelSelect: { template: '<div data-field="asset-model" />' },
        ImageTools: { template: "<div />" },
        "i-plus": { template: "<i />" },
      },
    },
  });
}

describe("R7 多个关联资产必须逐项展示", () => {
  it("同一类型三个资产全部垂直列出，不得折叠成 +N", async () => {
    const wrapper = mount(StoryboardTable, {
      props: {
        projectUuid,
        shots: [shot],
        assets,
        selectedShotUuid: shotUuid,
        selectedShotIds: [],
      },
      global: { stubs: tdesignStubs },
    });
    const cell = wrapper.get('[data-asset-slot="role"]');
    const names = wrapper.findAll('[data-asset-row] [data-asset-name]').map((node) => node.text());
    expect(names).toEqual(["林夏", "卫兵", "导演"]);
    expect(cell.text()).not.toMatch(/\+\d/);
    expect(cell.text()).not.toContain(roleA);
    expect(cell.text()).not.toContain(roleB.slice(-8));
    const rows = wrapper.findAll('[data-asset-row][data-asset-type="role"]');
    expect(rows).toHaveLength(3);
    expect(wrapper.findAll('[data-action="unbind-asset"]')).toHaveLength(3);
    wrapper.unmount();
  });

  it("点击第2个取消按钮只解绑该资产，且不打开选择抽屉", async () => {
    const wrapper = mount(StoryboardTable, {
      props: {
        projectUuid,
        shots: [shot],
        assets,
        selectedShotUuid: shotUuid,
        selectedShotIds: [],
      },
      global: { stubs: tdesignStubs },
    });
    const buttons = wrapper.findAll('[data-action="unbind-asset"]');
    expect(buttons).toHaveLength(3);
    await buttons[1]!.trigger("click");
    expect(wrapper.emitted("pickAsset")).toBeFalsy();
    expect(wrapper.emitted("unbindAsset")?.[0]).toMatchObject([{
      shotUuid,
      assetUuid: roleB,
      assetType: "role",
      sourceProjectUuid: projectUuid,
    }]);

    await wrapper.setProps({
      shots: [{ ...shot, bindings: [bindings[0], bindings[2]] }],
    });
    const remaining = wrapper.findAll('[data-asset-row] [data-asset-name]').map((node) => node.text());
    expect(remaining).toEqual(["林夏", "导演"]);
    expect(wrapper.findAll('[data-action="unbind-asset"]')).toHaveLength(2);
    wrapper.unmount();
  });

  it("已关联槽位仍可继续打开选择器，空槽显示选择文案", async () => {
    const wrapper = mount(ShotAssetSlots, {
      props: {
        bindings,
        assets,
        singleType: "role",
      },
      global: { stubs: tdesignStubs },
    });
    const pick = wrapper.get('[data-action="pick-asset"][data-asset-slot="role"]');
    expect(pick.text()).toMatch(/继续关联|选择角色/);
    await pick.trigger("click");
    expect(wrapper.emitted("pick")).toEqual([["role"]]);
    wrapper.unmount();

    const empty = mount(ShotAssetSlots, {
      props: { bindings: [], assets, singleType: "scene" },
      global: { stubs: tdesignStubs },
    });
    expect(empty.get('[data-action="pick-asset"][data-asset-slot="scene"]').text()).toContain("选择场景");
    empty.unmount();
  });
});

describe("R7 三个资产操作必须是全局弹窗", () => {
  beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPatch.mockReset();
    axiosDelete.mockReset();
    axiosGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/shots")) return Promise.resolve({ data: { data: [shot] } });
      if (String(url).includes("/storyboard/assets")) {
        return Promise.resolve({ data: { data: { sourceProjectUuid: projectUuid, assets } } });
      }
      return Promise.resolve({ data: { data: {} } });
    });
    axiosPost.mockImplementation((url: string) => {
      if (String(url).includes("/cornerScape/getAllAssets")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: { data: {} } });
    });
  });

  it("三个弹窗挂到 document.body，不得留在资产模块内部", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-module="assets"]').trigger("click");
    await flushPromises();
    const panel = wrapper.get('[data-panel="corner-scape-assets"]');

    await panel.get('[data-action="create-asset"]').trigger("click");
    await flushPromises();
    const create = document.body.querySelector('[data-modal="create-asset"]');
    expect(create, "新建资产弹窗必须存在").not.toBeNull();
    expect(create?.getAttribute("data-dialog-attach"), "必须 attach 到 body").toBe("body");
    expect(panel.find('[data-modal="create-asset"]').exists(), "不得作为资产模块内部弹层").toBe(false);
    expect(document.body.contains(create)).toBe(true);
    expect(create?.closest('[data-panel="corner-scape-assets"]')).toBeNull();
    expect(create?.querySelector('[data-field="asset-ratio"]')).not.toBeNull();
    expect(create?.textContent ?? "").not.toContain("角色分类");

    await panel.get('[data-action="batch-upload-assets"]').trigger("click");
    await flushPromises();
    const batch = document.body.querySelector('[data-modal="batch-upload-assets"]');
    expect(batch?.getAttribute("data-dialog-attach")).toBe("body");
    expect(panel.find('[data-modal="batch-upload-assets"]').exists()).toBe(false);

    await panel.get('[data-action="import-asset-descriptions"]').trigger("click");
    await flushPromises();
    const imported = document.body.querySelector('[data-modal="import-asset-descriptions"]');
    expect(imported?.getAttribute("data-dialog-attach")).toBe("body");
    expect(panel.find('[data-modal="import-asset-descriptions"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("关闭和切换项目后清理弹窗，宽度受视口约束", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();
    await wrapper.get('[data-module="assets"]').trigger("click");
    await flushPromises();
    const store = projectStore();
    await wrapper.get('[data-action="create-asset"]').trigger("click");
    await flushPromises();
    const create = document.body.querySelector('[data-modal="create-asset"]');
    const width = create?.getAttribute("data-dialog-width") || create?.getAttribute("width") || "";
    expect(width, "宽度必须用视口约束，不能写死 720px").toMatch(/100vw|min\(/);
    expect(width).not.toBe("720px");

    const close = Array.from(create?.querySelectorAll("button") ?? []).find((button) => button.textContent?.includes("取消"));
    close?.click();
    await flushPromises();
    expect(document.body.querySelector('[data-modal="create-asset"]')).toBeNull();

    await wrapper.get('[data-action="batch-upload-assets"]').trigger("click");
    await flushPromises();
    expect(document.body.querySelector('[data-modal="batch-upload-assets"]')).not.toBeNull();
    store.project = { ...store.project, projectUuid: "72222222-2222-4222-a222-222222222222" } as any;
    await flushPromises();
    expect(document.body.querySelector('[data-modal="batch-upload-assets"]'), "切换项目必须关闭旧弹窗").toBeNull();
    wrapper.unmount();
  });
});
