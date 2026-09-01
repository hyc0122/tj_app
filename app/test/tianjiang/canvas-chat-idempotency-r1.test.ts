import assert from "node:assert/strict";
import test from "node:test";

import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:APP_CANVAS_CHAT_IDEMPOTENCY";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000d41";
const REQUEST_ID = "018f3d6e-2d9e-7b6c-8a9b-000000000d42";

test("同 clientChatRequestId 同摘要必须回放，异摘要返回 409", async () => {
  await runWithTemporaryAccount("canvas-chat-idempotency", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    const body = {
      prompt: "一座春日庭院",
      attachmentAssetUuids: [],
      baseRevision: 0,
      clientChatRequestId: REQUEST_ID,
      requestDigest: "2".repeat(64),
    };
    try {
      const first = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/home-plan`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      );
      const replay = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/home-plan`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      );
      const conflict = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/home-plan`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, prompt: "另一座庭院", requestDigest: "3".repeat(64) }),
        },
      );
      const conflictBody = await conflict.json().catch(() => ({})) as { errorCode?: string };
      if (first.status === 404 || replay.status !== first.status || conflictBody.errorCode !== "CANVAS_CHAT_IDEMPOTENCY_CONFLICT") {
        console.error(SENTINEL);
        assert.notEqual(first.status, 404, SENTINEL);
        assert.equal(conflictBody.errorCode, "CANVAS_CHAT_IDEMPOTENCY_CONFLICT", SENTINEL);
      }
    } finally {
      await close();
    }
  });
});
