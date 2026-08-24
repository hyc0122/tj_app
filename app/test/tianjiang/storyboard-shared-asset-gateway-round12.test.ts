/**
 * Task 4 RED：共享资产必须走生产 Express 项目范围路由和双授权网关。
 */
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import test from "node:test";

const CONSUMER = "11111111-1111-4111-a111-111111111111";
const SOURCE = "22222222-2222-4222-a222-222222222222";

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port };
}

test("生产运行时必须提供分镜项目范围的共享资产读写入口", async () => {
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
  try {
    const listed = await fetch(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${CONSUMER}/storyboard/assets`,
    );
    assert.notEqual(listed.status, 404, "共享资产列表路由必须存在");
    assert.ok([200, 400, 403].includes(listed.status), `列表状态异常: ${listed.status}`);
    const body = await listed.json() as { data?: { assets?: unknown[] }; message?: string };
    if (listed.status === 200) {
      assert.ok(Array.isArray(body.data?.assets));
    } else {
      assert.ok(String(body.message ?? "").length > 0);
    }

    const written = await fetch(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${CONSUMER}/storyboard/assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "新角色", describe: "更新后的描述" }),
      },
    );
    assert.notEqual(written.status, 404);
    assert.ok([200, 403, 404, 409].includes(written.status));

    const deleted = await fetch(
      `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${CONSUMER}/storyboard/assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      { method: "DELETE" },
    );
    assert.notEqual(deleted.status, 404);
    void SOURCE;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
