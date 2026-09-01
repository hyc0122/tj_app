/**
 * RED→GREEN：切换项目是任务交接给后端，不是取消任务，也不是用旧 Store 等待。
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia, type Pinia } from "pinia";

vi.stubGlobal("$t", (key: string) => key);
vi.stubGlobal(
  "window",
  Object.assign(globalThis, {
    $message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  }),
);

const axiosPost = vi.fn(async (url: string, body?: Record<string, unknown>) => {
  if (String(url).includes("getFlowData")) {
    return {
      data: {
        script: "from-db",
        scriptPlan: "",
        storyboardTable: "",
        assets: [],
        storyboard: [],
        workbench: { videoList: [] },
      },
    };
  }
  if (String(url).includes("getMemory")) {
    return { data: [] };
  }
  if (String(url).includes("pollingImage") || String(url).includes("generate")) {
    return { data: [] };
  }
  return { data: body ?? {} };
});

vi.mock("@/utils/axios", () => ({
  default: {
    post: (...args: unknown[]) => axiosPost(...(args as [string, Record<string, unknown>?])),
    get: vi.fn(),
    patch: vi.fn(),
  },
}));

const liveSockets = new Set<{ connected: boolean }>();
const socketEmit = vi.fn();
const socketConnect = vi.fn();
const socketDisconnect = vi.fn();
const socketOn = vi.fn();
const socketOnce = vi.fn();
const socketOff = vi.fn();
const socketRemoveAll = vi.fn();

const ioFactory = vi.fn(() => {
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
  io: (...args: unknown[]) => ioFactory(...(args as never[])),
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

function piniaStores(pinia: Pinia, prefix: string): string[] {
  const registry = (pinia as unknown as { _s?: Map<string, unknown> })._s;
  if (!registry) return [];
  return [...registry.keys()].filter((key) => String(key).startsWith(prefix));
}

function projectOf(id: string): Project {
  return {
    id,
    name: `handoff-${id}`,
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
    projectUuid: id === "501" ? "55555555-5555-4555-8555-555555555501" : "55555555-5555-4555-8555-555555555502",
  };
}

function openProject(id: string) {
  projectStore().activateProject(projectOf(id), {
    mode: "readwrite",
    reason: "owner_lock",
    lockHolder: "",
  });
  return useProductionAgentStore();
}

describe("项目切换任务交接", () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    axiosPost.mockClear();
    socketEmit.mockClear();
    ioFactory.mockClear();
    liveSockets.clear();
    vi.useRealTimers();
  });

  it("项目A有两个运行任务时切到B：A的前端运行态立即释放，且不取消/不重提", async () => {
    const agentA = openProject("501");
    agentA.connect();
    agentA.flowData.assets = [
      {
        id: 1,
        derive: [
          { id: 11, state: "生成中", src: "" },
          { id: 12, state: "生成中", src: "" },
        ],
      } as never,
    ];
    agentA.flowData.storyboard = [
      { id: 21, state: "生成中", prompt: "shot-a", src: null },
      { id: 22, state: "生成中", prompt: "shot-b", src: null },
    ] as never;
    axiosPost.mockClear();
    socketEmit.mockClear();

    const agentB = openProject("502");
    agentB.connect();
    useScriptAgentStore();

    expect(piniaStores(pinia, "productionAgent-")).toEqual(["productionAgent-502"]);
    expect(piniaStores(pinia, "scriptAgent-")).toEqual(["scriptAgent-502"]);
    expect(
      (productionAgentModule as { hasProductionAgentStore?: (id: string) => boolean }).hasProductionAgentStore?.("501"),
    ).toBe(false);
    expect(socketEmit.mock.calls.some((call) => call[0] === "stop")).toBe(false);
    const posted = axiosPost.mock.calls.map((call) => String(call[0]));
    expect(posted.some((url) => /cancel|stopGenerate|stop-generate/i.test(url))).toBe(false);
    expect(posted.some((url) => /batchGenerate|generateVideo|generateImage/i.test(url))).toBe(false);
  });

  it("任务运行中重新进入A必须从接口重建，不复活旧 Store，不重复提交", async () => {
    const first = openProject("501");
    first.flowData.script = "stale-in-memory";
    const firstRef = first;
    openProject("502");
    axiosPost.mockClear();
    const revived = openProject("501");
    revived.episodesId = 1;
    await revived.getFlowData();
    expect(revived).not.toBe(firstRef);
    expect(revived.flowData.script).toBe("from-db");
    const posted = axiosPost.mock.calls.map((call) => String(call[0]));
    expect(posted.some((url) => String(url).includes("getFlowData"))).toBe(true);
    expect(posted.some((url) => /batchGenerate|generateVideo/i.test(url))).toBe(false);
    expect(socketEmit.mock.calls.some((call) => call[0] === "stop")).toBe(false);
  });

  it("temporary_failure 重试期间也不得保留旧项目完整 Store", () => {
    const agentA = openProject("501");
    agentA.flowData.storyboard = [{ id: 3, state: "生成中", prompt: "retry", src: null } as never];
    openProject("502");
    expect(piniaStores(pinia, "productionAgent-")).not.toContain("productionAgent-501");
    expect(piniaStores(pinia, "productionAgent-").length).toBe(1);
  });

  it("离开工作区 clearActiveProject 也必须释放前端运行态，而不是只清当前项目指针", () => {
    const agent = openProject("501");
    agent.connect();
    projectStore().clearActiveProject();
    expect(projectStore().project).toBeNull();
    expect(piniaStores(pinia, "productionAgent-")).toEqual([]);
    expect(liveSockets.size).toBe(0);
  });
});
