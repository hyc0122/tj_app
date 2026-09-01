import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import http from "node:http";
import test from "node:test";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const SENTINEL = "RED_EXPECTED:CANVAS_REVISION_IMPORT";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000a21";
const MUTATION_ID = "018f3d6e-2d9e-7b6c-8a9b-000000000a22";

const session = {
  id: "sess-canvas-import",
  serverUrl: "https://api.j11.com.cn",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 7601, username: "canvas-owner" },
};

test("JSON 导入必须重映射 UUID 并与文档 revision 同事务", async () => {
  await runWithTemporaryAccount("canvas-revision-import", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
    const { syncCoordinator } = await import("../../src/tianjiang/runtime/runtime");
    Object.assign(syncCoordinator, {
      listProjects: () => [{
        projectUuid: PROJECT_UUID,
        name: "导入画布",
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
    const sourceNode = crypto.randomUUID();
    const document = emptyCanvasDocument();
    document.graph.nodes = [{
      nodeUuid: sourceNode,
      kind: "text",
      position: { x: 1, y: 2 },
      zIndex: 1,
      collapsed: false,
      data: { title: "导入文本", runUuid: "should-strip" },
    }];
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/imports/json`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseRevision: 0,
            clientMutationId: MUTATION_ID,
            document,
          }),
        },
      );
      const body = await response.json().catch(() => ({})) as {
        data?: { revision?: number; document?: { graph?: { nodes?: Array<{ nodeUuid?: string; data?: Record<string, unknown> }> } } };
      };
      const imported = body.data?.document?.graph?.nodes?.[0];
      if (response.status !== 200 || body.data?.revision !== 1 || imported?.nodeUuid === sourceNode || imported?.data?.runUuid) {
        console.error(SENTINEL);
        assert.equal(response.status, 200, SENTINEL);
        assert.equal(body.data?.revision, 1, SENTINEL);
        assert.notEqual(imported?.nodeUuid, sourceNode, SENTINEL);
        assert.equal(imported?.data?.runUuid, undefined, SENTINEL);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
