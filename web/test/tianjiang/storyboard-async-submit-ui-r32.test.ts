import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const axiosGet = vi.fn();
const axiosPost = vi.fn();

vi.mock("@/utils/axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
  },
}));

import projectStore from "@/stores/project";
import { useStoryboardWorkspace } from "@/views/storyboardProject/useStoryboardWorkspace";

const projectUuid = "32323232-3232-4232-a232-323232323240";
const shotUuid = "32323232-3232-4232-a232-323232323241";
const singleOperationId = "32323232-3232-4232-a232-323232323242";
const batchOperationId = "32323232-3232-4232-a232-323232323243";
const previewDigest = "f".repeat(64);
const base = `/tianjiang/runtime/projects/${projectUuid}/storyboard`;

function accepted(clientOperationId: string, count = 1) {
  return {
    status: 202,
    data: {
      code: 0,
      data: {
        clientOperationId,
        tasks: Array.from({ length: count }, (_, index) => ({
          taskUuid: `queued-${index}`,
          status: "queued",
          clientOperationId,
        })),
      },
    },
  };
}

function createWorkspace() {
  setActivePinia(createPinia());
  projectStore().project = {
    projectUuid,
    name: "R32 即时提交",
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
  } as never;
  return useStoryboardWorkspace() as ReturnType<typeof useStoryboardWorkspace> & Record<string, any>;
}

beforeEach(() => {
  axiosGet.mockReset();
  axiosPost.mockReset();
  axiosGet.mockImplementation((url: string) => {
    if (url === `${base}/shots`) return Promise.resolve({ data: { data: [{ shotUuid, bindings: [] }] } });
    if (url === `${base}/assets`) return Promise.resolve({ data: { data: { sourceProjectUuid: "", assets: [] } } });
    if (url === "/setting/dreaminaCli/getStatus") {
      return Promise.resolve({ data: { data: { queue: { paused: false, maxConcurrency: 1 } } } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
});

describe("R32 分镜生成耐久受理后的即时 UI 完成", () => {
  it("单条提交不等待永不结束的分镜刷新", async () => {
    const workspace = createWorkspace();
    await workspace.refreshProductionState();
    axiosGet.mockImplementation((url: string) => {
      if (url === `${base}/shots`) return new Promise(() => undefined);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    axiosPost.mockResolvedValue(accepted(singleOperationId));

    const submission = workspace.generateShot(shotUuid, "video", {
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "text2video",
      resolution: "720p",
      expectedPreviewDigest: previewDigest,
    }, singleOperationId);
    const result = await Promise.race([
      submission,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    expect(result).toBe(true);
    expect(workspace.actionFeedback.value).toBe("提交完成，已进入任务队列");
    expect(workspace.errorMessage.value).toBe("");
  });

  it("批量提交不等待刷新，刷新失败也不把已受理结果改判为失败", async () => {
    const workspace = createWorkspace();
    await workspace.refreshProductionState();
    let rejectRefresh!: (reason: Error) => void;
    axiosGet.mockImplementation((url: string) => {
      if (url === `${base}/shots`) {
        return new Promise((_resolve, reject) => {
          rejectRefresh = reject;
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    axiosPost.mockResolvedValue(accepted(batchOperationId));

    const result = await workspace.generateBatch([{
      shotUuid,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "text2video",
      resolution: "720p",
      expectedPreviewDigest: previewDigest,
    }], true, batchOperationId);
    expect(result).toBe(true);
    expect(workspace.actionFeedback.value).toBe("提交完成，已进入任务队列");

    rejectRefresh(new Error("C:\\private\\token.json sk-secret"));
    await vi.waitFor(() => {
      expect(workspace.errorMessage.value).toBe("提交完成，状态刷新失败，请手动刷新");
    });
    expect(workspace.actionFeedback.value).toBe("提交完成，已进入任务队列");
    expect(workspace.errorMessage.value).not.toMatch(/private|token|secret/i);
  });
});
