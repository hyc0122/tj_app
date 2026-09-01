/**
 * RED→GREEN：项目切换必须立即销毁前一个项目的完整前端运行态。
 * 后台任务不得随 Store/Socket/轮询一起被取消；也不得靠保留旧 Store 等待完成。
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia, type Pinia } from "pinia";

vi.stubGlobal("$t", (key: string) => key);
vi.stubGlobal(
  "window",
  Object.assign(globalThis, {
    $message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  }),
);

const axiosPost = vi.fn(async (_url: string, _body?: unknown) => ({ data: {} }));
vi.mock("@/utils/axios", () => ({
  default: {
    post: (...args: unknown[]) => axiosPost(...(args as [string, unknown?])),
    get: vi.fn(),
    patch: vi.fn(),
  },
}));

const liveSockets = new Set<{ connected: boolean; disconnect: () => void; emit: (...args: unknown[]) => boolean }>();
const socketEmit = vi.fn();
const socketConnect = vi.fn();
const socketDisconnect = vi.fn();
const socketHandlers = new Map<string, (...args: unknown[]) => unknown>();
const socketOn = vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
  socketHandlers.set(event, handler);
});
const socketOnce = vi.fn();
const socketOff = vi.fn();
const socketRemoveAll = vi.fn();
let lastAuthPayload: Record<string, unknown> | undefined;

const ioFactory = vi.fn((_url: string, opts?: { auth?: Record<string, unknown> }) => {
  lastAuthPayload = opts?.auth ? { ...opts.auth } : undefined;
  const sock = {
    connected: false,
    connect: socketConnect.mockImplementation(function (this: { connected: boolean }) {
      this.connected = true;
    }),
    disconnect: socketDisconnect.mockImplementation(function (this: { connected: boolean }) {
      this.connected = false;
      liveSockets.delete(sock);
    }),
    on: socketOn,
    once: socketOnce,
    off: socketOff,
    emit: socketEmit,
    removeAllListeners: socketRemoveAll,
  };
  liveSockets.add(sock);
  return sock;
});

vi.mock("socket.io-client", () => ({
  io: (...args: unknown[]) =>
    ioFactory(...(args as [string, { auth?: Record<string, unknown> }?])),
}));

vi.mock("@/stores/setting", () => ({
  default: () => ({
    baseUrl: "http://127.0.0.1:10588/api",
    otherSetting: { assetsBatchGenereateSize: 2 },
  }),
}));

import projectStore, { type Project } from "@/stores/project";
import useProductionAgentStore from "@/stores/productionAgent";
import * as productionAgentModule from "@/stores/productionAgent";
import useScriptAgentStore from "@/stores/scriptAgent";
import * as scriptAgentModule from "@/stores/scriptAgent";
import imageListCacheStore from "@/stores/imageListCache";
import videoStore from "@/stores/video";

const createdObjectUrls: string[] = [];
const revokedObjectUrls: string[] = [];
let objectUrlSeq = 0;
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:http://local-test/polyfill";
}
if (typeof URL.revokeObjectURL !== "function") {
  URL.revokeObjectURL = () => undefined;
}
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function piniaStores(pinia: Pinia, prefix: string): string[] {
  const registry = (pinia as unknown as { _s?: Map<string, unknown> })._s;
  if (!registry) return [];
  return [...registry.keys()].filter((key) => String(key).startsWith(prefix));
}

function baseProject(id: string, uuidSuffix: string): Project {
  return {
    id,
    name: `项目${id}`,
    intro: "",
    type: "",
    artStyle: null,
    videoRatio: null,
    createTime: 0,
    updatedAt: 0,
    imageModel: "",
    videoModel: "",
    projectType: "storyboard",
    imageQuality: "",
    mode: "",
    directorManual: "",
    projectUuid: `aaaaaaaa-bbbb-4ccc-8ddd-${uuidSuffix.padStart(12, "0")}`,
  };
}

function activate(id: string) {
  const store = projectStore();
  store.activateProject(baseProject(id, id), {
    mode: "readwrite",
    reason: "owner_lock",
    lockHolder: "",
  });
  return {
    production: useProductionAgentStore(),
    script: useScriptAgentStore(),
  };
}

async function loadDisposal(): Promise<typeof import("@/features/tianjiang/project/project-runtime-disposal")> {
  const spec = "@/features/tianjiang/project/project-runtime-disposal";
  return import(spec);
}

describe("项目运行态销毁与资源上限", () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    axiosPost.mockReset();
    axiosPost.mockResolvedValue({ data: {} });
    socketEmit.mockClear();
    ioFactory.mockClear();
    socketConnect.mockClear();
    socketDisconnect.mockClear();
    socketRemoveAll.mockClear();
    socketHandlers.clear();
    liveSockets.clear();
    lastAuthPayload = undefined;
    createdObjectUrls.length = 0;
    revokedObjectUrls.length = 0;
    objectUrlSeq = 0;
    URL.createObjectURL = ((blob: Blob | MediaSource) => {
      const url = `blob:http://local-test/${++objectUrlSeq}`;
      createdObjectUrls.push(url);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      revokedObjectUrls.push(url);
    }) as typeof URL.revokeObjectURL;
  });

  it("productionAgent / scriptAgent 必须提供可测试的 release/delete，不能只有 create/get", () => {
    expect(typeof (productionAgentModule as { releaseProductionAgentStore?: unknown }).releaseProductionAgentStore).toBe(
      "function",
    );
    expect(typeof (productionAgentModule as { getProductionAgentStoreCount?: unknown }).getProductionAgentStoreCount).toBe(
      "function",
    );
    expect(typeof (scriptAgentModule as { releaseScriptAgentStore?: unknown }).releaseScriptAgentStore).toBe("function");
    expect(typeof (scriptAgentModule as { getScriptAgentStoreCount?: unknown }).getScriptAgentStoreCount).toBe(
      "function",
    );
  });

  it("切换项目后旧 productionAgent / scriptAgent 不得留在 Pinia 与 storeMap", () => {
    const first = activate("101");
    first.production.connect();
    first.script.connect();
    first.production.flowData.storyboard = [
      { prompt: "旧分镜", duration: 4, state: "生成中", src: "blob:http://old/1" } as never,
    ];
    first.script.planData.storySkeleton = "旧大纲应随项目释放";

    const second = activate("202");
    second.production.connect();

    expect(piniaStores(pinia, "productionAgent-")).toEqual(["productionAgent-202"]);
    expect(piniaStores(pinia, "scriptAgent-")).toEqual(["scriptAgent-202"]);
    expect(Object.keys(pinia.state.value).filter((key) => key.startsWith("productionAgent-"))).toEqual([
      "productionAgent-202",
    ]);
    expect(Object.keys(pinia.state.value).filter((key) => key.startsWith("scriptAgent-"))).toEqual([
      "scriptAgent-202",
    ]);
    expect(typeof (productionAgentModule as { hasProductionAgentStore?: (id: string) => boolean }).hasProductionAgentStore).toBe(
      "function",
    );
    expect(
      (productionAgentModule as { hasProductionAgentStore: (id: string) => boolean }).hasProductionAgentStore("101"),
    ).toBe(false);
    expect(
      (scriptAgentModule as { hasScriptAgentStore: (id: string) => boolean }).hasScriptAgentStore("101"),
    ).toBe(false);
  });

  it("disposeProjectRuntime 必须断开 UI Socket、停轮询、清空大对象，且不得 emit stop/cancel", async () => {
    const { production } = activate("101");
    production.connect();
    production.flowData.assets = [{ id: 1, derive: [{ id: 9, state: "生成中", src: "x" }] } as never];
    production.flowData.storyboard = [{ id: 2, state: "生成中", prompt: "p", src: "y" } as never];
    socketEmit.mockClear();

    const disposal = await loadDisposal();
    disposal.disposeProjectRuntime("101", "project-switch");

    expect(socketEmit.mock.calls.some((call) => call[0] === "stop")).toBe(false);
    expect(axiosPost.mock.calls.some((call) => String(call[0]).toLowerCase().includes("cancel"))).toBe(false);
    expect(liveSockets.size).toBe(0);
    expect(piniaStores(pinia, "productionAgent-")).toEqual([]);
  });

  it("连续切换 20 个项目时完整 Store 数始终不超过 1，资源不随切换次数增长", async () => {
    const snapshots: Array<{
      i: number;
      production: number;
      script: number;
      sockets: number;
      imageProjects: number;
    }> = [];
    const cache = imageListCacheStore();
    for (let i = 1; i <= 20; i += 1) {
      const id = String(3000 + i);
      const { production, script } = activate(id);
      production.connect();
      script.connect();
      production.messages = [{ id: "m", role: "assistant", content: [{ type: "text", data: "x".repeat(200) }] } as never];
      cache.setCache(id, 1, 1, [
        { id: i, src: `http://127.0.0.1:10588/files/${id}.png`, sources: "storyboard" } as never,
      ]);
      snapshots.push({
        i,
        production: piniaStores(pinia, "productionAgent-").length,
        script: piniaStores(pinia, "scriptAgent-").length,
        sockets: [...liveSockets].filter((s) => s.connected).length,
        imageProjects: Object.keys(cache.cacheData).length,
      });
    }

    for (const snap of snapshots) {
      expect(snap.production, `第 ${snap.i} 次切换后 production Store`).toBeLessThanOrEqual(1);
      expect(snap.script, `第 ${snap.i} 次切换后 script Store`).toBeLessThanOrEqual(1);
    }
    const last = snapshots[snapshots.length - 1];
    expect(last.production).toBe(1);
    expect(last.script).toBe(1);
    expect(piniaStores(pinia, "productionAgent-")).toEqual(["productionAgent-3020"]);
    expect(piniaStores(pinia, "scriptAgent-")).toEqual(["scriptAgent-3020"]);
    expect(cache.cacheData["3001"]).toBeUndefined();
    expect(Object.keys(cache.cacheData).length).toBeLessThanOrEqual(8);
  });

  it("imageListCache 禁止持久化 data: / blob:，项目释放时删除关联 URL 并 revoke", () => {
    const cache = imageListCacheStore();
    const blobUrl = URL.createObjectURL(new Blob(["x"], { type: "image/png" }));
    cache.setCache("101", 1, 9, [
      { id: 1, src: "data:image/png;base64,AAAA", sources: "storyboard" } as never,
      { id: 2, src: blobUrl, sources: "assets" } as never,
      { id: 3, src: "http://127.0.0.1:10588/files/ok.png", sources: "storyboard" } as never,
    ]);
    const raw = cache.getRawCache("101", 1, 9) ?? [];
    expect(raw.some((item) => String(item.src ?? "").startsWith("data:"))).toBe(false);
    expect(raw.some((item) => String(item.src ?? "").startsWith("blob:"))).toBe(false);
    const persisted = JSON.stringify({ cacheData: cache.cacheData });
    expect(persisted).not.toMatch(/data:/);
    expect(persisted).not.toMatch(/blob:/);

    cache.clearProjectCache("101");
    expect(cache.cacheData["101"]).toBeUndefined();
    expect(cache.urlMap["101:1:storyboard"]).toBeUndefined();
    expect(cache.urlMap["101:2:assets"]).toBeUndefined();
    expect(revokedObjectUrls).toContain(blobUrl);
  });

  it("不同项目出现相同素材 ID 时必须隔离 URL，禁止复用前一项目地址", () => {
    const cache = imageListCacheStore();
    cache.setCache("101", 1, 1, [
      { id: 7, src: "http://127.0.0.1:10588/files/project-101.png", sources: "storyboard" } as never,
    ]);
    cache.setCache("202", 1, 1, [
      { id: 7, src: "http://127.0.0.1:10588/files/project-202.png", sources: "storyboard" } as never,
    ]);

    expect(cache.getCache("101", 1, 1)?.[0]?.src).toContain("project-101.png");
    expect(cache.getCache("202", 1, 1)?.[0]?.src).toContain("project-202.png");

    cache.clearProjectCache("101");
    expect(cache.getCache("202", 1, 1)?.[0]?.src).toContain("project-202.png");
  });

  it("项目释放后旧图片 URL 请求即使晚到也不得重建已清理缓存", async () => {
    const cache = imageListCacheStore();
    cache.setCache("101", 1, 1, [
      { id: 7, src: "/files/old-project.png", sources: "storyboard" } as never,
    ]);
    cache.clearUrlMap();
    let resolveUrlRequest: ((value: { data: { data: Record<string, string> } }) => void) | undefined;
    axiosPost.mockImplementation((url: string) => {
      if (url === "/production/workbench/getFileUrl") {
        return new Promise((resolve) => {
          resolveUrlRequest = resolve;
        });
      }
      return Promise.resolve({ data: {} });
    });

    const pendingRequest = cache.resolveUrls("101", [{ id: 7, sources: "storyboard" }]);
    cache.clearProjectCache("101");
    resolveUrlRequest?.({
      data: { data: { "7:storyboard": "http://127.0.0.1/files/old-project.png" } },
    });
    await pendingRequest;

    expect(cache.cacheData["101"]).toBeUndefined();
    expect(cache.urlMap["101:7:storyboard"]).toBeUndefined();
  });

  it("imageListCache 必须有容量上限或 LRU，不得随项目切换无限增长", () => {
    const cache = imageListCacheStore();
    for (let i = 1; i <= 16; i += 1) {
      cache.setCache(String(i), 1, 1, [
        { id: i, src: `http://127.0.0.1:10588/files/${i}.png`, sources: "storyboard" } as never,
      ]);
    }
    expect(Object.keys(cache.cacheData).length).toBeLessThanOrEqual(8);
  });

  it("再次进入已销毁项目必须新建 Store，不得复活旧实例", async () => {
    const first = activate("101");
    first.production.flowData.script = "旧剧本缓存";
    const firstIdentity = first.production;
    const disposal = await loadDisposal();
    disposal.disposeProjectRuntime("101", "project-switch");
    const second = activate("101");
    expect(second.production).not.toBe(firstIdentity);
    expect(second.production.flowData.script).toBe("");
  });

  it("video store 在项目释放时停止轮询并清空当前项目大对象", async () => {
    activate("101");
    const video = videoStore();
    video.videoConfigs = [
      {
        id: 1,
        scriptId: 1,
        projectId: 101,
        model: "m",
        aiConfigId: 1,
        manufacturer: "x",
        mode: "text",
        startFrame: null,
        endFrame: null,
        images: [],
        resolution: "720p",
        duration: 4,
        prompt: "p",
        selectedResultId: null,
        createdAt: "",
        audioEnabled: false,
      },
    ];
    video.videoResults = [
      {
        id: 9,
        configId: 1,
        state: 0,
        filePath: "",
        firstFrame: "",
        duration: 4,
        prompt: "p",
        createdAt: "",
      },
    ];
    const disposal = await loadDisposal();
    disposal.disposeProjectRuntime("101", "project-switch");
    expect(video.videoConfigs).toEqual([]);
    expect(video.videoResults).toEqual([]);
  });

  it("项目释放后旧视频请求即使晚到也不得回灌已销毁的 Store", async () => {
    activate("101");
    const video = videoStore();
    let resolveVideoRequest: ((value: { data: unknown[] }) => void) | undefined;
    axiosPost.mockImplementation((url: string) => {
      if (url === "/video/getVideo") {
        return new Promise((resolve) => {
          resolveVideoRequest = resolve;
        });
      }
      return Promise.resolve({ data: [] });
    });

    const pendingRequest = video.fetchVideoData(1);
    const disposal = await loadDisposal();
    disposal.disposeProjectRuntime("101", "project-switch");
    resolveVideoRequest?.({
      data: [
        {
          id: 9,
          configId: 1,
          state: 1,
          filePath: "/old-project/video.mp4",
        },
      ],
    });
    await pendingRequest;

    expect(video.videoResults).toEqual([]);
  });

  it("供应商测试上传框必须在替换与卸载时 revokeObjectURL", () => {
    const webRoot = path.join(process.cwd(), "src");
    const files = [
      "components/setting/components/vendorTest/ImageUploadBox.vue",
      "components/setting/components/vendorTest/VideoUploadBox.vue",
      "components/setting/components/vendorTest/ImageModelTest.vue",
    ];
    for (const relative of files) {
      const source = readFileSync(path.join(webRoot, relative), "utf8");
      expect(source.includes("revokeObjectURL"), `${relative} 必须 revokeObjectURL`).toBe(true);
      expect(
        /onBeforeUnmount|onUnmounted/.test(source),
        `${relative} 必须在卸载时释放 object URL`,
      ).toBe(true);
    }
  });
});

afterAll(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});
