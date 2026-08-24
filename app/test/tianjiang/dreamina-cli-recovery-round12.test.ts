/**
 * Task 10 RED：outcome_unknown 必须占槽，崩溃后不得盲目补发。
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";

import { enterUserStorage } from "../../src/tianjiang/runtime/user-storage-context";

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

test("生产恢复入口必须能对账未知结果，且强制终结需要二次确认", async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    enterUserStorage({ issuer: "https://api.j11.com.cn", userId: 9102 });
    next();
  });
  for (const name of ["reconcileUnknown", "resolveUnknown", "getState"] as const) {
    try {
      const loaded = await import(`../../src/routes/task/dreaminaQueue/${name}.ts`);
      app.use(`/api/task/dreaminaQueue/${name}`, loaded.default);
    } catch {
      // GREEN 前未挂载。
    }
  }
  const { server, port } = await listen(app);
  try {
    const state = await fetch(`http://127.0.0.1:${port}/api/task/dreaminaQueue/getState`);
    assert.notEqual(state.status, 404, "队列状态路由必须存在");

    const forced = await fetch(`http://127.0.0.1:${port}/api/task/dreaminaQueue/resolveUnknown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskUuid: "11111111-1111-4111-a111-111111111111", confirm: false }),
    });
    assert.notEqual(forced.status, 404, "强制终结路由必须存在");
    assert.notEqual(forced.status, 200);

    const recovery = await import("../../src/tianjiang/model-providers/dreamina-cli/recovery");
    assert.equal(typeof recovery.recoverDreaminaSlots, "function");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
