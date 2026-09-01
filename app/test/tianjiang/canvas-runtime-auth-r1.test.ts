import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import test from "node:test";

import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const SENTINEL = "RED_EXPECTED:CANVAS_RUNTIME_AUTH";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000a01";
const OTHER_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000a02";

const session = {
  id: "sess-canvas-auth",
  serverUrl: "https://api.j11.com.cn",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 7601, username: "canvas-owner" },
};

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port };
}

test("未打开项目不能读取画布文档，跨项目路径不得泄露存在性", async () => {
  await runWithTemporaryAccount("canvas-runtime-auth", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { centralSession?: unknown }).centralSession = session;
      next();
    });
    app.use("/api/tianjiang/runtime", runtimeRouter);
    const { server, port } = await listen(app);
    try {
      const closed = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`,
      );
      const closedBody = await closed.json().catch(() => ({}));
      if (closed.status !== 403 || (closedBody as { errorCode?: string }).errorCode !== "PERMISSION_DENIED") {
        console.error(SENTINEL);
        assert.equal(closed.status, 403, SENTINEL);
        assert.equal((closedBody as { errorCode?: string }).errorCode, "PERMISSION_DENIED", SENTINEL);
      }
      const cross = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${OTHER_UUID}/canvas/document`,
      );
      const crossBody = await cross.json().catch(() => ({}));
      if (cross.status !== closed.status || (crossBody as { errorCode?: string }).errorCode !== "PERMISSION_DENIED") {
        console.error(SENTINEL);
        assert.equal(cross.status, closed.status, SENTINEL);
        assert.equal((crossBody as { errorCode?: string }).errorCode, "PERMISSION_DENIED", SENTINEL);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
