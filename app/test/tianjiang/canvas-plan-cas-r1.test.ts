import assert from "node:assert/strict";
import test from "node:test";

import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:APP_CANVAS_PLAN_CAS";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000d21";
const PLAN_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000d22";

test("对话计划不得自动应用，apply 必须以 CAS 提交", async () => {
  await runWithTemporaryAccount("canvas-plan-cas", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const chat = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationUuid: "018f3d6e-2d9e-7b6c-8a9b-000000000d23",
            prompt: "增加一个文本节点",
            attachmentAssetUuids: [],
            referencedNodeUuids: [],
            baseRevision: 0,
            clientChatRequestId: "018f3d6e-2d9e-7b6c-8a9b-000000000d24",
            requestDigest: "d".repeat(64),
          }),
        },
      );
      const applied = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/plans/${PLAN_UUID}/apply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseRevision: 0,
            clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000000d25",
            requestDigest: "e".repeat(64),
          }),
        },
      );
      if (chat.status === 404 || applied.status === 404) {
        console.error(SENTINEL);
        assert.notEqual(chat.status, 404, SENTINEL);
        assert.notEqual(applied.status, 404, SENTINEL);
      }
    } finally {
      await close();
    }
  });
});
