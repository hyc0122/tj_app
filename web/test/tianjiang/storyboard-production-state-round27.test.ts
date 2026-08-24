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

const projectUuid = "11111111-1111-4111-a111-111111111111";
const shotUuid = "11111111-1111-4111-a111-111111111101";
const secondShotUuid = "11111111-1111-4111-a111-111111111102";
const candidateUuid = "11111111-1111-4111-a111-111111111201";
const secondCandidateUuid = "11111111-1111-4111-a111-111111111202";
const sourceProjectUuid = "22222222-2222-4222-a222-222222222222";
const base = `/tianjiang/runtime/projects/${projectUuid}/storyboard`;
const previewDigest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const singleOperationId = "33333333-3333-4333-8333-333333333333";
const batchOperationId = "44444444-4444-4444-8444-444444444444";

const shots = [
  {
    shotUuid,
    displayOrder: 1,
    sourceText: "雨夜，林夏推开旧剧院的门。",
    visualDescription: "人物进入画面。",
    durationMs: 5000,
    aspectRatio: "9:16",
    bindings: [],
    candidates: [
      {
        candidateUuid,
        mediaType: "video",
        relativePath: `files/videos/storyboard/${shotUuid}/candidate.mp4`,
        selected: false,
        createdAt: "2026-08-15T00:00:00.000Z",
      },
    ],
    generationTasks: [
      {
        taskUuid: "11111111-1111-4111-a111-111111111301",
        mediaType: "video",
        providerId: "dreamina-cli",
        modelName: "dreamina-cli:seedance2.0fast",
        status: "queued",
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  },
  {
    shotUuid: secondShotUuid,
    displayOrder: 2,
    sourceText: "她停在舞台中央。",
    visualDescription: "冷色顶光落在脸上。",
    durationMs: 4000,
    aspectRatio: "9:16",
    bindings: [],
    candidates: [
      {
        candidateUuid: secondCandidateUuid,
        mediaType: "video",
        relativePath: `files/videos/storyboard/${secondShotUuid}/candidate.mp4`,
        selected: false,
        createdAt: "2026-08-15T00:00:00.000Z",
      },
    ],
    generationTasks: [],
  },
];

const assets = [
  { assetUuid: "role-1", name: "林夏", type: "role", describe: "女主角", sourceProjectUuid },
  { assetUuid: "scene-1", name: "旧剧院", type: "scene", describe: "雨夜剧院", sourceProjectUuid },
  { assetUuid: "tool-1", name: "旧钥匙", type: "tool", describe: "关键道具", sourceProjectUuid },
];

function createWorkspace() {
  setActivePinia(createPinia());
  projectStore().project = {
    projectUuid,
    name: "雨夜剧场",
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
  } as any;
  return useStoryboardWorkspace() as ReturnType<typeof useStoryboardWorkspace> & Record<string, any>;
}

beforeEach(() => {
  axiosGet.mockReset();
  axiosPost.mockReset();
  axiosGet.mockImplementation((url: string) => {
    if (url === `${base}/shots`) return Promise.resolve({ data: { data: shots } });
    if (url === `${base}/assets`) {
      return Promise.resolve({ data: { data: { sourceProjectUuid, assets } } });
    }
    if (url === "/setting/dreaminaCli/getStatus") {
      return Promise.resolve({
        data: { data: { queue: { paused: false, maxConcurrency: 3, queued: 2, active: 1, unknown: 1 } } },
      });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  axiosPost.mockImplementation((_url: string, payload?: Record<string, unknown>) => {
    const itemCount = Array.isArray(payload?.items) ? payload.items.length : 1;
    // 中文注释：正式 200 合同返回任务数组；每一项都必须逐字回显同一个客户端操作 ID。
    return Promise.resolve({
      status: 200,
      data: {
        code: 0,
        data: Array.from({ length: itemCount }, (_, index) => ({
          taskUuid: `task-${index + 1}`,
          status: "queued",
          clientOperationId: payload?.clientOperationId,
        })),
      },
    });
  });
});

describe("分镜生产工作区状态", () => {
  it("同时读取候选、任务、角色场景道具资产与本机队列三态", async () => {
    const workspace = createWorkspace();

    await workspace.refreshProductionState();

    expect(workspace.shots.value[0].candidates).toEqual(shots[0].candidates);
    expect(workspace.shots.value[0].generationTasks).toEqual(shots[0].generationTasks);
    expect(workspace.assets.value.map((item: { assetType: string }) => item.assetType)).toEqual([
      "role",
      "scene",
      "tool",
    ]);
    expect(workspace.queue.value).toEqual({
      paused: false,
      maxConcurrency: 3,
      queued: 2,
      active: 1,
      unknown: 1,
    });
    expect(workspace.generationSettings.value).toMatchObject({
      mediaType: "video",
      providerModel: "",
      mode: "text2video",
    });
  });

  it("绑定、采用与生成使用现有生产 URL，并在成功刷新后保留当前分镜", async () => {
    const workspace = createWorkspace();
    await workspace.refreshProductionState();
    workspace.selectShot(secondShotUuid);

    await workspace.bindAsset(secondShotUuid, {
      assetUuid: "role-1",
      assetType: "role",
      relationRole: "appear",
    });
    expect(axiosPost).toHaveBeenCalledWith(`${base}/shots/${secondShotUuid}/bindings`, {
      sourceProjectUuid,
      assetUuid: "role-1",
      assetType: "role",
      relationRole: "appear",
    });
    expect(workspace.selectedShotUuid.value).toBe(secondShotUuid);

    await workspace.selectCandidate(secondShotUuid, secondCandidateUuid);
    expect(axiosPost).toHaveBeenCalledWith(
      `${base}/shots/${secondShotUuid}/candidates/${secondCandidateUuid}/select`,
      {},
    );
    expect(workspace.selectedShotUuid.value).toBe(secondShotUuid);

    await workspace.generateShot(secondShotUuid, "video", {
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "text2video",
      resolution: "720p",
      expectedPreviewDigest: previewDigest,
    }, singleOperationId);
    expect(axiosPost).toHaveBeenCalledWith(`${base}/generate`, {
      clientOperationId: singleOperationId,
      shotUuid: secondShotUuid,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "text2video",
      resolution: "720p",
      expectedPreviewDigest: previewDigest,
      paidBatchConfirmed: false,
    }, { preserveResponse: true });
    expect(workspace.selectedShotUuid.value).toBe(secondShotUuid);
    expect(axiosGet.mock.calls.filter(([url]) => url === `${base}/shots`)).toHaveLength(4);
  });

  it("批量付费生成未确认时不发请求，动作失败也不泄漏响应或本机路径", async () => {
    const workspace = createWorkspace();
    await workspace.refreshProductionState();
    axiosPost.mockClear();

    const queued = await workspace.generateBatch([
      { shotUuid, mediaType: "video", providerModel: "dreamina-cli:seedance2.0", mode: "text2video" },
      { shotUuid: secondShotUuid, mediaType: "video", providerModel: "dreamina-cli:seedance2.0fast", mode: "text2video" },
    ], false, batchOperationId);
    expect(queued).toBe(false);
    expect(axiosPost).not.toHaveBeenCalled();
    expect(workspace.actionFeedback.value).toContain("确认");

    axiosPost.mockRejectedValueOnce(new Error("C:\\Users\\secret\\token.json 响应 sk-live-secret"));
    const bound = await workspace.bindAsset(shotUuid, {
      assetUuid: "role-1",
      assetType: "role",
      relationRole: "appear",
    });
    expect(bound).toBe(false);
    expect(workspace.errorMessage.value).toBe("绑定资产失败，请重试");
    expect(workspace.errorMessage.value).not.toMatch(/secret|token\.json|sk-live/i);

    const validItem = {
      shotUuid,
      mediaType: "video" as const,
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "text2video" as const,
      expectedPreviewDigest: previewDigest,
    };
    const invalidResponses: Array<{ status: number; payload: unknown }> = [
      { status: 200, payload: [] },
      { status: 200, payload: [{ taskUuid: "missing-id" }] },
      { status: 200, payload: [{ taskUuid: "wrong-id", clientOperationId: "00000000-0000-4000-8000-000000000000" }] },
      {
        status: 200,
        payload: [
          { taskUuid: "matching", clientOperationId: singleOperationId },
          { taskUuid: "mixed", clientOperationId: "00000000-0000-4000-8000-000000000000" },
        ],
      },
      { status: 200, payload: { clientOperationId: singleOperationId } },
      { status: 200, payload: { clientOperationId: "00000000-0000-4000-8000-000000000000", tasks: [{ taskUuid: "wrong-id" }] } },
      { status: 200, payload: { clientOperationId: singleOperationId, tasks: [] } },
      { status: 200, payload: { clientOperationId: singleOperationId, tasks: [null] } },
      // 中文注释：状态码与响应形状属于同一个协议，200 对象与 202 数组均必须拒绝。
      { status: 200, payload: { clientOperationId: singleOperationId, tasks: [{ taskUuid: "cross-200" }] } },
      { status: 202, payload: [{ taskUuid: "cross-202", clientOperationId: singleOperationId }] },
      { status: 201, payload: [{ taskUuid: "unsupported-status", clientOperationId: singleOperationId }] },
    ];
    axiosGet.mockClear();
    for (const invalidResponse of invalidResponses) {
      axiosPost.mockResolvedValueOnce({ status: invalidResponse.status, data: { code: 0, data: invalidResponse.payload } });
      expect(await workspace.generateShot(
        shotUuid,
        "video",
        validItem,
        singleOperationId,
      )).toBe(false);
      axiosPost.mockResolvedValueOnce({ status: invalidResponse.status, data: { code: 0, data: invalidResponse.payload } });
      expect(await workspace.generateBatch(
        [validItem],
        true,
        singleOperationId,
      )).toBe(false);
    }
    // 中文注释：畸形响应不得触发任何“成功后刷新”，单项与批量都必须 fail-closed。
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it("写操作成功但状态刷新失败时不得伪报完成", async () => {
    const workspace = createWorkspace();
    await workspace.refreshProductionState();

    axiosGet.mockImplementation((url: string) => {
      if (url === `${base}/shots`) {
        return Promise.reject(new Error("C:\\Users\\secret\\token.json sk-refresh-secret"));
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    const bound = await workspace.bindAsset(secondShotUuid, {
      assetUuid: "role-1",
      assetType: "role",
      relationRole: "appear",
    });
    expect(bound).toBe(false);
    expect(workspace.actionFeedback.value).toBe("");
    expect(workspace.errorMessage.value).toBe("资产已绑定，但刷新最新状态失败，请手动刷新");
    expect(workspace.errorMessage.value).not.toMatch(/secret|token\.json|sk-refresh/i);

    const generated = await workspace.generateShot(secondShotUuid, "video", {
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "text2video",
      expectedPreviewDigest: previewDigest,
    }, singleOperationId);
    expect(generated).toBe(true);
    expect(workspace.actionFeedback.value).toBe("提交完成，已进入任务队列");
    await vi.waitFor(() => {
      expect(workspace.errorMessage.value).toBe("提交完成，状态刷新失败，请手动刷新");
    });
  });

  it("单镜头与已确认批量生成必须原样保留用户选择的画幅和时长", async () => {
    const workspace = createWorkspace();
    await workspace.refreshProductionState();
    axiosPost.mockClear();

    axiosPost.mockResolvedValueOnce({
      status: 202,
      data: {
        code: 0,
        data: {
          clientOperationId: singleOperationId,
          tasks: [{ taskUuid: "recovered-single", status: "queued" }],
        },
      },
    });
    await workspace.generateShot(secondShotUuid, "video", {
      providerModel: "dreamina-cli:seedance2.0_vip",
      mode: "image2video",
      durationMs: 10_000,
      aspectRatio: "16:9",
      resolution: "720p",
      expectedPreviewDigest: previewDigest,
    }, singleOperationId);
    expect(axiosPost).toHaveBeenCalledWith(`${base}/generate`, {
      clientOperationId: singleOperationId,
      shotUuid: secondShotUuid,
      mediaType: "video",
      providerModel: "dreamina-cli:seedance2.0_vip",
      mode: "image2video",
      durationMs: 10_000,
      aspectRatio: "16:9",
      resolution: "720p",
      expectedPreviewDigest: previewDigest,
      paidBatchConfirmed: false,
    }, { preserveResponse: true });

    const selectedItems = [
      {
        shotUuid,
        mediaType: "video" as const,
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "text2video" as const,
        durationMs: 5_000,
        aspectRatio: "9:16",
        expectedPreviewDigest: previewDigest,
      },
      {
        shotUuid: secondShotUuid,
        mediaType: "video" as const,
        providerModel: "dreamina-cli:seedance2.0mini",
        mode: "image2video" as const,
        durationMs: 10_000,
        aspectRatio: "16:9",
        expectedPreviewDigest: previewDigest,
      },
    ];
    axiosPost.mockResolvedValueOnce({
      status: 202,
      data: {
        code: 0,
        data: {
          clientOperationId: batchOperationId,
          tasks: [
            { taskUuid: "recovered-batch-1", status: "queued" },
            { taskUuid: "recovered-batch-2", status: "queued" },
          ],
        },
      },
    });
    await workspace.generateBatch(selectedItems, true, batchOperationId);
    expect(axiosPost).toHaveBeenCalledWith(`${base}/generate`, {
      clientOperationId: batchOperationId,
      items: selectedItems,
      paidBatchConfirmed: true,
    }, { preserveResponse: true });
  });

  it("候选媒体 URL 只接受 files 目录内的安全相对路径", () => {
    const workspace = createWorkspace();

    expect(workspace.mediaUrl(`files/videos/storyboard/${shotUuid}/候选 1.mp4`)).toBe(
      `/api/tianjiang/runtime/projects/${projectUuid}/files/videos/storyboard/${shotUuid}/%E5%80%99%E9%80%89%201.mp4`,
    );
    for (const unsafe of [
      "files/../secret.png",
      "files/videos\\secret.mp4",
      "C:/Windows/secret.mp4",
      "/files/videos/absolute.mp4",
      undefined as unknown as string,
    ]) {
      expect(() => workspace.mediaUrl(unsafe)).toThrow("候选媒体路径无效");
    }
  });
});
