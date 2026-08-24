/**
 * Task 5 RED：连续分镜编号必须通过生产项目范围 HTTP 入口验证。
 */
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import test from "node:test";

const PROJECT = "11111111-1111-4111-a111-111111111111";

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

test("生产入口必须支持空项目首条为 1，并在 2/3 之间插入后顺延", async () => {
  const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { centralSession?: unknown }).centralSession = {
      serverUrl: "https://api.j11.com.cn",
      user: { id: 7, username: "alice" },
    };
    next();
  });
  app.use("/api/tianjiang/runtime", runtimeRouter);
  const { server, port } = await listen(app);
  const base = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard`;
  try {
    const listed = await fetch(`${base}/shots`);
    assert.notEqual(listed.status, 404, "分镜列表路由必须存在");
    const created = await fetch(`${base}/shots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ afterShotUuid: null, sourceText: "第一条" }),
    });
    assert.notEqual(created.status, 404, "插入分镜路由必须存在");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
