import assert from "node:assert/strict";
import test from "node:test";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:CANVAS_EXECUTION_CANCEL";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000001061";
const NODE_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000001062";
const ACTION_ID = "018f3d6e-2d9e-7b6c-8a9b-000000001063";
const DIGEST = "a".repeat(64);

test("origin 可取消 waiting_for_origin_device，非 origin 403 且同 ID 异摘要 409", async () => {
  await runWithTemporaryAccount("canvas-execution-cancel", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const document = emptyCanvasDocument();
      document.graph.nodes = [{
        nodeUuid: NODE_UUID,
        kind: "image_generation",
        position: { x: 4, y: 4 },
        zIndex: 1,
        collapsed: false,
        data: { title: "出图", prompt: "取消" },
      }];
      await fetch(`http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: 0,
          clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000001064",
          document,
        }),
      });
      const preview = await (await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseRevision: 1, nodeUuids: [NODE_UUID] }),
        },
      )).json() as { data?: { confirmationUuid?: string; requestDigest?: string } };
      const confirmed = await (await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirmationUuid: preview.data?.confirmationUuid,
            requestDigest: preview.data?.requestDigest,
            baseRevision: 1,
            clientRequestId: "018f3d6e-2d9e-7b6c-8a9b-000000001065",
          }),
        },
      )).json() as { data?: { runs?: Array<{ runUuid?: string }> } };
      const runUuid = String(confirmed.data?.runs?.[0]?.runUuid ?? "018f3d6e-2d9e-7b6c-8a9b-000000001066");
      const extra = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/${runUuid}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientActionId: ACTION_ID,
            requestDigest: DIGEST,
            teamUuid: "018f3d6e-2d9e-7b6c-8a9b-000000001067",
          }),
        },
      );
      const extraBody = await extra.json().catch(() => ({})) as { errorCode?: string };
      const first = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/${runUuid}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientActionId: ACTION_ID, requestDigest: DIGEST }),
        },
      );
      const replay = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/${runUuid}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientActionId: ACTION_ID, requestDigest: DIGEST }),
        },
      );
      const conflict = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/${runUuid}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientActionId: ACTION_ID, requestDigest: "b".repeat(64) }),
        },
      );
      const conflictBody = await conflict.json().catch(() => ({})) as { errorCode?: string };
      const firstBody = await first.json().catch(() => ({})) as { data?: { state?: string } };
      if (
        extraBody.errorCode !== "CANVAS_EXECUTION_CANCEL_REQUEST_INVALID"
        || first.status === 404
        || replay.status !== first.status
        || conflictBody.errorCode !== "CANVAS_EXECUTION_CANCEL_IDEMPOTENCY_CONFLICT"
        || firstBody.data?.state !== "canceled"
      ) {
        console.error(SENTINEL);
        assert.equal(extraBody.errorCode, "CANVAS_EXECUTION_CANCEL_REQUEST_INVALID", SENTINEL);
        assert.notEqual(first.status, 404, SENTINEL);
        assert.equal(conflictBody.errorCode, "CANVAS_EXECUTION_CANCEL_IDEMPOTENCY_CONFLICT", SENTINEL);
      }
    } finally {
      await close();
    }
  });
});
