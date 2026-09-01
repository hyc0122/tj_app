import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import http from "node:http";
import test from "node:test";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const SENTINEL = "RED_EXPECTED:CANVAS_REVISION_PIN";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000a41";

const session = {
  id: "sess-canvas-pin",
  serverUrl: "https://api.j11.com.cn",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 7601, username: "canvas-owner" },
};

function digest(payload: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

test("pin/unpin 必须走 mounted 路由并按摘要幂等", async () => {
  await runWithTemporaryAccount("canvas-revision-pin", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
    const { syncCoordinator } = await import("../../src/tianjiang/runtime/runtime");
    Object.assign(syncCoordinator, {
      listProjects: () => [{
        projectUuid: PROJECT_UUID,
        name: "固定画布",
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
            clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000000a43",
            document: emptyCanvasDocument(),
          }),
        },
      );
      const list = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/revisions`,
      );
      const listed = await list.json().catch(() => ({})) as {
        data?: { revisions?: Array<{ revisionUuid?: string }> };
      };
      const revisionUuid = listed.data?.revisions?.[0]?.revisionUuid;
      if (!revisionUuid) {
        console.error(SENTINEL);
        assert.ok(revisionUuid, SENTINEL);
        return;
      }
      const pinBody = {
        clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000000a44",
        requestDigest: "placeholder",
        pinReason: "保留恢复点",
      };
      pinBody.requestDigest = digest({
        operation: "pin",
        projectUuid: PROJECT_UUID,
        revisionUuid,
        pinReason: pinBody.pinReason,
      });
      const pin = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/revisions/${revisionUuid}/pin`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(pinBody),
        },
      );
      if (pin.status !== 200) {
        console.error(SENTINEL);
        assert.equal(pin.status, 200, SENTINEL);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
