import assert from "node:assert/strict";
import test from "node:test";

import { installSystemSessionEndHandlers } from "../../scripts/system-session-end";

test("Windows 关机查询先阻止销毁并进入同一退出门", async () => {
  const listeners = new Map<string, (...args: any[]) => void>();
  const events: string[] = [];
  installSystemSessionEndHandlers({
    platform: "win32",
    window: {
      on(event, listener) { listeners.set(event, listener); },
    },
    requestShutdown: async () => { events.push("shutdown"); },
  });
  const queryEvent = {
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
  listeners.get("query-session-end")?.(queryEvent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queryEvent.prevented, true);
  assert.deepEqual(events, ["shutdown"]);

  listeners.get("session-end")?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["shutdown", "shutdown"]);
});

test("非 Windows 平台不登记 Windows 会话结束事件", () => {
  const listeners: string[] = [];
  installSystemSessionEndHandlers({
    platform: "darwin",
    window: {
      on(event) { listeners.push(event); },
    },
    requestShutdown: async () => undefined,
  });
  assert.deepEqual(listeners, []);
});
