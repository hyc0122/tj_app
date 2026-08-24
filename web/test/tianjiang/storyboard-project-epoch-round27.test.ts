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

const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const shotA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const shotANew = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const shotB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const candidateA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const baseA = `/tianjiang/runtime/projects/${projectA}/storyboard`;
const baseB = `/tianjiang/runtime/projects/${projectB}/storyboard`;
const previewDigest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const singleOperationId = "55555555-5555-4555-8555-555555555555";
const batchOperationId = "66666666-6666-4666-8666-666666666666";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function response(data: unknown) {
  // 中文注释：Axios 正式响应始终带 HTTP 状态；生成合同用它区分 200 任务数组与 202 恢复对象。
  return { status: 200, data: { data } };
}

function shot(projectUuid: string, shotUuid: string, sourceText: string) {
  return {
    shotUuid,
    displayOrder: 1,
    sourceText,
    visualDescription: `${sourceText}画面`,
    durationMs: 5_000,
    aspectRatio: "9:16",
    bindings: [],
    candidates: [],
    generationTasks: [],
    projectUuid,
  };
}

function asset(projectUuid: string, assetUuid: string, name: string) {
  return {
    sourceProjectUuid: projectUuid,
    assets: [{ assetUuid, name, type: "role", describe: `${name}说明`, sourceProjectUuid: projectUuid }],
  };
}

function queue(queued: number) {
  return { queue: { paused: false, maxConcurrency: 3, queued, active: 0, unknown: 0 } };
}

function activateProject(projectUuid: string, name: string) {
  projectStore().project = {
    projectUuid,
    name,
    projectType: "storyboard",
    myRole: "owner",
    openMode: "readwrite",
  } as any;
}

function createWorkspace() {
  setActivePinia(createPinia());
  activateProject(projectA, "项目 A");
  return useStoryboardWorkspace() as ReturnType<typeof useStoryboardWorkspace> & Record<string, any>;
}

beforeEach(() => {
  axiosGet.mockReset();
  axiosPost.mockReset();
});

describe("分镜工作台项目 epoch 隔离", () => {
  it("A 的 shots/assets/queue 成功晚响应不得覆盖已经完成的 B 状态", async () => {
    const aShots = deferred<ReturnType<typeof response>>();
    const aAssets = deferred<ReturnType<typeof response>>();
    const aQueue = deferred<ReturnType<typeof response>>();
    let queueCalls = 0;
    axiosGet.mockImplementation((url: string) => {
      if (url === `${baseA}/shots`) return aShots.promise;
      if (url === `${baseA}/assets`) return aAssets.promise;
      if (url === `${baseB}/shots`) return Promise.resolve(response([shot(projectB, shotB, "B 最新分镜")]));
      if (url === `${baseB}/assets`) return Promise.resolve(response(asset(projectB, "asset-b", "B 角色")));
      if (url === "/setting/dreaminaCli/getStatus") {
        queueCalls += 1;
        return queueCalls === 1 ? aQueue.promise : Promise.resolve(response(queue(8)));
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    const workspace = createWorkspace();
    const staleRefresh = workspace.refreshProductionState();
    activateProject(projectB, "项目 B");
    await workspace.refreshProductionState();
    workspace.actionFeedback.value = "B 操作反馈";
    workspace.errorMessage.value = "B 独立提示";

    aShots.resolve(response([shot(projectA, shotA, "A 陈旧分镜")]));
    aAssets.resolve(response(asset(projectA, "asset-a", "A 角色")));
    aQueue.resolve(response(queue(1)));
    await staleRefresh;

    expect(workspace.shots.value.map((item: { sourceText: string }) => item.sourceText)).toEqual(["B 最新分镜"]);
    expect(workspace.assets.value.map((item: { name: string }) => item.name)).toEqual(["B 角色"]);
    expect(workspace.queue.value.queued).toBe(8);
    expect(workspace.selectedShotUuid.value).toBe(shotB);
    expect(workspace.actionFeedback.value).toBe("B 操作反馈");
    expect(workspace.errorMessage.value).toBe("B 独立提示");
  });

  it("A 的错误晚响应不得清空 B 状态或把失败提示写到 B", async () => {
    const aShots = deferred<never>();
    const aAssets = deferred<never>();
    const aQueue = deferred<never>();
    let queueCalls = 0;
    axiosGet.mockImplementation((url: string) => {
      if (url === `${baseA}/shots`) return aShots.promise;
      if (url === `${baseA}/assets`) return aAssets.promise;
      if (url === `${baseB}/shots`) return Promise.resolve(response([shot(projectB, shotB, "B 稳定分镜")]));
      if (url === `${baseB}/assets`) return Promise.resolve(response(asset(projectB, "asset-b", "B 角色")));
      if (url === "/setting/dreaminaCli/getStatus") {
        queueCalls += 1;
        return queueCalls === 1 ? aQueue.promise : Promise.resolve(response(queue(6)));
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    const workspace = createWorkspace();
    const staleRefresh = workspace.refreshProductionState();
    activateProject(projectB, "项目 B");
    await workspace.refreshProductionState();
    workspace.actionFeedback.value = "B 已完成";
    workspace.errorMessage.value = "B 当前提示";

    aShots.reject(new Error("A shots late failure"));
    aAssets.reject(new Error("A assets late failure"));
    aQueue.reject(new Error("A queue late failure"));
    await staleRefresh;

    expect(workspace.shots.value.map((item: { sourceText: string }) => item.sourceText)).toEqual(["B 稳定分镜"]);
    expect(workspace.assets.value.map((item: { name: string }) => item.name)).toEqual(["B 角色"]);
    expect(workspace.queue.value.queued).toBe(6);
    expect(workspace.selectedShotUuid.value).toBe(shotB);
    expect(workspace.actionFeedback.value).toBe("B 已完成");
    expect(workspace.errorMessage.value).toBe("B 当前提示");
  });

  it("A→B→A 后原 A epoch 的成功晚响应不得覆盖新 A epoch", async () => {
    const oldShots = deferred<ReturnType<typeof response>>();
    const oldAssets = deferred<ReturnType<typeof response>>();
    const oldQueue = deferred<ReturnType<typeof response>>();
    let shotsCalls = 0;
    let assetsCalls = 0;
    let queueCalls = 0;
    axiosGet.mockImplementation((url: string) => {
      if (url === `${baseA}/shots`) {
        shotsCalls += 1;
        return shotsCalls === 1
          ? oldShots.promise
          : Promise.resolve(response([shot(projectA, shotA, "A 新 epoch 分镜")]));
      }
      if (url === `${baseA}/assets`) {
        assetsCalls += 1;
        return assetsCalls === 1
          ? oldAssets.promise
          : Promise.resolve(response(asset(projectA, "asset-a-new", "A 新角色")));
      }
      if (url === "/setting/dreaminaCli/getStatus") {
        queueCalls += 1;
        return queueCalls === 1 ? oldQueue.promise : Promise.resolve(response(queue(9)));
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    const workspace = createWorkspace();
    const staleRefresh = workspace.refreshProductionState();
    activateProject(projectB, "项目 B");
    activateProject(projectA, "项目 A 再打开");
    await workspace.refreshProductionState();
    workspace.actionFeedback.value = "A 新 epoch 反馈";

    oldShots.resolve(response([shot(projectA, shotA, "A 旧 epoch 分镜")]));
    oldAssets.resolve(response(asset(projectA, "asset-a-old", "A 旧角色")));
    oldQueue.resolve(response(queue(2)));
    await staleRefresh;

    expect(workspace.shots.value[0].sourceText).toBe("A 新 epoch 分镜");
    expect(workspace.assets.value[0].name).toBe("A 新角色");
    expect(workspace.queue.value.queued).toBe(9);
    expect(workspace.actionFeedback.value).toBe("A 新 epoch 反馈");
  });

  it("同项目同 epoch 的旧 shots/assets/queue 晚响应不得覆盖较新的生产状态", async () => {
    const oldShots = deferred<ReturnType<typeof response>>();
    const oldAssets = deferred<ReturnType<typeof response>>();
    const oldQueue = deferred<ReturnType<typeof response>>();
    const newShots = deferred<ReturnType<typeof response>>();
    const newAssets = deferred<ReturnType<typeof response>>();
    const newQueue = deferred<ReturnType<typeof response>>();
    let shotsCalls = 0;
    let assetsCalls = 0;
    let queueCalls = 0;
    axiosGet.mockImplementation((url: string) => {
      if (url === `${baseA}/shots`) return ++shotsCalls === 1 ? oldShots.promise : newShots.promise;
      if (url === `${baseA}/assets`) return ++assetsCalls === 1 ? oldAssets.promise : newAssets.promise;
      if (url === "/setting/dreaminaCli/getStatus") return ++queueCalls === 1 ? oldQueue.promise : newQueue.promise;
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    const workspace = createWorkspace();
    const olderRefresh = workspace.refreshProductionState();
    const newerRefresh = workspace.refreshProductionState();

    newShots.resolve(response([shot(projectA, shotANew, "A 最新请求分镜")]));
    newAssets.resolve(response(asset(projectA, "asset-a-new", "A 最新请求角色")));
    newQueue.resolve(response(queue(12)));
    await newerRefresh;

    oldShots.resolve(response([shot(projectA, shotA, "A 旧请求分镜")]));
    oldAssets.resolve(response(asset(projectA, "asset-a-old", "A 旧请求角色")));
    oldQueue.resolve(response(queue(2)));
    await olderRefresh;

    expect(workspace.shots.value[0].sourceText).toBe("A 最新请求分镜");
    expect(workspace.assets.value[0].name).toBe("A 最新请求角色");
    expect(workspace.queue.value.queued).toBe(12);
    expect(workspace.selectedShotUuid.value).toBe(shotANew);
  });

  it("同项目旧 shots 请求先结束时不得提前清除较新请求的 loading", async () => {
    const oldShots = deferred<ReturnType<typeof response>>();
    const newShots = deferred<ReturnType<typeof response>>();
    let shotsCalls = 0;
    axiosGet.mockImplementation((url: string) => {
      if (url === `${baseA}/shots`) return ++shotsCalls === 1 ? oldShots.promise : newShots.promise;
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    const workspace = createWorkspace();
    const olderRefresh = workspace.refreshShots();
    const newerRefresh = workspace.refreshShots();
    expect(workspace.loading.value).toBe(true);

    oldShots.resolve(response([shot(projectA, shotA, "A 旧请求先完成")]));
    await olderRefresh;
    expect(workspace.loading.value).toBe(true);
    expect(workspace.shots.value).toEqual([]);

    newShots.resolve(response([shot(projectA, shotANew, "A 新请求后完成")]));
    await newerRefresh;
    expect(workspace.loading.value).toBe(false);
    expect(workspace.shots.value[0].sourceText).toBe("A 新请求后完成");
  });

  it.each([
    {
      name: "绑定资产",
      invoke: (workspace: Record<string, any>) => workspace.bindAsset(shotA, {
        sourceProjectUuid: projectA,
        assetUuid: "asset-a",
        assetType: "role",
        relationRole: "appear",
      }),
      successFeedback: "资产已绑定",
    },
    {
      name: "采用候选",
      invoke: (workspace: Record<string, any>) => workspace.selectCandidate(shotA, candidateA),
      successFeedback: "候选已采用",
    },
    {
      name: "生成镜头",
      invoke: (workspace: Record<string, any>) => workspace.generateShot(shotA, "video", {
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "text2video",
        expectedPreviewDigest: previewDigest,
      }, singleOperationId),
      successFeedback: "提交完成，已进入任务队列",
    },
    {
      name: "批量生成",
      invoke: (workspace: Record<string, any>) => workspace.generateBatch([
        { shotUuid: shotA, mediaType: "video", providerModel: "dreamina-cli:seedance2.0fast", mode: "text2video", expectedPreviewDigest: previewDigest },
        { shotUuid: shotANew, mediaType: "video", providerModel: "dreamina-cli:seedance2.0mini", mode: "text2video", expectedPreviewDigest: previewDigest },
      ], true, batchOperationId),
      successFeedback: "提交完成，已进入任务队列",
    },
  ])("$name 的内部刷新被后发手动刷新抢占时不得误报刷新失败", async ({
    invoke,
    successFeedback,
  }) => {
    const actionRefresh = deferred<ReturnType<typeof response>>();
    const manualRefresh = deferred<ReturnType<typeof response>>();
    let shotsCalls = 0;
    axiosPost.mockImplementation((_url: string, payload?: Record<string, unknown>) => Promise.resolve(response([
      { status: "queued", clientOperationId: payload?.clientOperationId },
    ])));
    axiosGet.mockImplementation((url: string) => {
      if (url === `${baseA}/shots`) {
        shotsCalls += 1;
        return shotsCalls === 1 ? actionRefresh.promise : manualRefresh.promise;
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    const workspace = createWorkspace();
    const action = invoke(workspace);
    await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledTimes(1));

    // 后发手动刷新代表当前页面采用的最新请求，旧动作刷新不得覆盖它的结果或提示。
    const newerRefresh = workspace.refreshShots();
    manualRefresh.resolve(response([shot(projectA, shotANew, "A 后发手动刷新")]));
    expect(await newerRefresh).toBe(true);
    workspace.actionFeedback.value = "后发刷新已完成";

    actionRefresh.resolve(response([shot(projectA, shotA, "A 动作内旧刷新")]));
    const actionResult = await action;

    expect(workspace.shots.value[0].sourceText).toBe("A 后发手动刷新");
    expect(workspace.selectedShotUuid.value).toBe(shotANew);
    expect(workspace.errorMessage.value).toBe("");
    expect(workspace.actionFeedback.value).not.toContain("刷新最新状态失败");
    expect(workspace.actionFeedback.value).toBe("后发刷新已完成");
    expect(workspace.actionFeedback.value).not.toBe(successFeedback);
    expect(actionResult).toBe(true);
  });

  it.each([
    {
      name: "绑定资产",
      invoke: (workspace: Record<string, any>) => workspace.bindAsset(shotA, {
        sourceProjectUuid: projectA,
        assetUuid: "asset-a",
        assetType: "role",
        relationRole: "appear",
      }),
      postUrl: `${baseA}/shots/${shotA}/bindings`,
    },
    {
      name: "采用候选",
      invoke: (workspace: Record<string, any>) => workspace.selectCandidate(shotA, candidateA),
      postUrl: `${baseA}/shots/${shotA}/candidates/${candidateA}/select`,
    },
    {
      name: "生成镜头",
      invoke: (workspace: Record<string, any>) => workspace.generateShot(shotA, "video", {
        providerModel: "dreamina-cli:seedance2.0fast",
        mode: "text2video",
        expectedPreviewDigest: previewDigest,
      }, singleOperationId),
      postUrl: `${baseA}/generate`,
    },
  ])("A 的$name完成后只按 A owner 刷新，且不得向 B 写成功反馈", async ({ invoke, postUrl }) => {
    const postDone = deferred<ReturnType<typeof response>>();
    axiosPost.mockReturnValue(postDone.promise);
    axiosGet.mockImplementation((url: string) => {
      if (url === `${baseA}/shots`) return Promise.resolve(response([shot(projectA, shotA, "A 刷新结果")]));
      if (url === `${baseB}/shots`) return Promise.resolve(response([shot(projectB, shotB, "B 不应被旧动作刷新")]));
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    const workspace = createWorkspace();
    const action = invoke(workspace);
    activateProject(projectB, "项目 B");
    workspace.shots.value = [shot(projectB, shotB, "B 当前分镜")];
    workspace.selectedShotUuid.value = shotB;
    workspace.actionFeedback.value = "B 当前反馈";
    workspace.errorMessage.value = "B 当前提示";

    postDone.resolve(response([{ status: "queued", clientOperationId: singleOperationId }]));
    const result = await action;

    expect(axiosPost.mock.calls[0]?.[0]).toBe(postUrl);
    if (postUrl.endsWith("/generate")) {
      // 中文注释：生成受理返回时项目已切换，不再启动旧项目后台刷新。
      expect(axiosGet).not.toHaveBeenCalledWith(`${baseA}/shots`);
    } else {
      expect(axiosGet).toHaveBeenCalledWith(`${baseA}/shots`);
    }
    expect(axiosGet).not.toHaveBeenCalledWith(`${baseB}/shots`);
    expect(result).toBe(false);
    expect(workspace.shots.value[0].sourceText).toBe("B 当前分镜");
    expect(workspace.selectedShotUuid.value).toBe(shotB);
    expect(workspace.actionFeedback.value).toBe("B 当前反馈");
    expect(workspace.errorMessage.value).toBe("B 当前提示");
  });

  it("A 的写请求错误晚响应不得把失败提示伪报到 B", async () => {
    const postDone = deferred<never>();
    axiosPost.mockReturnValue(postDone.promise);
    const workspace = createWorkspace();
    const action = workspace.generateShot(shotA, "video", {
      providerModel: "dreamina-cli:seedance2.0fast",
      mode: "text2video",
      expectedPreviewDigest: previewDigest,
    }, singleOperationId);

    activateProject(projectB, "项目 B");
    workspace.shots.value = [shot(projectB, shotB, "B 当前分镜")];
    workspace.selectedShotUuid.value = shotB;
    workspace.actionFeedback.value = "B 当前反馈";
    workspace.errorMessage.value = "B 当前提示";
    postDone.reject(new Error("A late secret C:\\Users\\secret\\token.json"));

    expect(await action).toBe(false);
    expect(axiosGet).not.toHaveBeenCalled();
    expect(workspace.shots.value[0].sourceText).toBe("B 当前分镜");
    expect(workspace.selectedShotUuid.value).toBe(shotB);
    expect(workspace.actionFeedback.value).toBe("B 当前反馈");
    expect(workspace.errorMessage.value).toBe("B 当前提示");
  });

  it.each([
    {
      name: "插入分镜",
      invoke: (workspace: Record<string, any>) => workspace.insertAfter(shotA),
      postUrl: `${baseA}/shots`,
      postResult: { shotUuid: shotA, displayOrder: 2 },
      expectedResult: undefined,
    },
    {
      name: "批量生成",
      invoke: (workspace: Record<string, any>) => workspace.generateBatch([
        { shotUuid: shotA, mediaType: "video", providerModel: "dreamina-cli:seedance2.0fast", mode: "text2video", expectedPreviewDigest: previewDigest },
        { shotUuid: shotANew, mediaType: "video", providerModel: "dreamina-cli:seedance2.0mini", mode: "text2video", expectedPreviewDigest: previewDigest },
      ], true, batchOperationId),
      postUrl: `${baseA}/generate`,
      postResult: [{ status: "queued", clientOperationId: batchOperationId }],
      expectedResult: false,
    },
  ])("A 的$name在 A→B→A 后仍按原 epoch owner 刷新且不污染新 A", async ({
    invoke,
    postUrl,
    postResult,
    expectedResult,
  }) => {
    const postDone = deferred<ReturnType<typeof response>>();
    axiosPost.mockReturnValue(postDone.promise);
    axiosGet.mockImplementation((url: string) => {
      if (url === `${baseA}/shots`) return Promise.resolve(response([shot(projectA, shotA, "A 旧动作刷新")]));
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    const workspace = createWorkspace();
    const action = invoke(workspace);
    activateProject(projectB, "项目 B");
    activateProject(projectA, "项目 A 新 epoch");
    workspace.shots.value = [shot(projectA, shotANew, "A 新 epoch 当前分镜")];
    workspace.selectedShotUuid.value = shotANew;
    workspace.actionFeedback.value = "A 新 epoch 反馈";
    workspace.errorMessage.value = "A 新 epoch 提示";

    postDone.resolve(response(postResult));
    expect(await action).toBe(expectedResult);

    expect(axiosPost.mock.calls[0]?.[0]).toBe(postUrl);
    if (postUrl.endsWith("/generate")) {
      // 中文注释：A→B→A 已形成新 epoch，旧生成受理不得再发起 A 旧 epoch 刷新。
      expect(axiosGet).not.toHaveBeenCalledWith(`${baseA}/shots`);
    } else {
      expect(axiosGet).toHaveBeenCalledWith(`${baseA}/shots`);
    }
    expect(workspace.shots.value[0].sourceText).toBe("A 新 epoch 当前分镜");
    expect(workspace.selectedShotUuid.value).toBe(shotANew);
    expect(workspace.actionFeedback.value).toBe("A 新 epoch 反馈");
    expect(workspace.errorMessage.value).toBe("A 新 epoch 提示");
  });
});
