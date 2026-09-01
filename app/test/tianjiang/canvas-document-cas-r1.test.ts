import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import http from "node:http";
import test from "node:test";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const SENTINEL = "RED_EXPECTED:CANVAS_DOCUMENT_CAS";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000a11";
const MUTATION_ID = "018f3d6e-2d9e-7b6c-8a9b-000000000a12";

const session = {
  id: "sess-canvas-cas",
  serverUrl: "https://api.j11.com.cn",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 7601, username: "canvas-owner" },
};

function catalogItem() {
  return {
    projectUuid: PROJECT_UUID,
    name: "CAS 画布",
    kind: "personal",
    ownerUserId: 7601,
    role: "owner",
    myRole: "owner",
    currentVersion: 0,
    syncState: "local_only",
    lastSyncedAt: null,
    updatedAt: new Date().toISOString(),
    lockStatus: "none",
    lockHolderName: "",
    openMode: "editable",
    businessType: "canvas",
  };
}

test("打开的个人画布文档 PUT 以 revision CAS 提交且幂等回放", async () => {
  await runWithTemporaryAccount("canvas-document-cas", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
    const { syncCoordinator } = await import("../../src/tianjiang/runtime/runtime");
    Object.assign(syncCoordinator, {
      listProjects: () => [catalogItem()],
      isProjectOpened: (uuid: string) => uuid === PROJECT_UUID,
    });
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use((req, _res, next) => {
      (req as { centralSession?: unknown }).centralSession = session;
      next();
    });
    app.use("/api/tianjiang/runtime", runtimeRouter);
    const server = await new Promise<http.Server>((resolve) => {
      const created = app.listen(0, "127.0.0.1", () => resolve(created));
    });
    const port = (server.address() as { port: number }).port;
    const document = emptyCanvasDocument();
    document.graph.nodes = [{
      nodeUuid: crypto.randomUUID(),
      kind: "text",
      position: { x: 10, y: 10 },
      zIndex: 1,
      collapsed: false,
      data: { title: "节点" },
    }];
    try {
      const put = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseRevision: 0,
            clientMutationId: MUTATION_ID,
            document,
          }),
        },
      );
      const body = await put.json().catch(() => ({}));
      if (put.status !== 200 || Number((body as { data?: { revision?: number } }).data?.revision) !== 1) {
        console.error(SENTINEL);
        assert.equal(put.status, 200, SENTINEL);
        assert.equal((body as { data?: { revision?: number } }).data?.revision, 1, SENTINEL);
      }
      const replay = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseRevision: 0,
            clientMutationId: MUTATION_ID,
            document,
          }),
        },
      );
      const replayBody = await replay.json().catch(() => ({}));
      if (replay.status !== 200 || Number((replayBody as { data?: { revision?: number } }).data?.revision) !== 1) {
        console.error(SENTINEL);
        assert.equal(replay.status, 200, SENTINEL);
        assert.equal((replayBody as { data?: { revision?: number } }).data?.revision, 1, SENTINEL);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
