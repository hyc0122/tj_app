import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import runCode from "../../src/utils/vm";

test("动态 vendor 创建返回 remoteTaskId 后必须在首次轮询前触发持久化钩子", async () => {
  const events: string[] = [];
  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      events.push("remote-create");
      return response.end(JSON.stringify({ data: { task_id: "remote-bridge-1" } }));
    }
    events.push("remote-poll");
    response.end(JSON.stringify({ status: "completed", output: "https://media.invalid/result.png" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const code = `
    exports.vendor = { id: "synthetic", inputValues: { baseUrl: "http://127.0.0.1:${address.port}" } };
    exports.imageRequest = async () => {
      const created = await fetch(exports.vendor.inputValues.baseUrl + "/tasks", { method: "POST" });
      const payload = await created.json();
      const taskId = payload.data.task_id;
      const status = await fetch(exports.vendor.inputValues.baseUrl + "/tasks/" + taskId);
      return (await status.json()).output;
    };
  `;
  try {
    const running = (runCode as any)(code, undefined, {
      provider: "synthetic",
      onRemoteTaskCreated: async (remoteTaskId: string) => {
        events.push(`persist-${remoteTaskId}`);
      },
    });
    await running.imageRequest({});
    assert.deepEqual(events, [
      "remote-create",
      "persist-remote-bridge-1",
      "remote-poll",
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
