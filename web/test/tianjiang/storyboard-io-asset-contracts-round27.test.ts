// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const axiosGet = vi.fn();
const axiosPost = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
  },
}));

import projectStore from "@/stores/project";
import AssetManager from "@/views/storyboardProject/components/AssetManager.vue";
import StoryboardAssetPickerDrawer from "@/views/storyboardProject/components/StoryboardAssetPickerDrawer.vue";
import StoryboardExportDialog from "@/views/storyboardProject/components/StoryboardExportDialog.vue";
import StoryboardImportDialog from "@/views/storyboardProject/components/StoryboardImportDialog.vue";
import { useStoryboardWorkspace } from "@/views/storyboardProject/useStoryboardWorkspace";

const projectUuid = "27000000-0000-4000-a000-000000000701";
const sourceProjectUuid = "27000000-0000-4000-a000-000000000702";
const protectedCoverUrl = `/api/tianjiang/runtime/projects/${sourceProjectUuid}/files/assets/safe.png`;

function globalOptions() {
  return {
    stubs: {
      TButton: {
        inheritAttrs: true,
        props: ["loading", "disabled"],
        template: "<button v-bind=\"$attrs\" :disabled=\"disabled || loading\"><slot name=\"icon\"/><slot/></button>",
      },
      TIcon: { template: "<i />" },
      TDrawer: {
        inheritAttrs: true,
        props: ["visible", "header"],
        emits: ["update:visible", "close"],
        template: "<aside v-if=\"visible\" v-bind=\"$attrs\" role=\"dialog\"><h2>{{ header }}</h2><slot/></aside>",
      },
    },
  };
}

function mountImport(): VueWrapper {
  return mount(StoryboardImportDialog, {
    props: { projectUuid },
    global: globalOptions(),
  });
}

function mountExport(): VueWrapper {
  return mount(StoryboardExportDialog, {
    props: { projectUuid },
    global: globalOptions(),
  });
}

function mountAssetManager(): VueWrapper {
  return mount(AssetManager, {
    props: { projectUuid, sourceProjectUuid },
    global: globalOptions(),
  });
}

let createObjectUrl: ReturnType<typeof vi.fn>;
let revokeObjectUrl: ReturnType<typeof vi.fn>;
let anchorClick: ReturnType<typeof vi.spyOn> | null = null;
let originalCreateObjectUrl: typeof URL.createObjectURL | undefined;
let originalRevokeObjectUrl: typeof URL.revokeObjectURL | undefined;

function installDownloadSpies() {
  originalCreateObjectUrl = URL.createObjectURL;
  originalRevokeObjectUrl = URL.revokeObjectURL;
  createObjectUrl = vi.fn(() => "blob:storyboard-safe-download");
  revokeObjectUrl = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: createObjectUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: revokeObjectUrl });
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
}

function restoreDownloadSpies() {
  anchorClick?.mockRestore();
  anchorClick = null;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: originalCreateObjectUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: originalRevokeObjectUrl });
}

beforeEach(() => {
  axiosGet.mockReset();
  axiosPost.mockReset();
});

afterEach(() => {
  if (anchorClick) restoreDownloadSpies();
});

describe("Round27 分镜导入导出与资产边界", () => {
  it("导入只提供后端实际支持的 CSV/TXT 与追加模式", () => {
    const wrapper = mountImport();

    const optionValues = wrapper.findAll("option").map((option) => option.attributes("value"));
    expect(optionValues).toEqual(["csv", "txt", "append"]);
    expect(wrapper.text()).not.toMatch(/XLSX|替换现有分镜/);
    wrapper.unmount();
  });

  it("导入预览和提交发送同一 TXT 内容且写入模式固定为 append", async () => {
    axiosPost.mockImplementation((url: string) => {
      if (url.endsWith("/import/preview")) {
        return Promise.resolve({ data: { data: { digest: "round27-io-digest", rows: [{ sourceText: "镜头一" }], errors: [] } } });
      }
      return Promise.resolve({ data: { code: 0, data: {} } });
    });
    const wrapper = mountImport();
    const selects = wrapper.findAll("select");
    await selects[0].setValue("txt");
    await wrapper.get("textarea").setValue("镜头一\n镜头二");
    await wrapper.get('[data-action="preview-import"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="commit-import"]').trigger("click");
    await flushPromises();

    const previewCall = axiosPost.mock.calls.find(([url]) => String(url).endsWith("/import/preview"));
    const commitCall = axiosPost.mock.calls.find(([url]) => String(url).endsWith("/import/commit"));
    expect(previewCall?.[1]).toEqual({
      format: "txt",
      contentBase64: "6ZWc5aS05LiACumVnOWktOS6jA==",
      txtDelimiter: { mode: "auto", delimiter: "" },
    });
    expect(commitCall?.[1]).toEqual({
      format: "txt",
      contentBase64: previewCall?.[1]?.contentBase64,
      previewDigest: "round27-io-digest",
      mode: "append",
      txtDelimiter: previewCall?.[1]?.txtDelimiter,
    });
    wrapper.unmount();
  });

  it("导出只提供后端实际支持的 CSV/TXT", () => {
    const wrapper = mountExport();

    expect(wrapper.text()).toContain("CSV 表格");
    expect(wrapper.text()).toContain("TXT 文本");
    expect(wrapper.text()).not.toContain("JSON 数据");
    wrapper.unmount();
  });

  it("导出把服务端文本保存为固定白名单文件", async () => {
    installDownloadSpies();
    // 中文注释：项目 Axios 拦截器返回 response.data；真实导出调用拿到的是正文字符串而非 AxiosResponse。
    axiosPost.mockResolvedValue("镜头编号,画面描述\n1,雨夜剧院");
    let capturedDownload = "";
    anchorClick?.mockImplementation(function (this: HTMLAnchorElement) {
      capturedDownload = this.download;
    });
    const wrapper = mountExport();

    await wrapper.get('[data-action="confirm-export"]').trigger("click");
    await flushPromises();

    expect(axiosPost).toHaveBeenCalledWith(
      `/tianjiang/storyboard/${projectUuid}/export`,
      { format: "csv" },
    );
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    const blob = createObjectUrl.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("text/csv;charset=utf-8");
    expect(capturedDownload).toBe("storyboard-export.csv");
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:storyboard-safe-download");
    expect(wrapper.get('[role="status"]').text()).toBe("分镜已下载");
    wrapper.unmount();
  });

  it("导出响应不是文本时失败关闭且不会触发下载", async () => {
    installDownloadSpies();
    axiosPost.mockResolvedValue({ localPath: "C:\\Users\\secret\\storyboard.csv", token: "secret-export" });
    const wrapper = mountExport();
    await wrapper.get('[data-action="confirm-export"]').trigger("click");
    await flushPromises();

    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(anchorClick).not.toHaveBeenCalled();
    const status = wrapper.get('[role="status"]');
    expect(status.text()).toBe("导出失败，请重试");
    expect(status.text()).not.toMatch(/C:\\Users|secret-export|token|storyboard\.csv/i);
    wrapper.unmount();
  });

  it("资产面板统一识别 SharedAssetDto 的 type/describe 并只渲染安全封面 URL", async () => {
    axiosGet.mockResolvedValue({
      data: {
        data: {
          sourceProjectUuid,
          assets: [
            { assetUuid: "safe-relative", name: "安全角色", type: "role", describe: "来自共享资产合同", coverUrl: protectedCoverUrl },
            { assetUuid: "safe-https", name: "安全远端", type: "scene", describe: "HTTPS 封面", coverUrl: "https://cdn.example.com/assets/safe.png" },
            { assetUuid: "unsafe-file", name: "文件协议", type: "tool", describe: "不应加载", coverUrl: "file:///C:/Users/secret/token.png" },
            { assetUuid: "unsafe-data", name: "数据协议", type: "tool", describe: "不应加载", coverUrl: "data:image/png;base64,c2VjcmV0" },
            { assetUuid: "unsafe-drive", name: "盘符路径", type: "tool", describe: "不应加载", coverUrl: "C:\\Users\\secret\\token.png" },
            { assetUuid: "unsafe-unc", name: "UNC 路径", type: "tool", describe: "不应加载", coverUrl: "\\\\server\\share\\token.png" },
            { assetUuid: "unsafe-traversal", name: "穿越路径", type: "tool", describe: "不应加载", coverUrl: "/tianjiang/runtime/projects/p/files/../secret.png" },
            { assetUuid: "unsafe-double-traversal", name: "双编码穿越", type: "tool", describe: "不应加载", coverUrl: "/tianjiang/runtime/projects/p/files/%252e%252e/secret.png" },
            { assetUuid: "unsafe-double-unc", name: "双编码 UNC", type: "tool", describe: "不应加载", coverUrl: "/tianjiang/runtime/projects/p/files/%255c%255cserver%255csecret.png" },
          ],
        },
      },
    });
    const wrapper = mountAssetManager();
    await flushPromises();

    expect(wrapper.text()).toContain("来自共享资产合同");
    expect(wrapper.text()).toContain("角色");
    const imageSources = wrapper.findAll("img").map((image) => image.attributes("src"));
    expect(imageSources).toEqual([protectedCoverUrl, "https://cdn.example.com/assets/safe.png"]);
    for (const assetUuid of [
      "unsafe-file",
      "unsafe-data",
      "unsafe-drive",
      "unsafe-unc",
      "unsafe-traversal",
      "unsafe-double-traversal",
      "unsafe-double-unc",
    ]) {
      expect(wrapper.get(`[data-asset-id="${assetUuid}"]`).find("img").exists()).toBe(false);
    }
    expect(wrapper.html()).not.toMatch(/file:\/\/|data:image|C:\\Users|\\\\server|files\/\.\.\/secret|%252e|%255c/i);
    wrapper.unmount();
  });

  it("工作台与资产面板对 SharedAssetDto 使用相同的字段归一化结果", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    projectStore().project = {
      projectUuid,
      name: "字段归一化项目",
      projectType: "storyboard",
    } as any;
    axiosGet.mockImplementation((url: string) => {
      if (url.endsWith("/shots")) return Promise.resolve({ data: { data: [] } });
      if (url.endsWith("/assets")) {
        return Promise.resolve({
          data: {
            data: {
              sourceProjectUuid,
              assets: [{ assetUuid: "legacy-role", name: "旧合同角色", type: "role", describe: "旧字段说明", coverUrl: protectedCoverUrl }],
            },
          },
        });
      }
      return Promise.resolve({ data: { data: { queue: { paused: false, maxConcurrency: 1, queued: 0, active: 0, unknown: 0 } } } });
    });
    const workspace = useStoryboardWorkspace();
    await workspace.refreshProductionState();

    expect(workspace.assets.value).toEqual([{
      assetUuid: "legacy-role",
      name: "旧合同角色",
      assetType: "role",
      description: "旧字段说明",
      coverUrl: protectedCoverUrl,
      sourceProjectUuid,
      hasAudio: false,
    }]);
  });

  it("资产选择器沿用同一安全媒体 URL 边界", () => {
    const wrapper = mount(StoryboardAssetPickerDrawer, {
      props: {
        open: true,
        target: { shotUuid: "shot-1", shotNumber: 1, assetType: "role" },
        assets: [
          { assetUuid: "role-safe", name: "安全角色", assetType: "role", sourceProjectUuid, coverUrl: protectedCoverUrl },
          { assetUuid: "role-file", name: "文件角色", assetType: "role", sourceProjectUuid, coverUrl: "file:///C:/Users/secret/role.png" },
          { assetUuid: "role-data", name: "数据角色", assetType: "role", sourceProjectUuid, coverUrl: "data:image/png;base64,c2VjcmV0" },
        ],
      },
      global: globalOptions(),
    });

    expect(wrapper.findAll("img").map((image) => image.attributes("src"))).toEqual([protectedCoverUrl]);
    expect(wrapper.html()).not.toMatch(/file:\/\/|data:image|C:\\Users/i);
    wrapper.unmount();
  });
});
