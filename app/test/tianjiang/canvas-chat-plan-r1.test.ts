import assert from "node:assert/strict";
import test from "node:test";

import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:APP_CANVAS_CHAT_PLAN";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000d11";

test("home-plan 必须由服务端固定 source=home 并拒绝客户端伪造 source", async () => {
  await runWithTemporaryAccount("canvas-chat-plan", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const forged = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/home-plan`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: "一座春日庭院",
            attachmentAssetUuids: [],
            baseRevision: 0,
            clientChatRequestId: "018f3d6e-2d9e-7b6c-8a9b-000000000d12",
            requestDigest: "b".repeat(64),
            source: "home",
          }),
        },
      );
      const valid = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/home-plan`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: "一座春日庭院",
            attachmentAssetUuids: [],
            baseRevision: 0,
            clientChatRequestId: "018f3d6e-2d9e-7b6c-8a9b-000000000d13",
            requestDigest: "c".repeat(64),
          }),
        },
      );
      const forgedBody = await forged.json().catch(() => ({})) as { errorCode?: string };
      const validBody = await valid.json().catch(() => ({})) as { data?: { source?: string; planUuid?: string } };
      if (
        forged.status !== 422
        || forgedBody.errorCode !== "CANVAS_HOME_PLAN_REQUEST_INVALID"
        || valid.status === 404
        || validBody.data?.source !== "home"
      ) {
        console.error(SENTINEL);
        assert.equal(forged.status, 422, SENTINEL);
        assert.equal(validBody.data?.source, "home", SENTINEL);
      }
    } finally {
      await close();
    }
  });
});
