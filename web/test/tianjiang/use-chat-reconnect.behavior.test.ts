/**
 * useChat 延迟 reconnect 定时器生命周期（fake timers + 可控 io mock）
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const socketConnect = vi.fn();
const socketDisconnect = vi.fn();
const socketOn = vi.fn();
const socketOnce = vi.fn();
const socketOff = vi.fn();
const socketEmit = vi.fn();
const socketRemoveAll = vi.fn();

const ioFactory = vi.fn(() => {
  const sock = {
    connected: false,
    connect: socketConnect,
    disconnect: socketDisconnect,
    on: socketOn,
    once: socketOnce,
    off: socketOff,
    emit: socketEmit,
    removeAllListeners: socketRemoveAll,
  };
  // connect() 会把 connected 置 true 的模拟留给业务层自己维护；此处只计数
  socketConnect.mockImplementation(() => {
    sock.connected = true;
  });
  socketDisconnect.mockImplementation(() => {
    sock.connected = false;
  });
  return sock;
});

vi.mock("socket.io-client", () => ({
  io: (...args: unknown[]) => ioFactory(...args),
}));

// mock 之后再导入 useChat
const { useChat } = await import("@/utils/useChat");

describe("useChat reconnect 定时器不得逃逸 disconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ioFactory.mockClear();
    socketConnect.mockClear();
    socketDisconnect.mockClear();
    socketOn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnect 后立即 disconnect，推进定时器不得再次 connect", () => {
    const chat = useChat({
      url: "http://127.0.0.1:10588/api/socket/scriptAgent",
      autoConnect: false,
      manageLifecycle: false,
    });
    chat.connect();
    expect(ioFactory).toHaveBeenCalledTimes(1);
    const connectsAfterCreate = socketConnect.mock.calls.length;

    chat.reconnect();
    // 用户立刻离开页面
    chat.disconnect();
    vi.advanceTimersByTime(200);

    // disconnect 必须取消待执行 reconnect，不得再触发 socket.connect
    expect(socketConnect.mock.calls.length).toBe(connectsAfterCreate);
  });

  it("连续多次 reconnect 最多保留一个待执行定时器，推进后只连接一次", () => {
    const chat = useChat({
      url: "http://127.0.0.1:10588/api/socket/scriptAgent",
      autoConnect: false,
      manageLifecycle: false,
    });
    chat.connect();
    const before = socketConnect.mock.calls.length;

    chat.reconnect();
    chat.reconnect();
    chat.reconnect();
    vi.advanceTimersByTime(200);

    // 三次 reconnect 合并为一个延迟 connect
    expect(socketConnect.mock.calls.length - before).toBe(1);
  });

  it("正常 reconnect → advanceTimers 只额外连接一次", () => {
    const chat = useChat({
      url: "http://127.0.0.1:10588/api/socket/scriptAgent",
      autoConnect: false,
      manageLifecycle: false,
    });
    chat.connect();
    const before = socketConnect.mock.calls.length;

    chat.reconnect();
    vi.advanceTimersByTime(100);

    expect(socketConnect.mock.calls.length - before).toBe(1);
    expect(socketDisconnect).toHaveBeenCalled();
  });

  it("页面卸载 disconnect 后推进定时器不触发 onError", () => {
    const onError = vi.fn();
    const chat = useChat({
      url: "http://127.0.0.1:10588/api/socket/scriptAgent",
      autoConnect: false,
      manageLifecycle: false,
      onError,
    });
    chat.connect();
    chat.reconnect();
    chat.disconnect();
    vi.advanceTimersByTime(500);
    expect(onError).not.toHaveBeenCalled();
  });
});
