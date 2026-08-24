// @vitest-environment jsdom
import { mount, type VueWrapper } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import StoryboardTable from "@/views/storyboardProject/components/StoryboardTable.vue";
import type { WorkspaceShot } from "@/views/storyboardProject/storyboard-workbench-types";

const projectUuid = "project / 27";
const shotUuid = "11111111-1111-4111-a111-111111111271";
const imageCandidateUuid = "11111111-1111-4111-a111-111111111272";
const videoCandidateUuid = "11111111-1111-4111-a111-111111111273";
const roleAssetUuid = "11111111-1111-4111-a111-111111111281";
const sceneAssetUuid = "11111111-1111-4111-a111-111111111282";
const failedVideoTaskUuid = "11111111-1111-4111-a111-111111111292";

/**
 * 使用后端工作台 DTO 的完整行数据挂载真实组件。
 * 这里保留显式字面量，避免测试复用生产构造逻辑后形成镜像断言。
 */
const productionShot = {
  shotUuid,
  displayOrder: 7,
  sourceText: "林夏推开剧院侧门，雨水顺着衣角滴落。",
  visualDescription: "紫蓝霓虹映在积水中，镜头从门外缓慢跟入。",
  imagePrompt: "电影感雨夜，人物背影，紫蓝霓虹",
  videoPrompt: "镜头缓慢跟随人物向前移动",
  negativePrompt: "模糊，低清",
  shotSize: "全景",
  cameraMovement: "跟拍",
  composition: "中心构图",
  durationMs: 5000,
  aspectRatio: "9:16",
  bindings: [
    {
      sourceProjectUuid: "11111111-1111-4111-a111-111111111200",
      assetUuid: roleAssetUuid,
      assetType: "role",
      relationRole: "appear",
    },
    {
      sourceProjectUuid: "11111111-1111-4111-a111-111111111200",
      assetUuid: sceneAssetUuid,
      assetType: "scene",
      relationRole: "background",
    },
  ],
  candidates: [
    {
      candidateUuid: imageCandidateUuid,
      mediaType: "image",
      relativePath: "files/images/shot-07-a.png",
      selected: true,
      createdAt: "2026-08-15T08:00:00.000Z",
    },
    {
      candidateUuid: videoCandidateUuid,
      mediaType: "video",
      relativePath: "files/videos/shot-07-a.mp4",
      selected: false,
      createdAt: "2026-08-15T08:01:00.000Z",
    },
  ],
  generationTasks: [
    {
      taskUuid: "11111111-1111-4111-a111-111111111291",
      mediaType: "image",
      providerId: "dreamina-cli",
      modelName: "seedream-4.0",
      status: "queued",
      createdAt: 1786780800000,
      updatedAt: 1786780801000,
    },
    {
      taskUuid: failedVideoTaskUuid,
      mediaType: "video",
      providerId: "dreamina-cli",
      modelName: "seedance2.0fast",
      status: "failed",
      createdAt: 1786780802000,
      updatedAt: 1786780803000,
    },
  ],
} as unknown as WorkspaceShot;

function mountProductionTable(readonly = false, mountedShots: WorkspaceShot[] = [productionShot]): VueWrapper {
  return mount(StoryboardTable, {
    props: {
      projectUuid,
      shots: mountedShots,
      selectedShotUuid: shotUuid,
      loading: false,
      readonly,
      inserting: false,
      // 中文注释：纯行组件测试显式声明父层已有真实图片 provider；真实页面无 provider 时另有禁用合同。
      imageGenerationAvailable: true,
    },
    global: {
      stubs: {
        TButton: {
          inheritAttrs: true,
          props: ["loading", "disabled"],
          template: '<button v-bind="$attrs" :disabled="disabled || loading"><slot name="icon"/><slot/></button>',
        },
        TIcon: { template: '<i aria-hidden="true" />' },
      },
    },
  });
}

describe("Round27 Jimeng 风格分镜生产行", () => {
  it("同一镜头行同时呈现提示词、三类资产和真实综合状态", () => {
    const wrapper = mountProductionTable();
    const row = wrapper.get(`[data-shot-id="${shotUuid}"]`);

    expect(row.get('[data-field="video-prompt"]').text()).toContain("镜头缓慢跟随人物向前移动");
    expect(row.text()).not.toContain("叙事内容");
    expect(row.text()).not.toContain("镜头语言");

    // 资产槽必须表达真实关联身份，不能只靠“角色/场景”文案冒充已绑定。
    expect(row.get(`[data-asset-slot="role"][data-asset-id="${roleAssetUuid}"]`).attributes("data-bound")).toBe("true");
    expect(row.get(`[data-asset-slot="scene"][data-asset-id="${sceneAssetUuid}"]`).attributes("data-bound")).toBe("true");
    expect(row.get('[data-asset-slot="tool"]').attributes("data-bound")).toBe("false");
    expect(row.get("[data-shot-summary-status]").attributes("data-status")).toBe("failed");
    expect(row.find('[data-action="preview-shot"]').exists()).toBe(true);

    // 已有 queued/failed 真状态时，禁止退回两个固定“待生成”占位。
    expect(row.text().match(/待生成/g) ?? []).toHaveLength(0);
    wrapper.unmount();
  });

  it("选择镜头通过 select 事件报告所属镜头", async () => {
    const wrapper = mountProductionTable();
    await wrapper.get(`[data-shot-id="${shotUuid}"]`).trigger("click");
    expect(wrapper.emitted("select")?.at(-1)).toEqual([shotUuid]);
    wrapper.unmount();
  });

  it.each(["Enter", " "])("父行接收 %s 时选择镜头，但同一按键从子按钮冒泡时不得额外选择", async (key) => {
    const rowWrapper = mountProductionTable();
    await rowWrapper.get(`[data-shot-id="${shotUuid}"]`).trigger("keydown", { key });
    expect(rowWrapper.emitted("select")?.at(-1)).toEqual([shotUuid]);
    rowWrapper.unmount();

    const buttonWrapper = mountProductionTable();
    const insertButton = buttonWrapper.get(`[data-action="insert-after"][data-shot-id="${shotUuid}"]`);
    await insertButton.trigger("keydown", { key });
    expect(buttonWrapper.emitted("select")).toBeUndefined();

    // jsdom 不合成键盘产生的 click；显式 click 用于证明按钮仍保留原生激活动作。
    await insertButton.trigger("click");
    expect(buttonWrapper.emitted("insert")?.at(-1)).toEqual([shotUuid]);
    expect(buttonWrapper.emitted("select")).toBeUndefined();
    buttonWrapper.unmount();
  });

  it("行内插入通过 insert 事件报告插入锚点", async () => {
    const wrapper = mountProductionTable();
    await wrapper.get(`[data-action="insert-after"][data-shot-id="${shotUuid}"]`).trigger("click");
    expect(wrapper.emitted("insert")?.at(-1)).toEqual([shotUuid]);
    wrapper.unmount();
  });

  it("资产槽动作通过 pickAsset 事件报告镜头与资产类型", async () => {
    const wrapper = mountProductionTable();
    await wrapper.get('[data-action="pick-asset"][data-asset-type="role"]').trigger("click");
    expect(wrapper.emitted("pickAsset")?.at(-1)).toEqual([shotUuid, "role"]);
    wrapper.unmount();
  });

  it("预览入口通过 preview 事件报告所属镜头", async () => {
    const wrapper = mountProductionTable();
    await wrapper.get(`[data-action="preview-shot"][data-shot-id="${shotUuid}"]`).trigger("click");
    expect(wrapper.emitted("preview")?.at(-1)).toEqual([shotUuid]);
    wrapper.unmount();
  });

  it("生产行综合状态明确区分 failed、queued、selected 与 idle", () => {
    const queuedShot = {
      ...productionShot,
      shotUuid: "11111111-1111-4111-a111-111111111275",
      displayOrder: 8,
      candidates: [],
      generationTasks: productionShot.generationTasks?.filter((task) => task.status === "queued"),
    } as WorkspaceShot;
    const selectedShot = {
      ...productionShot,
      shotUuid: "11111111-1111-4111-a111-111111111276",
      displayOrder: 9,
      generationTasks: [],
      candidates: productionShot.candidates?.filter((candidate) => candidate.selected),
    } as WorkspaceShot;
    const idleShot = {
      ...productionShot,
      shotUuid: "11111111-1111-4111-a111-111111111277",
      displayOrder: 10,
      generationTasks: [],
      candidates: [],
    } as WorkspaceShot;
    const wrapper = mountProductionTable(false, [productionShot, queuedShot, selectedShot, idleShot]);

    expect(wrapper.get(`[data-shot-id="${shotUuid}"] [data-shot-summary-status]`).attributes("data-status")).toBe("failed");
    expect(wrapper.get(`[data-shot-id="${queuedShot.shotUuid}"] [data-shot-summary-status]`).attributes("data-status")).toBe("queued");
    expect(wrapper.get(`[data-shot-id="${selectedShot.shotUuid}"] [data-shot-summary-status]`).attributes("data-status")).toBe("selected");
    expect(wrapper.get(`[data-shot-id="${idleShot.shotUuid}"] [data-shot-summary-status]`).attributes("data-status")).toBe("idle");
    wrapper.unmount();
  });

  it.each([
    { label: "插入", selector: `[data-action="insert-after"][data-shot-id="${shotUuid}"]`, eventName: "insert" },
    { label: "选择资产", selector: '[data-action="pick-asset"][data-asset-type="role"]', eventName: "pickAsset" },
    { label: "删除", selector: `[data-action="delete-shot"][data-shot-id="${shotUuid}"]`, eventName: "remove" },
  ] as const)("只读模式禁用$label且不得发出$eventName变更事件", async ({ selector, eventName }) => {
    const wrapper = mountProductionTable(true);
    const control = wrapper.get(selector);

    expect((control.element as HTMLButtonElement).disabled).toBe(true);
    await control.trigger("click");
    expect(wrapper.emitted(eventName)).toBeUndefined();
    wrapper.unmount();
  });

  it("只让镜头外层使用 panel 悬浮，内部控件不重复叠加 transform", () => {
    const wrapper = mountProductionTable();
    const row = wrapper.get(`[data-shot-id="${shotUuid}"]`);
    expect(row.classes()).toContain("module-interactive--panel");
    expect(row.findAll(".module-interactive, .module-interactive--sm, .module-interactive--panel")).toHaveLength(0);
    wrapper.unmount();
  });
});
