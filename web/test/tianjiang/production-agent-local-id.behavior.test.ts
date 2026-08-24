/**
 * RED→GREEN：Production Agent 本地 projectId 必须为 JSON number。
 * 走真实 store 请求构造 + axios mock 捕获 body/auth，不得只做源码正则。
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

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
  },
}));

const socketEmit = vi.fn();
const socketConnect = vi.fn();
const socketDisconnect = vi.fn();
const socketHandlers = new Map<string, (...args: any[]) => unknown>();
const socketOn = vi.fn((event: string, handler: (...args: any[]) => unknown) => {
  socketHandlers.set(event, handler);
});
const socketOnce = vi.fn();
const socketOff = vi.fn();
const socketRemoveAll = vi.fn();
/** useChat 在 io() 时已把 auth 函数求值为普通对象 */
let lastAuthPayload: Record<string, unknown> | undefined;

const ioFactory = vi.fn((_url: string, opts?: { auth?: Record<string, unknown> }) => {
  lastAuthPayload = opts?.auth ? { ...opts.auth } : undefined;
  return {
    connected: false,
    connect: socketConnect.mockImplementation(function (this: { connected: boolean }) {
      this.connected = true;
    }),
    disconnect: socketDisconnect.mockImplementation(function (this: { connected: boolean }) {
      this.connected = false;
    }),
    on: socketOn,
    once: socketOnce,
    off: socketOff,
    emit: socketEmit,
    removeAllListeners: socketRemoveAll,
  };
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
import useProductionAgentStore, {
  shouldPersistProductionXmlTag,
} from "@/stores/productionAgent";
import { LocalProjectIdError, toLocalProjectId } from "@/features/tianjiang/project/local-project-id";

const baseProject = (): Project => ({
  id: "101",
  name: "生产 ID 契约",
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
  projectUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
});

function activate(id = "101") {
  const store = projectStore();
  store.activateProject(
    { ...baseProject(), id },
    { mode: "readwrite", reason: "owner_lock", lockHolder: "" },
  );
  return useProductionAgentStore();
}

describe("Production Agent：Project.id 字符串经边界后为 number", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosPost.mockClear();
    axiosPost.mockResolvedValue({ data: {} });
    socketEmit.mockClear();
    ioFactory.mockClear();
    socketHandlers.clear();
    lastAuthPayload = undefined;
  });

  it("setFlowData / getFlowData / batchGenerate / getMemory body.projectId 均为 number 101", async () => {
    const agent = activate("101");
    agent.episodesId = 7;
    // getFlowData 返回完整结构，避免 store 内 computed 崩溃
    axiosPost.mockImplementation(async (url: string) => {
      if (String(url).includes("getFlowData")) {
        return {
          data: {
            script: "",
            scriptPlan: "",
            storyboardTable: "",
            assets: [],
            storyboard: [],
            workbench: { videoList: [] },
          },
        };
      }
      if (String(url).includes("getMemory")) return { data: [] };
      if (String(url).includes("batchGenerateImage")) return { data: [] };
      return { data: {} };
    });

    await agent.setFlowData(7);
    await agent.getFlowData();
    await agent.batchGenerateStoryboard([1, 2], false);
    await agent.getHistory();

    const posts = axiosPost.mock.calls.map(([url, body]) => ({
      url: String(url),
      body: body as Record<string, unknown>,
    }));
    const byUrl = (part: string) => posts.filter((p) => p.url.includes(part));

    expect(byUrl("saveFlowData").length).toBeGreaterThan(0);
    expect(byUrl("getFlowData").length).toBeGreaterThan(0);
    expect(byUrl("batchGenerateImage").length).toBeGreaterThan(0);
    expect(byUrl("getMemory").length).toBeGreaterThan(0);

    for (const p of posts) {
      if (p.body && "projectId" in p.body) {
        expect(p.body.projectId, p.url).toBe(101);
        expect(typeof p.body.projectId, p.url).toBe("number");
      }
    }
  });

  it("Socket auth 与 updateContext 发送 number projectId/scriptId", () => {
    vi.useFakeTimers();
    try {
      const agent = activate("101");
      agent.episodesId = 9;
      // reconnect 延迟 100ms 后 connect，io 时求值 auth
      agent.reconnect();
      vi.advanceTimersByTime(100);
      expect(lastAuthPayload).toBeTruthy();
      expect(lastAuthPayload!.projectId).toBe(101);
      expect(typeof lastAuthPayload!.projectId).toBe("number");
      expect(lastAuthPayload!.scriptId).toBe(9);

      // 已连接时 updateContext 直接 emit
      agent.updateContext();
      const updateCall = socketEmit.mock.calls.find((c) => c[0] === "updateContext");
      expect(updateCall).toBeTruthy();
      const ctx = updateCall![1] as { projectId: unknown; scriptId: unknown };
      expect(ctx.projectId).toBe(101);
      expect(typeof ctx.projectId).toBe("number");
      expect(ctx.scriptId).toBe(9);
      expect(typeof ctx.scriptId).toBe("number");
    } finally {
      vi.useRealTimers();
    }
  });

  it("非法 projectId 在构造 Socket auth 时失败关闭", () => {
    vi.useFakeTimers();
    try {
      const store = projectStore();
      store.activateProject(
        { ...baseProject(), id: "0" },
        { mode: "readwrite", reason: "owner_lock", lockHolder: "" },
      );
      const agent = useProductionAgentStore();
      agent.reconnect();
      expect(() => vi.advanceTimersByTime(100)).toThrow(LocalProjectIdError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scriptPlan 完整 XML 仅作预览，其他既有阶段仍按原逻辑保存", () => {
    expect(shouldPersistProductionXmlTag("scriptPlan", "complete")).toBe(false);
    expect(shouldPersistProductionXmlTag("scriptPlan", "pending")).toBe(false);
    expect(shouldPersistProductionXmlTag("storyboardTable", "complete")).toBe(true);
  });

  it("artifactCommitted 后从后端刷新导演规划，不把预览反向保存", async () => {
    const agent = activate("101");
    agent.episodesId = 7;
    const authoritative = {
      script: "剧本",
      scriptPlan: "后端权威导演规划",
      storyboardTable: "",
      assets: [],
      storyboard: [],
      workbench: { videoList: [] },
    };
    axiosPost.mockImplementation(async (url: string) => {
      if (String(url).includes("getFlowData")) return { data: authoritative };
      return { data: {} };
    });

    agent.connect();
    await Promise.resolve();
    const handler = socketHandlers.get("artifactCommitted");
    expect(handler).toBeTypeOf("function");
    axiosPost.mockClear();

    await handler?.({
      stage: "directorPlan",
      projectId: 101,
      episodesId: 7,
    });

    const urls = axiosPost.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.includes("getFlowData"))).toHaveLength(1);
    expect(urls.some((url) => url.includes("saveFlowData"))).toBe(false);
    expect(agent.flowData.scriptPlan).toBe("后端权威导演规划");
  });
});

describe("任务中心 / 中央 UUID 不得被错误转换", () => {
  it("projectUuid 字符串不是 toLocalProjectId 合法输入", () => {
    expect(() => toLocalProjectId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toThrow(LocalProjectIdError);
  });
});
