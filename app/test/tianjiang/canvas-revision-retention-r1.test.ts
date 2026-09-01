import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import test from "node:test";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const SENTINEL = "RED_EXPECTED:CANVAS_REVISION_RETENTION";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000a31";

const session = {
  id: "sess-canvas-retention",
  serverUrl: "https://api.j11.com.cn",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 7601, username: "canvas-owner" },
};

test("文档保存后必须留下可列出的 revision 快照", async () => {
  await runWithTemporaryAccount("canvas-revision-retention", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
    const { syncCoordinator } = await import("../../src/tianjiang/runtime/runtime");
    Object.assign(syncCoordinator, {
      listProjects: () => [{
        projectUuid: PROJECT_UUID,
        name: "历史画布",
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
      }],
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
    try {
      await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseRevision: 0,
            clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000000a33",
            document: emptyCanvasDocument(),
          }),
        },
      );
      const list = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/revisions`,
      );
      const body = await list.json().catch(() => ({})) as { data?: { revisions?: unknown[] } };
      if (list.status !== 200 || !Array.isArray(body.data?.revisions) || body.data.revisions.length < 1) {
        console.error(SENTINEL);
        assert.equal(list.status, 200, SENTINEL);
        assert.ok(Array.isArray(body.data?.revisions) && body.data.revisions.length >= 1, SENTINEL);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
