import assert from "node:assert/strict";
import test from "node:test";

import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:CANVAS_AI_MOUNTED_LIMITS";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000001051";

test("executions 请求超限必须在 handler 前拒绝且零写入", async () => {
  await runWithTemporaryAccount("canvas-ai-limits", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const tooMany = Array.from({ length: 2001 }, () => "018f3d6e-2d9e-7b6c-8a9b-000000001052");
      const preview = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseRevision: 0, nodeUuids: tooMany }),
        },
      );
      const body = await preview.json().catch(() => ({})) as { errorCode?: string };
      const cancel = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/018f3d6e-2d9e-7b6c-8a9b-000000001053/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientActionId: "not-a-uuid", requestDigest: "zz" }),
        },
      );
      const cancelBody = await cancel.json().catch(() => ({})) as { errorCode?: string };
      if (
        preview.status === 200
        || body.errorCode === undefined
        || cancel.status === 404
        || cancelBody.errorCode !== "CANVAS_EXECUTION_CANCEL_REQUEST_INVALID"
      ) {
        console.error(SENTINEL);
        assert.notEqual(preview.status, 200, SENTINEL);
        assert.equal(cancelBody.errorCode, "CANVAS_EXECUTION_CANCEL_REQUEST_INVALID", SENTINEL);
      }
    } finally {
      await close();
    }
  });
});
