/**
 * Production Agent 导演规划真实回归：完整 XML 后再次提到标签名时，
 * 必须保留完整闭合产物，禁止把尾部完成摘要当成 scriptPlan。
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type SocketHandler = (...args: any[]) => void;
const handlers = new Map<string, SocketHandler[]>();

const fakeSocket = {
  connected: false,
  connect: vi.fn(() => {
    fakeSocket.connected = true;
  }),
  disconnect: vi.fn(() => {
    fakeSocket.connected = false;
  }),
  on: vi.fn((event: string, handler: SocketHandler) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
    return fakeSocket;
  }),
  once: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  removeAllListeners: vi.fn(),
};

vi.mock("socket.io-client", () => ({
  io: () => fakeSocket,
}));

const { useChat } = await import("@/utils/useChat");

function receive(event: string, payload: unknown) {
  for (const handler of handlers.get(event) ?? []) handler(payload);
}

describe("Production Agent 导演规划 XML 输出契约", () => {
  beforeEach(() => {
    handlers.clear();
    fakeSocket.connected = false;
    vi.clearAllMocks();
  });

  it("完整 scriptPlan 后出现未闭合标签文字时不得被尾部摘要覆盖", () => {
    const received: Array<{ value: string; status: string }> = [];
    const chat = useChat({
      url: "http://127.0.0.1:10588/api/socket/productionAgent",
      autoConnect: false,
      manageLifecycle: false,
      xmlTags: [{ tag: "scriptPlan", keepInMessage: false }],
      onXmlTag: ({ value, status }) => received.push({ value, status }),
    });
    chat.connect();

    const completePlan = [
      "# 分场汇总表",
      "| 场次 | 场景 | 人物 | 情绪基调 | 核心事件 |",
      "| 1-1 | 陆家厨房 | 沈云禾、小满 | 温暖转压抑 | 生日汤被倒 |",
      "## 逐场注意事项",
      "保持剧本事实，不新增人物。",
    ].join("\n");
    const raw = [
      "## 第 3 步 · 一次性写出 `<scriptPlan>`",
      `<scriptPlan>${completePlan}</scriptPlan>`,
      "## 第 5 步 · 结束",
      "导演规划 `<scriptPlan>` 已完成，三场内容可交付下游。",
    ].join("\n\n");

    receive("message", {
      id: "director-plan-1",
      role: "assistant",
      name: "执行导演",
      status: "complete",
      datetime: new Date(0).toISOString(),
      content: [
        {
          id: "text-1",
          type: "text",
          status: "complete",
          data: raw,
        },
      ],
    });

    expect(received.at(-1)).toEqual({
      value: completePlan,
      status: "complete",
    });
    expect(received.at(-1)?.value).not.toContain("已完成，三场内容可交付下游");
  });
});
